# 🚀 Enterprise-Grade eBay Scraper with SKU Mapping

A production-ready, highly reliable eBay scraping system with advanced features including SKU mapping, intelligent retry logic, anti-blocking measures, and comprehensive error handling.

## ✨ Features

### 🛡️ High Reliability
- **Never crashes**: Robust error handling ensures one failed request doesn't break the entire job
- **Exponential backoff**: Intelligent retry logic with configurable attempts
- **Detailed logging**: Every request, retry, and failure is logged with full context

### 🎭 Anti-Blocking Strategy
- **Randomized delays**: Mimics human behavior (2-7 seconds configurable)
- **Domain-specific throttling**: Additional delays for same-domain requests
- **User agent rotation**: Multiple browser identities
- **Bot detection**: Automatically detects and responds to rate limiting
- **Stealth mode**: Browser automation masking

### 🎯 Request Control
- **Concurrency limiting**: Maximum concurrent requests (default: 3)
- **Request queue**: Intelligent queue management
- **Auto-throttling**: Automatically slows down when detecting rate limits
- **Cooldown periods**: Pauses scraping when blocks are detected

### 🏷️ SKU Mapping
- **SKU-to-URL mapping**: Associate every scraped listing with its originating SKU
- **Bulk operations**: Process hundreds or thousands of SKUs
- **Flexible mapping**: One SKU can map to multiple URLs
- **Results tracking**: Complete traceability from SKU to scraped data

### 📊 Structured Output
- **JSON format**: Clean, structured data in `data.json`
- **Deduplication**: Automatic removal of duplicate listings
- **Data validation**: Validates and fills missing fields
- **Multiple formats**: Export to CSV, JSONL, or JSON
- **Automatic backups**: Creates backups before overwriting

### 📈 Scalability
- **Batch processing**: Handle thousands of SKUs efficiently
- **Queue management**: Processes large workloads reliably
- **Memory efficient**: Streaming approach for large datasets

### 🔍 Observability
- **Comprehensive logging**: Requests, retries, delays, errors, successes
- **File and console logs**: Dual output for monitoring
- **Statistics tracking**: Success rates, timing, error counts
- **Detailed error reports**: Full stack traces when needed

## 📁 Architecture

```
scraper/
├── config.js           # Configuration settings
├── logger.js           # Logging module
├── requestQueue.js     # Queue and concurrency control
├── retryHandler.js     # Retry logic with exponential backoff
├── scraperEngine.js    # Core Puppeteer scraping engine
├── skuMapper.js        # SKU to URL mapping
├── outputWriter.js     # Data persistence and export
├── orchestrator.js     # Main coordinator
└── index.js            # Public API

data/
├── data.json           # Main output file
├── backups/            # Automatic backups
├── logs/               # Log files
└── [hash]/             # Downloaded images by item
```

## 🚀 Quick Start

### Installation

```bash
npm install puppeteer
```

### Basic Usage

```javascript
const { createScraper } = require('./scraper');

async function main() {
  const scraper = createScraper();

  // Add SKUs with their eBay URLs
  scraper.addSku('KNIFE-001', 'https://www.ebay.com/itm/302710852493');
  scraper.addSku('KNIFE-002', 'https://www.ebay.com/itm/304053796929');

  // Run the scraper
  const results = await scraper.run();

  // Save to data.json
  scraper.saveResults();

  console.log('Success rate:', results.stats.successRate);
}

main();
```

### Bulk Import

```javascript
const scraper = createScraper();

const skuMappings = {
  'PROD-001': 'https://www.ebay.com/itm/302710852493',
  'PROD-002': 'https://www.ebay.com/itm/304053796929',
  'PROD-003': [
    'https://www.ebay.com/itm/305449960570',
    'https://www.ebay.com/itm/304569312160',
  ],
};

scraper.addBulkSkus(skuMappings);
await scraper.run();
scraper.saveResults();
```

## ⚙️ Configuration

All parameters are configurable in `scraper/config.js`:

