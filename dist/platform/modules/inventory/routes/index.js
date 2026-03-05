"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerInventoryRoutes = registerInventoryRoutes;
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
const inventory_controller_1 = require("../controllers/inventory.controller");
async function registerInventoryRoutes(app) {
    app.get('/api/platform/inventory/low-stock', { preHandler: [auth_1.authGuard] }, inventory_controller_1.inventoryController.lowStock);
    app.patch('/api/platform/inventory/:productId/adjust', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager'])] }, inventory_controller_1.inventoryController.adjust);
}
