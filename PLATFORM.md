# Strapey Enterprise Platform

## Overview

The Strapey Enterprise Platform is a centralized, scalable brand management system that orchestrates multi-channel commerce operations. Built with TypeScript, Fastify, PostgreSQL, Redis, and BullMQ, it provides a modular architecture for managing products, orders, inventory, shipping, marketing campaigns, and social media across multiple sales channels.

## Architecture

### Technology Stack

- **Runtime**: Node.js v18+
- **Language**: TypeScript 5.6+ (strict mode)
- **Web Framework**: Fastify 5.0 with security middleware (Helmet, CORS, JWT, Rate Limiting)
- **Database**: PostgreSQL with pgcrypto extension
- **Cache & Queue**: Redis + BullMQ for background job processing
- **API Layer**: REST + GraphQL (Mercurius with GraphiQL)
- **Security**: bcryptjs password hashing, JWT tokens, AES-256-GCM encryption for secrets, RBAC with 5 roles
- **Logging**: Pino structured logger

### Core Modules

1. **Products**: Master product catalog with SKU management, pricing, inventory tracking, SEO metadata
2. **Orders**: Unified order management across all channels with auto-shipping label generation
3. **Inventory**: Low-stock detection, adjustment tracking, automated pause/resume rules
4. **Shipping**: Multi-carrier label generation (CanadaPost, USPS, UPS, FedEx, ShipStation, EasyPost)
5. **Marketing**: Campaign scheduling with discount management and channel targeting
6. **Analytics**: Business intelligence dashboard with sales, orders, and channel performance
7. **Social**: Post scheduling for Instagram, Facebook, TikTok, Pinterest, X

### Integration System

Plugin-based architecture supporting 4 channel types:

- **eBay**: Full CRUD + intelligent competitor scraper with anti-blocking
- **Etsy**: Marketplace integration (skeleton)
- **WordPress/WooCommerce**: E-commerce integration (skeleton)
- **Social Media**: Multi-platform automation (skeleton)

## Prerequisites

### Required Services

#### 1. PostgreSQL 14+

```bash
# macOS
brew install postgresql@14
brew services start postgresql@14

# Ubuntu/Debian
sudo apt install postgresql-14
sudo systemctl start postgresql

# Create database
createdb strapey_platform
```

#### 2. Redis 6+

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis-server
```

### Environment Configuration

Create a `.env.platform` file (or add to existing `.env`):

```env
# Platform Server
PLATFORM_PORT=4000
NODE_ENV=development

# Database
PLATFORM_DB_URL=postgres://postgres:postgres@localhost:5432/strapey_platform

# Redis
PLATFORM_REDIS_URL=redis://127.0.0.1:6379

# Security
PLATFORM_JWT_SECRET=your-secure-random-secret-here

# Rate Limiting
PLATFORM_API_RATE_LIMIT_MAX=300
PLATFORM_API_RATE_LIMIT_WINDOW=60000
```

**Generate a secure JWT secret**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Installation

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run platform:build

# Apply database schema
# Start the platform first, then:
curl -X POST http://localhost:4000/api/platform/admin/bootstrap-schema
```

## Running the Platform

### Development Mode (with auto-reload)

```bash
npm run platform:dev
```

The platform starts on **port 4000** (your existing Express server remains on port 3001).

### Production Mode

```bash
# Build TypeScript
npm run platform:build

# Run compiled JavaScript
npm run platform:start
```

## Database Setup

### 1. Apply Schema

**Option A**: Via HTTP endpoint (recommended)

```bash
curl -X POST http://localhost:4000/api/platform/admin/bootstrap-schema
```

**Option B**: Manually via psql

```bash
psql -U postgres -d strapey_platform -f src/platform/database/schema.sql
```

### 2. Verify Schema

```sql
-- Connect to database
psql -U postgres -d strapey_platform

-- List tables
\dt

-- Expected tables:
-- users, products, channel_listings, orders, shipping_labels,
-- marketing_campaigns, social_posts, audit_logs, integration_secrets
```

### Schema Overview

