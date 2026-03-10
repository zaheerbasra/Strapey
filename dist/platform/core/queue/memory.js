"use strict";
/**
 * In-memory job queue implementation
 * Replaces BullMQ for development/testing without Redis dependency
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.queues = void 0;
exports.enqueue = enqueue;
exports.createWorker = createWorker;
class MemoryQueue {
    name;
    queue = new Map();
    jobCounter = 0;
    processors = new Map();
    processingInterval = null;
    constructor(name) {
        this.name = name;
        // Start processing jobs periodically
        this.processingInterval = setInterval(() => this.processJobs(), 100);
    }
    async add(jobName, data, options) {
        const id = `${this.name}-${++this.jobCounter}`;
        const job = {
            id,
            name: jobName,
            data,
            status: 'pending',
            attempts: 0,
            maxAttempts: options?.attempts || 5,
            createdAt: new Date(),
        };
        this.queue.set(id, job);
        return job;
    }
    on(eventName, handler) {
        // Simplified event handling
        if (eventName === 'process') {
            // This is handled by the processor registration
        }
    }
    process(jobName, processor) {
        this.processors.set(jobName, processor);
    }
    async processJobs() {
        for (const [id, job] of Array.from(this.queue.entries())) {
            if (job.status !== 'pending')
                continue;
            const processor = this.processors.get(job.name);
            if (!processor)
                continue;
            job.status = 'processing';
            try {
                job.result = await processor(job);
                job.status = 'completed';
                job.processedAt = new Date();
                // Remove completed job from queue
                this.queue.delete(id);
            }
            catch (error) {
                job.attempts++;
                if (job.attempts >= job.maxAttempts) {
                    job.status = 'failed';
                    job.error = error instanceof Error ? error.message : String(error);
                    // Keep failed job in queue for debugging
                }
                else {
                    // Reset to pending for retry
                    job.status = 'pending';
                    // Exponential backoff delay
                    await new Promise((resolve) => setTimeout(resolve, 100 * job.attempts));
                }
            }
        }
    }
    getJobs(status) {
        return Array.from(this.queue.values()).filter((job) => !status || job.status === status);
    }
    async close() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        this.queue.clear();
        this.processors.clear();
    }
}
exports.queues = {
    scraping: new MemoryQueue('scraping'),
    orderSync: new MemoryQueue('order-sync'),
    listingSync: new MemoryQueue('listing-sync'),
    shipping: new MemoryQueue('shipping'),
    marketing: new MemoryQueue('marketing'),
    social: new MemoryQueue('social'),
};
async function enqueue(queueName, name, payload, opts = {}) {
    return exports.queues[queueName].add(name, payload, opts);
}
function createWorker(queueName, processor) {
    exports.queues[queueName].process('*', processor);
}
