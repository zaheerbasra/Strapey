import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { shippingController } from '../controllers/shipping.controller';

export async function registerShippingRoutes(app: FastifyInstance) {
  app.post('/api/platform/shipping/orders/:orderId/labels', { preHandler: [authGuard, requireRole(['admin', 'manager', 'support'])] }, shippingController.generateLabel);
}