```
users (authentication)
  ├── user_id (UUID, PK)
  ├── username, email, password_hash
  └── role (admin, manager, marketing, support, viewer)

products (master catalog)
  ├── product_id (UUID, PK)
  ├── sku (unique), title, brand, category
  ├── price, cost, inventory
  ├── images[], videos[], seo_title, seo_description
  └── created_at, updated_at

channel_listings (products ↔ channels)
  ├── listing_id (UUID, PK)
  ├── product_id (FK → products)
  ├── channel (ebay, etsy, wordpress, social)
  ├── external_listing_id, status, channel_price
  └── synced_at, metadata

orders (unified order management)
  ├── order_id (UUID, PK)
  ├── channel, channel_order_id
  ├── customer, items (JSONB)
  ├── total_price, shipping_cost, tax
  ├── status, tracking_number, shipping_label
  └── created_at, updated_at

shipping_labels
  ├── label_id (UUID, PK)
  ├── order_id (FK → orders)
  ├── carrier (canadapost, usps, ups, fedex, shipstation, easypost)
  ├── tracking_number, label_url, cost
  └── created_at

marketing_campaigns
  ├── campaign_id (UUID, PK)
  ├── campaign_name, channel, discount_type, discount_value
  ├── schedule_at, status, metadata
  └── created_at, updated_at

social_posts
  ├── post_id (UUID, PK)
  ├── platform (instagram, facebook, tiktok, pinterest, x)
  ├── content, media_urls[], scheduled_time
  ├── status, external_post_id, metadata
  └── created_at

audit_logs (compliance trail)
  ├── log_id (UUID, PK)
  ├── actor, action, resource_type, resource_id
  ├── metadata, status_code
  └── created_at

integration_secrets (encrypted API keys)
  ├── integration_key (ebay, etsy, wordpress, social)
  ├── secret_name, encrypted_value (AES-256-GCM)
  └── UNIQUE (integration_key, secret_name)
```

## API Documentation

### Base URL

```
http://localhost:4000/api/platform
```

### Authentication

**Login**:

```bash
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Use token in requests**:

```bash
curl http://localhost:4000/api/platform/products \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Core Endpoints

#### Products

```bash
# List products
GET /api/platform/products?limit=50

# Create product
POST /api/platform/products
{
  "sku": "KNIFE-001",
  "title": "15\" Fixed Blade Survival Knife",
  "brand": "Acme",
  "category": "Outdoor Gear",
  "price": 149.99,
  "cost": 75.00,
  "inventory": 50,
  "images": ["https://example.com/image.jpg"],
  "seo_title": "Premium Survival Knife | Acme",
  "seo_description": "High-carbon steel blade with ergonomic handle"
}

# Update product
PATCH /api/platform/products/:productId
{
  "price": 139.99,
  "inventory": 45
}
```

#### Orders

```bash
# List orders
GET /api/platform/orders?limit=50

# Create order (auto-generates shipping label)
POST /api/platform/orders
{
  "channel": "ebay",
  "channel_order_id": "12345-67890",
  "customer": {
    "name": "John Doe",
    "email": "john@example.com",
    "address": {
      "street": "123 Main St",
      "city": "Toronto",
      "state": "ON",
      "zip": "M5V 3A8",
      "country": "CA"
    }
  },
  "items": [
    {
      "sku": "KNIFE-001",
      "quantity": 1,
      "price": 149.99
    }
  ],
  "total_price": 149.99,
  "shipping_cost": 10.00,
  "tax": 19.50
}

# Update order status
PATCH /api/platform/orders/:orderId
{
  "status": "shipped",
  "tracking_number": "1Z999AA10123456784"
}
```

#### Inventory

```bash
# Check low stock (inventory < threshold)
GET /api/platform/inventory/low-stock?threshold=10

# Adjust inventory
POST /api/platform/inventory/adjust
{
  "product_id": "uuid-here",
  "delta": -5,
  "reason": "Sold via eBay"
}

# Sync inventory from channel
POST /api/platform/inventory/sync
{
  "channel": "ebay"
}
```

#### Shipping

