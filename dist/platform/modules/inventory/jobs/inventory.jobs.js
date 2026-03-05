"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueInventorySync = enqueueInventorySync;
const queue_1 = require("../../../core/queue");
async function enqueueInventorySync(channel, sku, quantity) {
    return (0, queue_1.enqueue)('listingSync', 'inventory.sync', { channel, sku, quantity });
}
