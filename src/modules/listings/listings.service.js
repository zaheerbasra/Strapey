/**
 * Listings Service - Marketplace Listing Management
 * Connects products to sales channels (eBay, Etsy, WooCommerce)
 */

const prisma = require('../../core/database');
const logger = require('../../core/logger')('listings.service');

class ListingsService {
  /**
   * Get all listings
   */
  async listListings(filters = {}) {
    try {
      const { channel, status, productId, limit = 50 } = filters;

      const where = {};
      if (channel) where.channel = channel;
      if (status) where.status = status;
      if (productId) where.productId = productId;

      const listings = await prisma.listing.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          product: true
        }
      });

      logger.info(`Listed ${listings.length} listings`);
      return listings;
    } catch (error) {
      logger.error('Failed to list listings', { error: error.message });
      throw error;
    }
  }

  /**
   * Get listing by ID
   */
  async getListingById(id) {
    try {
      const listing = await prisma.listing.findUnique({
        where: { id },
        include: {
          product: true
        }
      });

      if (!listing) {
        throw new Error('Listing not found');
      }

      return listing;
    } catch (error) {
      logger.error('Failed to get listing', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Create new listing
   */
  async createListing(listingData) {
    try {
      // Validate product exists
      const product = await prisma.product.findUnique({
        where: { id: listingData.productId }
      });

      if (!product) {
        throw new Error('Product not found');
      }

      const listing = await prisma.listing.create({
        data: {
          productId: listingData.productId,
          channel: listingData.channel,
          channelListingId: listingData.channelListingId || null,
          title: listingData.title || product.title,
          description: listingData.description || product.description,
          price: listingData.price !== undefined ? parseFloat(listingData.price) : product.price,
          quantity: listingData.quantity !== undefined ? parseInt(listingData.quantity) : product.inventory,
          status: listingData.status || 'draft',
          listingUrl: listingData.listingUrl || null,
          offerId: listingData.offerId || null,
          metadata: listingData.metadata ? JSON.stringify(listingData.metadata) : null,
          publishedAt: listingData.publishedAt || null
        },
        include: {
          product: true
        }
      });

      logger.info('Listing created', { 
        id: listing.id, 
        channel: listing.channel,
        productSku: product.sku 
      });
      
      return listing;
    } catch (error) {
      logger.error('Failed to create listing', { error: error.message });
      throw error;
    }
  }

  /**
   * Update listing
   */
  async updateListing(id, updates) {
    try {
      // Handle metadata JSON
      if (updates.metadata && typeof updates.metadata === 'object') {
        updates.metadata = JSON.stringify(updates.metadata);
      }

      const listing = await prisma.listing.update({
        where: { id },
        data: updates,
        include: {
          product: true
        }
      });

      logger.info('Listing updated', { id: listing.id, channel: listing.channel });
      return listing;
    } catch (error) {
      logger.error('Failed to update listing', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Delete listing
   */
  async deleteListing(id) {
    try {
      await prisma.listing.delete({
        where: { id }
      });

      logger.info('Listing deleted', { id });
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete listing', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Update listing status
   */
  async updateStatus(id, status, metadata = {}) {
    try {
      const updates = { status };
      
      if (status === 'active' && !metadata.publishedAt) {
        updates.publishedAt = new Date();
      }

      if (Object.keys(metadata).length > 0) {
        updates.metadata = JSON.stringify(metadata);
      }

      const listing = await prisma.listing.update({
        where: { id },
        data: updates,
        include: {
          product: true
        }
      });

      logger.info('Listing status updated', { 
        id: listing.id, 
        status: listing.status 
      });
      
      return listing;
    } catch (error) {
      logger.error('Failed to update listing status', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Get listings by product
   */
  async getListingsByProduct(productId) {
    try {
      const listings = await prisma.listing.findMany({
        where: { productId },
        include: {
          product: true
        }
      });

      return listings;
    } catch (error) {
      logger.error('Failed to get listings by product', { productId, error: error.message });
      throw error;
    }
  }

  /**
   * Get active listings
   */
  async getActiveListings(channel = null) {
    try {
      const where = { status: 'active' };
      if (channel) where.channel = channel;

      const listings = await prisma.listing.findMany({
        where,
        include: {
          product: true
        }
      });

      return listings;
    } catch (error) {
      logger.error('Failed to get active listings', { error: error.message });
      throw error;
    }
  }

  /**
   * Sync listing quantity with product inventory
   */
  async syncQuantity(listingId) {
    try {
      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
        include: { product: true }
      });

      if (!listing) {
        throw new Error('Listing not found');
      }

      const updated = await prisma.listing.update({
        where: { id: listingId },
        data: { quantity: listing.product.inventory }
      });

      logger.info('Listing quantity synced', { 
        id: listingId, 
        quantity: updated.quantity 
      });
      
      return updated;
    } catch (error) {
      logger.error('Failed to sync listing quantity', { listingId, error: error.message });
      throw error;
    }
  }
}

module.exports = new ListingsService();
