"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAnalyticsRoutes = registerAnalyticsRoutes;
const auth_1 = require("../../../core/security/auth");
const analytics_controller_1 = require("../controllers/analytics.controller");
async function registerAnalyticsRoutes(app) {
    app.get('/api/platform/analytics/dashboard', { preHandler: [auth_1.authGuard] }, analytics_controller_1.analyticsController.dashboard);
}
