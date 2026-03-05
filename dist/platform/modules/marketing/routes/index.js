"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMarketingRoutes = registerMarketingRoutes;
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
const marketing_controller_1 = require("../controllers/marketing.controller");
async function registerMarketingRoutes(app) {
    app.get('/api/platform/marketing/campaigns', { preHandler: [auth_1.authGuard] }, marketing_controller_1.marketingController.list);
    app.post('/api/platform/marketing/campaigns', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'marketing'])] }, marketing_controller_1.marketingController.create);
}
