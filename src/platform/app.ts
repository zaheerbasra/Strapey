import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import pino from 'pino';
import { env } from './config/env';
import { registerRoutes } from './core/http/register-routes';
import { registerGraphql } from './core/graphql/schema';
import { registerIntegrations } from './integrations';
import { registerShippingWorkers } from './modules/shipping/jobs/shipping.jobs';
import { registerMarketingWorkers } from './modules/marketing/jobs/marketing.jobs';
import { logAudit } from './core/audit/audit.service';

export async function buildPlatformApp() {
  const app = Fastify({
    logger: {
      level: env.nodeEnv === 'production' ? 'info' : 'debug'
    }
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(rateLimit, {
    max: env.apiRateLimitMax,
    timeWindow: env.apiRateLimitWindow
  });

  registerIntegrations();
  registerShippingWorkers();
  registerMarketingWorkers();

  await registerGraphql(app);
  await registerRoutes(app);

  app.addHook('onResponse', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (!request.url.startsWith('/api/platform')) return;

    const user = (request as any).user as { sub?: string } | undefined;
    try {
      await logAudit({
        actor_id: user?.sub || 'system',
        action: `${request.method} ${request.url}`,
        resource_type: 'api',
        metadata: {
          statusCode: reply.statusCode
        }
      });
    } catch {
      app.log.warn('Audit log write failed');
    }
  });

  return app;
}
