"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queues = void 0;
exports.enqueue = enqueue;
exports.createWorker = createWorker;
const bullmq_1 = require("bullmq");
// Use plain Redis connection config to avoid ioredis version conflicts
const connectionOpts = {
    host: '127.0.0.1',
    port: 6379
};
exports.queues = {
    scraping: new bullmq_1.Queue('scraping', { connection: connectionOpts }),
    orderSync: new bullmq_1.Queue('order-sync', { connection: connectionOpts }),
    listingSync: new bullmq_1.Queue('listing-sync', { connection: connectionOpts }),
    shipping: new bullmq_1.Queue('shipping', { connection: connectionOpts }),
    marketing: new bullmq_1.Queue('marketing', { connection: connectionOpts }),
    social: new bullmq_1.Queue('social', { connection: connectionOpts })
};
const defaultOptions = {
    attempts: 5,
    removeOnComplete: 200,
    removeOnFail: 500,
    backoff: {
        type: 'exponential',
        delay: 1000
    }
};
async function enqueue(queueName, name, payload, opts = {}) {
    return exports.queues[queueName].add(name, payload, { ...defaultOptions, ...opts });
}
function createWorker(queueName, processor) {
    return new bullmq_1.Worker(queueName, processor, { connection: connectionOpts });
}
