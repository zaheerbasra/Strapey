/**
 * Products Controller
 * HTTP request handlers for product management
 */

const productsService = require('./products.service');
const logger = require('../../core/logger')('products.controller');

class ProductsController {
  /**
   * GET /api/products - List products
   */
  async list(req, res) {
    try {
      const filters = {
        search: req.query.search,
        category: req.query.category,
        minPrice: req.query.minPrice,
        maxPrice: req.query.maxPrice,
        limit: req.query.limit
      };

      const products = await productsService.listProducts(filters);
      
      res.json({
        success: true,
        count: products.length,
        products
      });
    } catch (error) {
      logger.error('List products failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/products/:id - Get product by ID
   */
  async getById(req, res) {
    try {
      const product = await productsService.getProductById(req.params.id);
      
      res.json({
        success: true,
        product
      });
    } catch (error) {
      logger.error('Get product failed', { error: error.message });
      res.status(404).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/products/sku/:sku - Get product by SKU
   */
  async getBySku(req, res) {
    try {
      const product = await productsService.getProductBySku(req.params.sku);
      
      res.json({
        success: true,
        product
      });
    } catch (error) {
      logger.error('Get product by SKU failed', { error: error.message });
      res.status(404).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/products - Create product
   */
  async create(req, res) {
    try {
      const product = await productsService.createProduct(req.body);
      
      res.status(201).json({
        success: true,
        product
      });
    } catch (error) {
      logger.error('Create product failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * PATCH /api/products/:id - Update product
   */
  async update(req, res) {
    try {
      const product = await productsService.updateProduct(req.params.id, req.body);
      
      res.json({
        success: true,
        product
      });
    } catch (error) {
      logger.error('Update product failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * DELETE /api/products/:id - Delete product
   */
  async delete(req, res) {
    try {
      await productsService.deleteProduct(req.params.id);
      
      res.json({
        success: true,
        message: 'Product deleted'
      });
    } catch (error) {
      logger.error('Delete product failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/products/:id/inventory - Update inventory
   */
  async updateInventory(req, res) {
    try {
      const { quantity, operation } = req.body;
      const product = await productsService.updateInventory(
        req.params.id, 
        quantity, 
        operation
      );
      
      res.json({
        success: true,
        product
      });
    } catch (error) {
      logger.error('Update inventory failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/products/low-stock - Get low stock products
   */
  async lowStock(req, res) {
    try {
      const threshold = parseInt(req.query.threshold) || 5;
      const products = await productsService.getLowStockProducts(threshold);
      
      res.json({
        success: true,
        count: products.length,
        products
      });
    } catch (error) {
      logger.error('Get low stock failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new ProductsController();
