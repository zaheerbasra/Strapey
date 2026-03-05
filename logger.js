/**
 * Comprehensive Logger for Strapey eBay Scraper & Publisher
 * Logs detailed information about all operations with timestamps and context
 */

const fs = require('fs-extra');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
fs.ensureDirSync(LOGS_DIR);

const LogLevels = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  SUCCESS: 'SUCCESS'
};

class DetailedLogger {
  constructor(moduleName = 'General') {
    this.moduleName = moduleName;
    this.logBuffer = [];
    this.maxBufferSize = 100;
  }

  /**
   * Format log message with timestamp and module name
   */
  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.moduleName}]`;
    
    if (data) {
      return {
        text: `${prefix} ${message}`,
        data,
        timestamp,
        level,
        module: this.moduleName
      };
    }
    
    return {
      text: `${prefix} ${message}`,
      timestamp,
      level,
      module: this.moduleName
    };
  }

  /**
   * Log to console and buffer
   */
  log(level, message, data = null) {
    const logEntry = this.formatMessage(level, message, data);
    const displayText = logEntry.text + (logEntry.data ? '\n' + JSON.stringify(logEntry.data, null, 2) : '');
    
    console.log(displayText);
    this.logBuffer.push(logEntry);

    // Keep buffer size manageable
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    return logEntry;
  }

  error(message, errorObj = null) {
    const errorData = errorObj ? {
      message: errorObj.message,
      code: errorObj.code,
      status: errorObj.response?.status,
      statusText: errorObj.response?.statusText,
      errorDetails: errorObj.response?.data,
      stack: errorObj.stack
    } : null;

    return this.log(LogLevels.ERROR, message, errorData);
  }

  warn(message, data = null) {
    return this.log(LogLevels.WARN, message, data);
  }

  info(message, data = null) {
    return this.log(LogLevels.INFO, message, data);
  }

  debug(message, data = null) {
    return this.log(LogLevels.DEBUG, message, data);
  }

  success(message, data = null) {
    return this.log(LogLevels.SUCCESS, message, data);
  }

  /**
   * Get formatted error response for API
   */
  getErrorResponse(operationType, error) {
    return {
      success: false,
      operation: operationType,
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN_ERROR',
        status: error.response?.status || 500,
        details: error.response?.data || null,
        timestamp: new Date().toISOString()
      },
      logs: this.logBuffer.slice(-20) // Return last 20 log entries
    };
  }

  /**
   * Save logs to file
   */
  async saveLogs(filename) {
    try {
      const logFile = path.join(LOGS_DIR, filename);
      const logContent = this.logBuffer
        .map(entry => entry.text)
        .join('\n');
      
      await fs.writeFile(logFile, logContent, 'utf8');
      return logFile;
    } catch (err) {
      console.error('Failed to save logs:', err.message);
      return null;
    }
  }

  /**
   * Clear buffer
   */
  clear() {
    this.logBuffer = [];
  }

  /**
   * Get all logs
   */
  getLogs() {
    return this.logBuffer;
  }
}

module.exports = {
  DetailedLogger,
  LogLevels,
  createLogger: (moduleName) => new DetailedLogger(moduleName)
};
