/**
 * Scraper Module Index
 * Exports all scraper components
 */

const ScraperOrchestrator = require('./orchestrator');
const config = require('./config');

// Export main orchestrator and config
module.exports = {
  ScraperOrchestrator,
  config,
  
  // Convenience function to create a new scraper instance
  createScraper: (customConfig = {}) => {
    return new ScraperOrchestrator(customConfig);
  },
};
