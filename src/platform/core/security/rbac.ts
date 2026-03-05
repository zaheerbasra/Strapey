import { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '../../types/domain';

export function requireRole(allowed: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user as { role?: UserRole } | undefined;
    if (!user?.role || !allowed.includes(user.role)) {
      return reply.code(403).send({ error: 'Forbidden', requiredRoles: allowed });
    }
  };
}
