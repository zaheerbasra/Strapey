# Strapey - Complete Documentation

## Table of Contents
1. [Project Overview](#project-overview)
2. [Getting Started](#getting-started)
3. [Architecture](#architecture)
4. [Deployment](#deployment)
5. [Operations Guide](#operations-guide)
6. [WordPress Integration](#wordpress-integration)
7. [eBay Integration](#ebay-integration)
8. [Database & Schema](#database--schema)
9. [Troubleshooting](#troubleshooting)

---

## Project Overview

**Strapey** is a centralized brand operations platform with multi-channel commerce orchestration. It consists of:

1. **Express Backend** (port 3001): Web scraping, eBay API integration, publishing orchestration
2. **Fastify Platform** (port 4000): Enterprise TypeScript-based system for managing products, orders, inventory, shipping, marketing, and social media across multiple channels

### Key Features
- Multi-channel product synchronization (eBay, WooCommerce, Etsy, social media)
- Intelligent bulk publishing with circuit breaker pattern
- Real-time inventory management
- Audit logging and data protection
- GraphQL API (Mercurius)
- Background job processing (BullMQ + Redis)

---

## Getting Started

### Prerequisites
- **Node.js**: v18+
- **TypeScript**: 5.6+
- **PostgreSQL**: 14+ (for enterprise platform)
- **Redis**: 6+ (for job queues)
- **npm**: Latest version

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials:
# - WordPress: WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD
# - WooCommerce: WC_CONSUMER_KEY, WC_CONSUMER_SECRET
# - eBay: EBAY_SANDBOX_CLIENT_ID, EBAY_PROD_REFRESH_TOKEN, etc.
# - Network: FAST_PIPELINE=true (optional)

# Compile Platform TypeScript (if needed)
npm run platform:build
```

### Development

**Backend (Express - port 3001):**
```bash
npm start              # Production mode
npm run dev           # Development with nodemon
```

**Frontend/Platform (Fastify - port 4000):**
```bash
npm run platform:dev    # Development mode with auto-reload (tsx watch)
npm run platform:start  # Production mode (requires dist/ compiled)
```

### Quick Health Check

```bash
# Backend health
curl http://localhost:3001/api/runtime/environment

# Frontend health  
curl http://localhost:4000/

# GraphQL endpoint
curl -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ products { sku } }"}'
```

---

## Architecture

### 6-Layer Pattern (Platform)

```
Controllers → Services → Routes → Models → Jobs → Utils
```

### Directory Structure

```
src/
├── platform/              # Enterprise Fastify platform
│   ├── main.ts           # Entry point
│   ├── controllers/       # HTTP request handlers
│   ├── services/         # Business logic
│   ├── routes/           # Route definitions
│   ├── models/           # Data structures (Zod schemas)
│   ├── jobs/             # Background job handlers
│   ├── database/         # Schema, migrations
│   ├── core/             # DB, cache, queue, auth
│   └── integrations/     # eBay, WooCommerce, Etsy plugins
├── modules/              # Legacy Express modules
│   ├── products/
│   ├── orders/
│   └── ...
├── utils/                # Shared utilities
└── integrations/         # Express integration adapters
```

### Key Technologies

| Purpose | Technology |
|---------|-----------|
| Web Frameworks | Express 4.18, Fastify 5.0 |
| Language | TypeScript 5.6, Node.js 18+ |
| Database | PostgreSQL 14+ |
| Cache/Queue | Redis 6+ + BullMQ |
| GraphQL | Mercurius |
| Authentication | JWT + bcryptjs |
| Security | AES-256-GCM encryption, RBAC |
| API Integrations | Axios (connection pooling) |
| Web Scraping | Cheerio, Axios |
| Logging | Pino |

---

## Deployment

### Environment Modes

**Stage (Sandbox):**
```bash
curl -X PUT http://localhost:3001/api/runtime/environment \
  -H 'Content-Type: application/json' \
  -d '{"mode":"stage"}' \
  -w '\n' | jq '.mode'
```
- Uses eBay Sandbox API
- Uses WooCommerce test environment
- Safe for development/testing

**Production:**
```bash
curl -X PUT http://localhost:3001/api/runtime/environment \
  -H 'Content-Type: application/json' \
  -d '{"mode":"prod"}' \
  -w '\n' | jq '.mode'
```
- Uses eBay Production API
- Uses live WooCommerce instance
- Requires proper eBay OAuth tokens and merchant location setup

### Pre-Flight Checks

Before publishing to production:

```bash
curl -X POST http://localhost:3001/publish-ebay/preflight \
  -H 'Content-Type: application/json' \
  -d '{}' | jq '{success, environment, auth, configuration, policies}'
```

Expected successful response includes:
- `environment`: prod
- `auth`: true (valid OAuth tokens)
- `configuration`: true (merchant location, shipping policies, return policies)
- `policies`: true (all required policies configured)

### Warehouse Setup (Production)

Before publishing to eBay production, register a merchant location:

```bash
curl -X POST http://localhost:3001/api/warehouse/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"Default Warehouse",
    "country":"US",
    "state":"TX",
    "city":"Houston",
    "postalCode":"77001"
  }'
```

---

## Operations Guide

### Bulk Publishing

**Validate Data:**
```bash
curl -X POST http://localhost:3001/publish-ebay/validate-bulk \
  -H 'Content-Type: application/json' \
  -d '{}' | jq '{totalProducts, publishable, percentReady}'
```

**Start Bulk Publish (Stage):**
```bash
curl -X POST http://localhost:3001/publish-ebay/bulk \
  -H 'Content-Type: application/json' \
  -d '{"limit":100,"dryRun":false}' | jq '.jobId'
```

**Monitor Job:**
```bash
JOB_ID="bulk-1772783828737-xxx"
curl http://localhost:3001/publish-ebay/bulk/$JOB_ID | \
  jq '.job | {status, progress, successCount, failureCount, recentErrors}'
```

### Product Query

**Get Single Product:**
```bash
curl http://localhost:3001/api/products/SKU_HERE | \
  jq '{sku, title, price, imageSourceUrls, categoryId}'
```

**Publish by Link (Production Mode):**
```bash
URL="https://example.com/product-page"
curl -X POST http://localhost:3001/publish-ebay \
  -H 'Content-Type: application/json' \
  -d "{\"link\":\"$URL\"}" | \
  jq '{success, sku, listingId, prodListingLink, errorDetails}'
```

### Runtime Configuration

**Check Current Mode:**
```bash
curl http://localhost:3001/api/runtime/environment | jq '{mode, serviceTargets}'
```

**Set Mode:**
```bash
# Switch to production
curl -X PUT http://localhost:3001/api/runtime/environment \
  -H 'Content-Type: application/json' \
  -d '{"mode":"prod"}'

# Switch back to stage
curl -X PUT http://localhost:3001/api/runtime/environment \
  -H 'Content-Type: application/json' \
  -d '{"mode":"stage"}'
```

---

## WordPress Integration

### Configuration

Set in `.env`:
```
WP_BASE_URL=https://strapey.com
WP_USERNAME=Care
WP_APP_PASSWORD=<your_password>
WC_CONSUMER_KEY=<key>
WC_CONSUMER_SECRET=<secret>
```

### Integration Features

The platform connects **WooCommerce REST API** to sync products, inventory, and orders:

- **Product Sync**: Automatic synchronization of eBay products to WordPress
- **Inventory Management**: Real-time stock level updates
- **Category Mapping**: Intelligent product grouping (pistol-parts, hunting-knives, kitchen-chef-sets, other)
- **Image Handling**: Batch image upload with CDN optimization
- **SEO Integration**: Product titles, descriptions, and meta optimization

### Product Grouping

Some product categories are **excluded from WordPress by default**:
- Pistol grips (category filter: `includePistolGrips: true` to override)

Groups are auto-mapped during scrape/import from `src/utils/product-grouping.js`.

### Endpoints

**Sync Products:**
```bash
curl -X POST http://localhost:3001/wordpress/sync \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":false}' | \
  jq '{success, synced, failed, errors}'
```

**Check Sync Status:**
```bash
curl http://localhost:3001/wordpress/status | jq '.'
```

---

## eBay Integration

### Authentication

**Sandbox (Stage):**
- Uses EBAY_SANDBOX_CLIENT_ID and refreshed tokens
- Less strict validation, useful for testing

**Production:**
- Uses EBAY_PROD_REFRESH_TOKEN (OAuth 3-legged)
- Requires valid merchant location
- Requires configured shipping/return policies

### Category Resolution

eBay requires category IDs. The platform:
1. Caches category lookups locally (500-item LRU cache)
2. Validates category IDs during preflight
3. Falls back to default category if needed

**Preflight will warn if categories are invalid.**

### Listing Publishing Flow

1. **Data Validation** → Check item has title, price, description, images
2. **Category Resolution** → Map product to eBay category ID
3. **Policy Validation** → Confirm shipping/return policies exist
4. **Image Upload** → Send images to eBay
5. **Create Listing** → POST to eBay API (stage or prod)
6. **Store Reference** → Save listing ID in data.json or database

### Common Publishing Issues

| Issue | Solution |
|-------|----------|
| `Missing category` | Run preflight check, add category mapping |
| `Invalid shipping policy` | Set up shipping policy in eBay app |
| `Image upload failed` | Verify image URLs are public/CDN-hosted |
| `Location not found` | Run warehouse setup endpoint (prod only) |
| `Auth timeout (60s)` | Check EBAY_PROD_REFRESH_TOKEN, may need refresh |

---

## Database & Schema

### PostgreSQL (Enterprise Platform)

Located at `src/platform/database/schema.sql`

Main tables:
- `products` — Product inventory
- `orders` — Order tracking
- `integrations` — Connected channels
- `audit_logs` — Change history (auto-logged)
- `background_jobs` — BullMQ job records

**Extension required:**
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### SQLite (Legacy/Prisma)

Default database for Express app (`prisma/strapey.db`).

Schema: `prisma/schema.prisma`

Main models:
- Product
- Listing
- Inventory

---

## Troubleshooting

### Backend Not Responding

**Check listening:**
```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

**Restart cleanly:**
```bash
pkill -f "node server.js" || true
npm start
```

**Check logs:**
```bash
tail -f /tmp/strapey_server.log
```

### Platform Not Responding

**Check listening:**
```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

**Restart:**
```bash
pkill -f "tsx watch" || true
npm run platform:dev
```

**Check logs:**
```bash
tail -f /tmp/strapey_frontend.log
```

### eBay Publishing Timeouts

**Issue:** Publishing hangs for 60+ seconds.

**Causes:**
- OAuth token invalid or expired
- eBay API rate limiting
- Network connectivity issue

**Solutions:**
1. Check token: `curl -X POST http://localhost:3001/publish-ebay/preflight -H 'Content-Type: application/json' -d '{}'`
2. Verify network: `curl https://api.ebay.com/`
3. Check logs: `tail -100 /tmp/strapey_server.log | grep -i ebay`
4. Restart backend: `pkill -f "node server.js" && npm start`

### WordPress Sync Failures

**Check connectivity:**
```bash
curl -u Care:$WP_APP_PASSWORD https://strapey.com/wp-json/wc/v3/products?per_page=1
```

**Common causes:**
- Invalid WP_APP_PASSWORD
- WordPress plugin disabled
- WooCommerce not active
- Cookie/session mismatch (use non-www canonical URL)

**Reset:**
1. Regenerate WooCommerce API keys in WordPress admin
2. Update .env
3. Restart backend

### Data Corruption

**JSON Parse Error in data.json:**

```bash
node -e "
const fs = require('fs');
const original = fs.readFileSync('data/data.json', 'utf8');
try { JSON.parse(original); console.log('VALID'); }
catch (e) {
  const m = String(e.message).match(/position \s+(\d+)/i);
  if (m) {
    const pos = Number(m[1]);
    let fixed = original.slice(0, pos).trimEnd();
    while (fixed.length > 0) {
      try { JSON.parse(fixed); 
        fs.writeFileSync('data/data.json.backup', original);
        fs.writeFileSync('data/data.json', fixed + '\n');
        console.log('REPAIRED at position ' + pos);
        process.exit(0);
      } catch (err) { fixed = fixed.slice(0, -1).trimEnd(); }
    }
  }
}
"
```

---

## Additional Resources

- **README.md** — Quick start and project overview
- **PLATFORM.md** — Detailed enterprise platform documentation
- **.env.example** — Environment variable template

---

**Last Updated:** March 10, 2026  
**Maintained by:** Strapey Team
