"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShippingService = void 0;
const queue_1 = require("../../../core/queue");
const pg_1 = require("../../../core/db/pg");
class ShippingService {
    async generateLabel(orderId, carrier = 'ShipStation') {
        const labelUrl = `label://${carrier.toLowerCase()}/${orderId}`;
        const rows = await (0, pg_1.query)('UPDATE orders SET shipping_label = $2, status = $3, updated_at = NOW() WHERE order_id = $1 RETURNING *', [orderId, labelUrl, 'processing']);
        return rows[0] || null;
    }
    async enqueueAutoLabel(orderId) {
        return (0, queue_1.enqueue)('shipping', 'shipping.label.generate', { orderId });
    }
}
exports.ShippingService = ShippingService;
