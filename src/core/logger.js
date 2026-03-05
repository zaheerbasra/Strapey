/**
 * Simple File-Based Logger
 * Logs to local files for debugging and monitoring
 */

const fs = require('fs-extra');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
fs.ensureDirSync(LOG_DIR);

class Logger {
  constructor(module) {
    this.module = module;
  }

  _write(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      module: this.module,
      message,
      ...metadata
    };

    // Console output
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.module}] ${message}`);
    
    // File output
    const logFile = path.join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  }

  info(message, metadata) {
    this._write('info', message, metadata);
  }

  error(message, metadata) {
    this._write('error', message, metadata);
  }

  warn(message, metadata) {
    this._write('warn', message, metadata);
  }

  debug(message, metadata) {
    if (process.env.NODE_ENV === 'development') {
      this._write('debug', message, metadata);
    }
  }
}

module.exports = (module) => new Logger(module);
