import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { orderController } from '../controllers/order.controller';

export async function registerOrderRoutes(app: FastifyInstance) {
  app.get('/api/platform/orders', { preHandler: [authGuard] }, orderController.list);
  app.post('/api/platform/orders', { preHandler: [authGuard, requireRole(['admin', 'manager', 'support'])] }, orderController.create);
  app.patch('/api/platform/orders/:orderId/status', { preHandler: [authGuard, requireRole(['admin', 'manager', 'support'])] }, orderController.updateStatus);
}
