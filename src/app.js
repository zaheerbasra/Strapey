/**
 * Strapey - Centralized Commerce Management Platform
 * Simple, local-first Express application with SQLite
 */

const express = require('express');
const config = require('./core/config');
const logger = require('./core/logger')('app');

// Initialize Express app
const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    query: req.query,
    ip: req.ip
  });
  next();
});

// API Routes - Modular Architecture
app.use('/api/products', require('./modules/products/products.routes'));
app.use('/api/listings', require('./modules/listings/listings.routes'));
app.use('/api/orders', require('./modules/orders/orders.routes'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv
  });
});

// Root endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Strapey Commerce Management Platform',
    version: '2.0.0',
    architecture: 'Centralized, Local-First',
    endpoints: {
      products: '/api/products',
      listings: '/api/listings',
      orders: '/api/orders',
      health: '/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path
  });

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`🚀 Strapey Platform running on port ${PORT}`);
  logger.info(`📊 Environment: ${config.nodeEnv}`);
  logger.info(`💾 Database: SQLite (prisma/strapey.db)`);
  logger.info(`🔗 API Base: http://localhost:${PORT}/api`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

module.exports = app;
