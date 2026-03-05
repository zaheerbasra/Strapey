"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSocialModuleRoutes = registerSocialModuleRoutes;
const auth_1 = require("../../../core/security/auth");
const rbac_1 = require("../../../core/security/rbac");
const social_controller_1 = require("../controllers/social.controller");
async function registerSocialModuleRoutes(app) {
    app.get('/api/platform/social/posts', { preHandler: [auth_1.authGuard] }, social_controller_1.socialController.list);
    app.post('/api/platform/social/posts', { preHandler: [auth_1.authGuard, (0, rbac_1.requireRole)(['admin', 'manager', 'marketing'])] }, social_controller_1.socialController.create);
}
