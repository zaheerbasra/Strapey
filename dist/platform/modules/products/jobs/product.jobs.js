"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueuePriceOptimizationJob = enqueuePriceOptimizationJob;
const queue_1 = require("../../../core/queue");
async function enqueuePriceOptimizationJob(productId) {
    return (0, queue_1.enqueue)('listingSync', 'product.price.optimize', { productId });
}
