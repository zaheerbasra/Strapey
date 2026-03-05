import { FastifyRequest } from 'fastify';
import { OrderService } from '../services/order.service';

const service = new OrderService();

export const orderController = {
  list: async (request: FastifyRequest) => {
    const { limit } = (request.query || {}) as { limit?: string };
    return service.list(Number(limit || 50));
  },
  create: async (request: FastifyRequest) => service.create(request.body as any),
  updateStatus: async (request: FastifyRequest) => {
    const { orderId } = request.params as { orderId: string };
    const body = request.body as { status: string; tracking_number?: string };
    return service.updateStatus(orderId, body.status, body.tracking_number);
  }
};
