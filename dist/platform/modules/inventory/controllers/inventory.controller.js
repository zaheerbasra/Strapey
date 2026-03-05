"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inventoryController = void 0;
const inventory_service_1 = require("../services/inventory.service");
const service = new inventory_service_1.InventoryService();
exports.inventoryController = {
    lowStock: async (request) => {
        const { threshold } = (request.query || {});
        return service.listLowStock(Number(threshold || 5));
    },
    adjust: async (request) => {
        const { productId } = request.params;
        const body = request.body;
        return service.adjust(productId, Number(body.delta || 0));
    }
};
