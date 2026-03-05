/**
 * Scraper Orchestrator
 * Main controller that coordinates all scraping components
 */

const config = require('./config');
const Logger = require('./logger');
const RequestQueue = require('./requestQueue');
const RetryHandler = require('./retryHandler');
const ScraperEngine = require('./scraperEngine');
const SkuMapper = require('./skuMapper');
const OutputWriter = require('./outputWriter');

class ScraperOrchestrator {
  constructor(customConfig = {}) {
    this.config = { ...config, ...customConfig };
    this.logger = new Logger(this.config);
    this.queue = new RequestQueue(this.config, this.logger);
    this.retryHandler = new RetryHandler(this.config, this.logger);
    this.scraper = new ScraperEngine(this.config, this.logger, this.retryHandler);
    this.skuMapper = new SkuMapper(this.logger);
    this.outputWriter = new OutputWriter(this.config, this.logger);
    
    this.stats = {
      startTime: null,
      endTime: null,
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      errors: [],
    };
  }

  /**
   * Add SKU with associated URL(s) to scraping queue
   * @param {string} sku - SKU identifier
   * @param {string|string[]} urls - URL(s) to scrape for this SKU
   */
  addSku(sku, urls) {
    this.skuMapper.addMapping(sku, urls);
  }

  /**
   * Add multiple SKUs at once
   * @param {Object} skuMappings - Object with SKU as key and URL(s) as value
   */
  addBulkSkus(skuMappings) {
    this.skuMapper.addBulkMappings(skuMappings);
  }

  /**
   * Start scraping all queued SKUs
   * @returns {Promise<Object>} - Scraping results and statistics
   */
  async run() {
    this.stats.startTime = Date.now();
    const skus = this.skuMapper.getAllSkus();
    
    if (skus.length === 0) {
      this.logger.warn('No SKUs to process');
      return this.getResults();
    }

    this.logger.info(`Starting scraper with ${skus.length} SKU(s)`);
    await this.scraper.initialize();

    // Process each SKU
    for (const sku of skus) {
      await this.processSku(sku);
    }

    // Wait for queue to complete
    await this.waitForQueueCompletion();

    await this.scraper.close();
    this.stats.endTime = Date.now();

    return this.getResults();
  }

  /**
   * Process all URLs for a given SKU
   * @param {string} sku
   */
  async processSku(sku) {
    const urls = this.skuMapper.getUrls(sku);
    this.logger.info(`Processing SKU: ${sku} with ${urls.length} URL(s)`);

    for (const url of urls) {
      this.stats.totalTasks++;

      this.queue.add({
        url,
        fn: async () => await this.scrapeUrl(url, sku),
        onSuccess: (result, duration) => this.handleSuccess(url, sku, result, duration),
        onError: (error) => this.handleError(url, sku, error),
      });
    }
  }

  /**
   * Scrape a single URL
   * @param {string} url
   * @param {string} sku
   */
  async scrapeUrl(url, sku) {
    const result = await this.scraper.scrapeEbayListing(url, sku);

    // Check if we should throttle based on error rate
    if (this.retryHandler.shouldThrottle(url)) {
      this.logger.logThrottling('High error rate detected');
      this.queue.enableThrottling(this.config.rateLimiting.throttleMultiplier);
      this.queue.pause(this.config.rateLimiting.cooldownPeriod);
    }

    return result;
  }

  /**
   * Handle successful scrape
   */
  handleSuccess(url, sku, result, duration) {
    if (result.success) {
      this.stats.successfulTasks++;
      this.skuMapper.storeResult(sku, url, result.data);
      this.logger.logSkuMapping(sku, 1);
    } else {
      this.stats.failedTasks++;
      this.stats.errors.push({
        url,
        sku,
        error: result.error,
        attempts: result.attempts,
      });
    }
  }

  /**
   * Handle scraping error
   */
  handleError(url, sku, error) {
    this.stats.failedTasks++;
    this.stats.errors.push({
      url,
      sku,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    this.logger.error('Task failed', { url, sku, error: error.message });
  }

  /**
   * Wait for request queue to complete
   */
  async waitForQueueCompletion() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const queueStats = this.queue.getStats();
        
        if (queueStats.queueLength === 0 && queueStats.activeRequests === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);

      // Timeout after configured duration
      setTimeout(() => {
        clearInterval(checkInterval);
        this.logger.warn('Queue completion timeout reached');
        resolve();
      }, this.config.concurrency.queueTimeout);
    });
  }

  /**
   * Save results to data.json
   * @param {boolean} merge - Whether to merge with existing data
   */
  saveResults(merge = true) {
    const data = this.skuMapper.getResultsFlat();
    const deduplicated = this.outputWriter.deduplicate(data);
    return this.outputWriter.save(deduplicated, merge);
  }

  /**
   * Get results and statistics
   * @returns {Object}
   */
  getResults() {
    const duration = this.stats.endTime 
      ? (this.stats.endTime - this.stats.startTime) / 1000 
      : 0;

    const results = {
      success: this.stats.failedTasks === 0,
      stats: {
        duration: `${duration.toFixed(2)}s`,
        totalTasks: this.stats.totalTasks,
        successful: this.stats.successfulTasks,
        failed: this.stats.failedTasks,
        successRate: this.stats.totalTasks > 0 
          ? ((this.stats.successfulTasks / this.stats.totalTasks) * 100).toFixed(2) + '%'
          : '0%',
        ...this.skuMapper.getStats(),
      },
      data: this.skuMapper.getResultsFlat(),
      errors: this.stats.errors,
    };

    this.logger.logSummary(results.stats);
    return results;
  }

  /**
   * Export results in different formats
   * @param {string} format - 'json', 'csv', 'jsonl'
   * @param {string} outputPath
   */
  export(format, outputPath) {
    const data = this.skuMapper.getResultsFlat();
    return this.outputWriter.export(data, format, outputPath);
  }

  /**
   * Reset scraper state
   */
  reset() {
    this.skuMapper.clear();
    this.queue.clear();
    this.retryHandler.reset();
    this.stats = {
      startTime: null,
      endTime: null,
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      errors: [],
    };
    this.logger.info('Scraper reset');
  }
}

module.exports = ScraperOrchestrator;
