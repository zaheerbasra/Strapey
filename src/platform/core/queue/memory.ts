export type Job = {
  id: string;
  name: string;
  data: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
};
/**
 * In-memory job queue implementation
 * Replaces BullMQ for development/testing without Redis dependency
 */

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
}

interface QueueOptions {
  attempts?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  backoff?: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
}

class MemoryQueue {
  private queue: Map<string, Job> = new Map();
  private jobCounter = 0;
  private processors: Map<string, (job: Job) => Promise<unknown>> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(private name: string) {
    // Start processing jobs periodically
    this.processingInterval = setInterval(() => this.processJobs(), 100);
  }

  async add(
    jobName: string,
    data: unknown,
    options?: QueueOptions
  ): Promise<Job> {
    const id = `${this.name}-${++this.jobCounter}`;
    const job: Job = {
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

  on(eventName: string, handler: (job: Job) => void): void {
    // Simplified event handling
    if (eventName === 'process') {
      // This is handled by the processor registration
    }
  }

  process(
    jobName: string,
    processor: (job: Job) => Promise<unknown>
  ): void {
    this.processors.set(jobName, processor);
  }

  private async processJobs(): Promise<void> {
    for (const [id, job] of Array.from(this.queue.entries())) {
      if (job.status !== 'pending') continue;

      const processor = this.processors.get(job.name);
      if (!processor) continue;

      job.status = 'processing';
      try {
        job.result = await processor(job);
        job.status = 'completed';
        job.processedAt = new Date();
        // Remove completed job from queue
        this.queue.delete(id);
      } catch (error) {
        job.attempts++;
        if (job.attempts >= job.maxAttempts) {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          // Keep failed job in queue for debugging
        } else {
          // Reset to pending for retry
          job.status = 'pending';
          // Exponential backoff delay
          await new Promise((resolve) => setTimeout(resolve, 100 * job.attempts));
        }
      }
    }
  }

  getJobs(status?: Job['status']): Job[] {
    return Array.from(this.queue.values()).filter(
      (job) => !status || job.status === status
    );
  }

  async close(): Promise<void> {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.queue.clear();
    this.processors.clear();
  }
}

export const queues = {
  scraping: new MemoryQueue('scraping'),
  orderSync: new MemoryQueue('order-sync'),
  listingSync: new MemoryQueue('listing-sync'),
  shipping: new MemoryQueue('shipping'),
  marketing: new MemoryQueue('marketing'),
  social: new MemoryQueue('social'),
};

export async function enqueue(
  queueName: keyof typeof queues,
  name: string,
  payload: unknown,
  opts: QueueOptions = {}
): Promise<Job> {
  return queues[queueName].add(name, payload, opts);
}

export function createWorker(
  queueName: keyof typeof queues,
  processor: (job: Job) => Promise<unknown>
): void {
  queues[queueName].process('*', processor);
}
