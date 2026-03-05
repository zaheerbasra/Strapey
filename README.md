# Strapey - Complete eBay Scraping & Publishing Platform

A production-ready Node.js platform for scraping eBay listings and publishing to your eBay store. Features enterprise-grade reliability, SKU mapping, anti-blocking measures, and comprehensive error handling.

## 🌟 Features

### 🔍 **Advanced Web Scraping**
- **SKU Mapping**: Associate scraped listings with your SKUs
- **Batch Processing**: Scrape hundreds or thousands of listings
- **Anti-Blocking**: Randomized delays, user agent rotation, bot detection evasion
- **Intelligent Retries**: Exponential backoff with configurable attempts
- **Comprehensive Logging**: Track every request, retry, and failure
- **Data Validation**: Automatic deduplication and field validation
- **Multiple Export Formats**: JSON, CSV, JSONL

### 🚀 **eBay Publishing**
- **Web UI**: Simple interface for scraping and publishing
- **API Endpoints**: RESTful API for automation
- **Business Policies**: Automated fulfillment, payment, and return policies
- **OAuth Integration**: Secure authentication with eBay
- **Category Management**: Smart category assignment
- **Image Handling**: Automatic image downloading and storage

### 🛡️ **Production Ready**
- **Never Crashes**: Robust error handling throughout
- **Auto-Throttling**: Responds automatically to rate limiting
- **Request Queue**: Manages concurrency and prevents overload
- **Backup System**: Automatic backups before data changes
- **Observability**: Detailed logs for debugging and monitoring

## 📦 Installation

```bash
# Clone repository
git clone https://github.com/yourusername/strapey.git
cd strapey

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your eBay credentials
```

## ⚙️ Configuration

Create a `.env` file with your eBay credentials:

```env
# eBay API Configuration
EBAY_ENV=sandbox                    # or 'production'
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_REFRESH_TOKEN=your_refresh_token
EBAY_REDIRECT_URI=your_runame

# Business Policy IDs (create via eBay Developer Console)
EBAY_FULFILLMENT_POLICY_ID=123456789
EBAY_PAYMENT_POLICY_ID=123456789
EBAY_RETURN_POLICY_ID=123456789

# Optional Settings
EBAY_CATEGORY_ID=179776            # Default category (Fixed Blade Knives)
EBAY_LOCATION_KEY=default
EBAY_MARKETPLACE_ID=EBAY_US
```

### 🔐 Getting eBay Credentials

