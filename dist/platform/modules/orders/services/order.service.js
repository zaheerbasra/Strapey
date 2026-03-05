"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const crypto_1 = require("crypto");
const pg_1 = require("../../../core/db/pg");
const queue_1 = require("../../../core/queue");
const rule_engine_1 = require("../../../core/automation/rule-engine");
class OrderService {
    async list(limit = 50) {
        return (0, pg_1.query)('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
    }
    async create(order) {
        const orderId = order.order_id || (0, crypto_1.randomUUID)();
        const rows = await (0, pg_1.query)(`INSERT INTO orders(order_id, channel, channel_order_id, customer, items, total_price, shipping_cost, tax, status, tracking_number, shipping_label)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)
       RETURNING *`, [
            orderId,
            order.channel,
            order.channel_order_id,
            JSON.stringify(order.customer || {}),
            JSON.stringify(order.items || []),
            Number(order.total_price || 0),
            Number(order.shipping_cost || 0),
            Number(order.tax || 0),
            order.status || 'pending',
            order.tracking_number || null,
            order.shipping_label || null
        ]);
        await (0, queue_1.enqueue)('shipping', 'shipping.label.generate', { order_id: orderId });
        await (0, rule_engine_1.evaluateAutomationRules)({
            newOrder: { order_id: orderId, channel: order.channel }
        });
        return rows[0];
    }
    async updateStatus(orderId, status, trackingNumber) {
        const rows = await (0, pg_1.query)(`UPDATE orders SET status=$2, tracking_number = COALESCE($3, tracking_number), updated_at = NOW() WHERE order_id=$1 RETURNING *`, [orderId, status, trackingNumber || null]);
        return rows[0] || null;
    }
}
exports.OrderService = OrderService;
