"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShippingRoutes = registerShippingRoutes;
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
const shipping_controller_1 = require("../controllers/shipping.controller");
async function registerShippingRoutes(app) {
    app.post('/api/platform/shipping/orders/:orderId/labels', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'support'])] }, shipping_controller_1.shippingController.generateLabel);
}
