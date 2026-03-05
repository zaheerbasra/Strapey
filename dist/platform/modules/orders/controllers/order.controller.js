"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderController = void 0;
const order_service_1 = require("../services/order.service");
const service = new order_service_1.OrderService();
exports.orderController = {
    list: async (request) => {
        const { limit } = (request.query || {});
        return service.list(Number(limit || 50));
    },
    create: async (request) => service.create(request.body),
    updateStatus: async (request) => {
        const { orderId } = request.params;
        const body = request.body;
        return service.updateStatus(orderId, body.status, body.tracking_number);
    }
};