1. **Create Developer Account**: Visit [eBay Developers Program](https://developer.ebay.com)
2. **Create Application**: Get your App ID (Client ID) and Cert ID (Client Secret)
3. **Generate RuName**: Create a redirect URI name in Application Settings
4. **OAuth Consent**: Authorize with scopes: `sell.inventory`, `sell.account`, `sell.fulfillment`
5. **Get Refresh Token**: Exchange authorization code for refresh token

See [eBay OAuth Documentation](https://developer.ebay.com/api-docs/static/oauth-tokens.html) for detailed instructions.

## 🚀 Quick Start

### Option 1: Web Interface

```bash
npm start
```

Open http://localhost:3001 and:
1. Enter eBay URLs (one per line)
2. Click "Scrape" to fetch listing data
3. Review scraped listings
4. Click "Publish to eBay" to create listings

### Option 2: Enterprise Scraper (Programmatic)

```javascript
const { createScraper } = require('./scraper');

async function main() {
  const scraper = createScraper();

  // Add SKU mappings
  scraper.addSku('KNIFE-001', 'https://www.ebay.com/itm/302710852493');
  scraper.addSku('KNIFE-002', 'https://www.ebay.com/itm/304053796929');

  // Run scraper
  const results = await scraper.run();

  // Save to data.json
  scraper.saveResults();

  console.log(`Success: ${results.stats.successRate}`);
}

main();
```

### Option 3: REST API

```bash
# Scrape listings
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://www.ebay.com/itm/302710852493"]}'

# Publish to eBay
curl -X POST http://localhost:3001/api/ebay-create-test-listing \
  -H "Content-Type: application/json"
```

## 📚 Documentation

### Project Structure

```
strapey/
├── scraper/                    # Enterprise scraper module
│   ├── config.js              # Configuration settings
│   ├── logger.js              # Logging module
│   ├── requestQueue.js        # Queue management
│   ├── retryHandler.js        # Retry logic
│   ├── scraperEngine.js       # Core scraping engine
│   ├── skuMapper.js           # SKU mapping
│   ├── outputWriter.js        # Data persistence
│   ├── orchestrator.js        # Main coordinator
│   └── index.js               # Public API
├── server.js                   # Express server with eBay API
├── public/
│   └── index.html             # Web UI
├── data/
│   ├── data.json              # Scraped listing data
│   ├── backups/               # Automatic backups
│   ├── logs/                  # Log files
│   └── [item-hash]/           # Downloaded images
├── examples.js                 # 8 usage examples
├── SCRAPER_README.md          # Detailed scraper docs
└── README.md                  # This file
```

### Core Components

#### 1. Enterprise Scraper (`/scraper`)

Production-grade scraping system with:
- **Config Management**: All parameters configurable
- **Logging**: Structured logs to files and console
- **Request Queue**: Concurrency control and intelligent delays
- **Retry Handler**: Exponential backoff with jitter
- **Scraper Engine**: Puppeteer-based with anti-blocking
- **SKU Mapper**: Map results to originating SKUs
- **Output Writer**: Save, backup, deduplicate data
- **Orchestrator**: Coordinates all components

See [SCRAPER_README.md](SCRAPER_README.md) for detailed documentation.

#### 2. Express Server (`server.js`)

REST API with endpoints:
- `POST /scrape`: Scrape eBay URLs
- `POST /api/ebay-create-test-listing`: Create business policies
- `POST /api/ebay-publish`: Publish listing to eBay

#### 3. Web UI (`public/index.html`)

Simple interface for:
- Entering eBay URLs
- Viewing scraped data
- Publishing to eBay

## 🎯 Usage Examples

### Example 1: Basic Scraping

```javascript
const { createScraper } = require('./scraper');

const scraper = createScraper();
scraper.addSku('PROD-001', 'https://www.ebay.com/itm/302710852493');
await scraper.run();
scraper.saveResults();
```

### Example 2: Bulk Import

```javascript
const mappings = {
  'KNIFE-001': 'https://www.ebay.com/itm/302710852493',
  'KNIFE-002': 'https://www.ebay.com/itm/304053796929',
  'KNIFE-003': [
    'https://www.ebay.com/itm/305449960570',
    'https://www.ebay.com/itm/304569312160',
  ],
};

scraper.addBulkSkus(mappings);
await scraper.run();
scraper.saveResults();
```

### Example 3: Custom Configuration

```javascript
const scraper = createScraper({
  delays: {
    minDelay: 5000,
    maxDelay: 10000,
  },
  concurrency: {
    maxConcurrent: 2,
  },
  retry: {
    maxRetries: 5,
  },
});
```

### Example 4: Export to CSV

```javascript
const results = await scraper.run();
scraper.saveResults();
scraper.export('csv', './export.csv');
```

### Example 5: Process from File

```javascript
const fs = require('fs');

// Load SKUs from CSV
const content = fs.readFileSync('./sku-list.csv', 'utf8');
const lines = content.split('\n').slice(1);

const mappings = {};
lines.forEach(line => {
  const [sku, url] = line.split(',').map(s => s.trim());
  if (sku && url) mappings[sku] = url;
});

scraper.addBulkSkus(mappings);
await scraper.run();
scraper.saveResults();
```

See `examples.js` for 8 comprehensive examples.

## 🔧 Advanced Configuration

### Scraper Settings

```javascript
const config = {
  delays: {
    minDelay: 2000,           // Min delay between requests (ms)
    maxDelay: 7000,           // Max delay between requests (ms)
    domainDelay: 10000,       // Additional delay for same domain
    errorBackoff: 5000,       // Initial error backoff
    maxBackoff: 120000,       // Max backoff duration
  },
  retry: {
    maxRetries: 3,            // Max retry attempts
    retryStatusCodes: [408, 429, 500, 502, 503, 504],
    exponentialBase: 2,       // Backoff multiplier
  },
  concurrency: {
    maxConcurrent: 3,         // Max concurrent requests
    queueTimeout: 300000,     // Queue timeout (5 min)
  },
  antiBlocking: {
    userAgents: [...],        // Rotating user agents
    rotateUserAgent: true,
    detectBlocking: true,
  },
  rateLimiting: {
    errorThreshold: 3,        // Errors before throttling
    throttleMultiplier: 2,    // Delay multiplier
    cooldownPeriod: 60000,    // Cooldown duration
  },
};
```

### Production Deployment

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
  logging: {
    level: 'info',
    logFile: true,
  },
});
```

## 📊 Output Format

### data.json Structure

```json
{
  "https://www.ebay.com/itm/302710852493": {
    "url": "https://www.ebay.com/itm/302710852493",
    "itemNumber": "302710852493",
    "sku": "KNIFE-001",
    "title": "10X2 HAND FORGED DAMASCUS STEEL...",
    "price": 28.49,
    "currency": "USD",
    "images": [],
    "itemSpecifics": {
      "Blade Material": "Damascus Steel",
      "Brand": "SHARD"
    },
    "imagesOriginal": [
      "data/1c5a3d92ab0acb2de9dcd15ee5ae5eb0/image_0.webp"
    ],
    "lastUpdated": "2026-03-05T12:34:56.789Z"
  }
}
```

## 🔍 Logging & Monitoring

Logs are saved to `data/logs/scraper-YYYY-MM-DD.log`

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

Check logs:
```bash
# View today's logs
tail -f data/logs/scraper-$(date +%Y-%m-%d).log

