"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOrderRoutes = registerOrderRoutes;
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
const order_controller_1 = require("../controllers/order.controller");
async function registerOrderRoutes(app) {
    app.get('/api/platform/orders', { preHandler: [auth_1.authGuard] }, order_controller_1.orderController.list);
    app.post('/api/platform/orders', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'support'])] }, order_controller_1.orderController.create);
    app.patch('/api/platform/orders/:orderId/status', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'support'])] }, order_controller_1.orderController.updateStatus);
}
