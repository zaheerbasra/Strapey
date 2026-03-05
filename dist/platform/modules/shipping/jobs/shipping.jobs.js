"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShippingWorkers = registerShippingWorkers;
const queue_1 = require("../../../core/queue");
const shipping_service_1 = require("../services/shipping.service");
const service = new shipping_service_1.ShippingService();
function registerShippingWorkers() {
    return (0, queue_1.createWorker)('shipping', async (job) => {
        if (job.name === 'shipping.label.generate') {
            const payload = job.data;
            const orderId = payload.orderId || payload.order_id;
            if (!orderId)
                return;
            await service.generateLabel(orderId, payload.carrier || 'ShipStation');
        }
    });
}
