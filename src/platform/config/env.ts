import 'dotenv/config';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PLATFORM_PORT || 4000),
  jwtSecret: process.env.PLATFORM_JWT_SECRET || 'change-me-enterprise-secret',
  // Database and cache now use in-memory implementations (SQLite and memory cache)
  apiRateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 300),
  apiRateLimitWindow: process.env.API_RATE_LIMIT_WINDOW || '1 minute'
};
