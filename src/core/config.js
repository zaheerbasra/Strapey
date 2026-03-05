/**
 * Application Configuration
 * Centralized configuration management
 */

require('dotenv').config();

module.exports = {
  // Server - Use port 3000 for new simplified app (old server uses 3001)
  port: 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // eBay API
  ebay: {
    env: process.env.EBAY_ENV || 'sandbox',
    clientId: process.env.EBAY_CLIENT_ID,
    clientSecret: process.env.EBAY_CLIENT_SECRET,
    refreshToken: process.env.EBAY_REFRESH_TOKEN,
    redirectUri: process.env.EBAY_REDIRECT_URI,
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
    paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
    returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
    categoryId: process.env.EBAY_CATEGORY_ID || '179776',
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    locationKey: process.env.EBAY_LOCATION_KEY || 'default',
    useEpsImages: process.env.EBAY_USE_EPS_IMAGES === 'true'
  },

  // Storage
  storage: {
    dataDir: './data',
    imagesDir: './data/images',
    labelsDir: './data/labels',
    scrapedDir: './data/scraped'
  },

  // Scraper
  scraper: {
    delayMin: 2000,
    delayMax: 5000,
    maxRetries: 3,
    timeout: 30000
  }
};
