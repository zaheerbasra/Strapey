/**
 * Advanced Logger Module
 * Provides structured logging with multiple levels and outputs
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(config) {
    this.config = config.logging;
    this.logPath = config.output.logPath;
    this.ensureLogDirectory();
    this.logFile = path.join(this.logPath, `scraper-${this.getDateString()}.log`);
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logPath)) {
      fs.mkdirSync(this.logPath, { recursive: true });
    }
  }

  getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  formatMessage(level, message, meta = {}) {
    const entry = {
      timestamp: this.getTimestamp(),
      level: level.toUpperCase(),
      message,
      ...meta,
    };
    return JSON.stringify(entry);
  }

  write(level, message, meta = {}) {
    const formattedMessage = this.formatMessage(level, message, meta);

    // Console output
    if (this.config.consoleLog) {
      const color = this.getColor(level);
      console.log(`${color}[${level.toUpperCase()}] ${message}${'\x1b[0m'}`, meta);
    }

    // File output
    if (this.config.logFile) {
      fs.appendFileSync(this.logFile, formattedMessage + '\n', 'utf8');
    }
  }

  getColor(level) {
    const colors = {
      debug: '\x1b[36m',   // Cyan
      info: '\x1b[32m',    // Green
      warn: '\x1b[33m',    // Yellow
      error: '\x1b[31m',   // Red
    };
    return colors[level] || '\x1b[0m';
  }

  debug(message, meta = {}) {
    if (this.config.level === 'debug') {
      this.write('debug', message, meta);
    }
  }

  info(message, meta = {}) {
    if (['debug', 'info'].includes(this.config.level)) {
      this.write('info', message, meta);
    }
  }

  warn(message, meta = {}) {
    if (['debug', 'info', 'warn'].includes(this.config.level)) {
      this.write('warn', message, meta);
    }
  }

  error(message, meta = {}) {
    this.write('error', message, meta);
  }

  logRequest(url, sku, method = 'GET') {
    this.debug('Making request', { url, sku, method });
  }

  logSuccess(url, sku, duration) {
    this.info('Request successful', { url, sku, duration: `${duration}ms` });
  }

  logRetry(url, sku, attempt, maxAttempts, error) {
    this.warn('Retrying request', {
      url,
      sku,
      attempt: `${attempt}/${maxAttempts}`,
      error: error.message,
    });
  }

  logFailure(url, sku, error, attempts) {
    this.error('Request failed after retries', {
      url,
      sku,
      attempts,
      error: error.message,
      stack: this.config.detailedErrors ? error.stack : undefined,
    });
  }

  logBlocking(url, indicator) {
    this.warn('Blocking detected', { url, indicator });
  }

  logThrottling(reason) {
    this.warn('Auto-throttling activated', { reason });
  }

  logSkuMapping(sku, listingsCount) {
    this.info('SKU processed', { sku, listingsCount });
  }

  logDataSaved(path, count) {
    this.info('Data saved', { path, itemCount: count });
  }

  logSummary(stats) {
    this.info('Scraping summary', stats);
  }
}

module.exports = Logger;
