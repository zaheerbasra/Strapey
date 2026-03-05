/**
 * SKU Mapper
 * Maps SKUs to URLs and results
 */

class SkuMapper {
  constructor(logger) {
    this.logger = logger;
    this.skuMap = new Map();
    this.results = new Map();
  }

  /**
   * Add SKU to URL mapping
   * @param {string} sku - SKU identifier
   * @param {string|string[]} urls - URL(s) to scrape for this SKU
   */
  addMapping(sku, urls) {
    const urlArray = Array.isArray(urls) ? urls : [urls];
    
    if (this.skuMap.has(sku)) {
      // Merge with existing URLs
      const existing = this.skuMap.get(sku);
      this.skuMap.set(sku, [...new Set([...existing, ...urlArray])]);
    } else {
      this.skuMap.set(sku, urlArray);
    }

    this.logger.debug(`Mapped SKU: ${sku} to ${urlArray.length} URL(s)`);
  }

  /**
   * Bulk add mappings
   * @param {Object} mappings - Object with SKU as key and URL(s) as value
   */
  addBulkMappings(mappings) {
    for (const [sku, urls] of Object.entries(mappings)) {
      this.addMapping(sku, urls);
    }
  }

  /**
   * Get URLs for a SKU
   * @param {string} sku
   * @returns {string[]}
   */
  getUrls(sku) {
    return this.skuMap.get(sku) || [];
  }

  /**
   * Get all SKUs
   * @returns {string[]}
   */
  getAllSkus() {
    return Array.from(this.skuMap.keys());
  }

  /**
   * Get total URL count
   * @returns {number}
   */
  getTotalUrlCount() {
    let count = 0;
    for (const urls of this.skuMap.values()) {
      count += urls.length;
    }
    return count;
  }

  /**
   * Store result for a URL under a SKU
   * @param {string} sku
   * @param {string} url
   * @param {Object} data
   */
  storeResult(sku, url, data) {
    if (!this.results.has(sku)) {
      this.results.set(sku, []);
    }

    const skuResults = this.results.get(sku);
    skuResults.push({
      url,
      data,
      scrapedAt: new Date().toISOString(),
    });

    this.logger.debug(`Stored result for SKU: ${sku}`, { url });
  }

  /**
   * Get all results for a SKU
   * @param {string} sku
   * @returns {Object[]}
   */
  getResults(sku) {
    return this.results.get(sku) || [];
  }

  /**
   * Get all results grouped by SKU
   * @returns {Object}
   */
  getAllResults() {
    const output = {};
    for (const [sku, results] of this.results.entries()) {
      output[sku] = results;
    }
    return output;
  }

  /**
   * Convert results to flat format (URL-keyed)
   * @returns {Object}
   */
  getResultsFlat() {
    const output = {};
    
    for (const [sku, results] of this.results.entries()) {
      for (const result of results) {
        output[result.url] = {
          ...result.data,
          sku,  // Add SKU to the data
        };
      }
    }
    
    return output;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    const stats = {
      totalSkus: this.skuMap.size,
      totalUrls: this.getTotalUrlCount(),
      scrapedSkus: this.results.size,
      scrapedListings: 0,
    };

    for (const results of this.results.values()) {
      stats.scrapedListings += results.length;
    }

    stats.successRate = stats.totalUrls > 0 
      ? ((stats.scrapedListings / stats.totalUrls) * 100).toFixed(2) + '%'
      : '0%';

    return stats;
  }

  /**
   * Clear all mappings and results
   */
  clear() {
    this.skuMap.clear();
    this.results.clear();
    this.logger.info('SKU mapper cleared');
  }
}

module.exports = SkuMapper;
