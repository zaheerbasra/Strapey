/**
 * Simple logger utility for Strapey
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function createLogger(module) {
  const logFile = path.join(LOGS_DIR, `${module}.log`);
  const inMemoryLogs = [];
  const maxInMemoryLogs = 300;

  const log = (level, message, data) => {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      module,
      message,
      ...(data && typeof data === 'object' ? data : {})
    };
    
    const logStr = `[${timestamp}] [${level}] [${module}] ${message}${
      data ? ' ' + JSON.stringify(data) : ''
    }`;
    
    console.log(logStr);

    inMemoryLogs.push(logStr);
    if (inMemoryLogs.length > maxInMemoryLogs) {
      inMemoryLogs.shift();
    }
    
    try {
      fs.appendFileSync(logFile, logStr + '\n');
    } catch (e) {
      // Silently ignore file write errors
    }
  };

  return {
    info: (message, data) => log('INFO', message, data),
    success: (message, data) => log('SUCCESS', message, data),
    warn: (message, data) => log('WARN', message, data),
    error: (message, data) => log('ERROR', message, data),
    debug: (message, data) => log('DEBUG', message, data),
    getLogs: () => [...inMemoryLogs],
  };
}

module.exports = { createLogger };
