/**
 * Scraper Configuration
 * All runtime parameters for the eBay scraping system
 */

module.exports = {
  // Request timing and delays
  delays: {
    minDelay: 2000,        // Minimum delay between requests (ms)
    maxDelay: 7000,        // Maximum delay between requests (ms)
    domainDelay: 10000,    // Additional delay for same-domain requests (ms)
    errorBackoff: 5000,    // Initial backoff delay on error (ms)
    maxBackoff: 120000,    // Maximum backoff delay (ms)
  },

  // Retry configuration
  retry: {
    maxRetries: 3,         // Maximum retry attempts per request
    retryStatusCodes: [408, 429, 500, 502, 503, 504], // HTTP status codes to retry
    exponentialBase: 2,    // Exponential backoff multiplier
  },

  // Concurrency control
  concurrency: {
    maxConcurrent: 3,      // Maximum concurrent requests
    queueTimeout: 300000,  // Queue processing timeout (ms)
  },

  // Anti-blocking
  antiBlocking: {
    userAgents: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    ],
    rotateUserAgent: true,
    detectBlocking: true,
    blockingIndicators: [
      'captcha',
      'robot',
      'automated',
      'verify you are human',
      'access denied',
      'rate limit',
    ],
  },

  // Browser configuration
  browser: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: {
      width: 1920,
      height: 1080,
    },
  },

  // Output configuration
  output: {
    dataPath: './data/data.json',
    backupPath: './data/backups',
    logPath: './data/logs',
    imagePath: './data',
  },

  // Data validation
  validation: {
    requiredFields: ['url', 'itemNumber', 'title'],
    fallbackValues: {
      price: null,
      description: 'N/A',
      images: [],
      availableQuantity: 'N/A',
      format: 'Buy It Now',
      currency: 'USD',
    },
  },

  // Logging
  logging: {
    level: 'info', // debug, info, warn, error
    logFile: true,
    consoleLog: true,
    detailedErrors: true,
  },

  // Rate limiting detection
  rateLimiting: {
    enabled: true,
    errorThreshold: 3,     // Number of errors before auto-throttling
    throttleMultiplier: 2, // Multiply delays by this factor when throttled
    cooldownPeriod: 60000, // Wait period after detecting rate limiting (ms)
  },
};