# Check for errors
grep "ERROR" data/logs/scraper-*.log

# Monitor throttling
grep "Throttling" data/logs/scraper-*.log
```

## 🛡️ Error Handling

### Common Issues

| Error | Cause | Solution |
|-------|-------|----------|
| `Timeout` | Slow network | Increase retry count |
| `Access denied` | Rate limiting | Increase delays |
| `Captcha detected` | Bot detection | System auto-throttles |
| `Invalid OAuth token` | Expired token | Refresh token via OAuth |

### Retry Logic

The system automatically retries failed requests with exponential backoff:

```
Attempt 1: 5s delay
Attempt 2: 10s delay  (5 * 2^1)
Attempt 3: 20s delay  (5 * 2^2)
```

## 🚀 API Reference

### REST Endpoints

#### POST /scrape
Scrape eBay URLs

**Request:**
```json
{
  "urls": [
    "https://www.ebay.com/itm/302710852493",
    "https://www.ebay.com/itm/304053796929"
  ]
}
```

**Response:**
```json
{
  "success": true,
  "items": [...]
}
```

#### POST /api/ebay-create-test-listing
Create business policies and test listing

**Response:**
```json
{
  "success": true,
  "listingUrl": "https://sandbox.ebay.com/itm/110589128082"
}
```

## 🧪 Testing

### Test with Sandbox

```env
EBAY_ENV=sandbox
```

### Create Test Listing

```bash
curl -X POST http://localhost:3001/api/ebay-create-test-listing
```

## 🔐 Security Best Practices

- ✅ Never commit `.env` files
- ✅ Use environment variables for secrets
- ✅ Rotate tokens regularly
- ✅ Use sandbox for testing
- ✅ Monitor rate limits
- ✅ Keep dependencies updated

## 📈 Performance

### Recommended Settings

- **Max Concurrent**: 3-5 requests
- **Delays**: 2-7 seconds between requests
- **Retries**: 3-4 attempts
- **Timeout**: 5 minutes per batch

### Scalability

The system can handle:
- ✅ Thousands of SKUs
- ✅ Multiple concurrent batches
- ✅ Long-running scraping jobs
- ✅ Large datasets (GB+ of data)

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

- 📖 [Detailed Scraper Docs](SCRAPER_README.md)
- 📝 [Examples](examples.js)
- 🐛 [Issues](https://github.com/yourusername/strapey/issues)
- 📧 Email: support@strapey.com

## 🙏 Acknowledgments

Built with:
- [Puppeteer](https://pptr.dev/) - Headless browser automation
- [Express](https://expressjs.com/) - Web framework
- [eBay API](https://developer.ebay.com/) - Listing management

---

**Made with ❤️ for reliable eBay automation**