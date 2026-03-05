"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productController = void 0;
const product_service_1 = require("../services/product.service");
const service = new product_service_1.ProductService();
exports.productController = {
    list: async (request) => {
        const { limit } = (request.query || {});
        return service.list(Number(limit || 50));
    },
    getById: async (request) => {
        const { productId } = request.params;
        return service.getById(productId);
    },
    create: async (request) => service.create(request.body),
    update: async (request) => {
        const { productId } = request.params;
        return service.update(productId, request.body);
    }
};