```bash
# Generate shipping label
POST /api/platform/shipping/labels
{
  "order_id": "uuid-here",
  "carrier": "canadapost",
  "service_level": "expedited"
}

# Get label by order
GET /api/platform/shipping/labels/:orderId
```

#### Marketing

```bash
# List campaigns
GET /api/platform/marketing/campaigns

# Create campaign
POST /api/platform/marketing/campaigns
{
  "campaign_name": "Black Friday 2024",
  "channel": "ebay",
  "discount_type": "percentage",
  "discount_value": 25,
  "schedule_at": "2024-11-29T00:00:00Z",
  "metadata": {
    "target_category": "Knives"
  }
}
```

#### Analytics

```bash
# Business dashboard
GET /api/platform/analytics/dashboard
```

Response:

```json
{
  "gross_sales": 15432.50,
  "order_count": 127,
  "product_count": 342,
  "channel_performance": [
    {
      "channel": "ebay",
      "order_count": 89,
      "total_revenue": 10123.45
    },
    {
      "channel": "etsy",
      "order_count": 38,
      "total_revenue": 5309.05
    }
  ]
}
```

#### Social Media

```bash
# List scheduled posts
GET /api/platform/social/posts

# Schedule post
POST /api/platform/social/posts
{
  "platform": "instagram",
  "content": "Check out our new survival knife collection! #outdoor #survival",
  "media_urls": ["https://example.com/image.jpg"],
  "scheduled_time": "2024-12-01T15:00:00Z"
}
```

### Integration Endpoints

#### eBay Competitor Scraper

```bash
# Scrape competitor prices
POST /api/platform/ebay/scraper/competitors
{
  "urls": [
    "https://www.ebay.com/itm/123456789",
    "https://www.ebay.com/itm/987654321"
  ],
  "report": "summary"
}
```

Response:

```json
{
  "market_insights": {
    "average_price": 142.50,
    "min_price": 119.99,
    "max_price": 189.99,
    "total_listings": 2
  },
  "listings": [...]
}
```

#### Unified Listings API

```bash
# List all cross-channel listings
GET /api/platform/listings?channel=ebay

# Create/update listing on channel
POST /api/platform/listings
{
  "integration_key": "ebay",
  "product_id": "uuid-here",
  "channel_price": 149.99
}

# Pause listing
POST /api/platform/integrations/ebay/listings/:listingId/pause

# Relist item
POST /api/platform/integrations/ebay/listings/:listingId/relist

# Sync orders from channel
POST /api/platform/integrations/ebay/orders/sync

# Sync pricing across channels
POST /api/platform/integrations/ebay/pricing/sync
```

### Admin Endpoints

```bash
# Apply database schema
POST /api/platform/admin/bootstrap-schema

# Store encrypted secret
POST /api/platform/admin/integrations/secrets
{
  "integration_key": "ebay",
  "secret_name": "client_id",
  "secret_value": "YourEbayAppId"
}

# List all secrets (returns metadata, not values)
GET /api/platform/admin/integrations/secrets/:integrationKey

# System health
GET /api/platform/admin/health

# Observability dashboard
GET /api/platform/admin/observability
```

Response:

```json
{
  "queues": {
    "scraping": { "waiting": 0, "active": 0, "completed": 42, "failed": 1, "delayed": 0 },
    "orderSync": { "waiting": 3, "active": 1, "completed": 128, "failed": 0, "delayed": 0 },
    ...
  },
  "integrations": ["ebay", "etsy", "wordpress", "social"]
}
```

### Automation Rules

```bash
# Evaluate automation rules
POST /api/platform/automation/evaluate
{
  "productInventoryChanged": {
    "product_id": "uuid-here",
    "new_inventory": 3
  }
}
```

**Built-in Rules**:

1. **Low Inventory → Pause Listing**: When inventory < 5, pauses listing across all channels
2. **New Order → Auto Shipping Label**: When order status = 'pending', generates shipping label and transitions to 'processing'
3. **Competitor Price Drop → Adjust Price**: When competitor price < current price × 0.9, adjusts price to match

## GraphQL API

**Endpoint**: `http://localhost:4000/graphql`

