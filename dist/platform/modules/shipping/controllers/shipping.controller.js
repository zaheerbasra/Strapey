"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shippingController = void 0;
const shipping_service_1 = require("../services/shipping.service");
const service = new shipping_service_1.ShippingService();
exports.shippingController = {
    generateLabel: async (request) => {
        const { orderId } = request.params;
        const body = request.body;
        return service.generateLabel(orderId, body?.carrier || 'ShipStation');
    }
};
