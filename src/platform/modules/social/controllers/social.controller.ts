import { FastifyRequest } from 'fastify';
import { SocialService } from '../services/social.service';

const service = new SocialService();

export const socialController = {
	list: async (request: FastifyRequest) => {
		const { limit } = (request.query || {}) as { limit?: string };
		return service.list(Number(limit || 50));
	},
	create: async (request: FastifyRequest) => service.createPost(request.body as any)
};
