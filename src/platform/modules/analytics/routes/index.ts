import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { analyticsController } from '../controllers/analytics.controller';

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get('/api/platform/analytics/dashboard', { preHandler: [authGuard] }, analyticsController.dashboard);
}
