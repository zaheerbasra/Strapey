"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueOrderSync = enqueueOrderSync;
const queue_1 = require("../../../core/queue");
async function enqueueOrderSync(channel) {
    return (0, queue_1.enqueue)('orderSync', 'orders.sync.channel', { channel });
}
