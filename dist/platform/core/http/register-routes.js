"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const routes_1 = require("../../modules/products/routes");
const routes_2 = require("../../modules/orders/routes");
const routes_3 = require("../../modules/inventory/routes");
const routes_4 = require("../../modules/shipping/routes");
const routes_5 = require("../../modules/marketing/routes");
const routes_6 = require("../../modules/analytics/routes");
const routes_7 = require("../../modules/social/routes");
const plugin_manager_1 = require("../plugin/plugin-manager");
const auth_1 = require("../security/auth");
const rbac_1 = require("../security/rbac");
const plugin_1 = require("../../integrations/ebay/plugin");
const rule_engine_1 = require("../automation/rule-engine");
const bootstrap_1 = require("../../database/bootstrap");
const pg_1 = require("../db/pg");
const queue_1 = require("../queue");
const crypto_1 = require("../security/crypto");
async function registerRoutes(app) {
    await (0, auth_1.registerAuth)(app);
    await (0, routes_1.registerProductRoutes)(app);
    await (0, routes_2.registerOrderRoutes)(app);
    await (0, routes_3.registerInventoryRoutes)(app);
    await (0, routes_4.registerShippingRoutes)(app);
    await (0, routes_5.registerMarketingRoutes)(app);
    await (0, routes_7.registerSocialModuleRoutes)(app);
    await (0, routes_6.registerAnalyticsRoutes)(app);
    app.get('/api/platform/integrations', { preHandler: [auth_1.authGuard] }, async () => ({ integrations: plugin_manager_1.pluginManager.list() }));
    app.post('/api/platform/integrations/:integrationKey/listings', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.createListing)
            return reply.code(404).send({ error: 'Integration not found or does not support createListing' });
        return plugin.createListing(request.body);
    });
    app.patch('/api/platform/integrations/:integrationKey/listings', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.updateListing)
            return reply.code(404).send({ error: 'Integration not found or does not support updateListing' });
        return plugin.updateListing(request.body);
    });
    app.post('/api/platform/integrations/:integrationKey/listings/pause', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.pauseListing)
            return reply.code(404).send({ error: 'Integration not found or does not support pauseListing' });
        return plugin.pauseListing(request.body);
    });
    app.post('/api/platform/integrations/:integrationKey/listings/relist', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.relistItem)
            return reply.code(404).send({ error: 'Integration not found or does not support relistItem' });
        return plugin.relistItem(request.body);
    });
    app.delete('/api/platform/integrations/:integrationKey/listings', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.deleteListing)
            return reply.code(404).send({ error: 'Integration not found or does not support deleteListing' });
        return plugin.deleteListing(request.body);
    });
    app.post('/api/platform/integrations/:integrationKey/inventory/sync', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.syncInventory)
            return reply.code(404).send({ error: 'Integration not found or does not support inventory sync' });
        return plugin.syncInventory(request.body);
    });
    app.post('/api/platform/integrations/:integrationKey/pricing/sync', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.syncPricing)
            return reply.code(404).send({ error: 'Integration not found or does not support pricing sync' });
        return plugin.syncPricing(request.body);
    });
    app.post('/api/platform/integrations/:integrationKey/orders/sync', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'support'])] }, async (request, reply) => {
        const { integrationKey } = request.params;
        const plugin = plugin_manager_1.pluginManager.get(integrationKey);
        if (!plugin?.syncOrders)
            return reply.code(404).send({ error: 'Integration not found or does not support order sync' });
        return plugin.syncOrders();
    });
    app.post('/api/platform/ebay/scraper/competitors', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request) => {
        const body = request.body;
        return (0, plugin_1.runIntelligentCompetitorScraper)({ keyword: body.keyword, maxPages: body.maxPages || 3 });
    });
    app.post('/api/platform/automation/evaluate', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request) => {
        const actions = await (0, rule_engine_1.evaluateAutomationRules)(request.body);
        return { actions };
    });
    app.get('/api/platform/listings', { preHandler: [auth_1.authGuard] }, async (request) => {
        const { channel, limit } = (request.query || {});
        if (channel) {
            return (0, pg_1.query)('SELECT * FROM channel_listings WHERE channel = $1 ORDER BY updated_at DESC LIMIT $2', [channel, Number(limit || 100)]);
        }
        return (0, pg_1.query)('SELECT * FROM channel_listings ORDER BY updated_at DESC LIMIT $1', [Number(limit || 100)]);
    });
    app.post('/api/platform/listings', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async (request) => {
        const body = request.body;
        const rows = await (0, pg_1.query)(`INSERT INTO channel_listings(product_id, channel, external_listing_id, status, price, quantity, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(channel, external_listing_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         status = EXCLUDED.status,
         price = EXCLUDED.price,
         quantity = EXCLUDED.quantity,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`, [
            body.product_id,
            body.channel,
            body.external_listing_id,
            body.status || 'active',
            Number(body.price || 0),
            Number(body.quantity || 0),
            JSON.stringify(body.metadata || {})
        ]);
        return rows[0];
    });
    app.post('/api/platform/admin/bootstrap-schema', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin'])] }, async () => {
        return (0, bootstrap_1.applySchema)();
    });
    app.post('/api/platform/admin/integrations/secrets', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin'])] }, async (request) => {
        const body = request.body;
        const cipher = (0, crypto_1.encryptSensitive)(body.secret_value);
        const rows = await (0, pg_1.query)(`INSERT INTO integration_secrets(integration_key, secret_name, secret_cipher)
       VALUES($1,$2,$3)
       ON CONFLICT(integration_key, secret_name)
       DO UPDATE SET secret_cipher = EXCLUDED.secret_cipher, updated_at = NOW()
       RETURNING integration_key, secret_name, created_at, updated_at`, [body.integration_key, body.secret_name, cipher]);
        return rows[0];
    });
    app.get('/api/platform/admin/integrations/secrets', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin'])] }, async () => {
        const rows = await (0, pg_1.query)('SELECT integration_key, secret_name, secret_cipher, updated_at FROM integration_secrets ORDER BY updated_at DESC');
        return rows.map((row) => ({
            integration_key: row.integration_key,
            secret_name: row.secret_name,
            updated_at: row.updated_at,
            preview: `${(0, crypto_1.decryptSensitive)(row.secret_cipher).slice(0, 4)}****`
        }));
    });
    app.get('/api/platform/admin/observability', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, async () => {
        const queueStats = await Promise.all(Object.entries(queue_1.queues).map(async ([name, queue]) => {
            const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
            return { name, counts };
        }));
        return {
            timestamp: new Date().toISOString(),
            integrations: plugin_manager_1.pluginManager.list(),
            queueStats
        };
    });
    app.get('/api/platform/admin/health', async () => ({ ok: true, module: 'platform' }));
}
