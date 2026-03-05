/**
 * Products Service - Central Product Catalog
 * Single source of truth for all product data
 */

const prisma = require('../../core/database');
const logger = require('../../core/logger')('products.service');

class ProductsService {
  /**
   * Get all products
   */
  async listProducts(filters = {}) {
    try {
      const { search, category, minPrice, maxPrice, limit = 50 } = filters;

      const where = {};
      
      if (search) {
        where.OR = [
          { title: { contains: search } },
          { sku: { contains: search } },
          { description: { contains: search } }
        ];
      }

      if (category) {
        where.category = category;
      }

      if (minPrice || maxPrice) {
        where.price = {};
        if (minPrice) where.price.gte = parseFloat(minPrice);
        if (maxPrice) where.price.lte = parseFloat(maxPrice);
      }

      const products = await prisma.product.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          listings: true
        }
      });

      logger.info(`Listed ${products.length} products`);
      return products;
    } catch (error) {
      logger.error('Failed to list products', { error: error.message });
      throw error;
    }
  }

  /**
   * Get product by ID
   */
  async getProductById(id) {
    try {
      const product = await prisma.product.findUnique({
        where: { id },
        include: {
          listings: true,
          orderItems: {
            include: {
              order: true
            }
          }
        }
      });

      if (!product) {
        throw new Error('Product not found');
      }

      return product;
    } catch (error) {
      logger.error('Failed to get product', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Get product by SKU
   */
  async getProductBySku(sku) {
    try {
      const product = await prisma.product.findUnique({
        where: { sku },
        include: {
          listings: true
        }
      });

      if (!product) {
        throw new Error('Product not found');
      }

      return product;
    } catch (error) {
      logger.error('Failed to get product by SKU', { sku, error: error.message });
      throw error;
    }
  }

  /**
   * Create new product
   */
  async createProduct(productData) {
    try {
      const product = await prisma.product.create({
        data: {
          sku: productData.sku,
          title: productData.title,
          description: productData.description || null,
          brand: productData.brand || null,
          price: parseFloat(productData.price),
          cost: productData.cost ? parseFloat(productData.cost) : null,
          inventory: parseInt(productData.inventory) || 0,
          images: JSON.stringify(productData.images || []),
          category: productData.category || null,
          weight: productData.weight ? parseFloat(productData.weight) : null,
          dimensions: productData.dimensions ? JSON.stringify(productData.dimensions) : null,
          specifics: productData.specifics ? JSON.stringify(productData.specifics) : null,
          sourceUrl: productData.sourceUrl || null
        }
      });

      logger.info('Product created', { id: product.id, sku: product.sku });
      return product;
    } catch (error) {
      logger.error('Failed to create product', { error: error.message });
      throw error;
    }
  }

  /**
   * Update product
   */
  async updateProduct(id, updates) {
    try {
      // Parse JSON fields if provided
      if (updates.images && typeof updates.images === 'object') {
        updates.images = JSON.stringify(updates.images);
      }
      if (updates.dimensions && typeof updates.dimensions === 'object') {
        updates.dimensions = JSON.stringify(updates.dimensions);
      }
      if (updates.specifics && typeof updates.specifics === 'object') {
        updates.specifics = JSON.stringify(updates.specifics);
      }

      const product = await prisma.product.update({
        where: { id },
        data: updates
      });

      logger.info('Product updated', { id: product.id, sku: product.sku });
      return product;
    } catch (error) {
      logger.error('Failed to update product', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Delete product
   */
  async deleteProduct(id) {
    try {
      await prisma.product.delete({
        where: { id }
      });

      logger.info('Product deleted', { id });
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete product', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Update inventory
   */
  async updateInventory(id, quantity, operation = 'set') {
    try {
      let product;
      
      if (operation === 'increment') {
        product = await prisma.product.update({
          where: { id },
          data: { inventory: { increment: quantity } }
        });
      } else if (operation === 'decrement') {
        product = await prisma.product.update({
          where: { id },
          data: { inventory: { decrement: quantity } }
        });
      } else {
        product = await prisma.product.update({
          where: { id },
          data: { inventory: quantity }
        });
      }

      logger.info('Inventory updated', { id, inventory: product.inventory });
      return product;
    } catch (error) {
      logger.error('Failed to update inventory', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Get low stock products
   */
  async getLowStockProducts(threshold = 5) {
    try {
      const products = await prisma.product.findMany({
        where: {
          inventory: {
            lte: threshold
          }
        },
        orderBy: { inventory: 'asc' }
      });

      logger.info(`Found ${products.length} low stock products`);
      return products;
    } catch (error) {
      logger.error('Failed to get low stock products', { error: error.message });
      throw error;
    }
  }
}

module.exports = new ProductsService();
