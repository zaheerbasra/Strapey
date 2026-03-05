"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
function requireRole(allowed) {
    return async (request, reply) => {
        const user = request.user;
        if (!user?.role || !allowed.includes(user.role)) {
            return reply.code(403).send({ error: 'Forbidden', requiredRoles: allowed });
        }
    };
}