```javascript
const scraper = createScraper({
  delays: {
    minDelay: 3000,        // Min delay between requests (ms)
    maxDelay: 8000,        // Max delay between requests (ms)
    domainDelay: 15000,    // Additional delay for same domain
    errorBackoff: 5000,    // Initial error backoff delay
  },
  concurrency: {
    maxConcurrent: 3,      // Max concurrent requests
  },
  retry: {
    maxRetries: 3,         // Max retry attempts
  },
  rateLimiting: {
    errorThreshold: 3,     // Errors before auto-throttling
    throttleMultiplier: 2, // Delay multiplier when throttled
    cooldownPeriod: 60000, // Wait period after rate limit
  },
  logging: {
    level: 'info',         // debug, info, warn, error
    logFile: true,
    consoleLog: true,
  },
});
```

## 📖 API Reference

### ScraperOrchestrator

#### Methods

##### `addSku(sku, url)`
Add a single SKU with its URL(s)
```javascript
scraper.addSku('PROD-001', 'https://www.ebay.com/itm/123456');
scraper.addSku('PROD-002', ['url1', 'url2']); // Multiple URLs
```

##### `addBulkSkus(mappings)`
Add multiple SKUs at once
```javascript
scraper.addBulkSkus({
  'SKU1': 'url1',
  'SKU2': ['url2', 'url3'],
});
```

##### `run()`
Start scraping all queued SKUs
```javascript
const results = await scraper.run();
```

Returns:
```javascript
{
  success: true,
  stats: {
    duration: '45.23s',
    totalTasks: 10,
    successful: 9,
    failed: 1,
    successRate: '90.00%',
    totalSkus: 5,
    totalUrls: 10,
  },
  data: { /* scraped data keyed by URL */ },
  errors: [ /* array of error objects */ ]
}
```

##### `saveResults(merge = true)`
Save results to data.json
```javascript
scraper.saveResults();        // Merge with existing
scraper.saveResults(false);   // Overwrite existing
```

##### `export(format, path)`
Export data to different formats
```javascript
scraper.export('csv', './export.csv');
scraper.export('jsonl', './export.jsonl');
scraper.export('json', './export.json');
```

##### `reset()`
Reset scraper state for new batch
```javascript
scraper.reset();
```

## 📝 Output Format

### data.json Structure

```json
{
  "https://www.ebay.com/itm/302710852493": {
    "url": "https://www.ebay.com/itm/302710852493",
    "itemNumber": "302710852493",
    "sku": "KNIFE-001",
    "customLabel": "KNIFE-001",
    "title": "10X2 HAND FORGED DAMASCUS STEEL...",
    "price": 28.49,
    "description": "Item description from the seller",
    "images": [],
    "availableQuantity": "N/A",
    "format": "Buy It Now",
    "currency": "USD",
    "startPrice": 29.99,
    "variationDetails": {},
    "itemSpecifics": {
      "Blade Material": "Damascus Steel",
      "Brand": "SHARD",
      "Type": "Hunting"
    },
    "imagesOriginal": [
      "data/1c5a3d92ab0acb2de9dcd15ee5ae5eb0/image_0.webp",
      "data/1c5a3d92ab0acb2de9dcd15ee5ae5eb0/image_1.webp"
    ],
    "lastUpdated": "2026-03-05T12:34:56.789Z"
  }
}
```

## 🔧 Advanced Usage

### Error Handling

```javascript
const results = await scraper.run();

if (results.errors.length > 0) {
  console.log('Errors occurred:');
  results.errors.forEach(error => {
    console.log(`SKU ${error.sku}: ${error.error}`);
  });
}

// Still save successful results
scraper.saveResults();
```

### Custom Retry Logic

```javascript
const scraper = createScraper({
  retry: {
    maxRetries: 5,
    retryStatusCodes: [408, 429, 500, 502, 503, 504],
    exponentialBase: 2,
  },
  delays: {
    errorBackoff: 10000,    // Wait 10s before first retry
    maxBackoff: 300000,     // Max 5 minutes backoff
  },
});
```

