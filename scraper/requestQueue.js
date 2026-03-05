/**
 * Request Queue Manager
 * Manages request queue with concurrency limiting and rate control
 */

class RequestQueue {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = config.concurrency.maxConcurrent;
    this.processing = false;
    this.paused = false;
    this.lastRequestTime = {};
    this.throttled = false;
    this.throttleMultiplier = 1;
  }

  add(task) {
    this.queue.push(task);
    if (!this.processing) {
      this.process();
    }
  }

  async process() {
    this.processing = true;

    while (this.queue.length > 0 || this.activeRequests > 0) {
      // Check if paused (due to rate limiting)
      if (this.paused) {
        await this.sleep(1000);
        continue;
      }

      // Process tasks while under concurrency limit
      while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
        const task = this.queue.shift();
        this.executeTask(task);
      }

      // Wait a bit before checking queue again
      await this.sleep(100);
    }

    this.processing = false;
  }

  async executeTask(task) {
    this.activeRequests++;

    try {
      // Apply delay before request
      await this.applyDelay(task.url);

      // Execute the task
      const startTime = Date.now();
      const result = await task.fn();
      const duration = Date.now() - startTime;

      // Update last request time for domain
      this.updateLastRequestTime(task.url);

      // Call success callback
      if (task.onSuccess) {
        task.onSuccess(result, duration);
      }
    } catch (error) {
      // Call error callback
      if (task.onError) {
        task.onError(error);
      }
    } finally {
      this.activeRequests--;
    }
  }

  async applyDelay(url) {
    const delay = this.calculateDelay(url);
    if (delay > 0) {
      this.logger.debug(`Applying delay: ${delay}ms`, { url });
      await this.sleep(delay);
    }
  }

  calculateDelay(url) {
    const baseDelay = this.getRandomDelay(
      this.config.delays.minDelay,
      this.config.delays.maxDelay
    );

    // Apply throttle multiplier if system is throttled
    const throttledDelay = baseDelay * this.throttleMultiplier;

    // Check if we need domain-specific delay
    const domain = this.extractDomain(url);
    const lastRequestTime = this.lastRequestTime[domain];

    if (lastRequestTime) {
      const timeSinceLastRequest = Date.now() - lastRequestTime;
      const domainDelay = this.config.delays.domainDelay;

      if (timeSinceLastRequest < domainDelay) {
        const additionalDelay = domainDelay - timeSinceLastRequest;
        return throttledDelay + additionalDelay;
      }
    }

    return throttledDelay;
  }

  getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return 'unknown';
    }
  }

  updateLastRequestTime(url) {
    const domain = this.extractDomain(url);
    this.lastRequestTime[domain] = Date.now();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  pause(duration) {
    this.paused = true;
    this.logger.logThrottling(`Pausing for ${duration}ms`);

    setTimeout(() => {
      this.paused = false;
      this.logger.info('Resuming request processing');
    }, duration);
  }

  enableThrottling(multiplier = 2) {
    this.throttled = true;
    this.throttleMultiplier = multiplier;
    this.logger.logThrottling(`Delays multiplied by ${multiplier}x`);
  }

  disableThrottling() {
    this.throttled = false;
    this.throttleMultiplier = 1;
    this.logger.info('Throttling disabled');
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      paused: this.paused,
      throttled: this.throttled,
      throttleMultiplier: this.throttleMultiplier,
    };
  }

  clear() {
    this.queue = [];
    this.logger.info('Queue cleared');
  }
}

module.exports = RequestQueue;
