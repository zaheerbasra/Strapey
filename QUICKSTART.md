# Quick Start Guide - Strapey Enterprise Platform

## ✅ What's Been Built

The enterprise platform is fully implemented with:

- ✅ **65+ TypeScript files** compiled successfully
- ✅ **PostgreSQL schema** with 9 tables (products, orders, channel_listings, shipping_labels, marketing_campaigns, social_posts, audit_logs, integration_secrets, users)
- ✅ **REST API** with 25+ endpoints
- ✅ **GraphQL API** with GraphiQL UI
- ✅ **6 Background Job Queues** (scraping, orderSync, listingSync, shipping, marketing, social)
- ✅ **Security Layer** (JWT, RBAC, AES-256-GCM encryption, audit logging)
- ✅ **4 Integration Plugins** (eBay with intelligent scraper, Etsy, WordPress, Social)

## 🚀 Launch in 3 Steps

### Step 1: Start Required Services

```bash
# macOS
brew install postgresql@14 redis
brew services start postgresql@14
brew services start redis

# Ubuntu/Debian
sudo apt install postgresql-14 redis-server
sudo systemctl start postgresql
sudo systemctl start redis-server
```

### Step 2: Setup Database

```bash
# Create database
createdb strapey_platform

# Apply schema (after platform starts)
curl -X POST http://localhost:4000/api/platform/admin/bootstrap-schema
```

### Step 3: Start Platform

```bash
# Development mode (auto-reload)
npm run platform:dev
```

Platform runs on **http://localhost:4000**

## 🔐 First Login

**Default Admin**:
- Username: `admin`
- Password: `admin123`

```bash
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

Copy the returned token for API requests.

## 🧪 Test the Platform

### GraphQL Playground

Open in browser: **http://localhost:4000/graphql**

Try this query:

```graphql
{
  products(limit: 10) {
    product_id
    sku
    title
    price
    inventory
  }
}
```

### REST API Test

```bash
# Get your token first
TOKEN="your-jwt-token-here"

# Create a product
curl -X POST http://localhost:4000/api/platform/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "TEST-001",
    "title": "Test Product",
    "price": 99.99,
    "inventory": 100
  }'

# List products
curl http://localhost:4000/api/platform/products \
  -H "Authorization: Bearer $TOKEN"
```

## 📊 System Dashboard

```bash
# Health check
curl http://localhost:4000/api/platform/admin/health

# Queue monitoring (requires auth)
curl http://localhost:4000/api/platform/admin/observability \
  -H "Authorization: Bearer $TOKEN"
```

## 🐛 Troubleshooting

### Redis Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Fix**: Start Redis

```bash
brew services start redis
```

### PostgreSQL Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Fix**: Start PostgreSQL and create database

```bash
brew services start postgresql@14
createdb strapey_platform
```

## 📚 Full Documentation

See [PLATFORM.md](PLATFORM.md) for:
- Complete API reference
- Module architecture
- Integration plugin system
- Security configuration
- Deployment guides

## 🔄 Parallel Server Setup

Your **original eBay scraper** remains unchanged:

```bash
# Original server (port 3001)
npm start

# Enterprise platform (port 4000)
npm run platform:dev
```

Both can run simultaneously.

## 🎯 Next Steps

1. **Secure the Platform**: Change default admin password
2. **Configure Integrations**: Store API secrets via `/admin/integrations/secrets`
3. **Create Products**: Use REST API or GraphQL
4. **Test eBay Scraper**: POST to `/api/platform/ebay/scraper/competitors`
5. **Build Admin UI**: Create dashboard consuming the APIs

---

**Need Help?** Check [PLATFORM.md](PLATFORM.md) or open a GitHub issue.
