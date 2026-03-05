import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { socialController } from '../controllers/social.controller';

export async function registerSocialModuleRoutes(app: FastifyInstance) {
	app.get('/api/platform/social/posts', { preHandler: [authGuard] }, socialController.list);
	app.post('/api/platform/social/posts', { preHandler: [authGuard, requireRole(['admin', 'manager', 'marketing'])] }, socialController.create);
}
