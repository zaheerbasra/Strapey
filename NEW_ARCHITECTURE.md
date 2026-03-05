# Strapey v2.0 - Centralized Commerce Management Platform

## Overview

A **simple, local-first** commerce management system rebuilt from the ground up with:
- ✅ SQLite database (single file, no server needed)
- ✅ Prisma ORM (type-safe queries)
- ✅ Modular Express architecture
- ✅ Simple node-cron scheduler
- ✅ RESTful API for all operations

## What Was Built

### 1. Database Schema (SQLite + Prisma)

**9 Core Tables:**

- **Product** - Central product catalog (single source of truth)
- **Listing** - Marketplace listings (eBay, Etsy, WooCommerce)
- **Order** - Unified order management
- **OrderItem** - Line items in orders
- **Shipment** - Shipping labels and tracking
- **Campaign** - Marketing campaigns and promotions
- **ScrapedListing** - Competitor analysis data
- **ActivityLog** - System activity logs

**Location:** `prisma/strapey.db`

### 2. Modular Architecture

```
src/
├── core/                    # Core infrastructure
│   ├── config.js           # Configuration management
│   ├── database.js         # Prisma client singleton
│   └── logger.js           # File-based logging
│
├── modules/                 # Feature modules
│   ├── products/           # Product catalog
│   │   ├── products.service.js
│   │   ├── products.controller.js
│   │   └── products.routes.js
│   ├── listings/           # Marketplace listings
│   │   ├── listings.service.js
│   │   ├── listings.controller.js
│   │   └── listings.routes.js
│   ├── orders/             # Order management
│   │   ├── orders.service.js
│   │   ├── orders.controller.js
│   │   └── orders.routes.js
│   ├── shipping/           # (Placeholder)
│   ├── marketing/          # (Placeholder)
│   └── scraping/           # (Placeholder)
│
├── integrations/           # Channel integrations
│   └── ebay/              # (To migrate)
│
├── services/              # Background services
│   └── scheduler.js       # Cron job scheduler
│
└── app.js                 # Main Express application
```

### 3. REST API

**Base URL:** `http://localhost:3000/api`

#### Products API

```bash
GET    /api/products              # List products (with filters)
GET    /api/products/:id          # Get product by ID
GET    /api/products/sku/:sku     # Get product by SKU
GET    /api/products/low-stock    # Get low stock products
POST   /api/products              # Create product
PATCH  /api/products/:id          # Update product
DELETE /api/products/:id          # Delete product
POST   /api/products/:id/inventory # Update inventory
```

#### Listings API

```bash
GET    /api/listings              # List listings (with filters)
GET    /api/listings/active       # Get active listings
GET    /api/listings/:id          # Get listing by ID
GET    /api/listings/product/:id  # Get listings for product
POST   /api/listings              # Create listing
PATCH  /api/listings/:id          # Update listing
DELETE /api/listings/:id          # Delete listing
POST   /api/listings/:id/status   # Update listing status
POST   /api/listings/:id/sync-quantity # Sync with product inventory
```

#### Orders API

```bash
GET    /api/orders                # List orders (with filters)
GET    /api/orders/new            # Get new orders (pending)
GET    /api/orders/:id            # Get order by ID
POST   /api/orders                # Create order
POST   /api/orders/:id/status     # Update order status
```

### 4. Background Job Scheduler

Simple cron-based scheduler for:
- Order synchronization from marketplaces
- Inventory sync across channels
- Competitor price scraping
- Automated marketing campaigns

**Usage:**

```javascript
const scheduler = require('./services/scheduler');

// Run every 10 minutes
scheduler.scheduleJob('order-sync', '*/10 * * * *', async () => {
  // Sync orders from eBay
});

// Run every hour
scheduler.scheduleJob('inventory-sync', '0 * * * *', async () => {
  // Sync inventory
});
```

### 5. Core Infrastructure

**Database:** Prisma Client (auto-generated)
```javascript
const prisma = require('./core/database');

// Type-safe queries
const products = await prisma.product.findMany({
  where: { inventory: { lte: 5 } },
  include: { listings: true }
});
```

**Logger:** File-based structured logging
```javascript
const logger = require('./core/logger')('module-name');

logger.info('Operation completed', { productId: '123' });
logger.error('Operation failed', { error: err.message });
```

**Config:** Centralized environment configuration
```javascript
const config = require('./core/config');

console.log(config.ebay.clientId);
console.log(config.storage.dataDir);
```

## Quick Start

### Prerequisites

- Node.js v18+
- npm

### Installation

```bash
# Database is already setup!
# Prisma generated and SQLite DB created at: prisma/strapey.db

# Start the new application
npm run app

# Or with auto-reload
npm run app:dev
```

Server runs on **http://localhost:3000**

