import { enqueue } from '../../../core/queue';
import { query } from '../../../core/db/pg';

export class ShippingService {
  async generateLabel(orderId: string, carrier = 'ShipStation') {
    const labelUrl = `label://${carrier.toLowerCase()}/${orderId}`;
    const rows = await query('UPDATE orders SET shipping_label = $2, status = $3, updated_at = NOW() WHERE order_id = $1 RETURNING *', [orderId, labelUrl, 'processing']);
    return rows[0] || null;
  }

  async enqueueAutoLabel(orderId: string) {
    return enqueue('shipping', 'shipping.label.generate', { orderId });
  }
}
