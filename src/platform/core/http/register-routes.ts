import { FastifyInstance } from 'fastify';
import { registerProductRoutes } from '../../modules/products/routes';
import { registerOrderRoutes } from '../../modules/orders/routes';
import { registerInventoryRoutes } from '../../modules/inventory/routes';
import { registerShippingRoutes } from '../../modules/shipping/routes';
import { registerMarketingRoutes } from '../../modules/marketing/routes';
import { registerAnalyticsRoutes } from '../../modules/analytics/routes';
import { registerSocialModuleRoutes } from '../../modules/social/routes';
import { pluginManager } from '../plugin/plugin-manager';
import { authGuard, registerAuth } from '../security/auth';
import { requireRole } from '../security/rbac';
import { runIntelligentCompetitorScraper } from '../../integrations/ebay/plugin';
import { evaluateAutomationRules } from '../automation/rule-engine';
import { applySchema } from '../../database/bootstrap';
import { query } from '../db/pg';
import { queues } from '../queue';
import { decryptSensitive, encryptSensitive } from '../security/crypto';

export async function registerRoutes(app: FastifyInstance) {
  // Root route
  app.get('/', async () => ({
    message: 'Strapey Enterprise Platform API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      graphql: '/graphql',
      health: '/api/platform/admin/health',
      integrations: '/api/platform/integrations',
      products: '/api/platform/products',
      orders: '/api/platform/orders',
      inventory: '/api/platform/inventory',
      shipping: '/api/platform/shipping',
      marketing: '/api/platform/marketing',
      social: '/api/platform/social',
      analytics: '/api/platform/analytics'
    }
  }));

  await registerAuth(app);
  await registerProductRoutes(app);
  await registerOrderRoutes(app);
  await registerInventoryRoutes(app);
  await registerShippingRoutes(app);
  await registerMarketingRoutes(app);
  await registerSocialModuleRoutes(app);
  await registerAnalyticsRoutes(app);

  app.get('/api/platform/integrations', { preHandler: [authGuard] }, async () => ({ integrations: pluginManager.list() }));

  app.post('/api/platform/integrations/:integrationKey/listings', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.createListing) return reply.code(404).send({ error: 'Integration not found or does not support createListing' });
    return plugin.createListing(request.body);
  });

  app.patch('/api/platform/integrations/:integrationKey/listings', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.updateListing) return reply.code(404).send({ error: 'Integration not found or does not support updateListing' });
    return plugin.updateListing(request.body);
  });

  app.post('/api/platform/integrations/:integrationKey/listings/pause', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.pauseListing) return reply.code(404).send({ error: 'Integration not found or does not support pauseListing' });
    return plugin.pauseListing(request.body);
  });

  app.post('/api/platform/integrations/:integrationKey/listings/relist', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.relistItem) return reply.code(404).send({ error: 'Integration not found or does not support relistItem' });
    return plugin.relistItem(request.body);
  });

  app.delete('/api/platform/integrations/:integrationKey/listings', { preHandler: [authGuard, requireRole(['admin'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.deleteListing) return reply.code(404).send({ error: 'Integration not found or does not support deleteListing' });
    return plugin.deleteListing(request.body);
  });

  app.post('/api/platform/integrations/:integrationKey/inventory/sync', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.syncInventory) return reply.code(404).send({ error: 'Integration not found or does not support inventory sync' });
    return plugin.syncInventory(request.body);
  });

  app.post('/api/platform/integrations/:integrationKey/pricing/sync', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.syncPricing) return reply.code(404).send({ error: 'Integration not found or does not support pricing sync' });
    return plugin.syncPricing(request.body);
  });

  app.post('/api/platform/integrations/:integrationKey/orders/sync', { preHandler: [authGuard, requireRole(['admin', 'manager', 'support'])] }, async (request, reply) => {
    const { integrationKey } = request.params as { integrationKey: string };
    const plugin = pluginManager.get(integrationKey);
    if (!plugin?.syncOrders) return reply.code(404).send({ error: 'Integration not found or does not support order sync' });
    return plugin.syncOrders();
  });

  app.post('/api/platform/ebay/scraper/competitors', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request) => {
    const body = request.body as { keyword: string; maxPages?: number };
    return runIntelligentCompetitorScraper({ keyword: body.keyword, maxPages: body.maxPages || 3 });
  });

  app.post('/api/platform/automation/evaluate', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request) => {
    const actions = await evaluateAutomationRules(request.body as any);
    return { actions };
  });

  app.get('/api/platform/listings', { preHandler: [authGuard] }, async (request) => {
    const { channel, limit } = (request.query || {}) as { channel?: string; limit?: string };
    if (channel) {
      return query('SELECT * FROM channel_listings WHERE channel = $1 ORDER BY updated_at DESC LIMIT $2', [channel, Number(limit || 100)]);
    }
    return query('SELECT * FROM channel_listings ORDER BY updated_at DESC LIMIT $1', [Number(limit || 100)]);
  });

  app.post('/api/platform/listings', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async (request) => {
    const body = request.body as any;
    const rows = await query(
      `INSERT INTO channel_listings(product_id, channel, external_listing_id, status, price, quantity, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(channel, external_listing_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         status = EXCLUDED.status,
         price = EXCLUDED.price,
         quantity = EXCLUDED.quantity,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        body.product_id,
        body.channel,
        body.external_listing_id,
        body.status || 'active',
        Number(body.price || 0),
        Number(body.quantity || 0),
        JSON.stringify(body.metadata || {})
      ]
    );
    return rows[0];
  });

  app.post('/api/platform/admin/bootstrap-schema', { preHandler: [authGuard, requireRole(['admin'])] }, async () => {
    return applySchema();
  });

  app.post('/api/platform/admin/integrations/secrets', { preHandler: [authGuard, requireRole(['admin'])] }, async (request) => {
    const body = request.body as { integration_key: string; secret_name: string; secret_value: string };
    const cipher = encryptSensitive(body.secret_value);
    const rows = await query(
      `INSERT INTO integration_secrets(integration_key, secret_name, secret_cipher)
       VALUES($1,$2,$3)
       ON CONFLICT(integration_key, secret_name)
       DO UPDATE SET secret_cipher = EXCLUDED.secret_cipher, updated_at = NOW()
       RETURNING integration_key, secret_name, created_at, updated_at`,
      [body.integration_key, body.secret_name, cipher]
    );
    return rows[0];
  });

  app.get('/api/platform/admin/integrations/secrets', { preHandler: [authGuard, requireRole(['admin'])] }, async () => {
    const rows = await query<{ integration_key: string; secret_name: string; secret_cipher: string; updated_at: string }>(
      'SELECT integration_key, secret_name, secret_cipher, updated_at FROM integration_secrets ORDER BY updated_at DESC'
    );
    return rows.map((row) => ({
      integration_key: row.integration_key,
      secret_name: row.secret_name,
      updated_at: row.updated_at,
      preview: `${decryptSensitive(row.secret_cipher).slice(0, 4)}****`
    }));
  });

  app.get('/api/platform/admin/observability', { preHandler: [authGuard, requireRole(['admin', 'manager'])] }, async () => {
    const queueStats = await Promise.all(
      Object.entries(queues).map(async ([name, queue]) => {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        return { name, counts };
      })
    );

    return {
      timestamp: new Date().toISOString(),
      integrations: pluginManager.list(),
      queueStats
    };
  });

  app.get('/api/platform/admin/health', async () => ({ ok: true, module: 'platform' }));
}
