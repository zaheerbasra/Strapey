"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPlatformApp = buildPlatformApp;
const fastify_1 = __importDefault(require("fastify"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const cors_1 = __importDefault(require("@fastify/cors"));
const sensible_1 = __importDefault(require("@fastify/sensible"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const env_1 = require("./config/env");
const register_routes_1 = require("./core/http/register-routes");
const schema_1 = require("./core/graphql/schema");
const integrations_1 = require("./integrations");
const shipping_jobs_1 = require("./modules/shipping/jobs/shipping.jobs");
const marketing_jobs_1 = require("./modules/marketing/jobs/marketing.jobs");
const audit_service_1 = require("./core/audit/audit.service");
async function buildPlatformApp() {
    const app = (0, fastify_1.default)({
        logger: {
            level: env_1.env.nodeEnv === 'production' ? 'info' : 'debug'
        }
    });
    await app.register(helmet_1.default);
    await app.register(cors_1.default, { origin: true });
    await app.register(sensible_1.default);
    await app.register(jwt_1.default, { secret: env_1.env.jwtSecret });
    await app.register(rate_limit_1.default, {
        max: env_1.env.apiRateLimitMax,
        timeWindow: env_1.env.apiRateLimitWindow
    });
    (0, integrations_1.registerIntegrations)();
    (0, shipping_jobs_1.registerShippingWorkers)();
    (0, marketing_jobs_1.registerMarketingWorkers)();
    await (0, schema_1.registerGraphql)(app);
    await (0, register_routes_1.registerRoutes)(app);
    app.addHook('onResponse', async (request, reply) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
            return;
        if (!request.url.startsWith('/api/platform'))
            return;
        const user = request.user;
        try {
            await (0, audit_service_1.logAudit)({
                actor_id: user?.sub || 'system',
                action: `${request.method} ${request.url}`,
                resource_type: 'api',
                metadata: {
                    statusCode: reply.statusCode
                }
            });
        }
        catch {
            app.log.warn('Audit log write failed');
        }
    });
    return app;
}
