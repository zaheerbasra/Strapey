import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { marketingController } from '../controllers/marketing.controller';

export async function registerMarketingRoutes(app: FastifyInstance) {
  app.get('/api/platform/marketing/campaigns', { preHandler: [authGuard] }, marketingController.list);
  app.post('/api/platform/marketing/campaigns', { preHandler: [authGuard, requireRole(['admin', 'manager', 'marketing'])] }, marketingController.create);
}