**GraphiQL UI**: Open in browser for interactive exploration

### Queries

```graphql
{
  # Fetch products
  products(limit: 20) {
    product_id
    sku
    title
    brand
    category
    price
    inventory
  }

  # Fetch orders
  orders(limit: 20) {
    order_id
    channel
    channel_order_id
    status
    total_price
    created_at
  }
}
```

## Background Jobs

### Queue System (BullMQ)

**6 Named Queues**:

1. `scraping`: eBay competitor scraping jobs
2. `orderSync`: Channel order synchronization
3. `listingSync`: Cross-channel listing updates
4. `shipping`: Shipping label generation
5. `marketing`: Campaign execution
6. `social`: Social media post publishing

### Workers

Workers are auto-registered on platform startup:

- **Shipping Worker**: Consumes `shipping` queue → generates labels via ShippingService
- **Marketing Worker**: Consumes `marketing` queue → executes scheduled campaigns

### Job Enqueueing

```typescript
import { enqueue } from './core/queue';

// Enqueue a job
await enqueue('scraping', 'scraper.ebay.competitors', {
  urls: ['https://www.ebay.com/itm/123456789']
});

// With custom options
await enqueue('shipping', 'shipping.label.generate', 
  { order_id: 'uuid-here' },
  { delay: 5000, priority: 10 }
);
```

## Security

### Authentication

- **JWT-based**: Login returns token, required for all protected routes
- **Password Hashing**: bcryptjs with salt rounds = 10
- **Default Admin**: `admin@strapey.local` / `admin123` (change immediately in production)

### Authorization (RBAC)

**5 Roles**:

- `admin`: Full system access
- `manager`: Product, order, inventory, shipping management
- `marketing`: Marketing campaigns, analytics, social media
- `support`: Order status updates, shipping labels (viewer)
- `viewer`: Read-only access to all modules

**Usage**:

```typescript
import { requireRole } from './core/security/rbac';

// Protect route with roles
app.get('/admin/dashboard', 
  { onRequest: [authGuard, requireRole(['admin'])] },
  async (request, reply) => { ... }
);
```

### Encryption

**AES-256-GCM** for integration secrets:

```typescript
import { encryptSensitive, decryptSensitive } from './core/security/crypto';

const encrypted = encryptSensitive('my-api-key');
const decrypted = decryptSensitive(encrypted);
```

### Audit Logging

All mutating API calls (`POST`, `PUT`, `PATCH`, `DELETE` on `/api/platform/*`) are automatically logged to `audit_logs` table via Fastify `onResponse` hook.

**Manual Logging**:

```typescript
import { logAudit } from './core/audit/audit.service';

await logAudit({
  actor: 'admin@strapey.local',
  action: 'product.delete',
  resource_type: 'product',
  resource_id: productId,
  metadata: { sku: 'KNIFE-001' },
  status_code: 200
});
```

## Architecture Patterns

### Plugin System

Integrations implement the `IntegrationPlugin` interface (8 methods):

```typescript
export interface IntegrationPlugin {
  key: string;
  channelName: string;
  createListing(productId: string, price: number): Promise<string>;
  updateListing(listingId: string, updates: any): Promise<void>;
  pauseListing(listingId: string): Promise<void>;
  relistItem(listingId: string): Promise<void>;
  deleteListing(listingId: string): Promise<void>;
  syncOrders(since?: Date): Promise<any[]>;
  syncInventory(products: any[]): Promise<void>;
  syncPricing(productId: string, newPrice: number): Promise<void>;
}
```

**Register Plugin**:

```typescript
import { pluginManager } from './core/plugin/plugin-manager';
import { ebayPlugin } from './integrations/ebay/plugin';

pluginManager.register(ebayPlugin);
```

**Use Plugin**:

```typescript
const plugin = pluginManager.get('ebay');
await plugin.createListing('product-uuid', 149.99);
```

### Service Layer Pattern

Each module follows 6-layer structure:

```
modules/
  products/
    controllers/       # HTTP request handlers
    services/          # Business logic
    routes/           # Route definitions
    models/           # TypeScript types
    jobs/             # Background job processors
    utils/            # Helper functions
```

