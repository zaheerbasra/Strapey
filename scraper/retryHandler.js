/**
 * Retry Handler with Exponential Backoff
 * Provides intelligent retry logic for failed requests
 */

class RetryHandler {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.errorCounts = new Map();
  }

async executeWithRetry(fn, context = {}) {
    const { url, sku, maxRetries } = context;
    const retries = maxRetries || this.config.retry.maxRetries;
    let lastError;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        this.logger.logRequest(url, sku);
        const startTime = Date.now();
        const result = await fn();
        const duration = Date.now() - startTime;
        
        this.logger.logSuccess(url, sku, duration);
        this.clearErrorCount(url);
        return { success: true, data: result, attempts: attempt };
      } catch (error) {
        lastError = error;
        this.incrementErrorCount(url);

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          this.logger.error('Non-retryable error', { url, sku, error: error.message });
          throw error;
        }

        // If not last attempt, apply backoff and retry
        if (attempt <= retries) {
          const backoffDelay = this.calculateBackoff(attempt);
          this.logger.logRetry(url, sku, attempt, retries, error);
          await this.sleep(backoffDelay);
        }
      }
    }

    // All retries exhausted
    this.logger.logFailure(url, sku, lastError, retries + 1);
    return {
      success: false,
      error: lastError.message,
      attempts: retries + 1,
    };
  }

  isRetryable(error) {
    // Network errors are retryable
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // HTTP status code errors
    if (error.response && error.response.status) {
      const status = error.response.status;
      return this.config.retry.retryStatusCodes.includes(status);
    }

    // Timeout errors
    if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
      return true;
    }

    // Default: retry
    return true;
  }

  calculateBackoff(attempt) {
    const base = this.config.retry.exponentialBase;
    const initialDelay = this.config.delays.errorBackoff;
    const maxDelay = this.config.delays.maxBackoff;

    const backoff = initialDelay * Math.pow(base, attempt - 1);
    const jitter = Math.random() * 1000; // Add jitter to avoid thundering herd
    
    return Math.min(backoff + jitter, maxDelay);
  }

  incrementErrorCount(url) {
    const domain = this.extractDomain(url);
    const current = this.errorCounts.get(domain) || 0;
    this.errorCounts.set(domain, current + 1);
  }

  clearErrorCount(url) {
    const domain = this.extractDomain(url);
    this.errorCounts.delete(domain);
  }

  getErrorCount(url) {
    const domain = this.extractDomain(url);
    return this.errorCounts.get(domain) || 0;
  }

  shouldThrottle(url) {
    const errorCount = this.getErrorCount(url);
    return errorCount >= this.config.rateLimiting.errorThreshold;
  }

  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return 'unknown';
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reset() {
    this.errorCounts.clear();
  }

  getStats() {
    const stats = {};
    for (const [domain, count] of this.errorCounts.entries()) {
      stats[domain] = count;
    }
    return stats;
  }
}

module.exports = RetryHandler;
