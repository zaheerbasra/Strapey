"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
exports.env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PLATFORM_PORT || 4000),
    jwtSecret: process.env.PLATFORM_JWT_SECRET || 'change-me-enterprise-secret',
    postgresUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/strapey_platform',
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    apiRateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 300),
    apiRateLimitWindow: process.env.API_RATE_LIMIT_WINDOW || '1 minute'
};