### Test the API

```bash
# Health check
curl http://localhost:3000/health

# List products
curl http://localhost:3000/api/products

# Create a product
curl -X POST http://localhost:3000/api/products \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "TEST-001",
    "title": "Test Product",
    "price": 29.99,
    "inventory": 10,
    "images": ["https://example.com/image.jpg"]
  }'

# Create a listing
curl -X POST http://localhost:3000/api/listings \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "PRODUCT_ID_HERE",
    "channel": "ebay",
    "status": "active",
    "price": 29.99,
    "quantity": 10
  }'
```

## Migration from data.json

Your existing `data.json` contains eBay listings. Here's how to migrate:

### Step 1: Run Migration Script

```bash
node src/utils/migrate-data.js
```

This will:
1. Read `data/data.json`
2. Create products from scraped eBay data
3. Create eBay listings linked to products
4. Log migration results

### Step 2: Verify Data

```bash
# Check migrated products
curl http://localhost:3000/api/products

# Check listings
curl http://localhost:3000/api/listings?channel=ebay
```

## Architecture Philosophy

### Centralized, Local-First

- **Single SQLite database** (no server setup needed)
- **One Express application** (no microservices)
- **Simple cron jobs** (no complex queues)
- **Local file storage** (images, labels, logs)

### Modular & Maintainable

- **Feature modules** - Each module has service, controller, routes
- **Separation of concerns** - Business logic in services, HTTP in controllers
- **Easy to extend** - Add new modules by copying existing pattern

### Simple & Reliable

- **Prisma ORM** - Type-safe database queries
- **Express** - Battle-tested web framework
- **node-cron** - Simple scheduling
- **File logging** - Structured logs in `logs/` directory

## Integration Points

### eBay (Existing)

Your existing eBay integration in `server.js` can be migrated to:
- `src/integrations/ebay/ebay.service.js` - API client
- `src/integrations/ebay/ebay.controller.js` - HTTP handlers
- `src/integrations/ebay/ebay.routes.js` - Routes

**Example migration:**
```javascript
// src/integrations/ebay/ebay.service.js
const prisma = require('../../core/database');
const productsService = require('../../modules/products/products.service');
const listingsService = require('../../modules/listings/listings.service');

class EbayService {
  async publishListing(productId) {
    // Get product from database
    const product = await productsService.getProductById(productId);
    
    // Call eBay API (reuse existing code)
    const ebayListingId = await this.createEbayListing(product);
    
    // Save listing to database
    const listing = await listingsService.createListing({
      productId: product.id,
      channel: 'ebay',
      channelListingId: ebayListingId,
      status: 'active'
    });
    
    return listing;
  }
}
```

### Future Integrations

Add new channels by creating:
```
src/integrations/etsy/
  ├── etsy.service.js
  ├── etsy.controller.js
  └── etsy.routes.js
```

## Comparison: Old vs New Architecture

| Feature | Old (Complex) | New (Simple) |
|---------|--------------|--------------|
| **Database** | PostgreSQL server | SQLite file |
| **ORM** | Raw SQL | Prisma |
| **Queue System** | Redis + BullMQ | node-cron |
| **Architecture** | TypeScript, 65+ files, Fastify | JavaScript, modular Express |
| **Setup** | Install PostgreSQL, Redis | Just `npm install` |
| **API** | REST + GraphQL | REST only |
| **Complexity** | Enterprise-grade | Simple & local |

## File Locations

- **Database:** `prisma/strapey.db`
- **Logs:** `logs/YYYY-MM-DD.log`
- **Images:** `data/images/`
- **Labels:** `data/labels/`
- **Scraped Data:** `data/scraped/`

## Environment Variables

Already configured in `.env`:
```env
# Application
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL="file:./prisma/strapey.db"

# eBay (existing)
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
# ... etc
```

## Next Steps

1. ✅ **Database created** - Ready to use
2. ✅ **API running** - Test with `npm run app`
3. 🔄 **Migrate data** - Run migration script (next section)
4. 🔄 **Migrate eBay code** - Move integration to new structure
5. 🔄 **Add scheduling** - Configure cron jobs in `src/services/scheduler.js`
6. 🔄 **Build admin UI** - Create Next.js dashboard (optional)

## Support

- **Schema:** See `prisma/schema.prisma`
- **API Docs:** This file (full endpoint list above)
- **Logs:** Check `logs/` directory for debugging

## Summary

You now have a **simple, modular, local-first** commerce management platform that:
- Uses SQLite (no database server needed)
- Has a clean REST API for all operations
- Stores everything locally
- Can be extended easily with new integrations
- Runs on a single machine without complexity

The old enterprise platform (port 4000) remains intact. This new simplified version runs on **port 3000**.
