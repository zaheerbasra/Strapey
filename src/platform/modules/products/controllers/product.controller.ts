import { FastifyRequest } from 'fastify';
import { ProductService } from '../services/product.service';

const service = new ProductService();

export const productController = {
  list: async (request: FastifyRequest) => {
    const { limit } = (request.query || {}) as { limit?: string };
    return service.list(Number(limit || 50));
  },
  getById: async (request: FastifyRequest) => {
    const { productId } = request.params as { productId: string };
    return service.getById(productId);
  },
  create: async (request: FastifyRequest) => service.create(request.body as any),
  update: async (request: FastifyRequest) => {
    const { productId } = request.params as { productId: string };
    return service.update(productId, request.body as any);
  }
};
