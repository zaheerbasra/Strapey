import { FastifyRequest } from 'fastify';
import { ShippingService } from '../services/shipping.service';

const service = new ShippingService();

export const shippingController = {
  generateLabel: async (request: FastifyRequest) => {
    const { orderId } = request.params as { orderId: string };
    const body = request.body as { carrier?: string };
    return service.generateLabel(orderId, body?.carrier || 'ShipStation');
  }
};
