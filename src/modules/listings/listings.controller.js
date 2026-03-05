/**
 * Listings Controller
 * HTTP request handlers for listing management
 */

const listingsService = require('./listings.service');
const logger = require('../../core/logger')('listings.controller');

class ListingsController {
  /**
   * GET /api/listings - List listings
   */
  async list(req, res) {
    try {
      const filters = {
        channel: req.query.channel,
        status: req.query.status,
        productId: req.query.productId,
        limit: req.query.limit
      };

      const listings = await listingsService.listListings(filters);
      
      res.json({
        success: true,
        count: listings.length,
        listings
      });
    } catch (error) {
      logger.error('List listings failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/listings/:id - Get listing by ID
   */
  async getById(req, res) {
    try {
      const listing = await listingsService.getListingById(req.params.id);
      
      res.json({
        success: true,
        listing
      });
    } catch (error) {
      logger.error('Get listing failed', { error: error.message });
      res.status(404).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/listings - Create listing
   */
  async create(req, res) {
    try {
      const listing = await listingsService.createListing(req.body);
      
      res.status(201).json({
        success: true,
        listing
      });
    } catch (error) {
      logger.error('Create listing failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * PATCH /api/listings/:id - Update listing
   */
  async update(req, res) {
    try {
      const listing = await listingsService.updateListing(req.params.id, req.body);
      
      res.json({
        success: true,
        listing
      });
    } catch (error) {
      logger.error('Update listing failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * DELETE /api/listings/:id - Delete listing
   */
  async delete(req, res) {
    try {
      await listingsService.deleteListing(req.params.id);
      
      res.json({
        success: true,
        message: 'Listing deleted'
      });
    } catch (error) {
      logger.error('Delete listing failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/listings/:id/status - Update listing status
   */
  async updateStatus(req, res) {
    try {
      const { status, metadata } = req.body;
      const listing = await listingsService.updateStatus(req.params.id, status, metadata);
      
      res.json({
        success: true,
        listing
      });
    } catch (error) {
      logger.error('Update listing status failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/listings/product/:productId - Get listings by product
   */
  async getByProduct(req, res) {
    try {
      const listings = await listingsService.getListingsByProduct(req.params.productId);
      
      res.json({
        success: true,
        count: listings.length,
        listings
      });
    } catch (error) {
      logger.error('Get listings by product failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/listings/active - Get active listings
   */
  async getActive(req, res) {
    try {
      const channel = req.query.channel;
      const listings = await listingsService.getActiveListings(channel);
      
      res.json({
        success: true,
        count: listings.length,
        listings
      });
    } catch (error) {
      logger.error('Get active listings failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/listings/:id/sync-quantity - Sync listing quantity with product
   */
  async syncQuantity(req, res) {
    try {
      const listing = await listingsService.syncQuantity(req.params.id);
      
      res.json({
        success: true,
        listing
      });
    } catch (error) {
      logger.error('Sync quantity failed', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new ListingsController();
