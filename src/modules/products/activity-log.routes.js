/**
 * Product Activity Log Routes
 * API routes for fetching product activity audit logs
 */

const express = require('express');
const router = express.Router();
const activityLogService = require('./product-activity-log.service');
const logger = require('../../core/logger')('activity-log.routes');

/**
 * GET /api/products/:id/activity-logs
 * Get activity logs for a specific product
 */
router.get('/:id/activity-logs', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      limit = 50,
      offset = 0,
      actionType,
      startDate,
      endDate
    } = req.query;

    const result = await activityLogService.getProductLogs(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      actionType: actionType || null,
      startDate: startDate || null,
      endDate: endDate || null
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to fetch product activity logs', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/products/activity-logs/recent
 * Get recent activity across all products
 */
router.get('/activity-logs/recent', async (req, res) => {
  try {
    const { limit = 100, actionType } = req.query;

    const logs = await activityLogService.getRecentActivity({
      limit: parseInt(limit),
      actionType: actionType || null
    });

    res.json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    logger.error('Failed to fetch recent activity', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/products/activity-logs/action-types
 * Get list of all action types
 */
router.get('/activity-logs/action-types', (req, res) => {
  const actionTypes = activityLogService.getActionTypes();
  res.json({
    success: true,
    actionTypes
  });
});

module.exports = router;