### Database Access

**Type-safe Query Helper**:

```typescript
import { query } from './core/db/pg';

const rows = await query<{ product_id: string; sku: string }>(
  'SELECT product_id, sku FROM products WHERE category = $1',
  ['Knives']
);
```

## Troubleshooting

### Common Issues

#### 1. Redis Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Solution**: Start Redis

```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis-server
```

#### 2. PostgreSQL Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution**: Verify PostgreSQL is running and database exists

```bash
# Check service
pg_isready

# Create database if missing
createdb strapey_platform
```

#### 3. Fastify Plugin Version Mismatch

```
FST_ERR_PLUGIN_VERSION_MISMATCH: fastify-plugin: @fastify/sensible - expected '4.x'
```

**Solution**: Update plugin versions

```bash
npm install @fastify/sensible@^6.0.1
```

#### 4. TypeScript Compilation Errors

```
error TS7016: Could not find a declaration file for module 'pg'
```

**Solution**: Install type definitions

```bash
npm i --save-dev @types/pg @types/bcryptjs
```

## Performance Tuning

### Database Connection Pool

Adjust pool size in [pg.ts](src/platform/core/db/pg.ts):

```typescript
const pool = new Pool({
  connectionString: env.dbUrl,
  max: 20,            // Increase for high concurrency
  idleTimeoutMillis: 30000
});
```

### Rate Limiting

Configure in `.env.platform`:

```env
PLATFORM_API_RATE_LIMIT_MAX=1000     # requests per window
PLATFORM_API_RATE_LIMIT_WINDOW=60000 # 1 minute
```

### Queue Concurrency

Configure worker concurrency in [workers.ts](src/platform/workers.ts):

```typescript
const shippingWorker = createWorker('shipping', async (job) => {
  // ...
}, { concurrency: 5 }); // Process 5 jobs in parallel
```

## Development

### Project Structure

```
src/platform/
  ├── main.ts                 # Entry point
  ├── app.ts                  # Fastify app factory
  ├── config/
  │   └── env.ts              # Environment config
  ├── core/
  │   ├── db/pg.ts            # PostgreSQL pool
  │   ├── cache/redis.ts      # Redis client
  │   ├── queue/              # BullMQ queues
  │   ├── security/           # Auth, RBAC, encryption
  │   ├── audit/              # Audit logging
  │   ├── plugin/             # Plugin registry
  │   ├── graphql/            # GraphQL schema
  │   ├── automation/         # Rule engine
  │   └── http/               # Route registration
  ├── modules/
  │   ├── products/
  │   ├── orders/
  │   ├── inventory/
  │   ├── shipping/
  │   ├── marketing/
  │   ├── analytics/
  │   └── social/
  ├── integrations/
  │   ├── ebay/
  │   ├── etsy/
  │   ├── wordpress/
  │   └── social/
  ├── database/
  │   ├── schema.sql          # PostgreSQL DDL
  │   └── bootstrap.ts        # Schema application
  └── workers.ts              # Worker registration

dist/                         # Compiled JavaScript
```

### Adding a New Module

1. **Create module structure**:

```bash
mkdir -p src/platform/modules/mymodule/{controllers,services,routes,models,jobs,utils}
```

2. **Implement service** (`services/mymodule.service.ts`):

```typescript
import { query } from '../../../core/db/pg';

export class MyModuleService {
  async list(limit = 50) {
    return query('SELECT * FROM my_table LIMIT $1', [limit]);
  }
}
```

3. **Create controller** (`controllers/mymodule.controller.ts`):

```typescript
import { MyModuleService } from '../services/mymodule.service';

export async function listItems(request, reply) {
  const service = new MyModuleService();
  const items = await service.list(request.query.limit || 50);
  return reply.send(items);
}
```

4. **Define routes** (`routes/index.ts`):

```typescript
import { FastifyInstance } from 'fastify';
import { authGuard } from '../../../core/security/auth';
import { requireRole } from '../../../core/security/rbac';
import { listItems } from '../controllers/mymodule.controller';

export async function registerMyModuleRoutes(app: FastifyInstance) {
  app.get('/api/platform/mymodule', {
    onRequest: [authGuard, requireRole(['admin', 'manager'])]
  }, listItems);
}
```

