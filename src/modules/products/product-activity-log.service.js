/**
 * Product Activity Log Service
 * Tracks all operations on products for audit trail
 */

const prisma = require('../../core/database');
const logger = require('../../core/logger')('product-activity-log');

// Action type constants
const ACTION_TYPES = {
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_SCRAPED_FROM_EBAY: 'PRODUCT_SCRAPED_FROM_EBAY',
  PRODUCT_PRICE_UPDATED: 'PRODUCT_PRICE_UPDATED',
  PRODUCT_TITLE_UPDATED: 'PRODUCT_TITLE_UPDATED',
  PRODUCT_QTY_UPDATED: 'PRODUCT_QTY_UPDATED',
  PRODUCT_IMAGES_UPDATED: 'PRODUCT_IMAGES_UPDATED',
  PRODUCT_WEIGHT_UPDATED: 'PRODUCT_WEIGHT_UPDATED',
  PRODUCT_DIMENSIONS_UPDATED: 'PRODUCT_DIMENSIONS_UPDATED',
  PRODUCT_PUBLISHED_SANDBOX: 'PRODUCT_PUBLISHED_SANDBOX',
  PRODUCT_PUBLISHED_PRODUCTION: 'PRODUCT_PUBLISHED_PRODUCTION',
  PRODUCT_LISTING_UPDATED: 'PRODUCT_LISTING_UPDATED',
  PRODUCT_MARKED_INACTIVE: 'PRODUCT_MARKED_INACTIVE',
  PRODUCT_MARKED_ACTIVE: 'PRODUCT_MARKED_ACTIVE',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  PRODUCT_RESTORED: 'PRODUCT_RESTORED',
  PRODUCT_CATEGORY_UPDATED: 'PRODUCT_CATEGORY_UPDATED',
  PRODUCT_DESCRIPTION_UPDATED: 'PRODUCT_DESCRIPTION_UPDATED'
};

class ProductActivityLogService {
  /**
   * Log a product activity
   * @param {Object} params - Log parameters
   * @param {string} params.productId - Product ID
   * @param {string} params.actionType - Action type (from ACTION_TYPES)
   * @param {string} params.actionDescription - Human-readable description
   * @param {Object} params.previousValue - Previous state (optional)
   * @param {Object} params.newValue - New state (optional)
   * @param {string} params.performedBy - User ID or "system" (optional)
   * @param {string} params.sourceSystem - Source system (default: "strapey")
   * @param {string} params.ipAddress - IP address (optional)
   * @param {string} params.userAgent - User agent (optional)
   */
  async logActivity({
    productId,
    actionType,
    actionDescription,
    previousValue = null,
    newValue = null,
    performedBy = 'system',
    sourceSystem = 'strapey',
    ipAddress = null,
    userAgent = null
  }) {
    try {
      // Validate action type
      if (!Object.values(ACTION_TYPES).includes(actionType)) {
        logger.warn('Invalid action type', { actionType });
      }

      // Convert values to JSON strings if they're objects
      const prevValueStr = previousValue ? JSON.stringify(previousValue) : null;
      const newValueStr = newValue ? JSON.stringify(newValue) : null;

      const logEntry = await prisma.productActivityLog.create({
        data: {
          productId,
          actionType,
          actionDescription,
          previousValue: prevValueStr,
          newValue: newValueStr,
          performedBy,
          sourceSystem,
          ipAddress,
          userAgent
        }
      });

      logger.info('Product activity logged', { 
        logId: logEntry.id, 
        productId, 
        actionType 
      });

      return logEntry;
    } catch (error) {
      // Log errors but don't throw - logging should never break main workflow
      logger.error('Failed to log product activity', { 
        error: error.message, 
        productId, 
        actionType 
      });
      return null;
    }
  }

