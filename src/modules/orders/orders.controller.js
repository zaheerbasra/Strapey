/**
 * Orders Controller
 */

const ordersService = require('./orders.service');
const logger = require('../../core/logger')('orders.controller');

class OrdersController {
  async list(req, res) {
    try {
      const filters = {
        channel: req.query.channel,
        status: req.query.status,
        limit: req.query.limit
      };
      const orders = await ordersService.listOrders(filters);
      res.json({ success: true, count: orders.length, orders });
    } catch (error) {
      logger.error('List orders failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getById(req, res) {
    try {
      const order = await ordersService.getOrderById(req.params.id);
      res.json({ success: true, order });
    } catch (error) {
      logger.error('Get order failed', { error: error.message });
      res.status(404).json({ success: false, error: error.message });
    }
  }

  async getDetails(req, res) {
    try {
      const orderId = req.params.id;
      const details = await ordersService.getOrderDetails(orderId);
      res.json({ success: true, details });
    } catch (error) {
      logger.error('Get order details failed', { error: error.message });
      res.status(404).json({ success: false, error: error.message });
    }
  }

  async create(req, res) {
    try {
      const order = await ordersService.createOrder(req.body);
      res.status(201).json({ success: true, order });
    } catch (error) {
      logger.error('Create order failed', { error: error.message });
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async updateStatus(req, res) {
    try {
      const { status, trackingNumber } = req.body;
      const order = await ordersService.updateOrderStatus(req.params.id, status, trackingNumber);
      res.json({ success: true, order });
    } catch (error) {
      logger.error('Update order status failed', { error: error.message });
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async getNew(req, res) {
    try {
      const orders = await ordersService.getNewOrders();
      res.json({ success: true, count: orders.length, orders });
    } catch (error) {
      logger.error('Get new orders failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = new OrdersController();
