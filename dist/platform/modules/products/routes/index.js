"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProductRoutes = registerProductRoutes;
const product_controller_1 = require("../controllers/product.controller");
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
async function registerProductRoutes(app) {
    app.get('/api/platform/products', { preHandler: [auth_1.authGuard] }, product_controller_1.productController.list);
    app.get('/api/platform/products/:productId', { preHandler: [auth_1.authGuard] }, product_controller_1.productController.getById);
    app.post('/api/platform/products', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, product_controller_1.productController.create);
    app.put('/api/platform/products/:productId', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, product_controller_1.productController.update);
}