  /**
   * Get activity logs for a product
   * @param {string} productId - Product ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of logs to return
   * @param {number} options.offset - Offset for pagination
   * @param {string} options.actionType - Filter by action type
   * @param {Date} options.startDate - Filter by start date
   * @param {Date} options.endDate - Filter by end date
   */
  async getProductLogs(productId, options = {}) {
    try {
      const {
        limit = 50,
        offset = 0,
        actionType = null,
        startDate = null,
        endDate = null
      } = options;

      const where = { productId };

      if (actionType) {
        where.actionType = actionType;
      }

      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = new Date(startDate);
        if (endDate) where.createdAt.lte = new Date(endDate);
      }

      const [logs, totalCount] = await Promise.all([
        prisma.productActivityLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset
        }),
        prisma.productActivityLog.count({ where })
      ]);

      // Parse JSON values back to objects
      const parsedLogs = logs.map(log => ({
        ...log,
        previousValue: log.previousValue ? JSON.parse(log.previousValue) : null,
        newValue: log.newValue ? JSON.parse(log.newValue) : null
      }));

      return {
        logs: parsedLogs,
        totalCount,
        hasMore: offset + logs.length < totalCount
      };
    } catch (error) {
      logger.error('Failed to fetch product logs', { error: error.message, productId });
      throw error;
    }
  }

  /**
   * Get recent activity across all products
   * @param {Object} options - Query options
   */
  async getRecentActivity(options = {}) {
    try {
      const { limit = 100, actionType = null } = options;

      const where = {};
      if (actionType) {
        where.actionType = actionType;
      }

      const logs = await prisma.productActivityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          product: {
            select: {
              id: true,
              sku: true,
              title: true
            }
          }
        }
      });

      return logs.map(log => ({
        ...log,
        previousValue: log.previousValue ? JSON.parse(log.previousValue) : null,
        newValue: log.newValue ? JSON.parse(log.newValue) : null
      }));
    } catch (error) {
      logger.error('Failed to fetch recent activity', { error: error.message });
      throw error;
    }
  }

  /**
   * Helper method to log product creation
   */
  async logProductCreated(productId, productData, performedBy = 'system', sourceSystem = 'strapey') {
    return this.logActivity({
      productId,
      actionType: ACTION_TYPES.PRODUCT_CREATED,
      actionDescription: `Product created: ${productData.title || productData.sku}`,
      newValue: {
        sku: productData.sku,
        title: productData.title,
        price: productData.price,
        inventory: productData.inventory
      },
      performedBy,
      sourceSystem
    });
  }

  /**
   * Helper method to log product scraping
   */
  async logProductScraped(productId, sourceUrl, performedBy = 'scraper', sourceSystem = 'scraper') {
    return this.logActivity({
      productId,
      actionType: ACTION_TYPES.PRODUCT_SCRAPED_FROM_EBAY,
      actionDescription: `Product scraped from eBay listing: ${sourceUrl}`,
      newValue: { sourceUrl },
      performedBy,
      sourceSystem
    });
  }

  /**
   * Helper method to log publishing
   */
  async logProductPublished(productId, environment, listingId, performedBy = 'system', sourceSystem = 'publisher') {
    const actionType = environment === 'production' 
      ? ACTION_TYPES.PRODUCT_PUBLISHED_PRODUCTION 
      : ACTION_TYPES.PRODUCT_PUBLISHED_SANDBOX;

    return this.logActivity({
      productId,
      actionType,
      actionDescription: `Product published to eBay ${environment}: Listing ID ${listingId}`,
      newValue: { environment, listingId },
      performedBy,
      sourceSystem
    });
  }

  /**
   * Helper method to log field updates
   */
  async logFieldUpdate(productId, fieldName, previousValue, newValue, performedBy = 'system') {
    let actionType = ACTION_TYPES.PRODUCT_UPDATED;
    let description = `${fieldName} updated`;

    // Map specific fields to action types
    switch (fieldName.toLowerCase()) {
      case 'price':
        actionType = ACTION_TYPES.PRODUCT_PRICE_UPDATED;
        description = `Price updated from ${previousValue} to ${newValue}`;
        break;
      case 'title':
        actionType = ACTION_TYPES.PRODUCT_TITLE_UPDATED;
        description = `Title updated`;
        break;
      case 'inventory':
      case 'quantity':
        actionType = ACTION_TYPES.PRODUCT_QTY_UPDATED;
        description = `Inventory updated from ${previousValue} to ${newValue}`;
        break;
      case 'images':
        actionType = ACTION_TYPES.PRODUCT_IMAGES_UPDATED;
        description = `Product images updated`;
        break;
      case 'weight':
        actionType = ACTION_TYPES.PRODUCT_WEIGHT_UPDATED;
        description = `Weight updated from ${previousValue} to ${newValue}`;
        break;
      case 'dimensions':
        actionType = ACTION_TYPES.PRODUCT_DIMENSIONS_UPDATED;
        description = `Dimensions updated`;
        break;
      case 'category':
        actionType = ACTION_TYPES.PRODUCT_CATEGORY_UPDATED;
        description = `Category updated`;
        break;
      case 'description':
        actionType = ACTION_TYPES.PRODUCT_DESCRIPTION_UPDATED;
        description = `Description updated`;
        break;
    }

    return this.logActivity({
      productId,
      actionType,
      actionDescription: description,
      previousValue: { [fieldName]: previousValue },
      newValue: { [fieldName]: newValue },
      performedBy
    });
  }

  /**
   * Get action types
   */
  getActionTypes() {
    return ACTION_TYPES;
  }
}

// Export singleton instance
module.exports = new ProductActivityLogService();
module.exports.ACTION_TYPES = ACTION_TYPES;
