import { FastifyRequest } from 'fastify';
import { MarketingService } from '../services/marketing.service';

const service = new MarketingService();

export const marketingController = {
  list: async (request: FastifyRequest) => {
    const { limit } = (request.query || {}) as { limit?: string };
    return service.listCampaigns(Number(limit || 50));
  },
  create: async (request: FastifyRequest) => service.createCampaign(request.body as any)
};