### Processing from CSV File

```javascript
const fs = require('fs');

// sku-list.csv format:
// SKU,URL
// PROD-001,https://www.ebay.com/itm/123
// PROD-002,https://www.ebay.com/itm/456

const content = fs.readFileSync('./sku-list.csv', 'utf8');
const lines = content.split('\n').slice(1); // Skip header

const mappings = {};
lines.forEach(line => {
  const [sku, url] = line.split(',').map(s => s.trim());
  if (sku && url) mappings[sku] = url;
});

scraper.addBulkSkus(mappings);
await scraper.run();
scraper.saveResults();
```

### Incremental Scraping

```javascript
// Day 1: Scrape batch 1
scraper.addBulkSkus(batch1);
await scraper.run();
scraper.saveResults(merge = true);

scraper.reset();

// Day 2: Scrape batch 2
scraper.addBulkSkus(batch2);
await scraper.run();
scraper.saveResults(merge = true); // Merges with Day 1 data
```

## 📊 Logging

Logs are saved to `data/logs/scraper-YYYY-MM-DD.log`

Example log entry:
```json
{
  "timestamp": "2026-03-05T12:34:56.789Z",
  "level": "INFO",
  "message": "Request successful",
  "url": "https://www.ebay.com/itm/302710852493",
  "sku": "KNIFE-001",
  "duration": "2345ms"
}
```

## 🛡️ Anti-Blocking Best Practices

1. **Use Reasonable Delays**: 2-7 seconds between requests
2. **Limit Concurrency**: Max 3-5 concurrent requests
3. **Monitor Error Rates**: Auto-throttling activates at threshold
4. **Respect Rate Limits**: System automatically backs off
5. **Rotate User Agents**: Enabled by default
6. **Run During Off-Peak**: Less likely to trigger rate limits

## 🚨 Error Handling

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `Timeout` | Slow network or page | Increase retry count |
| `Access denied` | Rate limiting | Increase delays, reduce concurrency |
| `Captcha detected` | Bot detection | System auto-throttles, manual intervention may be needed |
| `Element not found` | Page structure changed | Update selectors in scraperEngine.js |

## 🎯 Production Deployment

### Recommended Settings

```javascript
const scraper = createScraper({
  delays: {
    minDelay: 4000,
    maxDelay: 8000,
    domainDelay: 15000,
  },
  concurrency: {
    maxConcurrent: 3,
  },
  retry: {
    maxRetries: 4,
  },
  rateLimiting: {
    enabled: true,
    errorThreshold: 2,
    throttleMultiplier: 3,
    cooldownPeriod: 120000,
  },
});
```

### Monitoring

Check logs for patterns:
```bash
grep "ERROR" data/logs/scraper-$(date +%Y-%m-%d).log
grep "Throttling" data/logs/scraper-$(date +%Y-%m-%d).log
```

## 📚 Examples

See `examples.js` for 8 comprehensive examples:

1. Basic Usage
2. Bulk SKU Import
3. Custom Configuration
4. Error Handling
5. Export to Different Formats
6. Processing from File
7. Incremental Scraping
8. Production Usage

Run examples:
```bash
node examples.js
```

## 🤝 Contributing

This is a production-ready system. Contributions welcome!

## 📄 License

MIT

## 🔗 Integration with Strapey

This scraper integrates seamlessly with the existing Strapey eBay publishing system:

1. **Scrape products** → Save to `data/data.json`
2. **Use SKU mappings** → Track inventory
3. **Publish to eBay** → Use existing API endpoints

Complete workflow:
```javascript
// 1. Scrape competitor listings
const scraper = createScraper();
scraper.addBulkSkus(competitorSkus);
await scraper.run();
scraper.saveResults();

// 2. Load scraped data
const data = require('./data/data.json');

// 3. Publish to your eBay account
// (Use existing Strapey endpoints)
```

---

**Built with ❤️ for reliable, scalable eBay scraping**
