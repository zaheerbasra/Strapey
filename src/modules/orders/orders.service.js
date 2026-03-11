/**
 * Orders Service - Unified Order Management
 * Centralized order management across all sales channels
 */

const prisma = require('../../core/database');
const logger = require('../../core/logger')('orders.service');

const fs = require('fs');
const path = require('path');
const DATA_STORE_PATH = path.join(__dirname, '../../data/data.json');

class OrdersService {
    /**
     * Get full order details (fulfillment, finance, item images)
     */
    async getOrderDetails(orderId) {
      try {
        // Fetch order with items and shipment using channelOrderId (string)
        const order = await prisma.order.findFirst({
          where: { channelOrderId: orderId },
          include: {
            items: { include: { product: true } },
            shipment: true
          }
        });
        if (!order) throw new Error('Order not found');

        // Load local product data for image mapping
        let productData = {};
        try {
          const raw = fs.readFileSync(DATA_STORE_PATH, 'utf8');
          productData = JSON.parse(raw);
        } catch (e) {
          productData = {};
        }

        // Map item SKUs to images
        const itemsWithImages = (order.items || []).map(item => {
          let images = [];
          // Try SKU, then customLabel
          for (const entry of Object.values(productData)) {
            if (entry && (entry.sku === item.sku || entry.customLabel === item.sku)) {
              images = entry.images || entry.imageSourceUrls || [];
              break;
            }
          }
          return {
            ...item,
            images
          };
        });

        // Placeholder: fetch fulfillment and finance details (extend as needed)
        const fulfillment = order.shipment || null;
        const finance = order.finance || null;

        return {
          orderId: order.id,
          order,
          fulfillment,
          finance,
          items: itemsWithImages
        };
      } catch (error) {
        logger.error('Failed to get order details', { orderId, error: error.message });
        throw error;
      }
    }
  /**
   * List orders
   */
  async listOrders(filters = {}) {
    try {
      const { channel, status, limit = 50 } = filters;

      const where = {};
      if (channel) where.channel = channel;
      if (status) where.status = status;

      const orders = await prisma.order.findMany({
        where,
        take: limit,
        orderBy: { orderDate: 'desc' },
        include: {
          items: {
            include: {
              product: true
            }
          },
          shipment: true
        }
      });

      logger.info(`Listed ${orders.length} orders`);
      return orders;
    } catch (error) {
      logger.error('Failed to list orders', { error: error.message });
      throw error;
    }
  }

  /**
   * Get order by ID
   */
  async getOrderById(id) {
    try {
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          items: {
            include: {
              product: true
            }
          },
          shipment: true
        }
      });

      if (!order) {
        throw new Error('Order not found');
      }

      return order;
    } catch (error) {
      logger.error('Failed to get order', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Create new order
   */
  async createOrder(orderData) {
    try {
      const order = await prisma.order.create({
        data: {
          orderNumber: orderData.orderNumber,
          channel: orderData.channel,
          channelOrderId: orderData.channelOrderId,
          customerName: orderData.customerName,
          customerEmail: orderData.customerEmail || null,
          shippingAddress: JSON.stringify(orderData.shippingAddress),
          subtotal: parseFloat(orderData.subtotal),
          shippingCost: parseFloat(orderData.shippingCost) || 0,
          tax: parseFloat(orderData.tax) || 0,
          total: parseFloat(orderData.total),
          status: orderData.status || 'new',
          trackingNumber: orderData.trackingNumber || null,
          orderDate: orderData.orderDate ? new Date(orderData.orderDate) : new Date(),
          items: {
            create: orderData.items.map(item => ({
              productId: item.productId || null,
              sku: item.sku,
              title: item.title,
              quantity: parseInt(item.quantity),
              price: parseFloat(item.price)
            }))
          }
        },
        include: {
          items: {
            include: {
              product: true
            }
          }
        }
      });

      // Decrement inventory for products
      for (const item of orderData.items) {
        if (item.productId) {
          await prisma.product.update({
            where: { id: item.productId },
            data: {
              inventory: {
                decrement: parseInt(item.quantity)
              }
            }
          });
        }
      }

      logger.info('Order created', { 
        id: order.id, 
        orderNumber: order.orderNumber,
        channel: order.channel 
      });
      
      return order;
    } catch (error) {
      logger.error('Failed to create order', { error: error.message });
      throw error;
    }
  }

  /**
   * Update order status
   */
  async updateOrderStatus(id, status, trackingNumber = null) {
    try {
      const updates = { status };
      if (trackingNumber) {
        updates.trackingNumber = trackingNumber;
      }

      const order = await prisma.order.update({
        where: { id },
        data: updates,
        include: {
          items: true,
          shipment: true
        }
      });

      logger.info('Order status updated', { id, status });
      return order;
    } catch (error) {
      logger.error('Failed to update order status', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Get new orders (pending processing)
   */
  async getNewOrders() {
    try {
      const orders = await prisma.order.findMany({
        where: {
          status: 'new'
        },
        orderBy: { orderDate: 'asc' },
        include: {
          items: {
            include: {
              product: true
            }
          }
        }
      });

      return orders;
    } catch (error) {
      logger.error('Failed to get new orders', { error: error.message });
      throw error;
    }
  }
}

module.exports = new OrdersService();