5. **Register in main router** (`core/http/register-routes.ts`):

```typescript
import { registerMyModuleRoutes } from '../../modules/mymodule/routes';

export async function registerRoutes(app: FastifyInstance) {
  await registerMyModuleRoutes(app);
  // ... other routes
}
```

### Adding a New Integration

1. **Implement plugin** (`integrations/myplugin/plugin.ts`):

```typescript
import { IntegrationPlugin } from '../../core/plugin/plugin-manager';

export const myPlugin: IntegrationPlugin = {
  key: 'myplugin',
  channelName: 'MyChannel',
  async createListing(productId, price) {
    // Implementation
    return 'listing-id';
  },
  // ... implement remaining 7 methods
};
```

2. **Register plugin** (`integrations/index.ts`):

```typescript
import { myPlugin } from './myplugin/plugin';

export function registerIntegrations() {
  pluginManager.register(myPlugin);
}
```

## Deployment

### Environment Variables (Production)

```env
NODE_ENV=production
PLATFORM_PORT=4000
PLATFORM_DB_URL=postgres://username:password@db-host:5432/strapey
PLATFORM_REDIS_URL=redis://redis-host:6379
PLATFORM_JWT_SECRET=<64-char-hex-secret>
PLATFORM_API_RATE_LIMIT_MAX=1000
PLATFORM_API_RATE_LIMIT_WINDOW=60000
```

### Process Management (PM2)

```bash
# Install PM2
npm install -g pm2

# Start platform
pm2 start dist/platform/main.js --name strapey-platform

# Start worker process
pm2 start dist/platform/workers.js --name strapey-workers

# Save process list
pm2 save

# Auto-restart on server reboot
pm2 startup
```

### Docker

**Dockerfile**:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run platform:build
EXPOSE 4000
CMD ["node", "dist/platform/main.js"]
```

**docker-compose.yml**:

```yaml
version: '3.8'
services:
  platform:
    build: .
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=production
      - PLATFORM_DB_URL=postgres://postgres:postgres@db:5432/strapey
      - PLATFORM_REDIS_URL=redis://redis:6379
      - PLATFORM_JWT_SECRET=${JWT_SECRET}
    depends_on:
      - db
      - redis

  db:
    image: postgres:14
    environment:
      - POSTGRES_DB=strapey
      - POSTGRES_PASSWORD=postgres
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:6-alpine

volumes:
  pgdata:
```

## Monitoring

### Health Check

```bash
curl http://localhost:4000/api/platform/admin/health
```

### Queue Monitoring

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:4000/api/platform/admin/observability
```

### Structured Logs (Pino)

```typescript
app.log.info({ event: 'order.created', order_id: 'uuid' }, 'Order created successfully');
```

**Output**:

```json
{
  "level": 30,
  "time": 1701234567890,
  "event": "order.created",
  "order_id": "uuid",
  "msg": "Order created successfully"
}
```

## Next Steps

1. **Setup Redis & PostgreSQL**: Install and start required services
2. **Apply Database Schema**: `curl -X POST http://localhost:4000/api/platform/admin/bootstrap-schema`
3. **Create Admin User**: Default `admin@strapey.local` / `admin123` (change password)
4. **Configure Integrations**: Store API secrets via `/admin/integrations/secrets`
5. **Test Endpoints**: Use GraphiQL or Postman to explore API
6. **Build Admin UI**: Create React/Vue dashboard consuming REST/GraphQL APIs
7. **Deploy Workers**: Start background worker process for job processing
8. **Production Hardening**: Update JWT secret, enable HTTPS, configure CORS origins

## Support

For issues, feature requests, or questions:

- **GitHub Issues**: https://github.com/yourusername/strapey/issues
- **Documentation**: See [README.md](README.md) for original eBay scraper docs
- **Architecture**: Modular design enables independent scaling of web server and workers

---

**Built with ❤️ by the Strapey Team**
