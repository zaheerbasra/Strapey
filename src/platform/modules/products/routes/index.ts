import { FastifyInstance } from 'fastify';
import { productController } from '../controllers/product.controller';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';

export async function registerProductRoutes(app: FastifyInstance) {
  app.get('/api/platform/products', { preHandler: [authGuard] }, productController.list);
  app.get('/api/platform/products/:productId', { preHandler: [authGuard] }, productController.getById);
  app.post('/api/platform/products', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, productController.create);
  app.put('/api/platform/products/:productId', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, productController.update);
}
