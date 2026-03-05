# Copilot Instructions for Strapey Project

## Project Summary

Strapey is a centralized brand operations platform with multi-channel commerce orchestration. It consists of two components:

1. **Original eBay Scraper** (Express on port 3001): Web scraping and publishing to eBay
2. **Enterprise Platform** (Fastify on port 4000): TypeScript-based modular architecture for managing products, orders, inventory, shipping, marketing, and social media across multiple channels

## Completed Setup

- [x] Project scaffolded with TypeScript compilation (tsconfig.platform.json)
- [x] All dependencies installed
- [x] Platform architecture implemented (65+ TypeScript files)
- [x] Database schema designed (PostgreSQL)
- [x] Background job system configured (BullMQ + Redis)
- [x] Security layer implemented (JWT, RBAC, encryption, audit logging)
- [x] Documentation created (PLATFORM.md)

## Key Technologies

- **Runtime**: Node.js v18+, TypeScript 5.6+
- **Web Framework**: Fastify 5.0 (platform), Express 4.18 (legacy scraper)
- **Database**: PostgreSQL with pgcrypto extension
- **Cache & Queue**: Redis + BullMQ
- **APIs**: REST + GraphQL (Mercurius)
- **Security**: bcryptjs, JWT, AES-256-GCM encryption

## Development Scripts

```bash
# Legacy eBay Scraper
npm start        # Start Express server (port 3001)
npm run dev      # Development mode with nodemon

# Enterprise Platform
npm run platform:dev    # Development mode with auto-reload (port 4000)
npm run platform:build  # Compile TypeScript
npm run platform:start  # Production mode
```

## Prerequisites for Platform

1. **PostgreSQL 14+**: Database server must be running
2. **Redis 6+**: Required for job queues
3. **Environment Variables**: Configure in `.env.platform` or `.env`

## Architecture Guidelines

When working on platform code:

1. **Module Structure**: Follow 6-layer pattern (controllers, services, routes, models, jobs, utils)
2. **Security**: Always use `authGuard` and `requireRole` for protected endpoints
3. **Database Queries**: Use type-safe `query<T>()` helper from `core/db/pg`
4. **Background Jobs**: Enqueue long-running tasks via `enqueue()` from `core/queue`
5. **Integration Plugins**: Implement `IntegrationPlugin` interface with 8 standard methods
6. **Audit Logging**: Mutating operations are auto-logged; use `logAudit()` for custom events

## File Locations

- **Platform Code**: `src/platform/`
- **Database Schema**: `src/platform/database/schema.sql`
- **Documentation**: `PLATFORM.md` (enterprise platform), `README.md` (original scraper)
- **Config Files**: `tsconfig.platform.json`, `package.json`

## Development Best Practices

- Maintain backward compatibility with existing Express server
- Use structured logging (Pino) for all platform operations
- Keep integration plugins stateless and idempotent
- Document all new endpoints and GraphQL queries
- Test TypeScript compilation after changes: `npm run platform:build`
