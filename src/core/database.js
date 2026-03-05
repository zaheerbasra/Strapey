/**
 * Database Connection - Prisma Client Singleton
 * Simple local SQLite database for centralized commerce management
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');

// Initialize Prisma client (will use DATABASE_URL from environment)
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;
