/**
 * Output Writer
 * Handles data persistence with backup and deduplication
 */

const fs = require('fs');
const path = require('path');

class OutputWriter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.ensureDirectories();
  }

  ensureDirectories() {
    const dirs = [
      path.dirname(this.config.output.dataPath),
      this.config.output.backupPath,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Load existing data from data.json
   * @returns {Object}
   */
  loadExisting() {
    try {
      if (fs.existsSync(this.config.output.dataPath)) {
        const content = fs.readFileSync(this.config.output.dataPath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      this.logger.error('Failed to load existing data', { error: error.message });
    }
    return {};
  }

  /**
   * Save data to data.json
   * @param {Object} data - Data to save (URL-keyed object)
   * @param {boolean} merge - DEPRECATED: Always merges to prevent data loss
   */
  save(data, merge = true) {
    try {
      // CRITICAL: Always load existing data and merge (never overwrite entire file)
      const existing = this.loadExisting();
      const existingCount = Object.keys(existing).length;
      
      // Merge new data with existing (upsert only)
      const outputData = { ...existing, ...data };
      const newCount = Object.keys(outputData).length;
      const addedCount = Object.keys(data).length;

      // Create backup before writing
      this.createBackup();

      // Write merged data
      fs.writeFileSync(
        this.config.output.dataPath,
        JSON.stringify(outputData, null, 4),
        'utf8'
      );

      // Log with data loss warning
      if (newCount < existingCount) {
        this.logger.error('⚠️ WARNING: Product count decreased!', { 
          before: existingCount, 
          after: newCount, 
          loss: existingCount - newCount 
        });
      } else {
        this.logger.logDataSaved(this.config.output.dataPath, newCount);
        if (addedCount > 0) {
          this.logger.info(`Added/updated ${addedCount} products. Total: ${newCount}`);
        }
      }

      return { success: true, itemCount: newCount, existingCount, addedCount };
    } catch (error) {
      this.logger.error('Failed to save data', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Create backup of current data.json
   */
  createBackup() {
    try {
      if (fs.existsSync(this.config.output.dataPath)) {
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        const backupFile = path.join(
          this.config.output.backupPath,
          `data-backup-${timestamp}.json`
        );

        fs.copyFileSync(this.config.output.dataPath, backupFile);
        this.logger.debug('Backup created', { backupFile });

        // Clean old backups (keep last 10)
        this.cleanOldBackups();
      }
    } catch (error) {
      this.logger.warn('Failed to create backup', { error: error.message });
    }
  }

  /**
   * Clean old backups keeping only the most recent ones
   * @param {number} keepCount - Number of backups to keep
   */
  cleanOldBackups(keepCount = 10) {
    try {
      const backupDir = this.config.output.backupPath;
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('data-backup-') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(backupDir, f),
          time: fs.statSync(path.join(backupDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      // Delete old backups
      for (let i = keepCount; i < files.length; i++) {
        fs.unlinkSync(files[i].path);
        this.logger.debug('Deleted old backup', { file: files[i].name });
      }
    } catch (error) {
      this.logger.warn('Failed to clean old backups', { error: error.message });
    }
  }

  /**
   * Deduplicate data by URL
   * @param {Object} data
   * @returns {Object}
   */
  deduplicate(data) {
    const unique = {};
    const duplicates = [];

    for (const [url, item] of Object.entries(data)) {
      if (unique[url]) {
        duplicates.push(url);
        // Keep the most recently updated
        if (new Date(item.lastUpdated) > new Date(unique[url].lastUpdated)) {
          unique[url] = item;
        }
      } else {
        unique[url] = item;
      }
    }

    if (duplicates.length > 0) {
      this.logger.info(`Deduplicated ${duplicates.length} items`);
    }

    return unique;
  }

  /**
   * Export data to different format
   * @param {Object} data
   * @param {string} format - 'json', 'csv', 'jsonl'
   * @param {string} outputPath
   */
  export(data, format, outputPath) {
    try {
      switch (format) {
        case 'json':
          fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
          break;

        case 'csv':
          const csv = this.convertToCSV(data);
          fs.writeFileSync(outputPath, csv, 'utf8');
          break;

        case 'jsonl':
          const jsonl = Object.values(data).map(item => JSON.stringify(item)).join('\n');
          fs.writeFileSync(outputPath, jsonl, 'utf8');
          break;

        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      this.logger.info('Data exported', { format, path: outputPath });
      return { success: true, path: outputPath };
    } catch (error) {
      this.logger.error('Export failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Convert data to CSV format
   * @param {Object} data
   * @returns {string}
   */
  convertToCSV(data) {
    const items = Object.values(data);
    if (items.length === 0) return '';

    // Get all unique keys
    const keys = new Set();
    items.forEach(item => {
      Object.keys(item).forEach(key => {
        if (typeof item[key] !== 'object') {
          keys.add(key);
        }
      });
    });

    const headers = Array.from(keys);
    const rows = [headers.join(',')];

    items.forEach(item => {
      const values = headers.map(header => {
        const value = item[header];
        if (value === null || value === undefined) return '';
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      rows.push(values.join(','));
    });

    return rows.join('\n');
  }
}

module.exports = OutputWriter;
