import { FastifyRequest } from 'fastify';
import { InventoryService } from '../services/inventory.service';

const service = new InventoryService();

export const inventoryController = {
  lowStock: async (request: FastifyRequest) => {
    const { threshold } = (request.query || {}) as { threshold?: string };
    return service.listLowStock(Number(threshold || 5));
  },
  adjust: async (request: FastifyRequest) => {
    const { productId } = request.params as { productId: string };
    const body = request.body as { delta: number };
    return service.adjust(productId, Number(body.delta || 0));
  }
};
