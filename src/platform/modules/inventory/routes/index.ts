import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { inventoryController } from '../controllers/inventory.controller';

export async function registerInventoryRoutes(app: FastifyInstance) {
  app.get('/api/platform/inventory/low-stock', { preHandler: [authGuard] }, inventoryController.lowStock);
  app.patch('/api/platform/inventory/:productId/adjust', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, inventoryController.adjust);
}
