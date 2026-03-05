import { createWorker } from '../../../core/queue';
import { ShippingService } from '../services/shipping.service';

const service = new ShippingService();

export function registerShippingWorkers() {
  return createWorker('shipping', async (job) => {
    if (job.name === 'shipping.label.generate') {
      const payload = job.data as { orderId?: string; order_id?: string; carrier?: string };
      const orderId = payload.orderId || payload.order_id;
      if (!orderId) return;
      await service.generateLabel(orderId, payload.carrier || 'ShipStation');
    }
  });
}
