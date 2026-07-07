// Export for scripts and direct usage
module.exports.scrapeEbayProduct = scrapeEbayProduct;
require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
// Import setTimeout from the Node.js timers/promises module
const { setTimeout: delay } = require("node:timers/promises");
const { createLogger } = require('./logger');
const scrapeQueue = require('./src/scrape-queue');
const SmartPublishingEngine = require('./src/services/smart-publishing-engine');
const EbayOrdersService = require('./src/ebay-orders-service');
const { registerWordpressIntegrationRoutes } = require('./src/integrations/wordpress-integration');
const { applyProductGroup, detectProductGroup, getProductGroupLabel } = require('./src/utils/product-grouping');
const { generateBrandedDescription, generateSeoTitle, getBrandConfig } = require('./src/utils/brand-content');
const { addWatermark, isWatermarkingEnabled, getWatermarkSettings } = require('./src/utils/image-watermark');
const { sanitizeProduct, sanitizeTitle, sanitizeDescription, stripTrademarkSymbols } = require('./src/utils/brand-sanitizer');
const { cleanProductImage } = require('./src/utils/image-cleaner');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

function isTruthyEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

const FAST_PIPELINE_ENABLED = isTruthyEnv(process.env.FAST_PIPELINE);
const SCRAPE_CONCURRENCY = Math.max(1, parseNonNegativeIntEnv('SCRAPE_CONCURRENCY', FAST_PIPELINE_ENABLED ? 8 : 1));
const SCRAPE_RETRY_CONCURRENCY = Math.max(1, parseNonNegativeIntEnv('SCRAPE_RETRY_CONCURRENCY', FAST_PIPELINE_ENABLED ? 6 : 1));
const PUBLISH_CONCURRENCY = Math.max(1, parseNonNegativeIntEnv('PUBLISH_CONCURRENCY', FAST_PIPELINE_ENABLED ? 4 : 1));
const EPS_UPLOAD_CONCURRENCY = Math.max(1, parseNonNegativeIntEnv('EPS_UPLOAD_CONCURRENCY', FAST_PIPELINE_ENABLED ? 4 : 1));
const SCRAPE_INTER_ITEM_DELAY_MS = parseNonNegativeIntEnv('SCRAPE_INTER_ITEM_DELAY_MS', FAST_PIPELINE_ENABLED ? 0 : 3000);

const SCRAPE_DELAY_PROFILE = {
  beforeNavigate: parseNonNegativeIntEnv('SCRAPE_BEFORE_NAV_DELAY_MS', FAST_PIPELINE_ENABLED ? 400 : 3000),
  afterNavigate: parseNonNegativeIntEnv('SCRAPE_AFTER_NAV_DELAY_MS', FAST_PIPELINE_ENABLED ? 400 : 3000),
  gallerySettle: parseNonNegativeIntEnv('SCRAPE_GALLERY_SETTLE_DELAY_MS', FAST_PIPELINE_ENABLED ? 500 : 3000),
  postScroll: parseNonNegativeIntEnv('SCRAPE_POST_SCROLL_DELAY_MS', FAST_PIPELINE_ENABLED ? 250 : 1000),
  afterDescriptionTab: parseNonNegativeIntEnv('SCRAPE_AFTER_DESC_TAB_DELAY_MS', FAST_PIPELINE_ENABLED ? 300 : 1200),
  afterItemSpecificsTab: parseNonNegativeIntEnv('SCRAPE_AFTER_ITEM_TAB_DELAY_MS', FAST_PIPELINE_ENABLED ? 250 : 800)
};

async function mapWithConcurrency(items, concurrency, worker) {
  const total = Array.isArray(items) ? items.length : 0;
  if (!total) return [];

  const limit = Math.max(1, Math.min(concurrency || 1, total));
  const results = new Array(total);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

let dataFileWriteChain = Promise.resolve();
async function withDataFileWriteLock(task) {
  const run = dataFileWriteChain.then(task, task);
  dataFileWriteChain = run.catch(() => {});
  return run;
}

// Initialize smart publishing engine
let smartPublishingEngine = null;
function getSmartPublishingEngine() {
  if (!smartPublishingEngine) {
    smartPublishingEngine = new SmartPublishingEngine(createLogger('SmartEngine'));
  }
  return smartPublishingEngine;
}

// Initialize eBay Orders Service
let ebayOrdersService = null;
function getEbayOrdersService() {
  if (!ebayOrdersService) {
    ebayOrdersService = new EbayOrdersService(getEbayRuntimeConfig, getEbayAccessToken);
  }
  return ebayOrdersService;
}

// --- Browser launch logging and fallback ---
function getBrowserLaunchOptions(useProfile = false) {
  const log = (msg, data) => console.log('[Puppeteer]', msg, data !== undefined ? JSON.stringify(data) : '');

  log('Resolving browser executable...');
  log('Platform', process.platform);
  log('Node version', process.version);
  log('PUPPETEER_SKIP_DOWNLOAD', process.env.PUPPETEER_SKIP_DOWNLOAD || '(not set)');
  log('PUPPETEER_EXECUTABLE_PATH', process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)');

  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;

  if (!executablePath) {
    try {
      const bundled = puppeteer.executablePath();
      log('Bundled Chromium path', bundled);
      if (bundled && fs.existsSync(bundled)) {
        executablePath = bundled;
        log('Using bundled Chromium (exists)', true);
      } else {
        log('Bundled Chromium missing or path invalid', true);
      }
    } catch (e) {
      log('puppeteer.executablePath() threw', e.message);
    }
  } else {
    log('Using PUPPETEER_EXECUTABLE_PATH', executablePath);
  }

  // Fallback: system Chrome/Chromium
  if (!executablePath || !fs.existsSync(executablePath)) {
    const systemChromePaths = [];
    if (process.platform === 'darwin') {
      systemChromePaths.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      );
    } else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      systemChromePaths.push(
        path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe')
      );
    } else if (process.platform === 'linux') {
      systemChromePaths.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
    }
    for (const p of systemChromePaths) {
      if (p && fs.existsSync(p)) {
        executablePath = p;
        log('Using system browser fallback', p);
        break;
      }
    }
  }

  if (!executablePath || !fs.existsSync(executablePath)) {
    log('No valid browser executable found. Path checked', executablePath || '(none)');
  } else {
    log('Final executablePath', executablePath);
  }

  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  };
  if (executablePath) opts.executablePath = executablePath;
  if (useProfile) {
    // Reuse a persistent Chrome profile so cookies/session build up across scrapes
    // like a real returning visitor, instead of every scrape looking like a brand
    // new stranger teleporting straight to one listing with zero history - one of
    // the signals bot detection weighs alongside request volume/fingerprinting.
    opts.userDataDir = path.join(__dirname, 'data', '.browser-profile');
  }
  return opts;
}

// Chrome refuses to run two instances against the same userDataDir at once, so only
// one concurrent scrape may use the persistent profile; others fall back to an
// ephemeral profile (previous behavior) rather than colliding with it.
let persistentProfileInUse = false;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Route handlers BEFORE static middleware (so root path works correctly)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/scraper', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Now add static file serving
app.use(express.static('public'));

// Ensure data folder exists
fs.ensureDirSync('data');
app.use('/data', express.static(path.join(__dirname, 'data')));

// Serve SKU-based product images
fs.ensureDirSync(path.join('data', 'images'));
app.use('/images', express.static(path.join(__dirname, 'data', 'images')));

// Persistent Chrome profile for scraping (cookies/session continuity - see
// getBrowserLaunchOptions). Not served statically: express.static ignores dotfiles.
fs.ensureDirSync(path.join('data', '.browser-profile'));

const DATA_FILE_PATH = path.join('data', 'data.json');
const ADMIN_CONFIG_PATH = path.join('data', 'admin-config.json');
const RUNTIME_ENV_CONFIG_PATH = path.join('data', 'runtime-environment.json');
const PRODUCT_ACTIVITY_LOG_FILE_PATH = path.join('data', 'product-activity-log.json');

/**
 * CRITICAL: Safe data loader with validation
 * Prevents accidental data loss from corrupted reads
 * @returns {Object} - Product data keyed by URL
 */
function loadProductDataSafely() {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      console.log('[SafeLoader] Data file does not exist, returning empty object');
      return {};
    }

    const content = fs.readFileSync(DATA_FILE_PATH, 'utf8');
    
    // Check for empty or suspiciously small files
    if (!content || content.trim().length < 10) {
      throw new Error(`Data file is empty or corrupted (${content.length} bytes)`);
    }

    const allData = JSON.parse(content);
    
    // Validate structure
    if (!allData || typeof allData !== 'object' || Array.isArray(allData)) {
      throw new Error('Data file has invalid structure (expected object)');
    }

    const productCount = Object.keys(allData).length;
    
    // SAFETY CHECK: Warn if product count is suspiciously low
    if (productCount < 50 && productCount > 0) {
      console.warn(`⚠️ WARNING: Data file only contains ${productCount} products. Expected 1000+. File may be corrupted.`);
    }

    console.log(`[SafeLoader] Loaded ${productCount} products successfully`);
    return allData;

  } catch (error) {
    console.error('⚠️ CRITICAL: Failed to load product data safely:', error.message);
    
    // Try to load from most recent backup
    try {
      const dataDir = path.dirname(DATA_FILE_PATH);
      const files = fs.readdirSync(dataDir);
      const backups = files
        .filter(f => f.startsWith('data.json.backup-') && /\d{13}$/.test(f))
        .map(f => ({
          name: f,
          path: path.join(dataDir, f),
          time: parseInt(f.match(/\d{13}$/)[0])
        }))
        .sort((a, b) => b.time - a.time);
      
      if (backups.length > 0) {
        console.log(`⚠️ Attempting to load from backup: ${backups[0].name}`);
        const backupContent = fs.readFileSync(backups[0].path, 'utf8');
        const backupData = JSON.parse(backupContent);
        console.log(`✓ Successfully loaded ${Object.keys(backupData).length} products from backup`);
        return backupData;
      }
    } catch (backupError) {
      console.error('Failed to load from backup:', backupError.message);
    }

    // If all else fails, return empty object but log prominently
    console.error('⚠️⚠️⚠️ RETURNING EMPTY DATA - ALL PRODUCTS MAY BE LOST ⚠️⚠️⚠️');
    return {};
  }
}

function backfillProductGroupsInDataStore() {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) return;

    const allData = fs.readJsonSync(DATA_FILE_PATH) || {};
    const beforeCount = Object.keys(allData).length;
    let changed = 0;

    Object.keys(allData).forEach((key) => {
      const before = allData[key] || {};
      const after = applyProductGroup(before);
      if (before.productGroup !== after.productGroup || before.productGroupLabel !== after.productGroupLabel) {
        allData[key] = after;
        changed += 1;
      }
    });

    if (changed > 0) {
      // CRITICAL: Verify no products were lost during backfill
      const afterCount = Object.keys(allData).length;
      if (afterCount < beforeCount) {
        console.error(`⚠️⚠️⚠️ CRITICAL ERROR: Backfill lost ${beforeCount - afterCount} products! ABORTING.`);
        return; // DO NOT WRITE if products were lost
      }
      
      fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
      console.log(`[ProductGrouping] Backfilled product groups for ${changed} products. Total: ${afterCount}`);
    }
  } catch (error) {
    console.error('[ProductGrouping] Backfill failed:', error.message);
  }
}

function loadProductActivityLogsStore() {
  try {
    if (!fs.existsSync(PRODUCT_ACTIVITY_LOG_FILE_PATH)) {
      return [];
    }
    const logs = fs.readJsonSync(PRODUCT_ACTIVITY_LOG_FILE_PATH);
    return Array.isArray(logs) ? logs : [];
  } catch (error) {
    console.error('[ActivityLog] Failed to load activity logs:', error.message);
    return [];
  }
}

function appendProductActivityLog(entry) {
  try {
    const logs = loadProductActivityLogsStore();
    logs.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry
    });

    // Keep file bounded to avoid unbounded growth.
    const cappedLogs = logs.slice(0, 20000);
    fs.writeJsonSync(PRODUCT_ACTIVITY_LOG_FILE_PATH, cappedLogs, { spaces: 2 });
  } catch (error) {
    console.error('[ActivityLog] Failed to append activity log:', error.message);
  }
}

backfillProductGroupsInDataStore();

registerWordpressIntegrationRoutes(app, { DATA_FILE_PATH });

const DEFAULT_RUNTIME_ENV_CONFIG = {
  mode: 'stage',
  services: {
    ebay: { stage: 'sandbox', prod: 'production' },
    etsy: { stage: 'sandbox', prod: 'production' },
    woocommerce: { stage: 'staging', prod: 'production' },
    social: { stage: 'staging', prod: 'production' }
  },
  updatedAt: null
};

let runtimeEnvConfigCache = null;

function normalizeRuntimeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'prod' || value === 'production' || value === 'live') {
    return 'prod';
  }
  return 'stage';
}

function normalizeEbayEnvironment(value) {
  const env = String(value || '').trim().toLowerCase();
  if (env === 'production' || env === 'prod' || env === 'live') {
    return 'production';
  }
  return 'sandbox';
}

function getRuntimeEnvironmentConfig() {
  if (runtimeEnvConfigCache) {
    return runtimeEnvConfigCache;
  }

  if (!fs.existsSync(RUNTIME_ENV_CONFIG_PATH)) {
    const initial = {
      ...DEFAULT_RUNTIME_ENV_CONFIG,
      updatedAt: new Date().toISOString()
    };
    fs.writeJsonSync(RUNTIME_ENV_CONFIG_PATH, initial, { spaces: 2 });
    runtimeEnvConfigCache = initial;
    return runtimeEnvConfigCache;
  }

  try {
    const fileConfig = fs.readJsonSync(RUNTIME_ENV_CONFIG_PATH);
    runtimeEnvConfigCache = {
      ...DEFAULT_RUNTIME_ENV_CONFIG,
      ...fileConfig,
      mode: normalizeRuntimeMode(fileConfig?.mode),
      services: {
        ...DEFAULT_RUNTIME_ENV_CONFIG.services,
        ...(fileConfig?.services || {})
      }
    };
  } catch (error) {
    runtimeEnvConfigCache = {
      ...DEFAULT_RUNTIME_ENV_CONFIG,
      updatedAt: new Date().toISOString()
    };
  }

  return runtimeEnvConfigCache;
}

function saveRuntimeEnvironmentConfig(nextConfig) {
  runtimeEnvConfigCache = {
    ...DEFAULT_RUNTIME_ENV_CONFIG,
    ...nextConfig,
    mode: normalizeRuntimeMode(nextConfig?.mode),
    services: {
      ...DEFAULT_RUNTIME_ENV_CONFIG.services,
      ...(nextConfig?.services || {})
    },
    updatedAt: new Date().toISOString()
  };
  fs.writeJsonSync(RUNTIME_ENV_CONFIG_PATH, runtimeEnvConfigCache, { spaces: 2 });
  return runtimeEnvConfigCache;
}

function resolveServiceEnvironment(serviceName, mode) {
  const config = getRuntimeEnvironmentConfig();
  const normalizedService = String(serviceName || '').trim().toLowerCase();
  const normalizedMode = normalizeRuntimeMode(mode || config.mode);
  const serviceConfig = config.services[normalizedService] || { stage: 'sandbox', prod: 'production' };
  return normalizedMode === 'prod' ? serviceConfig.prod : serviceConfig.stage;
}

function resolveEbayEnvironment(overrides = {}) {
  if (typeof overrides === 'string') {
    return normalizeEbayEnvironment(overrides);
  }
  if (overrides && overrides.environment) {
    return normalizeEbayEnvironment(overrides.environment);
  }
  return normalizeEbayEnvironment(resolveServiceEnvironment('ebay'));
}

function getRuntimeEnvironmentPayload() {
  const config = getRuntimeEnvironmentConfig();
  return {
    mode: normalizeRuntimeMode(config.mode),
    services: config.services,
    serviceTargets: {
      ebay: resolveServiceEnvironment('ebay', config.mode),
      etsy: resolveServiceEnvironment('etsy', config.mode),
      woocommerce: resolveServiceEnvironment('woocommerce', config.mode),
      social: resolveServiceEnvironment('social', config.mode)
    },
    updatedAt: config.updatedAt
  };
}

app.get('/api/runtime/environment', (req, res) => {
  try {
    return res.json({ success: true, ...getRuntimeEnvironmentPayload() });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to load runtime environment' });
  }
});

app.put('/api/runtime/environment', (req, res) => {
  try {
    const nextMode = normalizeRuntimeMode(req.body?.mode);
    const current = getRuntimeEnvironmentConfig();
    saveRuntimeEnvironmentConfig({
      ...current,
      mode: nextMode
    });
    return res.json({ success: true, ...getRuntimeEnvironmentPayload() });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to update runtime environment' });
  }
});

app.get('/api/runtime/environment/resolve', (req, res) => {
  try {
    const service = String(req.query.service || 'ebay').toLowerCase();
    const config = getRuntimeEnvironmentConfig();
    return res.json({
      success: true,
      mode: config.mode,
      service,
      targetEnvironment: resolveServiceEnvironment(service, config.mode)
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to resolve service environment' });
  }
});

// API: Get all products
app.get('/api/products', (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.json([]);
    }
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    const products = Object.values(allData).map((product) => {
      const grouped = applyProductGroup(product || {});
      const isPublished = Boolean(
        grouped.publishedToProduction ||
        grouped.productionListingId ||
        grouped.productionLink ||
        grouped.publishedLink ||
        grouped.sandboxListingId
      );
      return {
        id: grouped.itemNumber || grouped.sku || grouped.customLabel || 'unknown',
        sku: grouped.sku || grouped.customLabel,
        title: grouped.title,
        price: grouped.price,
        currency: grouped.currency || 'USD',
        description: grouped.description,
        imageSourceUrls: grouped.imageSourceUrls || grouped.images || grouped.imagesOriginal || [],
        images: grouped.imageSourceUrls || grouped.images || grouped.imagesOriginal || [],
        url: grouped.url,
        publishedLink: grouped.publishedLink,
        sandboxListingId: grouped.sandboxListingId || null,
        productionLink: grouped.productionLink || null,
        productionListingId: grouped.productionListingId || null,
        publishedToProduction: Boolean(grouped.publishedToProduction),
        publishStatus: grouped.publishStatus || (isPublished ? 'Published' : 'Draft'),
        latestPublishedListingId: grouped.latestPublishedListingId || grouped.productionListingId || grouped.sandboxListingId || null,
        latestPublishedLink: grouped.latestPublishedLink || grouped.productionLink || grouped.publishedLink || null,
        lastPublishEnvironment: grouped.lastPublishEnvironment || (grouped.productionLink || grouped.productionListingId ? 'production' : (grouped.publishedLink || grouped.sandboxListingId ? 'sandbox' : null)),
        listingId: grouped.listingId,
        inventory: grouped.inventoryQuantity ?? grouped.availableQuantity ?? grouped.inventory ?? 0,
        lastUpdated: grouped.lastUpdated,
        publishedDate: grouped.publishedDate,
        publishAction: grouped.publishAction,
        productGroup: grouped.productGroup,
        productGroupLabel: getProductGroupLabel(grouped.productGroup),
        ebayCategory: grouped.ebayCategory || null,
        ebayCategoryId: grouped.ebayCategoryId || grouped.categoryId || null
      };
    });
    res.json(products);
  } catch (error) {
    console.error('Error reading products:', error);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// API: Get single product by original listing link
app.get('/api/products/by-link', (req, res) => {
  try {
    const link = String(req.query.link || '').trim();
    if (!link) {
      return res.status(400).json({ error: 'link query parameter is required' });
    }

    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const allData = fs.readJsonSync(DATA_FILE_PATH);
    const product = allData[link];

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const grouped = applyProductGroup(product);
    return res.json({
      ...grouped,
      sku: grouped.sku || grouped.customLabel || '',
      productGroup: grouped.productGroup,
      productGroupLabel: getProductGroupLabel(grouped.productGroup)
    });
  } catch (error) {
    console.error('Error reading product by link:', error);
    return res.status(500).json({ error: 'Failed to load product' });
  }
});

// API: Get activity logs for a product
app.get('/api/products/:id/activity-logs', (req, res) => {
  try {
    const productId = String(req.params.id || '').trim();
    const actionType = String(req.query.actionType || '').trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = parseInt(req.query.offset, 10);
    const computedOffset = Number.isFinite(offset) && offset >= 0 ? offset : (page - 1) * limit;

    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productKey = findProductKeyById(allData, productId);
    const product = productKey ? allData[productKey] : null;
    const aliases = new Set([
      productId,
      productKey,
      product?.itemNumber,
      product?.sku,
      product?.customLabel,
      product?.url
    ].filter(Boolean).map((v) => String(v)));

    const allLogs = loadProductActivityLogsStore();
    const filtered = allLogs.filter((log) => {
      const logProductId = String(log.productId || '');
      if (!aliases.has(logProductId)) return false;
      if (actionType && String(log.actionType || '') !== actionType) return false;
      return true;
    });

    let sourceLogs = filtered;

    // Backward-compatible fallback: synthesize activity from existing product fields
    // for products published before activity logging existed.
    if (sourceLogs.length === 0 && !actionType) {
      if (product) {
        const syntheticLogs = [];

        if (product.lastPublishedToProdAt || product.productionListingId || product.productionLink) {
          syntheticLogs.push({
            id: `synthetic-prod-${productId}`,
            productId,
            createdAt: product.lastPublishedToProdAt || product.lastPublishedAt || new Date().toISOString(),
            actionType: 'PRODUCT_PUBLISHED_PRODUCTION',
            actionDescription: `Product published to eBay production: Listing ID ${product.productionListingId || 'unknown'}`,
            sourceSystem: 'historical-backfill',
            newValue: {
              environment: 'production',
              listingId: product.productionListingId || null,
              listingLink: product.productionLink || null
            }
          });
        }

        if (product.lastPublishedAt || product.sandboxListingId || product.publishedLink) {
          syntheticLogs.push({
            id: `synthetic-sbx-${productId}`,
            productId,
            createdAt: product.lastPublishedAt || new Date().toISOString(),
            actionType: 'PRODUCT_PUBLISHED_SANDBOX',
            actionDescription: `Product published to eBay sandbox: Listing ID ${product.sandboxListingId || 'unknown'}`,
            sourceSystem: 'historical-backfill',
            newValue: {
              environment: 'sandbox',
              listingId: product.sandboxListingId || null,
              listingLink: product.publishedLink || null
            }
          });
        }

        syntheticLogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        sourceLogs = syntheticLogs;
      }
    }

    const logs = sourceLogs.slice(computedOffset, computedOffset + limit);

    return res.json({
      success: true,
      logs,
      totalCount: sourceLogs.length,
      hasMore: computedOffset + logs.length < sourceLogs.length
    });
  } catch (error) {
    console.error('Failed to fetch product activity logs:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load activity logs' });
  }
});

// API: Get single product
app.get('/api/products/:id', (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    const product = Object.values(allData).find(p => 
      p.itemNumber === req.params.id || 
      p.sku === req.params.id || 
      p.customLabel === req.params.id
    );
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const grouped = applyProductGroup(product);
    res.json({
      ...grouped,
      sku: grouped.sku || grouped.customLabel || '',
      productGroup: grouped.productGroup,
      productGroupLabel: getProductGroupLabel(grouped.productGroup)
    });
  } catch (error) {
    console.error('Error reading product:', error);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// ============================================================================
// eBay Orders API Endpoints
// ============================================================================

// GET /api/orders - Fetch orders with filters and caching
app.get('/api/orders', async (req, res) => {
  try {
    const ordersService = getEbayOrdersService();
    
    // Get query parameters
    const {
      source = 'ebay', // Future: support 'etsy', 'website'
      status = null,
      limit = 200,
      forceRefresh = false,
      environment = null
    } = req.query;

    // Currently only eBay is supported
    if (source !== 'ebay') {
      return res.status(400).json({
        success: false,
        error: `Source '${source}' not yet implemented. Currently only 'ebay' is supported.`
      });
    }

    // Fetch orders from eBay
    const result = await ordersService.fetchOrders({
      environment,
      limit: parseInt(limit, 10),
      orderStatus: status,
      forceRefresh: forceRefresh === 'true' || forceRefresh === '1'
    });

    return res.json({
      success: true,
      source,
      ...result
    });
  } catch (error) {
    console.error('[OrdersAPI] Error fetching orders:', error);
    
    const errorDetails = error.response?.data || null;
    const isOAuthError = error.errorType === 'oauth' || error.errorType === 'scope';
    
    return res.status(isOAuthError ? 401 : 500).json({
      success: false,
      error: error.message,
      details: errorDetails,
      errorType: error.errorType || 'unknown',
      solution: isOAuthError ? {
        message: 'Token missing required permissions',
        steps: [
          '1. Visit /api/ebay-auth-url to get a new authorization URL',
          '2. Complete the OAuth flow with your eBay account',
          '3. Update your EBAY_REFRESH_TOKEN (or EBAY_PROD_REFRESH_TOKEN) in .env with the new token',
          '4. Restart the server'
        ],
        quickLink: '/api/ebay-auth-url'
      } : null
    });
  }
});

// GET /api/orders/counts - Get order counts by status
app.get('/api/orders/counts', async (req, res) => {
  try {
    const ordersService = getEbayOrdersService();
    
    const { environment = null } = req.query;
    const counts = await ordersService.getOrderCounts(environment);
    
    return res.json({
      success: true,
      environment,
      counts
    });
  } catch (error) {
    console.error('[OrdersAPI] Error fetching order counts:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/orders/refresh - Force refresh orders cache
app.post('/api/orders/refresh', async (req, res) => {
  try {
    const ordersService = getEbayOrdersService();
    const { environment = null } = req.body;
    
    // Clear cache
    ordersService.clearCache(environment);
    
    // Fetch fresh data
    const result = await ordersService.fetchOrders({
      environment,
      forceRefresh: true
    });
    
    return res.json({
      success: true,
      message: 'Orders cache refreshed',
      ...result
    });
  } catch (error) {
    console.error('[OrdersAPI] Error refreshing orders:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// End eBay Orders API
// ============================================================================

// API: Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    const productKey = Object.keys(allData).find(key => {
      const p = allData[key];
      return p.itemNumber === req.params.id || p.sku === req.params.id || p.customLabel === req.params.id;
    });
    
    if (!productKey) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Update product fields
    const product = allData[productKey];

    // SKU update: rename image folder/files and remap all image URLs
    if (req.body.sku !== undefined) {
      const newSku = String(req.body.sku || '').trim();
      const oldSku = product.sku || product.customLabel || '';
      if (!newSku) {
        return res.status(400).json({ error: 'SKU cannot be empty' });
      }
      if (newSku !== oldSku) {
        const skuTaken = Object.entries(allData).some(([key, p]) =>
          key !== productKey && (p.sku === newSku || p.customLabel === newSku)
        );
        if (skuTaken) {
          return res.status(409).json({ error: `SKU "${newSku}" is already used by another product` });
        }

        const renameMap = renameProductSkuAssets(oldSku, newSku);
        const remapImagePaths = (list) => Array.isArray(list)
          ? list.map((imgPath) => renameMap.get(imgPath) || imgPath)
          : list;

        product.images = remapImagePaths(product.images);
        product.imageSourceUrls = remapImagePaths(product.imageSourceUrls);
        product.imagesOriginal = remapImagePaths(product.imagesOriginal);
        product.sku = newSku;
        if (product.customLabel) product.customLabel = newSku;
      }
    }

    if (req.body.title !== undefined) product.title = sanitizeTitle(String(req.body.title || ''));
    if (req.body.price !== undefined) product.price = req.body.price;
    if (req.body.inventory !== undefined) product.inventoryQuantity = req.body.inventory;
    if (req.body.description !== undefined) {
      if (Array.isArray(req.body.description)) {
        product.description = req.body.description.map((line) => sanitizeDescription(String(line || '')));
      } else {
        product.description = sanitizeDescription(String(req.body.description || ''));
      }
    }
    if (req.body.productGroup !== undefined) product.productGroup = req.body.productGroup;

    // eBay category (id + name are set together so they never end up mismatched)
    if (req.body.ebayCategoryId !== undefined || req.body.ebayCategory !== undefined) {
      const newCategoryId = String(req.body.ebayCategoryId || '').trim();
      const newCategory = String(req.body.ebayCategory || '').trim();
      product.ebayCategoryId = newCategoryId;
      product.ebayCategory = newCategory;
      product.category = newCategory;
      product.categoryId = newCategoryId;
    }

    // Weight and dimensions support
    if (req.body.weight !== undefined) product.weight = req.body.weight;
    if (req.body.weightUnit !== undefined) product.weightUnit = req.body.weightUnit;
    if (req.body.dimensions !== undefined) product.dimensions = req.body.dimensions;
    
    product.productGroup = detectProductGroup(product);
    product.productGroupLabel = getProductGroupLabel(product.productGroup);
    product.lastUpdated = new Date().toISOString();
    
    fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
    res.json({ success: true, product });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// API: Delete product
app.delete('/api/products/:url', async (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const url = decodeURIComponent(req.params.url);
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    
    if (!allData[url]) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    delete allData[url];
    fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});


// API: Bulk cleanup titles and descriptions with SEO optimization
app.post('/api/products/bulk/cleanup-titles', async (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.json({ updated: 0 });
    }
    
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    let updated = 0;
    const details = [];
    
    // Brand keywords and patterns to remove
    const removeBrandPatterns = [
      /SHARD\s*BLADE?/gi,
      /Shard\s*-?\s*Blade?/gi,
      /-?Blade\s+/gi,  // Remove "-Blade " or "Blade " from start
      /Lorandos/gi,
      /\bShard\b/gi,
      /\bstrapey\s*[®™]?\b/gi
    ];
    
    // Function to clean and optimize text for SEO
    function optimizeForSEO(text, type = 'title') {
      if (!text) return text;
      
      let optimized = text;
      
      // Remove brand patterns
      removeBrandPatterns.forEach(pattern => {
        optimized = optimized.replace(pattern, '');
      });

      // Remove trademark symbols (®, ™) across both title and description
      optimized = stripTrademarkSymbols(optimized);

      // Clean up extra spaces and punctuation
      optimized = optimized.replace(/\s+/g, ' ').trim();
      optimized = optimized.replace(/\s*-\s*-\s*/g, ' - '); // Fix double dashes
      optimized = optimized.replace(/^\s*-\s*/, ''); // Remove leading dash
      optimized = optimized.replace(/\s*-\s*$/, ''); // Remove trailing dash

      // Strip any leftover leading punctuation/symbols (e.g. a stray "® " left
      // behind once the brand name in front of it was removed) so the string
      // always starts on an actual word character.
      optimized = optimized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      
      if (type === 'title') {
        // Title case for better readability and SEO
        optimized = optimized.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
        
        // Fix common abbreviations that should stay uppercase
        const uppercaseTerms = [
          'USA', 'UK', 'US', 'EU',
          'Damascus', 'Steel',
          'Hand Forged', 'Hand-Forged',
          'Custom', 'Handmade',
          'Carbon', 'Stainless',
          'VG10', 'D2'
        ];
        
        uppercaseTerms.forEach(term => {
          const regex = new RegExp('\\b' + term + '\\b', 'gi');
          optimized = optimized.replace(regex, term);
        });
        
        // Ensure title isn't too long (eBay recommends 80 chars)
        if (optimized.length > 80) {
          optimized = optimized.substring(0, 77) + '...';
        }
      } else if (type === 'description') {
        // For descriptions, just clean up the text without title case
        // Ensure proper sentence capitalization
        optimized = optimized.replace(/\.\s+([a-z])/g, (match, char) => '. ' + char.toUpperCase());
        
        // Capitalize first letter
        if (optimized.length > 0) {
          optimized = optimized.charAt(0).toUpperCase() + optimized.slice(1);
        }
      }
      
      return optimized;
    }
    
    // Function to generate SEO keywords from title
    function generateSEOKeywords(title) {
      if (!title) return [];
      
      const keywords = [];
      const words = title.toLowerCase().split(/\s+/);
      
      // Extract meaningful words (ignore common words)
      const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'for'];
      const meaningfulWords = words.filter(w => 
        w.length > 3 && !stopWords.includes(w) && !/^\d+$/.test(w)
      );
      
      // Add individual keywords
      keywords.push(...meaningfulWords);
      
      // Add common phrases for knife/blade products
      if (title.toLowerCase().includes('damascus')) keywords.push('damascus steel');
      if (title.toLowerCase().includes('hand')) keywords.push('hand forged', 'handmade');
      if (title.toLowerCase().includes('knife')) keywords.push('custom knife', 'fixed blade');
      if (title.toLowerCase().includes('sword')) keywords.push('sword', 'blade weapon');
      
      // Return unique keywords
      return [...new Set(keywords)].slice(0, 15);
    }
    
    Object.keys(allData).forEach(key => {
      const product = allData[key];
      const originalTitle = product.title || '';
      const originalDescription = product.description || '';
      
      // Optimize title
      const optimizedTitle = optimizeForSEO(originalTitle, 'title');
      
      // Optimize description (handle both string and array formats)
      let optimizedDescription = originalDescription;
      if (Array.isArray(originalDescription)) {
        optimizedDescription = originalDescription.map(desc => optimizeForSEO(desc, 'description'));
      } else if (typeof originalDescription === 'string') {
        optimizedDescription = optimizeForSEO(originalDescription, 'description');
      }
      
      // Generate SEO metadata
      const seoKeywords = generateSEOKeywords(optimizedTitle);
      
      // Update product data
      allData[key].title = optimizedTitle;
      allData[key].description = optimizedDescription;
      allData[key].seoKeywords = seoKeywords;
      allData[key].lastUpdated = new Date().toISOString();
      allData[key].seoOptimized = true;
      allData[key].seoOptimizedAt = new Date().toISOString();
      
      // Track changes
      if (originalTitle !== optimizedTitle || originalDescription !== optimizedDescription) {
        updated++;
        details.push({
          id: key,
          oldTitle: originalTitle,
          newTitle: optimizedTitle,
          keywords: seoKeywords.slice(0, 5) // Top 5 keywords
        });
      }
    });
    
    fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
    
    console.log(`SEO Cleanup Complete: updated=${updated}, total=${Object.keys(allData).length}`);
    
    res.json({ 
      success: true, 
      updated,
      total: Object.keys(allData).length,
      sample: details.slice(0, 10) // Return first 10 as sample
    });
  } catch (error) {
    console.error('Error cleaning up titles:', error);
    res.status(500).json({ error: 'Failed to cleanup titles' });
  }
});

// API: Re-scrape single product
app.post('/api/products/:id/rescrape', async (req, res) => {
  try {
    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productId = req.params.id;
    let product = null;
    
    // Try to find product by URL (primary key), itemNumber, or sku
    if (allData[productId]) {
      product = allData[productId];
    } else {
      product = Object.values(allData).find(p => 
        p.itemNumber === productId || p.sku === productId || p.customLabel === productId
      );
    }
    
    if (!product || !product.url) {
      return res.status(404).json({ error: 'Product not found or missing URL' });
    }
    
    // Create single-item scrape job
    const items = [{
      itemNumber: product.itemNumber || '',
      link: product.url,
      sku: product.sku || product.customLabel || '',
      category: product.ebayCategory || product.category || '',
      categoryId: product.ebayCategoryId || product.categoryId || ''
    }];
    
    const jobId = await scrapeQueue.createScrapeJob(items, 'rescrape');
    
    res.json({
      success: true,
      jobId,
      message: 'Re-scraping product...',
      productUrl: product.url
    });
    
    // Process asynchronously
    setImmediate(async () => {
      await processScrapeJob(jobId);
    });
  } catch (error) {
    console.error('Error re-scraping product:', error);
    res.status(500).json({ error: 'Failed to re-scrape product' });
  }
});

// API: Get scraped data for product
app.get('/api/products/:id/scraped-data', (req, res) => {
  try {
    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productId = req.params.id;
    let product = null;
    
    // Try to find product by URL (primary key), itemNumber, or sku
    if (allData[productId]) {
      product = allData[productId];
    } else {
      product = Object.values(allData).find(p => 
        p.itemNumber === productId || p.sku === productId || p.customLabel === productId
      );
    }
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const grouped = applyProductGroup(product);

    res.json({
      success: true,
      scrapedData: {
        title: grouped.title,
        description: grouped.description,
        price: grouped.price,
        currency: grouped.currency,
        images: grouped.imageSourceUrls || grouped.images || grouped.imagesOriginal || [],
        localImages: grouped.imageSourceUrls || grouped.images || grouped.imagesOriginal || [],
        itemSpecifics: grouped.itemSpecifics || {},
        condition: grouped.condition,
        lastScrapedAt: grouped.lastScrapedAt,
        url: grouped.url,
        sku: grouped.sku || grouped.customLabel,
        productGroup: grouped.productGroup,
        productGroupLabel: getProductGroupLabel(grouped.productGroup)
      }
    });
  } catch (error) {
    console.error('Error getting scraped data:', error);
    res.status(500).json({ error: 'Failed to load scraped data' });
  }
});

function findProductKeyById(allData, productId) {
  if (allData[productId]) {
    return productId;
  }

  return Object.keys(allData).find((key) => {
    const p = allData[key];
    return p.itemNumber === productId || p.url === productId || p.sku === productId || p.customLabel === productId;
  });
}

// API: Publish single product to sandbox
app.post('/api/products/:id/publish/sandbox', async (req, res) => {
  try {
    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productKey = findProductKeyById(allData, req.params.id);
    
    if (!productKey) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = allData[productKey];
    
    // Validate product has required fields
    if (!product.title || !product.price || !product.imageSourceUrls || product.imageSourceUrls.length === 0) {
      return res.status(400).json({ 
        error: 'Product missing required fields (title, price, or images)' 
      });
    }
    
    // Use existing publishToEbay function
    const result = await publishToEbay(product, { environment: 'sandbox' });
    
    if (result.success) {
      // Update product with listing info
      allData[productKey].publishedLink = result.listingLink;
      allData[productKey].sandboxListingId = result.listingId;
      allData[productKey].lastPublishedAt = new Date().toISOString();
      fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });

      appendProductActivityLog({
        productId: req.params.id,
        actionType: 'PRODUCT_PUBLISHED_SANDBOX',
        actionDescription: `Product published to eBay sandbox: Listing ID ${result.listingId || 'unknown'}`,
        sourceSystem: 'publish-api',
        newValue: {
          environment: 'sandbox',
          listingId: result.listingId || null,
          listingLink: result.listingLink || null
        }
      });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error publishing to sandbox:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// API: Publish single product to production
app.post('/api/products/:id/publish/production', async (req, res) => {
  try {
    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productKey = findProductKeyById(allData, req.params.id);
    
    if (!productKey) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = allData[productKey];
    
    // Validate product
    if (!product.title || !product.price || !product.imageSourceUrls || product.imageSourceUrls.length === 0) {
      return res.status(400).json({ 
        error: 'Product missing required fields (title, price, or images)' 
      });
    }
    
    // Use existing publishToEbay function with production environment
    const result = await publishToEbay(product, { environment: 'production' });
    
    if (result.success) {
      // Update product with production listing info
      allData[productKey].productionLink = result.listingLink;
      allData[productKey].productionListingId = result.listingId;
      allData[productKey].publishedToProduction = true;
      allData[productKey].publishStatus = 'Published';
      allData[productKey].status = 'Published';
      allData[productKey].latestPublishedListingId = result.listingId || null;
      allData[productKey].latestPublishedLink = result.listingLink || null;
      allData[productKey].lastPublishEnvironment = 'production';
      allData[productKey].lastPublishedListingId = result.listingId || null;
      allData[productKey].lastPublishedLink = result.listingLink || null;
      allData[productKey].lastPublishedItemNumber = result.listingId || null;
      allData[productKey].lastPublishedToProdAt = new Date().toISOString();
      fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });

      appendProductActivityLog({
        productId: req.params.id,
        actionType: 'PRODUCT_PUBLISHED_PRODUCTION',
        actionDescription: `Product published to eBay production: Listing ID ${result.listingId || 'unknown'}`,
        sourceSystem: 'publish-api',
        newValue: {
          environment: 'production',
          listingId: result.listingId || null,
          listingLink: result.listingLink || null
        }
      });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error publishing to production:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      ebayErrors: error.response?.data?.errors || error.response?.data || null
    });
  }
});

// API: Publish single product to active runtime environment (Stage/Prod)
app.post('/api/products/:id/publish/active', async (req, res) => {
  try {
    const allData = fs.existsSync(DATA_FILE_PATH) ? fs.readJsonSync(DATA_FILE_PATH) : {};
    const productKey = findProductKeyById(allData, req.params.id);

    if (!productKey) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = allData[productKey];
    if (!product.title || !product.price || !product.imageSourceUrls || product.imageSourceUrls.length === 0) {
      return res.status(400).json({
        error: 'Product missing required fields (title, price, or images)'
      });
    }

    const runtimeMode = normalizeRuntimeMode(getRuntimeEnvironmentConfig().mode);
    const targetEnvironment = resolveEbayEnvironment();
    const result = await publishToEbay(product, { environment: targetEnvironment });

    if (result.success) {
      if (targetEnvironment === 'production') {
        allData[productKey].productionLink = result.listingLink;
        allData[productKey].productionListingId = result.listingId;
        allData[productKey].publishedToProduction = true;
        allData[productKey].publishStatus = 'Published';
        allData[productKey].status = 'Published';
        allData[productKey].latestPublishedListingId = result.listingId || null;
        allData[productKey].latestPublishedLink = result.listingLink || null;
        allData[productKey].lastPublishEnvironment = 'production';
        allData[productKey].lastPublishedListingId = result.listingId || null;
        allData[productKey].lastPublishedLink = result.listingLink || null;
        allData[productKey].lastPublishedItemNumber = result.listingId || null;
        allData[productKey].lastPublishedToProdAt = new Date().toISOString();
      } else {
        allData[productKey].publishedLink = result.listingLink;
        allData[productKey].sandboxListingId = result.listingId;
        allData[productKey].publishStatus = 'Published';
        allData[productKey].status = 'Published';
        allData[productKey].latestPublishedListingId = result.listingId || null;
        allData[productKey].latestPublishedLink = result.listingLink || null;
        allData[productKey].lastPublishEnvironment = 'sandbox';
        allData[productKey].lastPublishedListingId = result.listingId || null;
        allData[productKey].lastPublishedLink = result.listingLink || null;
        allData[productKey].lastPublishedItemNumber = result.listingId || null;
        allData[productKey].lastPublishedAt = new Date().toISOString();
      }
      allData[productKey].publishAction = runtimeMode;
      fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });

      appendProductActivityLog({
        productId: req.params.id,
        actionType: targetEnvironment === 'production' ? 'PRODUCT_PUBLISHED_PRODUCTION' : 'PRODUCT_PUBLISHED_SANDBOX',
        actionDescription: `Product published to eBay ${targetEnvironment}: Listing ID ${result.listingId || 'unknown'}`,
        sourceSystem: 'publish-api',
        newValue: {
          runtimeMode,
          environment: targetEnvironment,
          listingId: result.listingId || null,
          listingLink: result.listingLink || null
        }
      });
    }

    return res.json({
      ...result,
      runtimeMode,
      targetEnvironment
    });
  } catch (error) {
    console.error('Error publishing to active runtime environment:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Bulk import products with eBay categories
app.post('/api/products/import/bulk', async (req, res) => {
  try {
    const productsImportService = require('./src/modules/products/products.import.service');
    
    // Get raw body as text
    let csvText = '';
    
    if (typeof req.body === 'string') {
      csvText = req.body;
    } else if (req.body && req.body.data) {
      csvText = req.body.data;
    } else {
      return res.status(400).json({
        success: false,
        error: 'No data provided'
      });
    }

    if (!csvText || csvText.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'No data provided'
      });
    }

    // Parse the CSV data
    const products = productsImportService.parseProductData(csvText);
    
    // Import products with intelligent upsert
    const results = await productsImportService.importProducts(products, {
      updateExisting: true,
      keepScrapedData: true
    });

    // Transform results to match frontend expectations
    const responseData = {
      success: true,
      imported: results.created.length,
      updated: results.updated.length,
      skipped: results.skipped ? results.skipped.length : 0,
      errors: results.failed.length,
      message: `✓ ${results.created.length} new products added, ${results.updated.length} updated, ${results.skipped ? results.skipped.length : 0} unchanged (skipped)`,
      details: [
        ...results.created.map(item => ({
          sku: item.sku,
          title: item.sku,
          ebayCategory: item.category,
          ebayCategoryId: item.categoryId,
          productGroup: item.productGroup,
          status: 'created'
        })),
        ...results.updated.map(item => ({
          sku: item.sku,
          title: item.sku,
          ebayCategory: item.category,
          ebayCategoryId: item.categoryId,
          productGroup: item.productGroup,
          status: 'updated'
        })),
        ...(results.skipped || []).map(item => ({
          sku: item.sku,
          title: item.sku,
          reason: item.reason,
          status: 'skipped'
        }))
      ]
    };

    res.json(responseData);
  } catch (error) {
    console.error('Import error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// API: Get bulk import template
app.get('/api/products/import/template', (req, res) => {
  const template = `Item number\tLink\tCustom label (SKU)\tTitle\tAvailable quantity\tCurrency\tStart price\teBay category 1 name\teBay category 1 number
304569312160\thttps://www.ebay.com/itm/304569312160\tUSL\t1911 Classic Wood Grips\t4\tUSD\t23.28\tPistol Parts\t73944`;
  
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ebay-import-template.tsv"');
  res.send(template);
});

// API: Publish to eBay Sandbox
app.post('/api/ebay/publish-sandbox', async (req, res) => {
  const logger = createLogger('eBay-Publish-Sandbox');
  
  try {
    const { productUrl, requireHostedImages = true, environment } = req.body;
    const ebayEnv = resolveEbayEnvironment({ environment });
    
    logger.info('=== EBAY SANDBOX PUBLISH STARTED ===');
    logger.info('Step 1: Validating request', { productUrl });
    
    if (!productUrl) {
      logger.error('Step 1 FAILED: productUrl is required');
      return res.status(400).json({ error: 'productUrl is required' });
    }
    
    logger.info('Step 2: Checking if data file exists', { path: DATA_FILE_PATH });
    if (!fs.existsSync(DATA_FILE_PATH)) {
      logger.error('Step 2 FAILED: Data file not found');
      return res.status(404).json({ error: 'Product not found' });
    }
    
    logger.info('Step 3: Loading product data');
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    let product = forceNewConditionDefaults(allData[productUrl]);
    
    if (!product) {
      logger.error('Step 3 FAILED: Product not found in data', { productUrl });
      return res.status(404).json({ error: 'Product not found' });
    }

    allData[productUrl] = product;
    
    logger.info('Step 3 SUCCESS: Product loaded', { 
      itemNumber: product.itemNumber, 
      sku: product.sku || product.customLabel,
      title: product.title 
    });
    
    // Check if this exact product is already published
    logger.info('Step 4: Checking if product already published');
    if (product.publishedLink) {
      logger.info('Step 4: Product already published', { 
        listingId: product.listingId,
        publishedLink: product.publishedLink 
      });
      return res.status(200).json({ 
        success: true,
        alreadyPublished: true,
        message: 'Product already published', 
        publishedLink: product.publishedLink,
        listingId: product.listingId 
      });
    }
    
    // Check for similar items already published (by SKU or item number)
    const sku = product.sku || product.customLabel;
    const itemNumber = product.itemNumber;
    
    logger.info('Step 5: Checking for similar published items', { sku, itemNumber });
    
    let similarPublishedProduct = null;
    if (sku || itemNumber) {
      similarPublishedProduct = Object.values(allData).find(p => {
        if (!p.publishedLink) return false;
        if (sku && (p.sku === sku || p.customLabel === sku)) return true;
        if (itemNumber && p.itemNumber === itemNumber) return true;
        return false;
      });
    }
    
    // If similar item already published, return existing link and update current product
    if (similarPublishedProduct) {
      logger.info('Step 5: Similar item found, reusing listing', { 
        existingListingId: similarPublishedProduct.listingId,
        existingPublishedLink: similarPublishedProduct.publishedLink 
      });
      
      product.listingId = similarPublishedProduct.listingId;
      product.publishedLink = similarPublishedProduct.publishedLink;
      product.publishedDate = similarPublishedProduct.publishedDate;
      product.publishAction = 'sandbox';
      product.lastUpdated = new Date().toISOString();
      
      fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
      
      logger.info('Step 6: Updated product with existing listing info');
      logger.info('=== EBAY SANDBOX PUBLISH COMPLETED (REUSED) ===');
      
      return res.status(200).json({ 
        success: true,
        alreadyPublished: true,
        message: 'Similar item already published',
        publishedLink: similarPublishedProduct.publishedLink,
        listingId: similarPublishedProduct.listingId 
      });
    }
    
    logger.info('Step 5 RESULT: No similar items found, proceeding with new listing');
    
    // Check for eBay API credentials from .env
    logger.warn('Step 6: Checking eBay API credentials');
    const runtimeEbayConfig = getEbayRuntimeConfig({ environment: ebayEnv });
    const ebayUserToken = runtimeEbayConfig.userToken;
    
    // Detailed credential verification logging
    logger.info('CREDENTIAL VERIFICATION:', {
      hasUserToken: !!ebayUserToken,
      userTokenLength: ebayUserToken?.length,
      userTokenStart: ebayUserToken?.substring(0, 30),
      ebayEnv: ebayEnv
    });
    
    if (!ebayUserToken) {
      logger.warn('Step 6: Missing eBay User Token. EBAY_USER_TOKEN not in .env');
      logger.warn('FALLING BACK TO MOCK MODE');
      return createMockListing(product, sku, logger, res, allData, 'Missing eBay User Token in .env');
    }
    
    logger.info('Step 6 SUCCESS: Found eBay User Token');
    logger.info('Detected environment:', { ebayEnv });
    
    // Step 7: Call eBay Trading API AddItem using User Token
    logger.info('Step 7: Creating item listing on eBay Trading API');
    
    const { tradingBase: tradingApiEndpoint } = getEbayBaseUrls({ environment: ebayEnv });
    
    const inventorySku = sku || `SKU-${Date.now()}`;

    const oauthToken = await getEbayAccessToken({ environment: ebayEnv });
    const { listingImageUrls } = await prepareListingImageUrls({
      imageSourceUrls: product.imageSourceUrls,
      token: oauthToken,
      logger,
      requireEps: Boolean(requireHostedImages)
    });

    const videoAsset = await generateMarketingVideoWithMediaApi({
      sku: inventorySku,
      title: product.title,
      description: product.description,
      imageUrls: listingImageUrls
    }, logger).catch((error) => {
      logger.warn('Trading path video generation unavailable, continuing with images only', { error: error.message });
      return { enabled: false, reason: error.message };
    });

    const pictureDetailsXml = buildTradingPictureDetailsXml(listingImageUrls);
    const videoDetailsXml = buildTradingVideoDetailsXml(videoAsset);
    
    // Build the AddItem XML payload for eBay Trading API
    const addItemXml = `<?xml version="1.0" encoding="utf-8"?>
<AddItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayUserToken}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <Title>${escapeXml(product.title || 'Product')}</Title>
    <Description>${escapeXml(product.description || product.title || 'Product')}</Description>
    <PrimaryCategory>
      <CategoryID>${runtimeEbayConfig.categoryId || '15687'}</CategoryID>
    </PrimaryCategory>
    <StartPrice>${product.price || 9.99}</StartPrice>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>1000</ConditionID>
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>3</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>United States</Location>
    <Quantity>${product.inventory || 1}</Quantity>
    <SKU>${inventorySku}</SKU>
  ${pictureDetailsXml}${videoDetailsXml}
    <ItemSpecifics>
      <NameValueList>
        <Name>Brand</Name>
        <Value>${escapeXml('Strapey')}</Value>
      </NameValueList>
      <NameValueList>
        <Name>Color</Name>
        <Value>${escapeXml(product.color || 'Black')}</Value>
      </NameValueList>
      <NameValueList>
        <Name>Size</Name>
        <Value>${escapeXml(product.size || 'Standard')}</Value>
      </NameValueList>
      <NameValueList>
        <Name>Department</Name>
        <Value>${escapeXml(product.department || 'Unisex')}</Value>
      </NameValueList>
      <NameValueList>
        <Name>Size Type</Name>
        <Value>${escapeXml(product.sizeType || 'Regular')}</Value>
      </NameValueList>
      <NameValueList>
        <Name>Condition</Name>
        <Value>New</Value>
      </NameValueList>
    </ItemSpecifics>
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSPriority</ShippingService>
        <ShippingServiceCost>5.99</ShippingServiceCost>
        <ShippingServiceAdditionalCost>0.99</ShippingServiceAdditionalCost>
      </ShippingServiceOptions>
    </ShippingDetails>
  </Item>
</AddItemRequest>`;
    
    logger.info('Step 7: Sending AddItem request to eBay Trading API');
    logger.debug('XML Payload:', addItemXml);
    
    let listingId;
    try {
      const tradingResponse = await axios.post(tradingApiEndpoint, addItemXml, {
        headers: {
          'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
          'X-EBAY-API-DEV-NAME': runtimeEbayConfig.devId || 'DevID',
          'X-EBAY-API-APP-NAME': runtimeEbayConfig.clientId || 'AppID',
          'X-EBAY-API-CERT-NAME': runtimeEbayConfig.certId || 'CertID',
          'X-EBAY-API-CALL-NAME': 'AddItem',
          'X-EBAY-API-SITEID': runtimeEbayConfig.siteId || '0',
          'Content-Type': 'text/xml'
        },
        timeout: 45000
      });
      
      // Parse XML response to get ItemID (listing ID)
      const xmlResponse = tradingResponse.data;
      logger.debug('Trading API Response:', xmlResponse);
      
      // Extract ItemID from response (simplified - you might need a proper XML parser)
      const itemIdMatch = xmlResponse.match(/<ItemID>(\d+)<\/ItemID>/);
      if (itemIdMatch) {
        listingId = itemIdMatch[1];
        logger.info('Step 7 SUCCESS: Item created on eBay Trading API');
        logger.info('Real eBay Listing ID:', listingId);
      } else {
        logger.error('Step 7 WARNING: No ItemID found in response');
        logger.debug('Full XML Response:', xmlResponse);
        
        // Check for errors in response
        const errorMatch = xmlResponse.match(/<LongMessage>(.*?)<\/LongMessage>/);
        if (errorMatch) {
          const errorMsg = errorMatch[1];
          logger.error('eBay API Error:', errorMsg);
          return createMockListing(product, sku, logger, res, allData, `eBay API Error: ${errorMsg}`);
        }
        
        return res.status(500).json({
          error: 'Failed to create eBay listing',
          message: 'ItemID not found in response'
        });
      }
    } catch (error) {
      logger.error('Step 7 FAILED: Could not create item on eBay');
      logger.error('Error status:', error.response?.status);
      logger.error('Error body:', error.response?.data || error.message);
      
      // Parse XML error response
      const xmlResponse = error.response?.data || '';
      const errorMatch = xmlResponse.match(/<LongMessage>(.*?)<\/LongMessage>/);
      const errorMessage = errorMatch ? errorMatch[1] : error.message;
      
      logger.error('eBay Error Message:', errorMessage);
      
      if (errorMessage.includes('permission') || errorMessage.includes('credentials') || errorMessage.toLowerCase().includes('seller')) {
        logger.error('PERMISSION ERROR: Check eBay seller account status');
        logger.warn('ACTION REQUIRED: Verify seller permissions in eBay sandbox account');
        return createMockListing(product, sku, logger, res, allData, `Permission Error: ${errorMessage}`);
      }
      
      return res.status(500).json({
        error: 'Failed to create eBay listing',
        message: errorMessage
      });
    }
    
    // Construct the eBay listing URL
    const ebayBaseUrl = ebayEnv === 'sandbox' 
      ? 'https://www.sandbox.ebay.com/itm'
      : 'https://www.ebay.com/itm';
    const publishedLink = `${ebayBaseUrl}/${listingId}`;
    
    // Step 11: Save to database
    logger.info('Step 11: Saving listing data to database');
    product.listingId = listingId;
    product.publishedLink = publishedLink;
    product.publishedDate = new Date().toISOString();
    product.publishAction = 'sandbox-real';
    product.lastUpdated = new Date().toISOString();
    product.condition = 'NEW';
    product.conditionDisplay = 'New';

    allData[productUrl] = product;
    
    fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
    logger.info('Step 11 SUCCESS: Product data saved');
    
    logger.info('=== EBAY SANDBOX PUBLISH COMPLETED SUCCESSFULLY ===');
    logger.info('Final Listing Details:', {
      listingId,
      publishedLink,
      sku: inventorySku,
      title: product.title,
      price: product.price
    });
    
    return res.json({ 
      success: true, 
      listingId,
      publishedLink,
      message: 'Product published to eBay Sandbox successfully',
      mode: 'sandbox-real',
      media: {
        imageCount: listingImageUrls.length,
        hostedImagesRequired: Boolean(requireHostedImages),
        video: videoAsset
      }
    });
    
  } catch (error) {
    logger.error('=== EBAY SANDBOX PUBLISH FAILED ===');
    logger.error('Error:', error.message);
    logger.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to publish to eBay: ' + error.message });
  }
});

// Helper function to escape XML special characters
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper function to create mock listing
function createMockListing(product, sku, logger, res, allData, reason = 'No API credentials') {
  logger.info('Creating MOCK listing');
  const mockListingId = `SB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const mockPublishedLink = `https://www.sandbox.ebay.com/itm/${mockListingId}`;
  
  logger.warn('⚠️  WARNING: This is a SIMULATED listing');
  logger.warn('⚠️  Reason:', reason);
  logger.warn('⚠️  The listing ID and URL are NOT real eBay listings');
  
  if (reason.includes('permission') || reason.includes('Permission')) {
    logger.warn('⚠️  ACTION REQUIRED:');
    logger.warn('    1. Go to https://developer.ebay.com/');
    logger.warn('    2. In your sandbox account under "My eBay" → "Account"');
    logger.warn('    3. Verify you have "Sell" permissions enabled');
    logger.warn('    4. After enabling, restart the server and try again');
  }
  
  product.listingId = mockListingId;
  product.publishedLink = mockPublishedLink;
  product.publishedDate = new Date().toISOString();
  product.publishAction = 'sandbox-mock';
  product.lastUpdated = new Date().toISOString();
  
  fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
  
  return res.json({ 
    success: true, 
    listingId: mockListingId,
    publishedLink: mockPublishedLink,
    message: `⚠️ MOCK LISTING (${reason})`,
    warning: 'This is a simulated listing. ' + (reason.includes('permission') ? 'Enable seller permissions in eBay sandbox and restart.' : 'Add valid eBay credentials to .env for real publishing.'),
    mode: 'sandbox-mock-fallback',
    reason
  });
}

function getDefaultAdminConfig() {
  return {
    media: {
      enableMediaVideo: true,
      mediaApiBaseUrl: '',
      mediaApiKey: '',
      mediaCreatePath: '/videos/create',
      maxImagesForVideo: 12,
      videoDurationSeconds: 18,
      style: 'product-showcase'
    },
    marketing: {
      enableMarketingEngine: true,
      marketingWebhookUrl: '',
      marketingRetryAttempts: 3,
      marketingRetryDelayMs: 1000,
      marketplaceId: 'EBAY_US'
    },
    ebay: {
      useEpsImages: false,
      compatibilityLevel: '1231',
      siteId: '0'
    },
    updatedAt: null
  };
}

function sanitizeAdminConfig(input = {}) {
  const defaults = getDefaultAdminConfig();
  const media = input.media || {};
  const marketing = input.marketing || {};
  const ebay = input.ebay || {};

  return {
    media: {
      enableMediaVideo: media.enableMediaVideo !== undefined ? Boolean(media.enableMediaVideo) : defaults.media.enableMediaVideo,
      mediaApiBaseUrl: String(media.mediaApiBaseUrl || defaults.media.mediaApiBaseUrl).trim(),
      mediaApiKey: String(media.mediaApiKey || defaults.media.mediaApiKey).trim(),
      mediaCreatePath: String(media.mediaCreatePath || defaults.media.mediaCreatePath).trim() || defaults.media.mediaCreatePath,
      maxImagesForVideo: Number.isFinite(Number(media.maxImagesForVideo)) ? Math.max(2, Math.min(24, Number(media.maxImagesForVideo))) : defaults.media.maxImagesForVideo,
      videoDurationSeconds: Number.isFinite(Number(media.videoDurationSeconds)) ? Math.max(6, Math.min(60, Number(media.videoDurationSeconds))) : defaults.media.videoDurationSeconds,
      style: String(media.style || defaults.media.style).trim() || defaults.media.style
    },
    marketing: {
      enableMarketingEngine: marketing.enableMarketingEngine !== undefined ? Boolean(marketing.enableMarketingEngine) : defaults.marketing.enableMarketingEngine,
      marketingWebhookUrl: String(marketing.marketingWebhookUrl || defaults.marketing.marketingWebhookUrl).trim(),
      marketingRetryAttempts: Number.isFinite(Number(marketing.marketingRetryAttempts)) ? Math.max(1, Math.min(6, Number(marketing.marketingRetryAttempts))) : defaults.marketing.marketingRetryAttempts,
      marketingRetryDelayMs: Number.isFinite(Number(marketing.marketingRetryDelayMs)) ? Math.max(250, Math.min(10000, Number(marketing.marketingRetryDelayMs))) : defaults.marketing.marketingRetryDelayMs,
      marketplaceId: String(marketing.marketplaceId || defaults.marketing.marketplaceId).trim() || defaults.marketing.marketplaceId
    },
    ebay: {
      useEpsImages: ebay.useEpsImages !== undefined ? Boolean(ebay.useEpsImages) : defaults.ebay.useEpsImages,
      compatibilityLevel: String(ebay.compatibilityLevel || defaults.ebay.compatibilityLevel).trim() || defaults.ebay.compatibilityLevel,
      siteId: String(ebay.siteId || defaults.ebay.siteId).trim() || defaults.ebay.siteId
    },
    updatedAt: new Date().toISOString()
  };
}

function loadAdminConfig() {
  const defaults = getDefaultAdminConfig();
  if (!fs.existsSync(ADMIN_CONFIG_PATH)) {
    return defaults;
  }

  try {
    const saved = fs.readJsonSync(ADMIN_CONFIG_PATH);
    return sanitizeAdminConfig({
      ...defaults,
      ...saved,
      media: { ...defaults.media, ...(saved.media || {}) },
      marketing: { ...defaults.marketing, ...(saved.marketing || {}) },
      ebay: { ...defaults.ebay, ...(saved.ebay || {}) }
    });
  } catch (error) {
    console.warn('Failed to read admin config, using defaults:', error.message);
    return defaults;
  }
}

function saveAdminConfig(config) {
  const safe = sanitizeAdminConfig(config);
  fs.writeJsonSync(ADMIN_CONFIG_PATH, safe, { spaces: 2 });
  return safe;
}

function getRuntimeConfig() {
  const fileConfig = loadAdminConfig();

  return {
    media: {
      enableMediaVideo: String(process.env.ENABLE_MEDIA_VIDEO || `${fileConfig.media.enableMediaVideo}`).toLowerCase() === 'true',
      mediaApiBaseUrl: String(process.env.MEDIA_API_BASE_URL || fileConfig.media.mediaApiBaseUrl || '').trim(),
      mediaApiKey: String(process.env.MEDIA_API_KEY || fileConfig.media.mediaApiKey || '').trim(),
      mediaCreatePath: String(process.env.MEDIA_API_CREATE_PATH || fileConfig.media.mediaCreatePath || '/videos/create').trim(),
      maxImagesForVideo: Number(process.env.MEDIA_MAX_IMAGES || fileConfig.media.maxImagesForVideo || 12),
      videoDurationSeconds: Number(process.env.MEDIA_VIDEO_DURATION_SECONDS || fileConfig.media.videoDurationSeconds || 18),
      style: String(process.env.MEDIA_VIDEO_STYLE || fileConfig.media.style || 'product-showcase').trim()
    },
    marketing: {
      enableMarketingEngine: String(process.env.ENABLE_MARKETING_ENGINE || `${fileConfig.marketing.enableMarketingEngine}`).toLowerCase() === 'true',
      marketingWebhookUrl: String(process.env.MARKETING_WEBHOOK_URL || fileConfig.marketing.marketingWebhookUrl || '').trim(),
      marketingRetryAttempts: Number(process.env.MARKETING_RETRY_ATTEMPTS || fileConfig.marketing.marketingRetryAttempts || 3),
      marketingRetryDelayMs: Number(process.env.MARKETING_RETRY_DELAY_MS || fileConfig.marketing.marketingRetryDelayMs || 1000),
      marketplaceId: String(process.env.EBAY_MARKETPLACE_ID || fileConfig.marketing.marketplaceId || 'EBAY_US').trim()
    },
    ebay: {
      useEpsImages: String(process.env.EBAY_USE_EPS_IMAGES || `${fileConfig.ebay.useEpsImages}`).toLowerCase() === 'true',
      compatibilityLevel: String(process.env.EBAY_COMPATIBILITY_LEVEL || fileConfig.ebay.compatibilityLevel || '1231').trim(),
      siteId: String(process.env.EBAY_SITE_ID || fileConfig.ebay.siteId || '0').trim()
    },
    loadedFromFile: fs.existsSync(ADMIN_CONFIG_PATH)
  };
}

/** SEO-friendly title: clean, concise, ~60–80 chars for snippets, title-style. */
function makeSeoTitle(raw, itemSpecifics = {}) {
  if (!raw || typeof raw !== 'string') return 'Product';

  let t = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*[|\-–—]\s*$/i, '')
    .trim();

  // Remove common eBay clutter
  t = t.replace(/\s*(New Listing|Free shipping|Best offer|\d+\s*available)\s*$/gi, '').trim();

  // Brand name must never appear in the title text itself (it's the value of the
  // Brand item specific/aspect, not title copy) - strip any occurrence, including
  // a trailing trademark symbol, rather than prepending it as SEO copy.
  t = t.replace(/\bstrapey\s*[®™]?\s*/gi, '').replace(/\s{2,}/g, ' ').trim();

  // Strip any stray trademark symbol / punctuation left dangling at the start
  // (e.g. a source brand name was stripped upstream, leaving just "® ").
  t = t.replace(/[™®]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s{2,}/g, ' ').trim();

  // Optimize length: ideal 80-90 chars for search results, max 90
  if (t.length > 90) {
    // Try to cut at word boundary
    let truncated = t.substring(0, 87).trim();
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 80) {
      truncated = truncated.substring(0, lastSpace).trim();
    }
    t = (truncated.length > 0 ? truncated : t.substring(0, 87).trim()) + '...';
  }

  return t || 'Product';
}

/** SEO-friendly description: structure, keywords, full content, remove eBay boilerplate */
const DESCRIPTION_MAX_LENGTH = 20000;

function makeSeoDescription(raw, itemSpecifics = {}, title = '', product = {}) {
  // eBay requires a non-empty description (1-4000 chars) to publish a listing.
  // Scrapes that get blocked/interstitial-blocked can leave raw description
  // empty; fall back to the title so we never hand eBay an empty string.
  const rawText = (raw && typeof raw === 'string') ? raw : '';

  // Clean up eBay boilerplate
  let d = rawText
    .replace(/\s*Read more\s*/gi, ' ')
    .replace(/\s*Item specifics[\s\S]*?opens in a new window or tab\s*/gi, ' ')
    .replace(/\s*See all condition definitions\s*/gi, ' ')
    .replace(/\s*See the seller's listing for full details\.?\s*/gi, ' ')
    .replace(/\s*Shipping.*?(?=\n|$)/gi, ' ')
    .replace(/\s*Returns.*?(?=\n|$)/gi, ' ')
    .replace(/\s*Payments.*?(?=\n|$)/gi, ' ')
    .replace(/\s*Estimated total.*?(?=\n|$)/gi, ' ')
    .replace(/\s*Was.*?(?=\n|$)/gi, ' ')
    .replace(/\s*Item price.*?(?=\n|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Use branded description if product has group classification
  if (product.productGroup && product.productGroup !== 'other') {
    try {
      const branded = generateBrandedDescription({
        ...product,
        description: d,
        itemSpecifics,
        includeSpecs: true,
        includeBrand: true
      });
      
      if (branded && branded.length > 0) {
        return branded.substring(0, DESCRIPTION_MAX_LENGTH);
      }
    } catch (error) {
      console.warn('Failed to generate branded description, using fallback:', error.message);
    }
  }
  
  // Fallback: Build enhanced description with structure
  let enhanced = d;
  
  // Add key specifications if available
  const specs = [];
  if (itemSpecifics.Brand) specs.push(`Brand: ${itemSpecifics.Brand}`);
  if (itemSpecifics['Blade Material']) specs.push(`Material: ${itemSpecifics['Blade Material']}`);
  if (itemSpecifics['Blade Type']) specs.push(`Type: ${itemSpecifics['Blade Type']}`);
  if (itemSpecifics.Color) specs.push(`Color: ${itemSpecifics.Color}`);
  // Business rule: all outbound listings are published as New condition.
  specs.push('Condition: New');
  if (itemSpecifics.Handmade) specs.push(`Handmade: Yes`);
  if (itemSpecifics['Country of Origin']) specs.push(`Origin: ${itemSpecifics['Country of Origin']}`);
  
  if (specs.length > 0) {
    enhanced = `${d}\n\nKey Features:\n${specs.join(' • ')}\n\nProduct Details: This premium item combines quality craftsmanship with exceptional durability. Perfect for collectors and professionals alike.`;
  } else {
    enhanced = `${d}\n\nThis is a premium quality product designed for discerning buyers who appreciate excellence and durability.`;
  }
  
  // Truncate if necessary
  if (enhanced.length > DESCRIPTION_MAX_LENGTH) {
    enhanced = enhanced.substring(0, DESCRIPTION_MAX_LENGTH - 3).trim() + '...';
  }
  
  return enhanced;
}

function forceNewConditionDefaults(product = {}) {
  const normalized = { ...(product || {}) };
  normalized.condition = 'NEW';
  normalized.conditionDisplay = 'New';

  const existingSpecifics = (normalized.itemSpecifics && typeof normalized.itemSpecifics === 'object')
    ? normalized.itemSpecifics
    : {};

  normalized.itemSpecifics = {
    ...existingSpecifics,
    Condition: 'New'
  };

  if (typeof normalized.description === 'string' && normalized.description.trim()) {
    normalized.description = normalized.description
      .replace(/condition\s*:\s*pre-owned\s*-\s*good\s*pre-owned\s*-\s*good/gi, 'Condition: New')
      .replace(/condition\s*:\s*pre-owned\s*-\s*good/gi, 'Condition: New');
  }

  return normalized;
}

async function extractEbayImageUrlsFromListing(productUrl, logger = null) {
  if (!productUrl || !/^https?:\/\//i.test(String(productUrl))) return [];
  try {
    const response = await axios.get(String(productUrl), {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    const html = String(response.data || '');
    const matches = html.match(/https?:\/\/i\.ebayimg\.com\/images\/[^"'\s<>)]+/gi) || [];
    const unique = Array.from(new Set(matches.map((u) => u.replace(/&amp;/g, '&').trim())));
    const cleaned = validateEbayHostedImageUrls(unique);
    if (logger) logger.info('Recovered eBay-hosted images from listing page', {
      sourceUrl: productUrl,
      discovered: unique.length,
      usable: cleaned.length
    });
    return cleaned;
  } catch (error) {
    if (logger) logger.warn('Failed to recover eBay-hosted images from listing page', {
      sourceUrl: productUrl,
      error: error.message
    });
    return [];
  }
}

async function extractEbayImageUrlsFromItemId(itemId, token, logger = null) {
  if (!itemId) return [];
  try {
    const { tradingBase } = getEbayBaseUrls();
    const runtime = getRuntimeConfig();
    const compatibilityLevel = runtime.ebay.compatibilityLevel || '1231';
    const siteId = runtime.ebay.siteId || '0';
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">\n  <ErrorLanguage>en_US</ErrorLanguage>\n  <WarningLevel>High</WarningLevel>\n  <DetailLevel>ReturnAll</DetailLevel>\n  <ItemID>${escapeXml(String(itemId))}</ItemID>\n</GetItemRequest>`;

    const response = await axios.post(tradingBase, xmlBody, {
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': compatibilityLevel,
        'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
        'X-EBAY-API-APP-NAME': process.env.EBAY_CLIENT_ID || '',
        'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
        'X-EBAY-API-SITEID': siteId,
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-IAF-TOKEN': token
      },
      timeout: 30000
    });

    const xml = String(response.data || '');
    const matches = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)].map((m) => String(m[1] || '').trim());
    const cleaned = validateEbayHostedImageUrls(Array.from(new Set(matches)));
    if (logger) logger.info('Recovered eBay-hosted images from Trading GetItem', {
      itemId: String(itemId),
      discovered: matches.length,
      usable: cleaned.length
    });
    return cleaned;
  } catch (error) {
    if (logger) logger.warn('Failed to recover eBay-hosted images from Trading GetItem', {
      itemId: String(itemId),
      error: error.message
    });
    return [];
  }
}

async function prepareListingImageUrls({ imageSourceUrls, remoteImageUrls = [], productUrl = '', itemId = '', token, logger, requireEps = true }) {
  const validatedSource = validateSourceImageUrls(Array.isArray(imageSourceUrls) ? imageSourceUrls : []);
  const validatedRemote = validateEbayHostedImageUrls(Array.isArray(remoteImageUrls) ? remoteImageUrls : []);
  const validatedSourceEbay = validateEbayHostedImageUrls(validatedSource);

  let ebayHostedCandidates = Array.from(new Set([
    ...validatedRemote,
    ...validatedSourceEbay
  ])).slice(0, 24);

  if (!ebayHostedCandidates.length && itemId) {
    const recoveredByItem = await extractEbayImageUrlsFromItemId(itemId, token, logger);
    ebayHostedCandidates = Array.from(new Set(recoveredByItem)).slice(0, 24);
  }

  if (!ebayHostedCandidates.length && productUrl) {
    const recovered = await extractEbayImageUrlsFromListing(productUrl, logger);
    ebayHostedCandidates = Array.from(new Set(recovered)).slice(0, 24);
  }
  
  if (logger) {
    logger.info('Image preparation started', {
      input: Array.isArray(imageSourceUrls) ? imageSourceUrls.length : 0,
      validatedSource: validatedSource.length,
      validatedRemote: validatedRemote.length,
      ebayHostedCandidates: ebayHostedCandidates.length,
      requireEps
    });
  }

  if (!ebayHostedCandidates.length) {
    throw new Error('Cannot publish: no eBay-hosted images available. Rescrape the product to recover eBay image URLs.');
  }

  if (!requireEps) {
    if (logger) logger.info('EPS upload skipped (requireEps=false)');
    return {
      sourceImageUrls: validatedSource,
      listingImageUrls: ebayHostedCandidates,
      epsEnabled: false,
      uploadedToEps: false
    };
  }

  // Existing approach policy: do NOT attach public-domain URLs; keep only eBay-hosted image URLs.
  // We still normalize through EPS when available, but reject non-ebay fallbacks.
  if (logger) logger.info('Starting EPS upload using eBay-hosted candidates only', { imageCount: ebayHostedCandidates.length });
  const hosted = await convertToEbayHostedImageUrls(ebayHostedCandidates, token, logger);
  const validHosted = validateEbayHostedImageUrls(hosted.length ? hosted : ebayHostedCandidates);
  
  if (logger) {
    logger.info('EPS upload completed', {
      uploaded: hosted.length,
      valid: validHosted.length,
      failed: hosted.length - validHosted.length
    });
  }

  if (!validHosted.length) {
    throw new Error('Cannot publish: image hosting/enhancement failed, no valid listing images available.');
  }

  return {
    sourceImageUrls: validatedSource,
    listingImageUrls: validHosted,
    epsEnabled: true,
    uploadedToEps: true
  };
}

function buildTradingPictureDetailsXml(imageUrls = []) {
  const safeUrls = (Array.isArray(imageUrls) ? imageUrls : [])
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    .slice(0, 24);

  if (!safeUrls.length) return '';

  const lines = safeUrls.map((url) => `      <PictureURL>${escapeXml(url)}</PictureURL>`).join('\n');
  return `\n    <PictureDetails>\n${lines}\n    </PictureDetails>`;
}

function buildTradingVideoDetailsXml(videoAsset = {}) {
  if (!videoAsset || !videoAsset.ebayVideoId) return '';
  return `\n    <VideoDetails>\n      <VideoID>${escapeXml(String(videoAsset.ebayVideoId))}</VideoID>\n    </VideoDetails>`;
}

// --- Image enhancement config: size, background, quality ---
const IMAGE_CONFIG = {
  // Size & Canvas
  targetSize: 2400,                    // Output canvas width & height (px)
  background: { r: 248, g: 248, b: 248, alpha: 1 },  // Light gray, consistent across all images
  
  // Quality Enhancement
  sharpenSigma: 1.5,                  // Sharpen strength for clarity
  webpQuality: 98,                     // Max practical quality (1–100)
  webpEffort: 6,                       // Encoding effort 0–6 (higher = smaller file, slower)
  allowEnlargement: true,              // Upscale small images to fill more of the canvas
  
  // AI Upscaling (Real-ESRGAN)
  enableAIUpscaling: true,             // Enable AI upscaling for 2x quality
  upscaleModel: '2x',                  // '2x', '3x', or '4x' (requires Real-ESRGAN)
  useUpscaylCLI: true,                 // Use upscayl CLI if available, fallback to sharp
  
  // Theme Consistency (applied to all images)
  themeEnabled: true,                  // Apply consistent theme filters
  theme: {
    saturation: 1.15,                  // 1.0 = normal, >1 = more vibrant, <1 = less vibrant
    brightness: 1.05,                  // 1.0 = normal, >1 = brighter, <1 = darker
    contrast: 1.08,                    // 1.0 = normal, >1 = more contrast
    vibrance: 0.12,                    // Additional vibrance boost (0-1)
    colorGrade: {
      highlights: { r: 1.02, g: 1.01, b: 1.0 },   // Warm highlights
      midtones: { r: 1.0, g: 1.0, b: 1.0 },       // Neutral midtones
      shadows: { r: 0.99, g: 0.99, b: 1.02 }      // Cool shadows
    },
    noiseReduction: true,              // Reduce noise for cleaner images
    autoAdjustLevels: true             // Auto adjust levels for optimal contrast
  }
};

// ============================================================================
// IMAGE AND CONTENT VALIDATION - Filter out scams, logos, and suspicious data
// ============================================================================

const SCAM_KEYWORDS = [
  'drop shipping', 'dropshipping', 'wholesale', 'bulk order', 'white label',
  'reseller kit', 'affiliate', 'make money', 'get rich', 'earn money fast',
  'click here', 'call now', 'act now', 'limited time offer', 'urgent',
  'free money', 'free item', 'too good to be true', 'mlm', 'pyramid',
  'spam', 'scam', 'fake', 'counterfeit', 'knock off', 'replica',
  'unauthorized', 'not genuine', 'imitation', 'fake brand',
  'amazon reseller', 'reddit reseller', 'tiktok shop', 'stolen account'
];

const SUSPICIOUS_IMAGE_PATTERNS = [
  'logo', 'watermark', 'cash', 'money', 'crypto', 'bitcoin', 'qr code',
  'text overlay', 'copyright notice', 'sample', 'watermark text',
  'placeholder', 'coming soon', 'sold out', 'not available'
];

const MARKETING_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'your',
  'you', 'are', 'was', 'were', 'will', 'can', 'not', 'new', 'used', 'item',
  'listing', 'ebay', 'size', 'type', 'color', 'steel', 'knife'
]);

function validateSourceImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];

  const filtered = imageUrls.filter((url) => {
    try {
      if (!url || typeof url !== 'string') return false;
      
      // Accept local paths (relative URLs)
      if (url.startsWith('/images/')) return true;
      
      // Accept full eBay URLs
      if (url.includes('ebayimg.com')) return true;
      
      // Accept other HTTP(S) URLs
      if (/^https?:\/\//i.test(url)) return true;
      
      return false;
    } catch (e) {
      return false;
    }
  });

  return filtered.slice(0, 24); // Max 24 images
}

function validateEbayHostedImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];

  const filtered = imageUrls.filter((url) => {
    try {
      // Must be valid URL
      if (!url || typeof url !== 'string') return false;
      if (!url.includes('ebayimg.com')) return false;

      // Filter out thumbnail sizes
      if (/s-l(50|100|140|200)\./. test(url)) return false;

      // Filter out suspicious file types
      if (/\.(gif|bmp|ico|svg)$/i.test(url)) return false;

      // Check for suspicious patterns in URL
      const urlLower = url.toLowerCase();
      if (SUSPICIOUS_IMAGE_PATTERNS.some(pattern => urlLower.includes(pattern))) {
        return false;
      }

      return true;
    } catch (e) {
      return false;
    }
  });

  return filtered.slice(0, 24); // Max 24 images
}

function validateProductContent(title = '', description = '') {
  const warnings = [];
  const errors = [];
  const contentLower = (title + ' ' + description).toLowerCase();

  // Check for scam keywords
  SCAM_KEYWORDS.forEach(keyword => {
    if (contentLower.includes(keyword.toLowerCase())) {
      warnings.push(`Contains suspicious keyword: "${keyword}"`);
    }
  });

  // Check for excessive punctuation (common spam pattern)
  if ((title?.match(/[!?]{2,}/g) || []).length > 2) {
    warnings.push('Excessive punctuation in title');
  }

  // Check for suspicious email/phone patterns
  if (/\b(?:\d{3}[-.]?\d{3}[-.]?\d{4}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i.test(contentLower)) {
    warnings.push('Contains contact information (email/phone) in description');
  }

  // Check for extremely short or missing title
  if (!title || title.trim().length < 5) {
    errors.push('Title is too short or missing');
  }

  return { warnings, errors, isValid: errors.length === 0 };
}

function shouldSkipImage(imageUrl) {
  const url = (imageUrl || '').toLowerCase();
  
  // Skip if doesn't contain ebayimg
  if (!url.includes('ebayimg.com')) return true;
  
  // Skip thumbnail sizes
  if (/s-l(50|100|140|200)\./.test(url)) return true;
  
  // Skip suspicious domains
  if (url.includes('cash') || url.includes('money') || url.includes('logo') || url.includes('watermark')) {
    return true;
  }
  
  return false;
}

async function retryAsync(fn, options = {}) {
  const {
    attempts = 3,
    delayMs = 1200,
    logger = null,
    label = 'operation'
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (logger) {
        logger.warn(`${label} failed`, {
          attempt,
          attempts,
          error: error.message
        });
      }
      if (attempt < attempts) {
        await delay(delayMs * attempt);
      }
    }
  }
  throw lastError;
}

function extractSeoKeywords(productData = {}) {
  const textBlob = [
    productData.title || '',
    productData.description || '',
    ...Object.keys(productData.itemSpecifics || {}),
    ...Object.values(productData.itemSpecifics || {})
  ].join(' ').toLowerCase();

  const words = textBlob
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !MARKETING_STOP_WORDS.has(word));

  const counts = new Map();
  words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
}

function buildMarketingUrls({ listingLink, title, sku, marketplaceId = 'EBAY_US', keywords = [] }) {
  const encodedTitle = encodeURIComponent(String(title || '').slice(0, 80));
  const encodedSku = encodeURIComponent(String(sku || ''));
  const keywordQuery = encodeURIComponent(keywords.slice(0, 6).join(' '));
  const campaignId = `strapey-${Date.now()}`;

  const base = listingLink || '';
  const separator = base.includes('?') ? '&' : '?';

  return {
    listingDirect: listingLink,
    promotedTracking: base ? `${base}${separator}mkcid=1&mkrid=711-53200-19255-0&campid=${campaignId}` : null,
    ebaySearchByTitle: `https://www.ebay.com/sch/i.html?_nkw=${encodedTitle}`,
    ebaySearchBySku: sku ? `https://www.ebay.com/sch/i.html?_nkw=${encodedSku}` : null,
    ebaySearchByKeywords: keywordQuery ? `https://www.ebay.com/sch/i.html?_nkw=${keywordQuery}` : null,
    marketplaceLanding: `https://www.ebay.com/globaldeals?mkpid=${encodeURIComponent(marketplaceId)}`,
    campaignId
  };
}

function buildSeoCampaignAssets(productData = {}, marketingUrls = {}, keywords = []) {
  const title = String(productData.title || '').trim();
  const shortTitle = title.length > 65 ? `${title.slice(0, 62).trim()}...` : title;
  const cta = 'Limited stock available. Order now with fast shipping and secure checkout on eBay.';

  return {
    seoTitle: shortTitle,
    seoMetaDescription: `${shortTitle}. ${keywords.slice(0, 8).join(', ')}. ${cta}`.slice(0, 280),
    primaryKeywords: keywords.slice(0, 12),
    socialCaptions: [
      `${shortTitle} | Shop now on eBay: ${marketingUrls.promotedTracking || marketingUrls.listingDirect}`,
      `Top quality ${keywords.slice(0, 4).join(', ')}. Buy now: ${marketingUrls.listingDirect}`
    ],
    adCopyVariants: [
      `${shortTitle} - Premium quality, competitive pricing, trusted eBay checkout.`,
      `Discover ${shortTitle}. Secure purchase with fast dispatch on eBay.`
    ]
  };
}

async function generateMarketingVideoWithMediaApi({ sku, title, description, imageUrls }, logger) {
  const runtime = getRuntimeConfig();
  const mediaApiBase = String(runtime.media.mediaApiBaseUrl || '').trim();
  const mediaApiKey = String(runtime.media.mediaApiKey || '').trim();
  const enableVideo = !!runtime.media.enableMediaVideo;

  if (!enableVideo) {
    return { enabled: false, reason: 'ENABLE_MEDIA_VIDEO=false' };
  }

  if (!mediaApiBase) {
    return { enabled: false, reason: 'MEDIA_API_BASE_URL not configured' };
  }

  if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
    return { enabled: false, reason: 'Not enough images to create video' };
  }

  const payload = {
    sku,
    title: String(title || '').substring(0, 120),
    description: String(description || '').substring(0, 1000),
    imageUrls: imageUrls.slice(0, Number(runtime.media.maxImagesForVideo) || 12),
    style: runtime.media.style || 'product-showcase',
    durationSeconds: Number(runtime.media.videoDurationSeconds) || 18,
    format: 'mp4',
    includeTransitions: true
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (mediaApiKey) headers.Authorization = `Bearer ${mediaApiKey}`;

  const createResponse = await retryAsync(
    async () => axios.post(`${mediaApiBase.replace(/\/$/, '')}${runtime.media.mediaCreatePath || '/videos/create'}`, payload, { headers, timeout: 30000 }),
    { attempts: 3, delayMs: 1500, logger, label: 'Media API video creation' }
  );

  const data = createResponse.data || {};
  const videoUrl = data.videoUrl || data.url || null;
  const externalVideoId = data.videoId || data.id || null;
  const ebayVideoId = data.ebayVideoId || null;

  if (!videoUrl && !externalVideoId && !ebayVideoId) {
    throw new Error('Media API did not return a video identifier');
  }

  return {
    enabled: true,
    provider: 'external-media-api',
    videoUrl,
    externalVideoId,
    ebayVideoId,
    createdAt: new Date().toISOString()
  };
}

async function upsertInventoryItemWithVideoFallback({ apiBase, sku, payload, token, logger }) {
  try {
    await axios.put(`${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US'
      },
      timeout: 30000
    });

    return {
      videoFallbackApplied: false,
      videoAttached: Array.isArray(payload?.product?.videoIds) && payload.product.videoIds.length > 0
    };
  } catch (error) {
    const hasVideo = Array.isArray(payload?.product?.videoIds) && payload.product.videoIds.length > 0;
    const errText = JSON.stringify(error.response?.data || {}).toLowerCase();
    const isVideoRelated = hasVideo && /video|media/.test(errText);

    if (!isVideoRelated) {
      logger.error('Inventory item upsert rejected by eBay', {
        sku,
        status: error.response?.status,
        ebayErrors: error.response?.data?.errors || error.response?.data
      });
      throw error;
    }

    logger.warn('Inventory upsert failed with videoIds. Retrying without video attachment.', {
      sku,
      error: error.message
    });

    const fallbackPayload = JSON.parse(JSON.stringify(payload));
    if (fallbackPayload.product) {
      delete fallbackPayload.product.videoIds;
    }

    await axios.put(`${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, fallbackPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US'
      },
      timeout: 30000
    });

    return {
      videoFallbackApplied: true,
      videoAttached: false
    };
  }
}

async function runPostPublishMarketingEngine({ productData, publishResult, logger }) {
  const runtime = getRuntimeConfig();
  if (!runtime.marketing.enableMarketingEngine) {
    return {
      executedAt: new Date().toISOString(),
      sophisticatedMode: true,
      failTolerance: true,
      channels: [{ channel: 'MARKETING_ENGINE', status: 'SKIPPED', reason: 'enableMarketingEngine=false' }]
    };
  }

  const now = new Date().toISOString();
  const marketplaceId = runtime.marketing.marketplaceId || 'EBAY_US';
  const keywords = extractSeoKeywords(productData);
  const marketingUrls = buildMarketingUrls({
    listingLink: publishResult.listingLink,
    title: productData.title,
    sku: publishResult.sku,
    marketplaceId,
    keywords
  });
  const seoAssets = buildSeoCampaignAssets(productData, marketingUrls, keywords);

  const channels = [];

  channels.push({
    channel: 'SEO_ASSETS',
    status: 'SUCCESS',
    generatedAt: now,
    details: {
      keywordsCount: keywords.length,
      seoTitle: seoAssets.seoTitle
    }
  });

  const webhookUrl = String(runtime.marketing.marketingWebhookUrl || '').trim();
  if (webhookUrl) {
    try {
      await retryAsync(
        async () => axios.post(webhookUrl, {
          event: 'LISTING_CREATED',
          listingId: publishResult.listingId,
          listingLink: publishResult.listingLink,
          sku: publishResult.sku,
          marketingUrls,
          seoAssets,
          timestamp: now
        }, { timeout: 20000 }),
        {
          attempts: Number(runtime.marketing.marketingRetryAttempts) || 3,
          delayMs: Number(runtime.marketing.marketingRetryDelayMs) || 1000,
          logger,
          label: 'Marketing webhook dispatch'
        }
      );

      channels.push({ channel: 'MARKETING_WEBHOOK', status: 'SUCCESS', generatedAt: now });
    } catch (error) {
      channels.push({ channel: 'MARKETING_WEBHOOK', status: 'FAILED', generatedAt: now, error: error.message });
    }
  } else {
    channels.push({ channel: 'MARKETING_WEBHOOK', status: 'SKIPPED', generatedAt: now, reason: 'MARKETING_WEBHOOK_URL not configured' });
  }

  return {
    executedAt: now,
    sophisticatedMode: true,
    failTolerance: true,
    marketingUrls,
    seoAssets,
    channels
  };
}

function getEbayBaseUrls(overrides = {}) {
  const ebayEnv = resolveEbayEnvironment(overrides);
  if (ebayEnv === 'production') {
    return {
      apiBase: 'https://api.ebay.com',
      identityBase: 'https://api.ebay.com',
      tradingBase: 'https://api.ebay.com/ws/api.dll',
      listingBase: 'https://www.ebay.com'
    };
  }
  return {
    apiBase: 'https://api.sandbox.ebay.com',
    identityBase: 'https://api.sandbox.ebay.com',
    tradingBase: 'https://api.sandbox.ebay.com/ws/api.dll',
    listingBase: 'https://sandbox.ebay.com'
  };
}

function getEbayRuntimeConfig(overrides = {}) {
  const environment = resolveEbayEnvironment(overrides);
  const isProduction = environment === 'production';

  const pickEnvVar = (name, fallback = '') => {
    const keys = isProduction
      ? [`EBAY_PROD_${name}`, `EBAY_${name}`]
      : [`EBAY_SANDBOX_${name}`, `EBAY_${name}`];

    for (const key of keys) {
      const value = process.env[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return { value, source: key };
      }
    }

    return { value: fallback, source: null };
  };

  const clientId = pickEnvVar('CLIENT_ID');
  const clientSecret = pickEnvVar('CLIENT_SECRET');
  const refreshToken = pickEnvVar('REFRESH_TOKEN');
  const userToken = pickEnvVar('USER_TOKEN');
  const marketplaceId = pickEnvVar('MARKETPLACE_ID', 'EBAY_US');
  const categoryId = pickEnvVar('CATEGORY_ID');
  const fulfillmentPolicyId = pickEnvVar('FULFILLMENT_POLICY_ID');
  const paymentPolicyId = pickEnvVar('PAYMENT_POLICY_ID');
  const returnPolicyId = pickEnvVar('RETURN_POLICY_ID');
  const locationKey = pickEnvVar('LOCATION_KEY', 'des-plaines-il-primary');
  const devId = pickEnvVar('DEV_ID');
  const certId = pickEnvVar('CERT_ID');
  const siteId = pickEnvVar('SITE_ID', '0');
  const redirectFallback = isProduction
    ? ''
    : (process.env.EBAY_REDIRECT_URI || 'Strapey_Inc-StrapeyI-Strape-xmqocvrv');
  const redirectUri = pickEnvVar('REDIRECT_URI', redirectFallback);
  const scope = pickEnvVar('SCOPE', [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
  ].join(' '));

  // Never let production use sandbox/global EBAY_USER_TOKEN as a fallback.
  if (isProduction && userToken.source === 'EBAY_USER_TOKEN') {
    userToken.value = '';
    userToken.source = null;
  }

  // Never let production OAuth use sandbox/global redirect URI fallback.
  if (isProduction && redirectUri.source === 'EBAY_REDIRECT_URI') {
    redirectUri.value = '';
    redirectUri.source = null;
  }

  return {
    environment,
    isProduction,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    refreshToken: refreshToken.value,
    userToken: userToken.value,
    marketplaceId: marketplaceId.value,
    categoryId: categoryId.value,
    fulfillmentPolicyId: fulfillmentPolicyId.value,
    paymentPolicyId: paymentPolicyId.value,
    returnPolicyId: returnPolicyId.value,
    locationKey: locationKey.value,
    devId: devId.value,
    certId: certId.value,
    siteId: siteId.value,
    redirectUri: redirectUri.value,
    scope: scope.value,
    sources: {
      clientId: clientId.source,
      clientSecret: clientSecret.source,
      refreshToken: refreshToken.source,
      userToken: userToken.source,
      marketplaceId: marketplaceId.source,
      categoryId: categoryId.source,
      fulfillmentPolicyId: fulfillmentPolicyId.source,
      paymentPolicyId: paymentPolicyId.source,
      returnPolicyId: returnPolicyId.source,
      locationKey: locationKey.source,
      devId: devId.source,
      certId: certId.source,
      siteId: siteId.source,
      redirectUri: redirectUri.source,
      scope: scope.source
    }
  };
}

async function getEbayAccessToken(overrides = {}) {
  const ebayConfig = getEbayRuntimeConfig(overrides);
  const clientId = ebayConfig.clientId;
  const clientSecret = ebayConfig.clientSecret;
  const refreshToken = ebayConfig.refreshToken;
  const userToken = ebayConfig.userToken;

  if (!clientId || !clientSecret) {
    throw new Error('Missing eBay credentials. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.');
  }

  const selectedToken = refreshToken || userToken || '';
  if (!selectedToken) {
    throw new Error('Missing eBay token. Set EBAY_REFRESH_TOKEN or EBAY_USER_TOKEN.');
  }

  console.log('[Token Debug] Token first 100 chars:', selectedToken.substring(0, 100));
  console.log('[Token Debug] Contains #f^0#p^:', selectedToken.includes('#f^0#p^'));
  console.log('[Token Debug] Contains #r^0#:', selectedToken.includes('#r^0#'));

  // If a refresh token exists, always exchange it for an access token.
  // Some refresh tokens also contain token markers that look similar to user tokens.
  if (!refreshToken && userToken) {
    console.log('Using direct OAuth User Token (2-hour expiry)');
    return userToken;
  }

  // Otherwise, exchange refresh token for access token
  const scope = ebayConfig.scope;

  const { identityBase } = getEbayBaseUrls({ environment: ebayConfig.environment });
  const tokenBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  try {
    const response = await axios.post(`${identityBase}/identity/v1/oauth2/token`, tokenBody.toString(), {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });

    return response.data.access_token;
  } catch (error) {
    const oauthError = String(error?.response?.data?.error || '').toLowerCase();
    const oauthDescription = String(error?.response?.data?.error_description || '').toLowerCase();

    // Fallback path: only allow direct user-token fallback outside production.
    if (
      !ebayConfig.isProduction &&
      userToken &&
      oauthError === 'invalid_grant' &&
      (oauthDescription.includes('refresh token is invalid') || oauthDescription.includes('issued to another client'))
    ) {
      console.warn('[Token Debug] Refresh token invalid_grant. Falling back to EBAY_USER_TOKEN.');
      return userToken;
    }

    if (
      oauthError === 'invalid_grant' &&
      (oauthDescription.includes('refresh token is invalid') || oauthDescription.includes('issued to another client'))
    ) {
      const tokenVarName = ebayConfig.isProduction ? 'EBAY_PROD_REFRESH_TOKEN' : 'EBAY_REFRESH_TOKEN';
      throw new Error(`${tokenVarName} is invalid or belongs to a different eBay app. Re-authorize OAuth and update ${tokenVarName}.`);
    }

    throw error;
  }
}

function parseQuantity(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  const text = String(raw || '');
  const match = text.match(/\d+/);
  if (!match) return 1;
  return Math.max(0, parseInt(match[0], 10));
}

function buildPublishSku(productData) {
  const base = String(productData.customLabel || productData.itemNumber || '').trim();
  if (base) return base.substring(0, 50);
  return `sku-${crypto.createHash('md5').update(productData.url).digest('hex').substring(0, 16)}`;
}

function shouldUseEbayHostedImages() {
  // Publishing policy: always use hosted/enhanced image URLs for outbound listings.
  return true;
}

async function uploadImageUrlToEbayEps(imageUrl, token) {
  const { tradingBase } = getEbayBaseUrls();
  const runtime = getRuntimeConfig();
  const compatibilityLevel = runtime.ebay.compatibilityLevel || '1231';
  const siteId = runtime.ebay.siteId || '0';

  const escapedUrl = String(imageUrl)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">\n  <ErrorLanguage>en_US</ErrorLanguage>\n  <WarningLevel>High</WarningLevel>\n  <PictureName>strapey-${Date.now()}</PictureName>\n  <ExternalPictureURL>${escapedUrl}</ExternalPictureURL>\n</UploadSiteHostedPicturesRequest>`;

  const response = await axios.post(tradingBase, xmlBody, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
      'X-EBAY-API-SITEID': String(siteId),
      'X-EBAY-API-COMPATIBILITY-LEVEL': String(compatibilityLevel),
      'X-EBAY-API-IAF-TOKEN': token
    },
    timeout: 30000
  });

  const xml = String(response.data || '');
  const fullUrlMatch = xml.match(/<[^>]*FullURL[^>]*>([^<]+)<\/[^>]*FullURL>/i);
  if (!fullUrlMatch || !fullUrlMatch[1]) {
    const shortMessageMatch = xml.match(/<[^>]*ShortMessage[^>]*>([^<]+)<\/[^>]*ShortMessage>/i);
    const longMessageMatch = xml.match(/<[^>]*LongMessage[^>]*>([^<]+)<\/[^>]*LongMessage>/i);
    const ackMatch = xml.match(/<[^>]*Ack[^>]*>([^<]+)<\/[^>]*Ack>/i);
    const message = longMessageMatch?.[1] || shortMessageMatch?.[1] || `UploadSiteHostedPictures did not return FullURL (Ack: ${ackMatch?.[1] || 'Unknown'})`;
    throw new Error(message.trim());
  }

  return fullUrlMatch[1].trim();
}

async function convertToEbayHostedImageUrls(imageUrls, token, logger = null) {
  if (logger) {
    logger.info('EPS batch upload starting', { 
      totalImages: imageUrls.length,
      concurrency: EPS_UPLOAD_CONCURRENCY 
    });
  }
  
  let successCount = 0;
  let failureCount = 0;
  
  const hosted = await mapWithConcurrency(imageUrls, EPS_UPLOAD_CONCURRENCY, async (imageUrl, index) => {
    try {
      const hostedUrl = await uploadImageUrlToEbayEps(imageUrl, token);
      successCount++;
      if (logger && (index < 3 || index === imageUrls.length - 1)) {
        logger.debug(`EPS image ${index + 1}/${imageUrls.length} uploaded`, { 
          source: imageUrl.substring(0, 50) + '...', 
          hosted: hostedUrl.substring(0, 50) + '...' 
        });
      }
      return hostedUrl;
    } catch (error) {
      failureCount++;
      if (logger) logger.warn(`EPS upload failed for image ${index + 1}/${imageUrls.length}, using fallback`, { 
        source: imageUrl.substring(0, 50) + '...', 
        error: error.message 
      });
      return imageUrl;
    }
  });
  
  if (logger) {
    logger.info('EPS batch upload completed', {
      total: imageUrls.length,
      success: successCount,
      failed: failureCount
    });
  }

  return hosted;
}

/**
 * Check if an offer/listing already exists for the given SKU
 */
async function findExistingOffer(sku, token, apiBase) {

  try {
    // Search for offers by SKU - eBay limits queries, so we use a basic approach
    const response = await axios.get(`${apiBase}/sell/inventory/v1/offer`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US'
      },
      params: {
        format: 'FIXED_PRICE',
        limit: 100
      },
      timeout: 30000
    });

    const offers = response.data?.offers || [];
    const matchingOffer = offers.find(offer => offer.sku === sku);

    if (matchingOffer) {
      return {
        found: true,
        offerId: matchingOffer.offerId,
        listingId: matchingOffer.listingId || null,
        status: matchingOffer.status,
        currentPrice: matchingOffer.pricingSummary?.price?.value,
        currentQuantity: matchingOffer.availableQuantity
      };
    }

    return { found: false };
  } catch (error) {
    console.log('Could not search for existing offers (may be normal):', error.message);
    return { found: false };
  }
}

/**
 * Enumerate every SKU registered in the seller's eBay account, paginating
 * through GET /sell/inventory/v1/inventory_item until all pages are consumed.
 * There is no bulk "list all offers" endpoint - GET /sell/inventory/v1/offer
 * requires a `sku` query param - so this is the only way to discover the
 * full set of SKUs without already knowing them.
 */
async function fetchAllEbayInventorySkus(token, apiBase, { logger = null } = {}) {
  const skus = new Set();
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const response = await axios.get(`${apiBase}/sell/inventory/v1/inventory_item`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: { limit, offset },
      timeout: 30000
    });

    const data = response.data || {};
    total = typeof data.total === 'number' ? data.total : (data.inventoryItems || []).length;
    const items = data.inventoryItems || [];

    items.forEach((item) => {
      if (item.sku) skus.add(item.sku);
    });

    if (logger) {
      logger.debug('Fetched eBay inventory item page', { offset, limit, received: items.length, total });
    }

    if (items.length === 0) break;
    offset += limit;
  }

  return skus;
}

/**
 * Look up the live offer for a single SKU via GET /sell/inventory/v1/offer?sku=.
 * Returns null if eBay has no offer for that SKU.
 */
async function fetchOfferForSku(sku, token, apiBase) {
  const response = await axios.get(`${apiBase}/sell/inventory/v1/offer`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-US'
    },
    params: { sku },
    timeout: 30000
  });

  const offer = (response.data?.offers || [])[0];
  if (!offer) return null;

  return {
    offerId: offer.offerId,
    listingId: offer.listing?.listingId || null,
    status: offer.status,
    price: offer.pricingSummary?.price?.value !== undefined ? Number(offer.pricingSummary.price.value) : null,
    quantity: typeof offer.availableQuantity === 'number' ? offer.availableQuantity : null
  };
}

function isEbayAccessDeniedError(error) {
  if (!error || error.response?.status !== 403) return false;
  const errors = error.response?.data?.errors;
  if (!Array.isArray(errors)) return false;

  return errors.some((e) => {
    const id = String(e?.errorId || '');
    const message = String(e?.message || '').toLowerCase();
    const longMessage = String(e?.longMessage || '').toLowerCase();
    return id === '1100' || message.includes('access denied') || longMessage.includes('insufficient permissions');
  });
}

async function publishViaTradingApiFallback(productData, logger, overrides = {}) {
  const productUrl = String(productData?.url || productData?.link || '').trim();
  if (!productUrl) {
    throw new Error('Trading fallback requires product URL/link in product data.');
  }

  const targetEnvironment = resolveEbayEnvironment(overrides);
  if (targetEnvironment === 'production') {
    throw new Error('Trading API fallback is currently configured for Sandbox only.');
  }

  const fallbackUrl = `http://localhost:${PORT}/api/ebay/publish-sandbox`;
  logger.warn('Sell Inventory API denied access. Attempting Trading API fallback...', {
    productUrl
  });

  const response = await axios.post(fallbackUrl, { productUrl, requireHostedImages: true, environment: targetEnvironment }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 90000
  });

  const result = response.data || {};
  const mode = String(result.mode || '').toLowerCase();
  const isMock = mode.includes('mock');

  if (!result.success || !result.listingId || isMock) {
    throw new Error(result.message || result.warning || 'Trading API fallback did not return a real listing.');
  }

  logger.success('Trading API fallback succeeded', {
    listingId: result.listingId,
    publishedLink: result.publishedLink,
    mode: result.mode
  });

  return {
    success: true,
    offerId: null,
    sku: buildPublishSku(productData),
    listingId: result.listingId,
    listingLink: result.publishedLink,
    status: 'PUBLISHED',
    action: 'CREATED_TRADING_FALLBACK',
    message: result.message || 'Published via Trading API fallback',
    quantity: 3,
    enableBackorder: true,
    media: { enabled: false, reason: 'Trading fallback path' },
    marketing: {
      executedAt: new Date().toISOString(),
      sophisticatedMode: true,
      failTolerance: true,
      channels: [{ channel: 'MARKETING_ENGINE', status: 'SKIPPED', reason: 'Trading fallback path' }]
    }
  };
}

// eBay requires category-specific item specifics; Pistol Parts (73944) rejects
// listings missing "For Gun Type" with errorId 25002 even though the rest of the
// listing (title/price/images) is valid.
const PISTOL_PARTS_CATEGORY_ID = '73944';

function getDefaultAspectsForCategory(categoryId) {
  const defaults = {
    'Brand': 'Strapey',
    'Size Type': 'Large',
    'Size': 'One Size',
    'Color': 'Silver',
    'Blade Material': 'Steel',
    'Type': 'Knife',
    'Department': 'Unisex'
  };

  if (String(categoryId || '') === PISTOL_PARTS_CATEGORY_ID) {
    defaults['For Gun Type'] = 'Handgun';
  }

  return defaults;
}

async function publishToEbay(productData, overrides = {}) {
  const logger = createLogger('PublishToEbay');
  
  try {
    const resolvedOverrides = typeof overrides === 'string'
      ? { environment: overrides }
      : (overrides || {});
    const ebayConfig = getEbayRuntimeConfig(resolvedOverrides);
    const normalizedProductData = forceNewConditionDefaults(productData || {});
    const sku = normalizedProductData.customLabel || normalizedProductData.sku || 'UNKNOWN';

    // eBay's Inventory API rejects an empty description with a 400 (errorId 25718).
    // Some older/re-imported records were saved with description: '' (e.g. from a
    // blocked scrape); regenerate one from the title/specifics rather than failing.
    if (!String(normalizedProductData.description || '').trim()) {
      logger.warn('Product has empty description; generating fallback before publish', { sku });
      normalizedProductData.description = makeSeoDescription(
        normalizedProductData.title || '',
        normalizedProductData.itemSpecifics || {},
        normalizedProductData.title || '',
        normalizedProductData
      );
    }

    logger.info('========================================');
    logger.info('PUBLISH FLOW STARTED', { 
      sku, 
      environment: resolvedOverrides.environment || 'default',
      imageCount: Array.isArray(normalizedProductData.imageSourceUrls) ? normalizedProductData.imageSourceUrls.length : 0
    });
    logger.info('========================================');
    
    // ==================================================================================
    // VALIDATE: Check content for scams, suspicious keywords, and malicious patterns
    // ==================================================================================
    const contentValidation = validateProductContent(normalizedProductData.title, normalizedProductData.description);
    if (contentValidation.errors.length > 0) {
      const errorMsg = `Cannot publish: ${contentValidation.errors.join(', ')}`;
      logger.error('Content validation failed', { errors: contentValidation.errors });
      throw new Error(errorMsg);
    }
    
    // Log warnings but allow publish
    if (contentValidation.warnings.length > 0) {
      logger.warn('Content validation warnings', { warnings: contentValidation.warnings });
    }
    
    // ==================================================================================
    // VALIDATE: Check images for scams, logos, and suspicious patterns
    // ==================================================================================
    const sourceImageUrlsFromData = Array.isArray(normalizedProductData.imageSourceUrls) ? normalizedProductData.imageSourceUrls : [];
    const remoteImageUrlsFromData = Array.isArray(normalizedProductData.remoteImageUrls) ? normalizedProductData.remoteImageUrls : [];
    logger.info('Step 1: Image validation started', { totalImages: sourceImageUrlsFromData.length });
    
    // Enforce eBay's 24-image limit BEFORE validation
    const limitedImages = sourceImageUrlsFromData.slice(0, 24);
    if (sourceImageUrlsFromData.length > 24) {
      logger.warn('Image count exceeds eBay limit', {
        original: sourceImageUrlsFromData.length,
        limited: limitedImages.length,
        dropped: sourceImageUrlsFromData.length - 24
      });
    }
    
    // Use source validation (accepts local paths)
    const validatedImages = validateSourceImageUrls(limitedImages);
    logger.info('Step 1: Image validation completed', { 
      input: limitedImages.length, 
      valid: validatedImages.length,
      filtered: limitedImages.length - validatedImages.length
    });
    
    if (validatedImages.length === 0 && remoteImageUrlsFromData.length === 0) {
      const errorMsg = 'Cannot publish: no valid product images found in source or remote image sets.';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    if (validatedImages.length < limitedImages.length) {
      const removed = limitedImages.length - validatedImages.length;
      logger.warn('Suspicious images removed', { 
        afterLimit: limitedImages.length, 
        valid: validatedImages.length,
        removed 
      });
    }
    
    logger.info('Step 2: Authenticating with eBay');
    const token = await getEbayAccessToken(resolvedOverrides);
    const ebayEnvironment = resolveEbayEnvironment(resolvedOverrides);
    const { apiBase, listingBase } = getEbayBaseUrls({ environment: ebayEnvironment });
    logger.info('Step 2: Authentication successful', { environment: ebayEnvironment });

    const marketplaceId = resolvedOverrides.marketplaceId || ebayConfig.marketplaceId || 'EBAY_US';
    logger.info('Step 3: Configuration loaded', { marketplaceId });
    
    // Category must come from product data (or explicit request override) in production.
    // Prefer eBay-specific field first; many imported products store the value in ebayCategoryId.
    // In stage/sandbox, env fallback is still allowed for convenience.
    let categoryId = normalizedProductData.ebayCategoryId || normalizedProductData.categoryId || resolvedOverrides.categoryId;

    if (categoryId === 'N/A') {
      categoryId = '';
    }

    if (!categoryId && ebayEnvironment !== 'production') {
      categoryId = ebayConfig.categoryId;
    }
    
    const fulfillmentPolicyId = ebayConfig.fulfillmentPolicyId;
    const paymentPolicyId = ebayConfig.paymentPolicyId;
    const returnPolicyId = ebayConfig.returnPolicyId;
    const merchantLocationKey = ebayConfig.locationKey || 'des-plaines-il-primary';

    logger.info('Step 4: Business policies validated', {
      categoryId: categoryId || 'NOT_SET',
      fulfillmentPolicyId: fulfillmentPolicyId ? 'SET' : 'MISSING',
      paymentPolicyId: paymentPolicyId ? 'SET' : 'MISSING',
      returnPolicyId: returnPolicyId ? 'SET' : 'MISSING',
      merchantLocationKey
    });

    if (!categoryId || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      const missing = [];
      if (!categoryId) missing.push(ebayEnvironment === 'production' ? 'product.categoryId' : 'EBAY_CATEGORY_ID or product.categoryId');
      if (!fulfillmentPolicyId) missing.push('EBAY_FULFILLMENT_POLICY_ID');
      if (!paymentPolicyId) missing.push('EBAY_PAYMENT_POLICY_ID');
      if (!returnPolicyId) missing.push('EBAY_RETURN_POLICY_ID');
      
      const errorMsg = `Missing eBay policy/config values: ${missing.join(', ')}`;
      logger.error(errorMsg, { missing });
      throw new Error(errorMsg);
    }

    // Note: sku already declared at top of function - no need to redeclare
    const quantity = parseQuantity(
      normalizedProductData.inventoryQuantity ??
      normalizedProductData.availableQuantity ??
      normalizedProductData.inventory
    );
    const currency = normalizedProductData.currency || 'USD';
    const price = typeof normalizedProductData.price === 'number' ? normalizedProductData.price : Number(normalizedProductData.price);
    // Load or set default backorder/overselling flag
    const enableBackorder = normalizedProductData.enableBackorder !== undefined ? normalizedProductData.enableBackorder : true;

    logger.debug('Product data extracted', { sku, quantity, currency, price, enableBackorder });

    if (!Number.isFinite(price) || price <= 0) {
      const errorMsg = `Invalid price: ${normalizedProductData.price}`;
      logger.error(errorMsg, { rawPrice: normalizedProductData.price, parsedPrice: price });
      throw new Error('Cannot publish: invalid numeric price in scraped data.');
    }

    let sourceImageUrls = validatedImages;
    let imageUrls = sourceImageUrls.slice(0, 24);
    logger.debug('Using validated images', { total: validatedImages.length, willUse: imageUrls.length });

    if (imageUrls.length === 0) {
      const errorMsg = 'Cannot publish: no source image URLs found. Re-scrape this listing first to populate imageSourceUrls.';
      logger.error(errorMsg, { sku, link: normalizedProductData.url || normalizedProductData.link || null });
      throw new Error(errorMsg);
    }

    if (shouldUseEbayHostedImages()) {
      logger.info('Hosted image pipeline enabled. Uploading images to eBay Picture Services...');
      const preparedImages = await prepareListingImageUrls({
        imageSourceUrls: sourceImageUrls,
        remoteImageUrls: remoteImageUrlsFromData,
        productUrl: normalizedProductData.url || normalizedProductData.link || '',
        itemId: normalizedProductData.itemNumber || normalizedProductData.id || '',
        token,
        logger,
        requireEps: true
      });
      sourceImageUrls = preparedImages.sourceImageUrls;
      imageUrls = preparedImages.listingImageUrls;
      logger.debug('EPS image URL set prepared', { total: imageUrls.length });
    }

    let videoAsset = { enabled: false, reason: 'Not generated' };
    try {
      videoAsset = await generateMarketingVideoWithMediaApi({
        sku,
        title: normalizedProductData.title,
        description: normalizedProductData.description,
        imageUrls
      }, logger);
      logger.info('Video generation evaluated', {
        enabled: !!videoAsset.enabled,
        hasEbayVideoId: !!videoAsset.ebayVideoId,
        hasVideoUrl: !!videoAsset.videoUrl,
        reason: videoAsset.reason || null
      });
    } catch (videoError) {
      logger.warn('Video generation failed, continuing without video', { error: videoError.message });
      videoAsset = { enabled: false, reason: videoError.message };
    }

    // CHECK FOR EXISTING LISTING BY SKU
    logger.info(`Checking for existing offer with SKU: ${sku}`);
    const existingOffer = await findExistingOffer(sku, token, apiBase);

    if (existingOffer.found) {
      logger.success(`Found existing offer:${existingOffer.offerId}`, { offerId: existingOffer.offerId, status: existingOffer.status });
      
      // Build aspects with defaults for common missing fields
      const aspects = Object.fromEntries(
        Object.entries(normalizedProductData.itemSpecifics || {}).map(([key, value]) => [
          key,
          [String(value).substring(0, 65)]
        ])
      );
      
      // Add default values for commonly required fields in collectible categories
      const defaultAspects = getDefaultAspectsForCategory(categoryId);

      Object.entries(defaultAspects).forEach(([key, value]) => {
        if (!aspects[key]) {
          aspects[key] = [value];
        }
      });
      
      // Check if price or quantity changed
      const priceChanged = existingOffer.currentPrice && Number(existingOffer.currentPrice) !== price;
      const quantityChanged = existingOffer.currentQuantity && existingOffer.currentQuantity !== quantity;
      const hasImageData = imageUrls.length > 0;
      const dataChanged = priceChanged || quantityChanged;
      const shouldUpdateInventory = dataChanged || hasImageData;

      logger.debug('Existing offer analysis', {
        previousPrice: existingOffer.currentPrice,
        newPrice: price,
        priceChanged,
        previousQuantity: existingOffer.currentQuantity,
        newQuantity: quantity,
        quantityChanged,
        hasImageData,
        shouldUpdateInventory
      });

      if (shouldUpdateInventory) {
        logger.info(`Inventory sync required. Updating inventory item...`, { priceChanged, quantityChanged, hasImageData });
        
        // Update inventory item
        const inventoryPayload = {
          condition: 'NEW',
          availability: {
            shipToLocationAvailability: {
              quantity
            }
          },
          product: {
            title: String(normalizedProductData.title || '').substring(0, 80),
            description: String(normalizedProductData.description || '').substring(0, 4000),
            imageUrls,
            aspects
          }
        };

        // Add weight if available
        if (normalizedProductData.weight) {
          inventoryPayload.product.weight = {
            value: normalizedProductData.weight,
            unit: (normalizedProductData.weightUnit || 'lb').toUpperCase()
          };
          logger.debug('Added weight to listing', { value: normalizedProductData.weight, unit: normalizedProductData.weightUnit });
        }

        // Add dimensions if available
        if (normalizedProductData.dimensions) {
          let dims = normalizedProductData.dimensions;
          if (typeof dims === 'string') {
            try {
              dims = JSON.parse(dims);
            } catch (e) {
              dims = {};
            }
          }
          if (dims && (dims.length || dims.width || dims.height)) {
            inventoryPayload.product.dimensions = {
              length: dims.length || 0,
              width: dims.width || 0,
              height: dims.height || 0,
              unit: (dims.unit || 'IN').toUpperCase()
            };
            logger.debug('Added dimensions to listing', { dimensions: inventoryPayload.product.dimensions });
          }
        }

        if (videoAsset.ebayVideoId) {
          inventoryPayload.product.videoIds = [String(videoAsset.ebayVideoId)];
        }

        logger.debug('Calling inventory PUT endpoint', { sku, url: `${apiBase}/sell/inventory/v1/inventory_item/${sku}` });

        const updateResult = await upsertInventoryItemWithVideoFallback({
          apiBase,
          sku,
          payload: inventoryPayload,
          token,
          logger
        });

        if (updateResult.videoFallbackApplied) {
          videoAsset = {
            ...videoAsset,
            attached: false,
            fallbackApplied: true,
            note: 'Video attachment failed in inventory API; listing published with images only.'
          };
        } else if (updateResult.videoAttached) {
          videoAsset = {
            ...videoAsset,
            attached: true,
            fallbackApplied: false
          };
        }

        logger.success(`Inventory item updated for SKU: ${sku}`);

        // Update offer (price/quantity) only when changed
        if (dataChanged) {
          const offerUpdatePayload = {
            availableQuantity: quantity,
            pricingSummary: {
              price: {
                value: String(price),
                currency
              }
            }
          };

          logger.debug('Calling offer PUT endpoint', { offerId: existingOffer.offerId });

          await axios.put(`${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(existingOffer.offerId)}`, offerUpdatePayload, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': 'en-US'
            },
            timeout: 30000
          });

          logger.success(`Offer updated: ${existingOffer.offerId}`);
        }
      } else {
        logger.info(`No inventory/offer changes detected. Listing remains as-is.`);
      }

      // The offer exists but was never actually published (e.g. a prior attempt
      // failed after offer creation but before the publish call succeeded).
      // Without this, the function returns "success" while no live listing exists.
      let finalListingId = existingOffer.listingId;
      if (!finalListingId) {
        logger.info(`Existing offer has no live listing yet. Publishing offer: ${existingOffer.offerId}`);
        const publishResponse = await axios.post(`${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(existingOffer.offerId)}/publish`, {}, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          },
          timeout: 30000
        });
        finalListingId = publishResponse.data?.listingId || null;
        logger.success(`Listing published successfully`, { listingId: finalListingId });
      }

      // Return existing listing link
      const listingLink = finalListingId ? `${listingBase}/itm/${finalListingId}` : null;

      logger.success(`Publish operation completed: ${dataChanged ? 'UPDATED' : 'UNCHANGED'}`, { listingLink });
      return {
        success: true,
        offerId: existingOffer.offerId,
        sku,
        listingId: finalListingId,
        listingLink,
        status: existingOffer.status,
        action: shouldUpdateInventory ? 'UPDATED' : 'UNCHANGED',
        message: shouldUpdateInventory ? `Updated existing listing with SKU: ${sku}` : `Listing already exists with SKU: ${sku}`,
        media: videoAsset,
        logs: logger.getLogs()
      };
    }

    // LISTING DOES NOT EXIST - CREATE NEW ONE
    logger.info(`No existing offer found. Creating new listing for SKU: ${sku}`);

    // Build aspects with defaults for common missing fields
    const aspects = Object.fromEntries(
      Object.entries(normalizedProductData.itemSpecifics || {}).map(([key, value]) => [
        key,
        [String(value).substring(0, 65)]
      ])
    );
    
    // Add default values for commonly required fields in collectible categories
    const defaultAspects = getDefaultAspectsForCategory(categoryId);

    Object.entries(defaultAspects).forEach(([key, value]) => {
      if (!aspects[key]) {
        aspects[key] = [value];
      }
    });

    const inventoryPayload = {
      condition: 'NEW',
      availability: {
        shipToLocationAvailability: {
          quantity
        }
      },
      product: {
        title: String(normalizedProductData.title || '').substring(0, 80),
        description: String(normalizedProductData.description || '').substring(0, 4000),
        imageUrls,
        aspects
      }
    };

    // Add weight if available
    if (normalizedProductData.weight) {
      inventoryPayload.product.weight = {
        value: normalizedProductData.weight,
        unit: (normalizedProductData.weightUnit || 'lb').toUpperCase()
      };
      logger.debug('Added weight to listing', { value: normalizedProductData.weight, unit: normalizedProductData.weightUnit });
    }

    // Add dimensions if available
    if (normalizedProductData.dimensions) {
      let dims = normalizedProductData.dimensions;
      if (typeof dims === 'string') {
        try {
          dims = JSON.parse(dims);
        } catch (e) {
          dims = {};
        }
      }
      if (dims && (dims.length || dims.width || dims.height)) {
        inventoryPayload.product.dimensions = {
          length: dims.length || 0,
          width: dims.width || 0,
          height: dims.height || 0,
          unit: (dims.unit || 'IN').toUpperCase()
        };
        logger.debug('Added dimensions to listing', { dimensions: inventoryPayload.product.dimensions });
      }
    }

    if (videoAsset.ebayVideoId) {
      inventoryPayload.product.videoIds = [String(videoAsset.ebayVideoId)];
    }

    logger.debug('Creating inventory item', { sku, hasLocation: !!inventoryPayload.location, locationKey: merchantLocationKey });
    logger.debug('Full inventory payload for debugging', { payload: JSON.stringify(inventoryPayload) });

    const createResult = await upsertInventoryItemWithVideoFallback({
      apiBase,
      sku,
      payload: inventoryPayload,
      token,
      logger
    });

    if (createResult.videoFallbackApplied) {
      videoAsset = {
        ...videoAsset,
        attached: false,
        fallbackApplied: true,
        note: 'Video attachment failed in inventory API; listing published with images only.'
      };
    } else if (createResult.videoAttached) {
      videoAsset = {
        ...videoAsset,
        attached: true,
        fallbackApplied: false
      };
    }

    logger.success(`Inventory item created for SKU: ${sku}`);

    const offerPayload = {
      sku,
      marketplaceId,
      format: 'FIXED_PRICE',
      availableQuantity: quantity,
      categoryId: String(categoryId),
      listingDescription: String(normalizedProductData.description || '').substring(0, 4000),
      merchantLocationKey,
      pricingSummary: {
        price: {
          value: String(price),
          currency
        }
      },
      listingPolicies: {
        fulfillmentPolicyId,
        paymentPolicyId,
        returnPolicyId
      }
    };

    logger.debug('Creating offer', { categoryId, marketplaceId, quantity, price });

    let offerId;
    try {
      const offerResponse = await axios.post(`${apiBase}/sell/inventory/v1/offer`, offerPayload, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        },
        timeout: 30000
      });

      offerId = offerResponse.data.offerId;
      if (!offerId) {
        logger.error('eBay offer creation did not return offerId', { responseData: offerResponse.data });
        throw new Error('eBay offer creation did not return offerId.');
      }

      logger.success(`Offer created: ${offerId}`);
    } catch (offerError) {
      // If offer already exists, extract the offerId from the error and continue
      if (offerError.response?.data?.errors?.[0]?.errorId === 25002 && 
          offerError.response?.data?.errors?.[0]?.message?.includes('already exists')) {
        
        const errorParams = offerError.response.data.errors[0].parameters;
        if (errorParams && errorParams[0]?.value) {
          offerId = errorParams[0].value;
          logger.info(`Offer already exists with ID: ${offerId}, will use existing offer`);
        } else {
          throw offerError;
        }
      } else {
        throw offerError;
      }
    }

    logger.info(`Publishing offer: ${offerId}`);

    const publishResponse = await axios.post(`${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {}, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US'
      },
      timeout: 30000
    });

    const listingId = publishResponse.data?.listingId || null;
    const listingLink = listingId ? `${listingBase}/itm/${listingId}` : null;

    logger.success(`Listing published successfully`, { listingId, listingLink, quantity, enableBackorder });

    let marketing = {
      executedAt: new Date().toISOString(),
      sophisticatedMode: true,
      failTolerance: true,
      channels: [{ channel: 'SEO_ASSETS', status: 'SKIPPED', reason: 'No listing link generated yet' }]
    };

    if (listingId && listingLink) {
      try {
        marketing = await runPostPublishMarketingEngine({
          productData: normalizedProductData,
          publishResult: { listingId, listingLink, sku },
          logger
        });
        logger.success('Post-publish marketing engine completed', {
          channels: marketing.channels?.length || 0
        });
      } catch (marketingError) {
        logger.warn('Post-publish marketing engine failed, publish still successful', {
          error: marketingError.message
        });
        marketing = {
          executedAt: new Date().toISOString(),
          sophisticatedMode: true,
          failTolerance: true,
          channels: [{ channel: 'MARKETING_ENGINE', status: 'FAILED', error: marketingError.message }]
        };
      }
    }

    logger.info('========================================');
    logger.info('PUBLISH FLOW COMPLETED SUCCESSFULLY', { 
      sku, 
      listingId, 
      listingLink,
      quantity,
      imageCount: validatedImages.length
    });
    logger.info('========================================');
    
    return {
      success: true,
      offerId,
      sku,
      listingId,
      listingLink,
      status: 'PUBLISHED',
      action: 'CREATED',
      message: `New listing created and published with SKU: ${sku} (${quantity} units, backorder: ${enableBackorder})`,
      quantity,
      enableBackorder,
      media: videoAsset,
      marketing,
      logs: logger.getLogs()
    };
  } catch (error) {
    const errorSku = productData?.customLabel || productData?.sku || 'UNKNOWN';
    logger.error('========================================');
    logger.error('PUBLISH FLOW FAILED', {
      sku: errorSku,
      error: error.message,
      ebayErrors: error.response?.data?.errors || error.response?.data,
      stack: error.stack?.split('\n').slice(0, 3).join(' | ')
    });
    logger.error('========================================');
    
    if (isEbayAccessDeniedError(error)) {
      logger.info('Attempting Trading API fallback...');
      try {
        const fallbackResult = await publishViaTradingApiFallback(productData, logger, resolvedOverrides);
        logger.info('Trading API fallback succeeded');
        return {
          ...fallbackResult,
          success: true,
          logs: logger.getLogs()
        };
      } catch (fallbackError) {
        logger.error('Trading API fallback also failed', {
          error: fallbackError.message
        });
      }
    }

    logger.error('Publish operation failed', error);
    // Attach logs to error so they can be accessed in the endpoint error handler
    error._publisherLogs = logger.getLogs();
    throw error;
  }
}

app.post('/api/ebay-upload-images', async (req, res) => {
  try {
    const imageUrls = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls.filter(Boolean) : [];

    if (!imageUrls.length) {
      return res.status(400).json({
        success: false,
        error: 'imageUrls array is required and must contain at least one URL'
      });
    }

    const token = await getEbayAccessToken();
    const hostedImageUrls = await convertToEbayHostedImageUrls(imageUrls.slice(0, 24), token);

    return res.json({
      success: true,
      environment: resolveEbayEnvironment(),
      requested: imageUrls.length,
      processed: hostedImageUrls.length,
      hostedImageUrls
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload images to eBay EPS'
    });
  }
});

// Endpoint to validate eBay API credentials
app.get('/api/validate-ebay-credentials', async (req, res) => {
  try {
    const ebayEnv = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnv });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    const devId = ebayConfig.devId;

    // Check if credentials are configured
    if (!clientId || !clientSecret) {
      return res.json({
        success: false,
        error: 'eBay credentials not configured',
        details: {
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret,
          hasDevId: !!devId,
          environment: ebayEnv
        }
      });
    }

    // Get OAuth token using Client Credentials flow (application token)
    const { identityBase } = getEbayBaseUrls({ environment: ebayEnv });
    const scope = 'https://api.ebay.com/oauth/api_scope';
    const tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scope
    });

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    console.log(`[eBay API Validation] Testing credentials for ${ebayEnv} environment...`);
    const tokenResponse = await axios.post(
      `${identityBase}/identity/v1/oauth2/token`,
      tokenBody.toString(),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const accessToken = tokenResponse.data.access_token;
    
    // For sandbox, just getting a token is enough validation
    // The metadata API may not be fully available in sandbox
    console.log('[eBay API Validation] ✓ Credentials validated successfully');
    console.log('[eBay API Validation] Token received, length:', accessToken.length);

    return res.json({
      success: true,
      message: 'eBay API credentials are valid - OAuth token obtained successfully',
      details: {
        environment: ebayEnv,
        hasClientId: true,
        hasClientSecret: true,
        hasDevId: !!devId,
        tokenReceived: true,
        tokenLength: accessToken.length,
        apiEndpoint: identityBase,
        note: 'Sandbox environment - OAuth token generation successful'
      }
    });

  } catch (error) {
    console.error('[eBay API Validation] Error:', error.message);
    
    let errorMessage = 'Failed to validate eBay credentials';
    let errorDetails = {};

    if (error.response) {
      errorMessage = error.response.data?.error_description || error.response.data?.message || errorMessage;
      errorDetails = {
        status: error.response.status,
        statusText: error.response.statusText,
        error: error.response.data?.error,
        errorDescription: error.response.data?.error_description
      };
    } else {
      errorDetails = {
        message: error.message
      };
    }

    return res.status(400).json({
      success: false,
      error: errorMessage,
      details: errorDetails
    });
  }
});

// Get eBay publish schema requirements and seller info
app.get('/api/ebay-publish-schema', async (req, res) => {
  try {
    const ebayEnv = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnv });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    const refreshToken = ebayConfig.refreshToken;
    
    // Check configuration status
    const configStatus = {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken,
      hasFulfillmentPolicy: !!ebayConfig.fulfillmentPolicyId,
      hasPaymentPolicy: !!ebayConfig.paymentPolicyId,
      hasReturnPolicy: !!ebayConfig.returnPolicyId,
      hasCategoryId: !!ebayConfig.categoryId,
      hasLocationKey: !!ebayConfig.locationKey,
      environment: ebayEnv
    };

    let sellerInfo = null;
    let userToken = null;

    // Try to get user info if refresh token is available
    if (refreshToken && clientId && clientSecret) {
      try {
        userToken = await getEbayAccessToken({ environment: ebayEnv });
        const { apiBase } = getEbayBaseUrls();
        
        // Get seller account info
        const accountResponse = await axios.get(
          `${apiBase}/sell/account/v1/privilege`,
          {
            headers: {
              Authorization: `Bearer ${userToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );

        sellerInfo = {
          hasSellingPrivilege: true,
          privileges: accountResponse.data?.sellingLimit || null
        };

      } catch (error) {
        console.error('[Schema] Error fetching seller info:', error.message);
        sellerInfo = {
          error: 'Unable to fetch seller account info',
          details: error.response?.data || error.message,
          note: 'This may indicate that the refresh token is missing or invalid'
        };
      }
    }

    // Define the complete schema for publishing
    const schema = {
      required: {
        scraped_data: {
          title: 'string (max 80 chars)',
          description: 'string (max 4000 chars)',
          price: 'number (positive)',
          currency: 'string (e.g., USD)',
          availableQuantity: 'number or string (e.g., "10 available")',
          imageSourceUrls: 'array of strings (max 24 URLs)',
          itemSpecifics: 'object (key-value pairs for product aspects)'
        },
        environment_variables: {
          EBAY_CLIENT_ID: 'App ID (Client ID)',
          EBAY_CLIENT_SECRET: 'Cert ID (Client Secret)',
          EBAY_DEV_ID: 'Developer ID',
          EBAY_REFRESH_TOKEN: 'User OAuth refresh token (requires user consent)',
          EBAY_MARKETPLACE_ID: 'e.g., EBAY_US, EBAY_UK',
          EBAY_CATEGORY_ID: 'eBay category ID for the product',
          EBAY_FULFILLMENT_POLICY_ID: 'Shipping policy ID',
          EBAY_PAYMENT_POLICY_ID: 'Payment policy ID',
          EBAY_RETURN_POLICY_ID: 'Return policy ID',
          EBAY_LOCATION_KEY: 'Merchant location key (inventory location)'
        },
        request_parameters: {
          link: 'Scraped product link (from data.json)',
          categoryId: 'Optional override for category',
          marketplaceId: 'Optional override for marketplace'
        }
      },
      optional: {
        customLabel: 'SKU/label for the listing',
        itemNumber: 'Original eBay item number'
      },
      authentication: {
        type: 'OAuth 2.0 User Token',
        flow: 'Authorization Code Grant with Refresh Token',
        scopes: [
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
          'https://api.ebay.com/oauth/api_scope/sell.account'
        ],
        note: 'Requires user authorization to access seller account. Listings will be created under the authorized seller account.'
      },
      api_calls: [
        {
          step: 1,
          endpoint: 'PUT /sell/inventory/v1/inventory_item/{sku}',
          purpose: 'Create inventory item with product details',
          required_fields: ['condition', 'availability', 'product.title', 'product.description', 'product.imageUrls']
        },
        {
          step: 2,
          endpoint: 'POST /sell/inventory/v1/offer',
          purpose: 'Create offer with pricing and policies',
          required_fields: ['sku', 'marketplaceId', 'format', 'categoryId', 'pricingSummary', 'listingPolicies']
        },
        {
          step: 3,
          endpoint: 'POST /sell/inventory/v1/offer/{offerId}/publish',
          purpose: 'Publish the offer to create active listing',
          required_fields: []
        }
      ],
      policy_setup: {
        note: 'You must create fulfillment, payment, and return policies in your eBay Seller Hub before publishing',
        links: {
          sandbox: 'https://www.sandbox.ebay.com/sh/ovw/seller',
          production: 'https://www.ebay.com/sh/ovw/seller'
        }
      }
    };

    return res.json({
      success: true,
      schema,
      configuration: configStatus,
      sellerAccount: sellerInfo,
      missingConfiguration: Object.entries(configStatus)
        .filter(([key, val]) => key.startsWith('has') && val === false)
        .map(([key]) => key.replace('has', '').replace(/([A-Z])/g, '_$1').toUpperCase())
    });

  } catch (error) {
    console.error('[Schema] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get OAuth authorization URL for user consent
app.get('/api/ebay-auth-url', (req, res) => {
  const ebayEnv = resolveEbayEnvironment();
  const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnv });
  const refreshTokenEnvVar = ebayEnv === 'production' ? 'EBAY_PROD_REFRESH_TOKEN' : 'EBAY_REFRESH_TOKEN';
  const clientId = ebayConfig.clientId;
  const redirectUri = ebayConfig.redirectUri;
  
  if (!clientId) {
    return res.status(400).json({ error: 'EBAY_CLIENT_ID not configured' });
  }

  if (!redirectUri) {
    const uriVar = ebayEnv === 'production' ? 'EBAY_PROD_REDIRECT_URI' : 'EBAY_REDIRECT_URI';
    return res.status(400).json({ error: `${uriVar} not configured` });
  }

  const scopeString = [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
  ].join(' ');

  const authBaseUrl = ebayEnv === 'production'
    ? 'https://auth.ebay.com/oauth2/authorize'
    : 'https://auth.sandbox.ebay.com/oauth2/authorize';

  const authUrl = `${authBaseUrl}?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopeString)}`;

  return res.json({
    authUrl,
    redirectUri,
    environment: ebayEnv,
    refreshTokenEnvVar,
    note: 'Visit this URL to authorize the app to access your eBay seller account. After authorization, you will receive a code to exchange for a refresh token.'
  });
});

// OAuth callback endpoint - eBay redirects here after user authorization
app.get('/api/ebay-callback', (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`
      <html>
        <head><title>eBay Authorization Failed</title></head>
        <body style="font-family: Arial; padding: 40px; max-width: 800px; margin: 0 auto;">
          <h1 style="color: #d32f2f;">❌ Authorization Failed</h1>
          <p><strong>Error:</strong> ${error}</p>
          <p><strong>Description:</strong> ${error_description || 'User declined authorization'}</p>
          <p><a href="/">← Back to Home</a></p>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html>
        <head><title>No Authorization Code</title></head>
        <body style="font-family: Arial; padding: 40px; max-width: 800px; margin: 0 auto;">
          <h1 style="color: #d32f2f;">❌ No Authorization Code Received</h1>
          <p>The authorization code was not provided in the callback.</p>
          <p><a href="/">← Back to Home</a></p>
        </body>
      </html>
    `);
  }

  // Display the authorization code and instructions
  res.send(`
    <html>
      <head>
        <title>eBay Authorization Success</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; }
          .success { color: #2e7d32; }
          .code-box { background: #f5f5f5; border: 2px solid #4caf50; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .code { font-family: monospace; font-size: 14px; word-break: break-all; background: white; padding: 15px; border-radius: 4px; }
          .button { background: #4caf50; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; text-decoration: none; display: inline-block; margin-top: 10px; }
          .button:hover { background: #45a049; }
          pre { background: #263238; color: #aed581; padding: 15px; border-radius: 4px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1 class="success">✅ Authorization Successful!</h1>
        <p>Great! You've successfully authorized the app. Here's your authorization code:</p>
        
        <div class="code-box">
          <h3>Authorization Code:</h3>
          <div class="code">${code}</div>
          <button class="button" onclick="copyCode()">📋 Copy Code</button>
        </div>

        <h3>Next Step: Exchange Code for Refresh Token</h3>
        <p>Run this command in your terminal to exchange the code for a refresh token:</p>
        
        <pre>curl -X POST http://localhost:3001/api/ebay-exchange-code \\
  -H "Content-Type: application/json" \\
  -d '{"code": "${code}"}' | python3 -m json.tool</pre>

        <p><strong>Note:</strong> This code expires in 5 minutes. If it expires, you'll need to restart the authorization process.</p>

        <div id="toast" style="display:none; position: fixed; top: 20px; right: 20px; background: linear-gradient(135deg, #2e7d32 0%, #66bb6a 100%); color: white; padding: 16px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; animation: slideIn 0.3s ease-out;">✓ Authorization code copied to clipboard!</div>
        
        <style>
          @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(400px); opacity: 0; }
          }
        </style>

        <script>
          function copyCode() {
            navigator.clipboard.writeText('${code}');
            const toast = document.getElementById('toast');
            toast.style.display = 'block';
            setTimeout(() => {
              toast.style.animation = 'slideOut 0.3s ease-out forwards';
              setTimeout(() => toast.style.display = 'none', 300);
            }, 3000);
          }
        </script>
      </body>
    </html>
  `);
});

// Exchange authorization code for refresh token
app.post('/api/ebay-exchange-code', async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ 
        success: false, 
        error: 'Authorization code is required' 
      });
    }

    const ebayEnv = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnv });
    const refreshTokenEnvVar = ebayEnv === 'production' ? 'EBAY_PROD_REFRESH_TOKEN' : 'EBAY_REFRESH_TOKEN';
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    const redirectUri = ebayConfig.redirectUri || 'Strapey_Inc-StrapeyI-Strape-xmqocvrv';
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({ 
        success: false, 
        error: 'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured' 
      });
    }

    const { identityBase } = getEbayBaseUrls({ environment: ebayEnv });
    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    console.log('Exchanging authorization code for token...');
    
    const response = await axios.post(
      `${identityBase}/identity/v1/oauth2/token`,
      `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authString}`
        }
      }
    );

    const { access_token, refresh_token, expires_in, token_type } = response.data;

    console.log('✅ Token exchange successful!');
    console.log('Refresh token obtained:', refresh_token ? 'Yes' : 'No');

    return res.json({
      success: true,
      message: 'Authorization successful! Save this refresh token to your .env file',
      tokens: {
        access_token: access_token.substring(0, 50) + '...',
        refresh_token,
        expires_in,
        token_type
      },
      instructions: {
        step1: 'Copy the refresh_token value',
        step2: `Add it to your .env file as ${refreshTokenEnvVar}=<token>`,
        step3: 'Restart the server',
        step4: 'Create business policies in Seller Hub',
        step5: 'Test listing creation with POST /api/ebay-create-test-listing'
      },
      nextSteps: [
        'Business policies: https://www.sandbox.ebay.com/sh/ovw/seller',
        'Test listing: curl -X POST http://localhost:3001/api/ebay-create-test-listing'
      ]
    });

  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to exchange authorization code',
      details: error.response?.data || error.message,
      hint: 'The authorization code may have expired (5 min timeout). Try the authorization flow again.'
    });
  }
});

// Fetch business policies from eBay
app.get('/api/ebay-get-policies', async (req, res) => {
  try {
    const accessToken = await getEbayAccessToken();
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Failed to obtain access token',
        hint: 'Check EBAY_REFRESH_TOKEN in .env'
      });
    }

    const { apiBase } = getEbayBaseUrls();
    
    // Fetch all policy types
    const [fulfillmentPolicies, paymentPolicies, returnPolicies] = await Promise.all([
      axios.get(`${apiBase}/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
      }).catch(e => ({ data: { fulfillmentPolicies: [], error: e.response?.data } })),
      
      axios.get(`${apiBase}/sell/account/v1/payment_policy?marketplace_id=EBAY_US`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
      }).catch(e => ({ data: { paymentPolicies: [], error: e.response?.data } })),
      
      axios.get(`${apiBase}/sell/account/v1/return_policy?marketplace_id=EBAY_US`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
      }).catch(e => ({ data: { returnPolicies: [], error: e.response?.data } }))
    ]);

    const result = {
      success: true,
      marketplace: 'EBAY_US',
      fulfillmentPolicies: fulfillmentPolicies.data.fulfillmentPolicies || [],
      paymentPolicies: paymentPolicies.data.paymentPolicies || [],
      returnPolicies: returnPolicies.data.returnPolicies || [],
      policyErrors: {
        fulfillment: fulfillmentPolicies.data.error || null,
        payment: paymentPolicies.data.error || null,
        returns: returnPolicies.data.error || null
      },
      summary: {
        fulfillmentCount: (fulfillmentPolicies.data.fulfillmentPolicies || []).length,
        paymentCount: (paymentPolicies.data.paymentPolicies || []).length,
        returnCount: (returnPolicies.data.returnPolicies || []).length
      }
    };

    if (result.summary.fulfillmentCount === 0 && result.summary.paymentCount === 0 && result.summary.returnCount === 0) {
      result.message = 'No business policies found. Create them in Sandbox Seller Hub: https://www.sandbox.ebay.com/sh/ovw/seller';
    } else {
      result.message = 'Policies found! Copy the policy IDs to your .env file.';
    }

    return res.json(result);

  } catch (error) {
    console.error('Error fetching policies:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch business policies',
      details: error.response?.data || error.message
    });
  }
});

// Attempt to opt-in and create default business policies via API
app.post('/api/ebay-init-policies', async (req, res) => {
  try {
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const accessToken = await getEbayAccessToken({ environment: ebayEnvironment });
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Failed to obtain access token',
        hint: 'Check EBAY_REFRESH_TOKEN in .env'
      });
    }

    const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
    const marketplaceId = ebayConfig.marketplaceId || 'EBAY_US';
    const timestamp = Date.now();

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US'
      },
      timeout: 30000
    };

    const steps = [];

    // Step 1: Try opt-in to selling policy management program
    let optInResult = null;
    try {
      const optInResponse = await axios.post(
        `${apiBase}/sell/account/v1/program/opt_in`,
        { programType: 'SELLING_POLICY_MANAGEMENT' },
        requestConfig
      );
      optInResult = { status: 'success', statusCode: optInResponse.status };
      steps.push({ step: 1, name: 'Program opt-in', status: 'success', result: optInResult });
    } catch (optInError) {
      optInResult = {
        status: 'warning',
        message: optInError.response?.data?.errors?.[0]?.message || optInError.message,
        details: optInError.response?.data || null
      };
      steps.push({ step: 1, name: 'Program opt-in', status: 'warning', result: optInResult });
    }

    // Step 2: Create fulfillment policy
    let fulfillmentPolicyId = null;
    try {
      const fulfillmentPayload = {
        name: `Strapey Fulfillment ${timestamp}`,
        marketplaceId,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        handlingTime: { value: 1, unit: 'DAY' },
        shippingOptions: [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            shippingServices: [
              {
                shippingServiceCode: 'USPSPriority',
                shippingCost: { value: '0.0', currency: 'USD' },
                freeShipping: true
              }
            ]
          }
        ]
      };

      const fulfillmentResponse = await axios.post(
        `${apiBase}/sell/account/v1/fulfillment_policy`,
        fulfillmentPayload,
        requestConfig
      );

      fulfillmentPolicyId = fulfillmentResponse.data?.fulfillmentPolicyId || null;
      steps.push({
        step: 2,
        name: 'Create fulfillment policy',
        status: 'success',
        result: { fulfillmentPolicyId }
      });
    } catch (error) {
      steps.push({
        step: 2,
        name: 'Create fulfillment policy',
        status: 'error',
        error: error.response?.data || { message: error.message }
      });
    }

    // Step 3: Create payment policy
    let paymentPolicyId = null;
    try {
      const paymentPayload = {
        name: `Strapey Payment ${timestamp}`,
        marketplaceId,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        paymentMethods: [
          { 
            paymentMethodType: 'CREDIT_CARD',
            brands: ['VISA', 'MASTERCARD', 'AMERICAN_EXPRESS', 'DISCOVER']
          }
        ],
        immediatePay: false
      };

      const paymentResponse = await axios.post(
        `${apiBase}/sell/account/v1/payment_policy`,
        paymentPayload,
        requestConfig
      );

      paymentPolicyId = paymentResponse.data?.paymentPolicyId || null;
      steps.push({
        step: 3,
        name: 'Create payment policy',
        status: 'success',
        result: { paymentPolicyId }
      });
    } catch (error) {
      steps.push({
        step: 3,
        name: 'Create payment policy',
        status: 'error',
        error: error.response?.data || { message: error.message }
      });
    }

    // Step 4: Create return policy
    let returnPolicyId = null;
    try {
      const returnPayload = {
        name: `Strapey Return ${timestamp}`,
        marketplaceId,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        returnsAccepted: true,
        returnPeriod: { value: 30, unit: 'DAY' },
        refundMethod: 'MONEY_BACK',
        returnShippingCostPayer: 'BUYER'
      };

      const returnResponse = await axios.post(
        `${apiBase}/sell/account/v1/return_policy`,
        returnPayload,
        requestConfig
      );

      returnPolicyId = returnResponse.data?.returnPolicyId || null;
      steps.push({
        step: 4,
        name: 'Create return policy',
        status: 'success',
        result: { returnPolicyId }
      });
    } catch (error) {
      steps.push({
        step: 4,
        name: 'Create return policy',
        status: 'error',
        error: error.response?.data || { message: error.message }
      });
    }

    const created = {
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId
    };

    const allCreated = !!(fulfillmentPolicyId && paymentPolicyId && returnPolicyId);

    return res.json({
      success: allCreated,
      marketplaceId,
      created,
      steps,
      message: allCreated
        ? 'Policies created. Copy IDs into .env (EBAY_FULFILLMENT_POLICY_ID, EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID).'
        : 'One or more policies could not be created. Review step errors.'
    });
  } catch (error) {
    console.error('Error initializing policies:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize business policies',
      details: error.response?.data || error.message
    });
  }
});

// Setup default warehouse location: Des Plaines, Illinois, United States
app.post('/api/warehouse/setup-default', async (req, res) => {
  try {
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    const refreshToken = ebayConfig.refreshToken;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'eBay credentials not fully configured',
        details: 'Please set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN in your .env file',
        missingConfig: {
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret,
          hasRefreshToken: !!refreshToken
        }
      });
    }

    // Des Plaines, Illinois warehouse details
    const warehouseName = 'Des Plaines Primary Warehouse';
    const city = 'Des Plaines';
    const stateOrProvince = 'IL';
    const country = 'US';
    const merchantLocationKey = ebayConfig.locationKey || 'des-plaines-il-primary';

    // Get OAuth token
    const { identityBase } = getEbayBaseUrls({ environment: ebayEnvironment });
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    console.log('[Warehouse Setup] Setting up Des Plaines warehouse...');
    const tokenResponse = await axios.post(
      `${identityBase}/identity/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const token = tokenResponse.data.access_token;
    console.log('[Warehouse Setup] OAuth token obtained');

    // Create/Update warehouse location
    const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
    const warehousePayload = {
      location: {
        address: {
          city,
          stateOrProvince,
          country
        }
      },
      name: warehouseName,
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE']
    };

    console.log(`[Warehouse Setup] Creating warehouse location with key: ${merchantLocationKey}`);
    
    try {
      await axios.post(
        `${apiBase}/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
        warehousePayload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (createError) {
      // Check if location already exists (409 or 400 with "already exists" message)
      const isAlreadyExists = 
        createError.response?.status === 409 ||
        createError.response?.data?.errors?.[0]?.message?.includes('already exists');
      
      if (isAlreadyExists) {
        console.log('[Warehouse Setup] Location already exists, will use existing');
      } else {
        throw createError;
      }
    }

    // Store location key in environment variable (for this session)
    process.env.EBAY_LOCATION_KEY = merchantLocationKey;

    return res.json({
      success: true,
      message: 'Des Plaines warehouse configured as default',
      warehouse: {
        name: warehouseName,
        address: {
          city,
          state: stateOrProvince,
          country
        },
        locationKey: merchantLocationKey,
        status: 'ENABLED'
      },
      setupInstructions: {
        step1: 'Location key has been saved for this session',
        step2: 'To make this permanent, add to your .env file:',
        envUpdate: `EBAY_LOCATION_KEY=${merchantLocationKey}`,
        step3: 'Restart the server after updating .env file',
        step4: 'All future product publishes will use this warehouse location'
      },
      environment: resolveEbayEnvironment()
    });
  } catch (error) {
    console.error('[Warehouse Setup] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to setup Des Plaines warehouse',
      message: error.message,
      details: error.response?.data || null
    });
  }
});

function normalizeOperatingHours(operatingHours) {
  if (!Array.isArray(operatingHours)) return [];

  return operatingHours
    .map((entry) => {
      const dayOfWeekEnum = String(entry?.dayOfWeekEnum || '').trim().toUpperCase();
      const intervals = Array.isArray(entry?.intervals)
        ? entry.intervals
            .map((interval) => ({
              open: String(interval?.open || '').trim(),
              close: String(interval?.close || '').trim()
            }))
            .filter((interval) => interval.open && interval.close)
        : [];

      if (!dayOfWeekEnum || intervals.length === 0) return null;
      return { dayOfWeekEnum, intervals };
    })
    .filter(Boolean);
}

function normalizeSameDayCutoffSchedule(schedule) {
  if (!Array.isArray(schedule)) return [];

  return schedule
    .map((entry) => {
      const days = Array.isArray(entry?.dayOfWeekEnum)
        ? entry.dayOfWeekEnum.map((day) => String(day || '').trim().toUpperCase()).filter(Boolean)
        : [];
      const cutOffTime = String(entry?.cutOffTime || '').trim();

      if (!days.length || !cutOffTime) return null;
      return {
        dayOfWeekEnum: days,
        cutOffTime
      };
    })
    .filter(Boolean);
}

function buildInventoryLocationPayload(input = {}, defaults = {}) {
  const address = input?.location?.address || {};
  const geoCoordinates = input?.location?.geoCoordinates || {};

  const payload = {
    location: {
      address: {
        addressLine1: String(address.addressLine1 || defaults.addressLine1 || '').trim(),
        addressLine2: String(address.addressLine2 || defaults.addressLine2 || '').trim(),
        city: String(address.city || defaults.city || '').trim(),
        country: String(address.country || defaults.country || 'US').trim().toUpperCase(),
        postalCode: String(address.postalCode || defaults.postalCode || '').trim(),
        stateOrProvince: String(address.stateOrProvince || defaults.stateOrProvince || '').trim()
      }
    },
    name: String(input?.name || defaults.name || 'Strapey Fulfillment Location').trim(),
    phone: String(input?.phone || defaults.phone || '').trim(),
    locationTypes: Array.isArray(input?.locationTypes) && input.locationTypes.length
      ? input.locationTypes.map((type) => String(type || '').trim().toUpperCase()).filter(Boolean)
      : ['WAREHOUSE'],
    merchantLocationStatus: String(input?.merchantLocationStatus || defaults.merchantLocationStatus || 'ENABLED').trim().toUpperCase()
  };

  const latitude = String(geoCoordinates?.latitude || '').trim();
  const longitude = String(geoCoordinates?.longitude || '').trim();
  if (latitude && longitude) {
    payload.location.geoCoordinates = { latitude, longitude };
  }

  const operatingHours = normalizeOperatingHours(input?.operatingHours);
  if (operatingHours.length) {
    payload.operatingHours = operatingHours;
  }

  const weeklySchedule = normalizeSameDayCutoffSchedule(
    input?.fulfillmentCenterSpecifications?.sameDayShippingCutOffTimes?.weeklySchedule
  );
  if (weeklySchedule.length) {
    payload.fulfillmentCenterSpecifications = {
      sameDayShippingCutOffTimes: {
        weeklySchedule
      }
    };
  }

  if (!payload.location.address.addressLine2) delete payload.location.address.addressLine2;
  if (!payload.phone) delete payload.phone;

  return payload;
}

// Create inventory location from custom request payload mapping
app.post('/api/warehouse/create-location', async (req, res) => {
  try {
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const merchantLocationKey = String(req.body?.merchantLocationKey || ebayConfig.locationKey || 'default').trim();
    const dryRun = Boolean(req.body?.dryRun);

    if (!merchantLocationKey) {
      return res.status(400).json({
        success: false,
        error: 'merchantLocationKey is required'
      });
    }

    const payload = buildInventoryLocationPayload(req.body, {
      name: 'Strapey Fulfillment Location',
      country: 'US'
    });

    const missing = [];
    if (!payload.location?.address?.addressLine1) missing.push('location.address.addressLine1');
    if (!payload.location?.address?.city) missing.push('location.address.city');
    if (!payload.location?.address?.postalCode) missing.push('location.address.postalCode');
    if (!payload.location?.address?.stateOrProvince) missing.push('location.address.stateOrProvince');
    if (!payload.location?.address?.country) missing.push('location.address.country');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required location fields',
        missing,
        merchantLocationKey,
        environment: ebayEnvironment,
        mappedPayload: payload
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        merchantLocationKey,
        environment: ebayEnvironment,
        payload
      });
    }

    const token = await getEbayAccessToken({ environment: ebayEnvironment });
    const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });

    try {
      const response = await axios.post(
        `${apiBase}/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          },
          timeout: 30000
        }
      );

      return res.json({
        success: true,
        environment: ebayEnvironment,
        merchantLocationKey,
        statusCode: response.status,
        message: 'Inventory location created',
        payload
      });
    } catch (createError) {
      const status = createError.response?.status || 500;
      const apiError = createError.response?.data || null;
      const alreadyExists =
        status === 409 ||
        String(apiError?.errors?.[0]?.message || '').toLowerCase().includes('already exists');

      if (alreadyExists) {
        return res.status(409).json({
          success: false,
          environment: ebayEnvironment,
          merchantLocationKey,
          error: 'Location already exists',
          details: apiError,
          payload
        });
      }

      return res.status(status).json({
        success: false,
        environment: ebayEnvironment,
        merchantLocationKey,
        error: 'Failed to create inventory location',
        details: apiError,
        payload
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Unexpected error creating inventory location',
      message: error.message
    });
  }
});

// Simple test endpoint to verify eBay API connectivity and test creating a listing
app.post('/api/ebay-test-listing', async (req, res) => {
  try {
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: 'eBay credentials not configured',
        step: 'validation'
      });
    }

    const steps = [];
    
    // Step 1: Get OAuth Token
    console.log('[Test Listing] Step 1: Getting OAuth token...');
    steps.push({ step: 1, name: 'Get OAuth Token', status: 'in-progress' });
    
    try {
      const { identityBase } = getEbayBaseUrls({ environment: ebayEnvironment });
      const scope = 'https://api.ebay.com/oauth/api_scope';
      const tokenBody = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: scope
      });

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenResponse = await axios.post(
        `${identityBase}/identity/v1/oauth2/token`,
        tokenBody.toString(),
        {
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 15000
        }
      );

      const accessToken = tokenResponse.data.access_token;
      steps[0].status = 'success';
      steps[0].result = { tokenLength: accessToken.length };
      console.log('[Test Listing] ✓ OAuth token obtained');

      // Step 2: Test API connectivity with a simple GET request
      console.log('[Test Listing] Step 2: Testing API connectivity...');
      steps.push({ step: 2, name: 'Test API Connectivity', status: 'in-progress' });
      
      const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
      
      // Try to get inventory locations (simple GET request)
      try {
        const locationsResponse = await axios.get(
          `${apiBase}/sell/inventory/v1/location`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        
        steps[1].status = 'success';
        steps[1].result = {
          locationsCount: locationsResponse.data?.locations?.length || 0,
          hasLocations: (locationsResponse.data?.locations?.length || 0) > 0
        };
        console.log('[Test Listing] ✓ API connectivity confirmed');

        // Step 3: Create a test inventory item (only with client credentials token)
        console.log('[Test Listing] Step 3: Creating test inventory item...');
        steps.push({ step: 3, name: 'Create Test Inventory Item', status: 'in-progress' });
        
        const testSku = `test-sku-${Date.now()}`;
        const testInventoryPayload = {
          availability: {
            shipToLocationAvailability: {
              quantity: 1
            }
          },
          condition: 'NEW',
          product: {
            title: 'Test Product - API Connectivity Test',
            description: 'This is a test listing created to verify API connectivity. Do not purchase.',
            imageUrls: ['https://i.ebayimg.com/images/g/~oYAAOSwfVpV-WTf/s-l1600.jpg'],
            aspects: {
              Brand: ['Test Brand'],
              Type: ['Test Type']
            }
          }
        };

        try {
          const inventoryResponse = await axios.put(
            `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(testSku)}`,
            testInventoryPayload,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Content-Language': 'en-US'
              },
              timeout: 15000
            }
          );

          steps[2].status = 'success';
          steps[2].result = {
            sku: testSku,
            statusCode: inventoryResponse.status,
            note: 'Inventory item created successfully (user token required to create offers)'
          };
          console.log('[Test Listing] ✓ Test inventory item created');

          // Step 4: Note about creating offers
          steps.push({
            step: 4,
            name: 'Create Offer & Publish',
            status: 'skipped',
            note: 'Requires user OAuth token (refresh token). Use client credentials token for testing only. To publish listings, complete the OAuth flow and configure business policies.'
          });

        } catch (invError) {
          steps[2].status = 'error';
          steps[2].error = {
            message: invError.response?.data?.errors?.[0]?.message || invError.message,
            fullError: invError.response?.data
          };
          console.error('[Test Listing] ✗ Failed to create inventory item:', invError.response?.data || invError.message);
        }

      } catch (apiError) {
        steps[1].status = 'error';
        steps[1].error = {
          message: apiError.response?.data?.errors?.[0]?.message || apiError.message,
          fullError: apiError.response?.data
        };
        console.error('[Test Listing] ✗ API connectivity test failed:', apiError.response?.data || apiError.message);
      }

      return res.json({
        success: steps[0].status === 'success',
        message: 'eBay API test completed',
        steps: steps,
        summary: {
          tokenObtained: steps[0].status === 'success',
          apiConnected: steps[1]?.status === 'success',
          inventoryCreated: steps[2]?.status === 'success',
          readyToPublish: false,
          nextSteps: [
            'Complete OAuth flow to get user refresh token',
            'Configure business policies (fulfillment, payment, return)',
            'Set category ID for your products',
            'Create inventory location',
            'Then you can publish offers to create live listings'
          ]
        }
      });

    } catch (tokenError) {
      steps[0].status = 'error';
      steps[0].error = {
        message: tokenError.response?.data?.error_description || tokenError.message,
        fullError: tokenError.response?.data
      };
      
      return res.status(400).json({
        success: false,
        error: 'Failed to obtain OAuth token',
        steps: steps,
        details: tokenError.response?.data
      });
    }

  } catch (error) {
    console.error('[Test Listing] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test GET inventory items endpoint
app.get('/api/ebay-test-get-inventory', async (req, res) => {
  try {
    console.log('[Test GET] Getting OAuth token...');
    
    // Get OAuth token
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: 'eBay credentials not configured'
      });
    }

    const { identityBase, apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
    const scope = 'https://api.ebay.com/oauth/api_scope';
    const tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scope
    });

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await axios.post(
      `${identityBase}/identity/v1/oauth2/token`,
      tokenBody.toString(),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const accessToken = tokenResponse.data.access_token;
    console.log('[Test GET] ✓ Token obtained, making GET request...');

    // Make GET request to inventory items
    const limit = req.query.limit || 10;
    const offset = req.query.offset || 0;
    
    const inventoryUrl = `${apiBase}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
    console.log('[Test GET] Requesting:', inventoryUrl);

    try {
      const inventoryResponse = await axios.get(inventoryUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      console.log('[Test GET] ✓ Request successful');
      
      return res.json({
        success: true,
        message: 'Successfully retrieved inventory items',
        endpoint: inventoryUrl,
        data: inventoryResponse.data,
        summary: {
          total: inventoryResponse.data?.total || 0,
          limit: inventoryResponse.data?.limit || 0,
          offset: inventoryResponse.data?.offset || 0,
          itemsReturned: inventoryResponse.data?.inventoryItems?.length || 0,
          hasItems: (inventoryResponse.data?.inventoryItems?.length || 0) > 0
        }
      });

    } catch (apiError) {
      console.error('[Test GET] API Error:', apiError.response?.data || apiError.message);
      
      return res.status(apiError.response?.status || 500).json({
        success: false,
        error: 'API request failed',
        endpoint: inventoryUrl,
        errorDetails: {
          message: apiError.response?.data?.errors?.[0]?.message || apiError.message,
          errorId: apiError.response?.data?.errors?.[0]?.errorId,
          fullError: apiError.response?.data
        },
        note: apiError.response?.data?.errors?.[0]?.errorId === 1100 
          ? 'Access denied - This endpoint requires user OAuth token (not client credentials). You need to complete the OAuth flow to get a refresh token.'
          : 'Check error details for more information'
      });
    }

  } catch (tokenError) {
    console.error('[Test GET] Token Error:', tokenError.message);
    return res.status(400).json({
      success: false,
      error: 'Failed to obtain OAuth token',
      details: tokenError.response?.data
    });
  }
});

// Complete test to create a simple listing following Inventory API flow
app.post('/api/ebay-create-test-listing', async (req, res) => {
  try {
    const steps = [];
    const errors = [];
    
    // Check prerequisites
    console.log('[Create Test Listing] Checking prerequisites...');
    const ebayEnvironment = resolveEbayEnvironment();
    const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
    const clientId = ebayConfig.clientId;
    const clientSecret = ebayConfig.clientSecret;
    const refreshToken = ebayConfig.refreshToken;
    const fulfillmentPolicyId = ebayConfig.fulfillmentPolicyId;
    const paymentPolicyId = ebayConfig.paymentPolicyId;
    const returnPolicyId = ebayConfig.returnPolicyId;
    const categoryId = ebayConfig.categoryId || '179776'; // Default: Fixed Blade Knives (leaf category)
    const marketplaceId = ebayConfig.marketplaceId || 'EBAY_US';
    
    const missingConfig = [];
    if (!clientId) missingConfig.push('EBAY_CLIENT_ID');
    if (!clientSecret) missingConfig.push('EBAY_CLIENT_SECRET');
    if (!refreshToken) missingConfig.push('EBAY_REFRESH_TOKEN');
    if (!fulfillmentPolicyId) missingConfig.push('EBAY_FULFILLMENT_POLICY_ID');
    if (!paymentPolicyId) missingConfig.push('EBAY_PAYMENT_POLICY_ID');
    if (!returnPolicyId) missingConfig.push('EBAY_RETURN_POLICY_ID');
    
    if (missingConfig.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required configuration',
        missingConfig,
        message: 'Please complete OAuth flow and configure business policies. See EBAY_PUBLISH_GUIDE.md'
      });
    }
    
    // Step 1: Get User OAuth Token
    console.log('[Create Test Listing] Step 1: Getting user OAuth token...');
    steps.push({ step: 1, name: 'Get User OAuth Token', status: 'in-progress' });
    
    try {
      const token = await getEbayAccessToken();
      steps[0].status = 'success';
      steps[0].result = { tokenLength: token.length };
      console.log('[Create Test Listing] ✓ User token obtained');
      
      const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
      const timestamp = Date.now();
      const merchantLocationKey = ebayConfig.locationKey || `test-location-${timestamp}`;
      const sku = `test-sku-${timestamp}`;
      
      // Step 2: Create or verify inventory location
      console.log('[Create Test Listing] Step 2: Creating inventory location...');
      steps.push({ step: 2, name: 'Create Inventory Location', status: 'in-progress' });
      
      try {
        const locationPayload = {
          location: {
            address: {
              postalCode: '95125',
              stateOrProvince: 'CA',
              country: 'US'
            }
          },
          name: `Test Warehouse ${timestamp}`,
          merchantLocationStatus: 'ENABLED',
          locationTypes: ['WAREHOUSE']
        };
        
        const locationResponse = await axios.post(
          `${apiBase}/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
          locationPayload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': 'en-US'
            },
            timeout: 15000
          }
        );
        
        steps[1].status = 'success';
        steps[1].result = { merchantLocationKey, statusCode: locationResponse.status };
        console.log('[Create Test Listing] ✓ Location created');
        
      } catch (locationError) {
        // Location might already exist, try to continue
        if (locationError.response?.status === 400 || locationError.response?.status === 409) {
          steps[1].status = 'warning';
          steps[1].result = { message: 'Location may already exist, continuing...', merchantLocationKey };
          console.log('[Create Test Listing] ⚠ Location exists or error, continuing...');
        } else {
          throw locationError;
        }
      }
      
      // Step 3: Create inventory item
      console.log('[Create Test Listing] Step 3: Creating inventory item...');
      steps.push({ step: 3, name: 'Create Inventory Item', status: 'in-progress' });
      
      try {
        const inventoryPayload = {
          availability: {
            shipToLocationAvailability: {
              quantity: 1
            }
          },
          condition: 'NEW',
          product: {
            title: 'TEST - Damascus Steel Billet Bar Knife Making Supply - API Test',
            description: 'This is a test listing created via the eBay Inventory API to verify integration. Please do not purchase. If you see this listing, it is for testing purposes only.',
            imageUrls: [
              'https://i.ebayimg.com/images/g/~oYAAOSwfVpV-WTf/s-l1600.jpg'
            ],
            aspects: {
              Brand: ['SHARD'],
              'Blade Material': ['Damascus Steel'],
              'Blade Type': ['Drop Point'],
              Type: ['Hunting'],
              'Blade Color': ['Gray'],
              Tang: ['Full'],
              Dexterity: ['Ambidextrous'],
              Handmade: ['Yes']
            }
          }
        };
        
        const inventoryResponse = await axios.put(
          `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
          inventoryPayload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': 'en-US'
            },
            timeout: 15000
          }
        );
        
        steps[2].status = 'success';
        steps[2].result = { sku, statusCode: inventoryResponse.status };
        console.log('[Create Test Listing] ✓ Inventory item created');
        
      } catch (invError) {
        steps[2].status = 'error';
        steps[2].error = {
          message: invError.response?.data?.errors?.[0]?.message || invError.message,
          errorId: invError.response?.data?.errors?.[0]?.errorId,
          fullError: invError.response?.data
        };
        errors.push(`Step 3 failed: ${steps[2].error.message}`);
        console.error('[Create Test Listing] ✗ Inventory item creation failed');
      }
      
      // Step 4: Create offer
      if (steps[2].status === 'success') {
        console.log('[Create Test Listing] Step 4: Creating offer...');
        steps.push({ step: 4, name: 'Create Offer', status: 'in-progress' });
        
        try {
          const offerPayload = {
            sku,
            marketplaceId,
            format: 'FIXED_PRICE',
            availableQuantity: 1,
            categoryId: String(categoryId),
            listingDescription: 'This is a test listing created via the eBay Inventory API. Please do not purchase.',
            merchantLocationKey,
            pricingSummary: {
              price: {
                value: '9.99',
                currency: 'USD'
              }
            },
            listingPolicies: {
              fulfillmentPolicyId,
              paymentPolicyId,
              returnPolicyId
            }
          };
          
          const offerResponse = await axios.post(
            `${apiBase}/sell/inventory/v1/offer`,
            offerPayload,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Language': 'en-US'
              },
              timeout: 15000
            }
          );
          
          const offerId = offerResponse.data.offerId;
          steps[3].status = 'success';
          steps[3].result = { offerId, statusCode: offerResponse.status };
          console.log('[Create Test Listing] ✓ Offer created, offerId:', offerId);
          
          // Step 5: Publish offer
          console.log('[Create Test Listing] Step 5: Publishing offer...');
          steps.push({ step: 5, name: 'Publish Offer', status: 'in-progress' });
          
          try {
            const publishResponse = await axios.post(
              `${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
              {},
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                  'Content-Language': 'en-US'
                },
                timeout: 45000
              }
            );
            
            const listingId = publishResponse.data.listingId;
            steps[4].status = 'success';
            steps[4].result = {
              listingId,
              statusCode: publishResponse.status,
              listingUrl: `https://${resolveEbayEnvironment() === 'sandbox' ? 'sandbox.' : ''}ebay.com/itm/${listingId}`
            };
            console.log('[Create Test Listing] ✓ Listing published! ListingId:', listingId);
            
            return res.json({
              success: true,
              message: 'Test listing created successfully!',
              listingId,
              listingUrl: steps[4].result.listingUrl,
              sku,
              offerId,
              merchantLocationKey,
              steps,
              note: 'This is a live test listing. You should end/delete it from Seller Hub after testing.'
            });
            
          } catch (publishError) {
            steps[4].status = 'error';
            steps[4].error = {
              message: publishError.response?.data?.errors?.[0]?.message || publishError.message,
              errorId: publishError.response?.data?.errors?.[0]?.errorId,
              longMessage: publishError.response?.data?.errors?.[0]?.longMessage,
              fullError: publishError.response?.data
            };
            errors.push(`Step 5 failed: ${steps[4].error.message}`);
            console.error('[Create Test Listing] ✗ Publish failed');
          }
          
        } catch (offerError) {
          steps[3].status = 'error';
          steps[3].error = {
            message: offerError.response?.data?.errors?.[0]?.message || offerError.message,
            errorId: offerError.response?.data?.errors?.[0]?.errorId,
            longMessage: offerError.response?.data?.errors?.[0]?.longMessage,
            fullError: offerError.response?.data
          };
          errors.push(`Step 4 failed: ${steps[3].error.message}`);
          console.error('[Create Test Listing] ✗ Offer creation failed');
        }
      }
      
      return res.status(400).json({
        success: false,
        message: 'Test listing creation failed',
        errors,
        steps,
        troubleshooting: [
          'Check that all business policies are created in Seller Hub',
          'Verify category ID is valid and available in your marketplace',
          'Ensure all required item specifics are provided for the category',
          'Check eBay Seller Hub for detailed error messages'
        ]
      });
      
    } catch (tokenError) {
      steps[0].status = 'error';
      steps[0].error = {
        message: tokenError.response?.data?.error_description || tokenError.message,
        fullError: tokenError.response?.data
      };
      
      return res.status(400).json({
        success: false,
        error: 'Failed to obtain user OAuth token',
        steps,
        message: 'Refresh token is invalid or expired. Complete OAuth flow again.'
      });
    }
    
  } catch (error) {
    console.error('[Create Test Listing] Unexpected error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      steps
    });
  }
});

// Helper: Check if a product should be scraped based on 24-hour window
function shouldScrapeProduct(productData) {
  // If no lastScrapedAt, allow scrape
  if (!productData || !productData.lastScrapedAt) {
    return true;
  }

  const lastScrapedTime = new Date(productData.lastScrapedAt).getTime();
  const currentTime = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  
  return (currentTime - lastScrapedTime) >= twentyFourHoursMs;
}

// Helper: Resolve inventory quantity from known product inventory fields
function getProductInventoryForScrape(productData) {
  const candidates = [
    productData?.inventory,
    productData?.inventoryQuantity,
    productData?.availableQuantity,
    productData?.quantityAvailable
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const parsed = Number(String(candidate).replace(/,/g, '').trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

// Helper: Get product from data.json by link
function getProductByLink(link) {
  try {
    const dataFile = path.join(__dirname, 'data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      return null;
    }

    const content = fs.readFileSync(dataFile, 'utf8');
    const allData = JSON.parse(content) || {};
    return allData[link] || null;
  } catch (error) {
    console.error('Error getting product by link:', error);
    return null;
  }
}

// Helper: Update all existing products with lastScrapedAt timestamp
function updateAllProductsWithTimestamp() {
  try {
    const dataFile = path.join(__dirname, 'data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      return { success: false, error: 'data.json not found' };
    }

    const content = fs.readFileSync(dataFile, 'utf8');
    let allData = JSON.parse(content) || {};
    const now = new Date().toISOString();
    let updated = 0;

    // Update all products that don't have lastScrapedAt
    Object.keys(allData).forEach(key => {
      if (!allData[key].lastScrapedAt) {
        allData[key].lastScrapedAt = now;
        updated++;
      }
    });

    // Write back to file
    fs.writeFileSync(dataFile, JSON.stringify(allData, null, 2));
    
    return { 
      success: true, 
      message: `Updated ${updated} products with current timestamp`,
      totalProducts: Object.keys(allData).length,
      timestamp: now
    };
  } catch (error) {
    console.error('Error updating products with timestamp:', error);
    return { success: false, error: error.message };
  }
}

// Smart Scraping Endpoint - Queue-based with async processing
app.post('/scrape', async (req, res) => {
  const logger = createLogger('ScrapeEndpoint');
  try {
    const body = req.body || {};
    logger.info('Scrape request received', { itemCount: Array.isArray(body.items) ? body.items.length : Array.isArray(body.urls) ? body.urls.length : 0 });
    
    let items = Array.isArray(body.items) ? body.items : null;
    // Support legacy format: { urls: [ "https://..." ] } → convert to items
    if (!items && Array.isArray(body.urls)) {
      logger.debug('Converting legacy urls format to items format', { urlCount: body.urls.length });
      items = body.urls.map(u => ({
        itemNumber: '',
        link: typeof u === 'string' ? u.trim() : '',
        sku: ''
      })).filter(i => i.link);
    }
    
    if (!items || items.length === 0) {
      logger.warn('No valid items provided in request', { hasItems: !!items, itemCount: items ? items.length : 0 });
      return res.status(400).json({
        error: 'Send items (Item number, Link, SKU) or urls. Example: { "items": [ { "itemNumber": "123", "link": "https://www.ebay.com/itm/123", "sku": "MY-SKU" } ] }',
        timestamp: new Date().toISOString(),
        logs: logger.getLogs()
      });
    }

    logger.info('Creating scrape job queue', { totalItems: items.length });
    
    // Create job and save to queue
    const jobId = await scrapeQueue.createScrapeJob(items, body.customLabel);
    logger.info('Scrape job queued', { jobId, totalItems: items.length });
    
    // Return immediately with job ID
    res.json({
      success: true,
      jobId: jobId,
      message: 'Scraping job queued. Processing in background...',
      status: 'queued',
      timestamp: new Date().toISOString()
    });

    // Process asynchronously (don't await)
    setImmediate(async () => {
      await processScrapeJob(jobId);
    });
    
  } catch (error) {
    logger.error('Scrape endpoint error', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get scrape job status
app.get('/scrape/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await scrapeQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
        jobId
      });
    }
    
    res.json({
      success: true,
      job: job,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all scrape jobs
app.get('/scrape/jobs', async (req, res) => {
  try {
    const jobs = await scrapeQueue.getQueue();
    res.json({
      success: true,
      jobs: jobs,
      total: jobs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Initialize scrape timestamps for all existing products
app.post('/scrape/initialize-timestamps', (req, res) => {
  try {
    const result = updateAllProductsWithTimestamp();
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Failed to update timestamps'
      });
    }

    res.json({
      success: true,
      message: result.message,
      totalProducts: result.totalProducts,
      updated: result.message.match(/\d+/)[0],
      timestamp: result.timestamp
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process a scrape job in the background
async function processScrapeJob(jobId) {
  const logger = createLogger('ScrapeJobProcessor');
  
  try {
    logger.info('Starting scrape job', { jobId });
    await scrapeQueue.markAsProcessing(jobId);
    
    const job = await scrapeQueue.getJob(jobId);
    if (!job) {
      logger.error('Job not found', { jobId });
      return;
    }

    logger.info('Processing items', { totalItems: job.items.length, concurrency: SCRAPE_CONCURRENCY, fastPipeline: FAST_PIPELINE_ENABLED });

    await mapWithConcurrency(job.items, SCRAPE_CONCURRENCY, async (item, index) => {
      const link = (item.link || item.url || (typeof item === 'string' ? item : '')).trim();
      const itemNumber = String(item.itemNumber).trim();
      const sku = String(item.sku).trim();
      
      logger.debug('Processing item', { index, link, itemNumber, sku });
      
      if (!link) {
        logger.warn('Item missing link', { index, itemNumber, sku });
        await scrapeQueue.updateItemResult(jobId, index, null, 'Link is required');
        return;
      }

      // Check if product was scraped within 24 hours
      const existingProduct = getProductByLink(link);
      if (existingProduct && !shouldScrapeProduct(existingProduct)) {
        const lastScraped = new Date(existingProduct.lastScrapedAt);
        const hoursSinceLastScrape = ((Date.now() - lastScraped.getTime()) / (1000 * 60 * 60)).toFixed(1);
        logger.info('Skipping: Product scraped recently', { 
          link, 
          lastScrapedAt: existingProduct.lastScrapedAt,
          hoursSinceLastScrape
        });
        await scrapeQueue.updateItemResult(jobId, index, existingProduct, 'Product scraped within 24 hours - skipped');
        return;
      }
      
      try {
        logger.info('Starting scrape for item', { jobId, index, link });
        const data = await scrapeEbayProduct(link, itemNumber, sku, item || {});
        logger.success('Item scraped successfully', { jobId, index, link, title: data.title });
        
        // Save scraped data to products with timestamp
        await saveProductToData(data);
        
        // Update job with result
        await scrapeQueue.updateItemResult(jobId, index, data, null);
      } catch (error) {
        logger.error('Scrape error for item', error);
        await scrapeQueue.updateItemResult(jobId, index, null, error.message);
      }

      if (SCRAPE_INTER_ITEM_DELAY_MS > 0) {
        logger.debug('Applying scrape throttle delay', { jobId, currentIndex: index, delayMs: SCRAPE_INTER_ITEM_DELAY_MS });
        await delay(SCRAPE_INTER_ITEM_DELAY_MS);
      }
    });

    logger.success('Scrape batch completed', { jobId, totalItems: job.items.length });
  } catch (err) {
    logger.error('Scrape job processing error', err);
    await scrapeQueue.updateJobStatus(jobId, 'failed');
  }
}

// Retry failed scrape items (cron job - runs every 10 minutes)
async function retryFailedScrapes() {
  const logger = createLogger('ScrapeRetryJob');
  
  try {
    const retryItems = await scrapeQueue.getRetryItems();
    
    if (retryItems.length === 0) {
      logger.debug('No items to retry');
      return;
    }
    
    logger.info('Found items to retry', { count: retryItems.length });
    
    await mapWithConcurrency(retryItems, SCRAPE_RETRY_CONCURRENCY, async (item) => {
      try {
        logger.info('Retrying item', { jobId: item.jobId, itemIndex: item.itemIndex, link: item.link, attempt: item.retries + 1 });
        const data = await scrapeEbayProduct(item.link, item.itemNumber, item.sku, item || {});
        logger.success('Item retry succeeded', { jobId: item.jobId, itemIndex: item.itemIndex });
        
        // Save product
        await saveProductToData(data);
        
        // Update job
        await scrapeQueue.updateItemResult(item.jobId, item.itemIndex, data, null);
      } catch (error) {
        logger.error('Retry failed', error);
        await scrapeQueue.updateItemResult(item.jobId, item.itemIndex, null, error.message);
      }
      if (SCRAPE_INTER_ITEM_DELAY_MS > 0) {
        await delay(SCRAPE_INTER_ITEM_DELAY_MS);
      }
    });
    
    // Cleanup old completed jobs
    await scrapeQueue.cleanupOldJobs();
    
  } catch (error) {
    logger.error('Retry job error', error);
  }
}

// Start retry cron job (every 10 minutes)
setInterval(retryFailedScrapes, 10 * 60 * 1000);

function sanitizeSkuFolderName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
}

function toPublicSkuImagePath(skuFolder, filename) {
  return `/images/${skuFolder}/${filename}`;
}

// Derives a stable identity for a remote eBay image URL (by CDN image ID when
// available) so two scrapes of the same listing can be compared without caring
// about query-string/size-variant differences in the URL itself.
function getRemoteImageKey(url) {
  const normalized = String(url || '')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/(\?|#).*$/, '');
  const gMatch = normalized.match(/\/images\/g\/([^/]+)/i);
  if (gMatch) return `g:${gMatch[1].toLowerCase()}`;
  const zMatch = normalized.match(/\/z\/([^/]+)/i);
  if (zMatch) return `z:${zMatch[1].toLowerCase()}`;
  return `u:${normalized.toLowerCase()}`;
}

function getRemoteImageKeySet(urls) {
  return new Set((Array.isArray(urls) ? urls : []).map(getRemoteImageKey));
}

function imageKeySetsMatch(a, b) {
  if (a.size === 0 || b.size === 0 || a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

function hasLocalSkuImages(skuFolder) {
  const dir = path.join(__dirname, 'data', 'images', skuFolder);
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
  } catch (_) {
    return false;
  }
}

function clearSkuImageFolder(skuFolder) {
  const dir = path.join(__dirname, 'data', 'images', skuFolder);
  if (!fs.existsSync(dir)) return;
  try {
    fs.emptyDirSync(dir);
  } catch (_) {
    // Best-effort; a failed cleanup just means old files linger alongside new ones.
  }
}

// Renames a product's SKU-based image folder (and embedded filename tokens) on disk,
// returning a Map of old public image path -> new public image path so callers can
// remap any stored image URL arrays (images, imageSourceUrls, imagesOriginal, etc.).
function renameProductSkuAssets(oldSku, newSku) {
  const oldFolder = sanitizeSkuFolderName(oldSku) || 'NoSKU';
  const newFolder = sanitizeSkuFolderName(newSku) || 'NoSKU';
  const renameMap = new Map();

  if (oldFolder === newFolder) {
    return renameMap;
  }

  const oldDir = path.join(__dirname, 'data', 'images', oldFolder);
  if (!fs.existsSync(oldDir)) {
    return renameMap;
  }

  const newDir = path.join(__dirname, 'data', 'images', newFolder);
  fs.ensureDirSync(newDir);

  const tokenPattern = new RegExp(oldFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const files = fs.readdirSync(oldDir);

  for (const file of files) {
    const renamedFile = file.replace(tokenPattern, newFolder);
    const sourcePath = path.join(oldDir, file);
    const targetPath = path.join(newDir, renamedFile);
    try {
      fs.moveSync(sourcePath, targetPath, { overwrite: true });
      renameMap.set(toPublicSkuImagePath(oldFolder, file), toPublicSkuImagePath(newFolder, renamedFile));
    } catch (_) {
      // Best-effort; leave file in place if the move fails.
    }
  }

  try {
    if (fs.readdirSync(oldDir).length === 0) {
      fs.removeSync(oldDir);
    }
  } catch (_) {
    // Ignore cleanup errors.
  }

  return renameMap;
}

function migrateLegacyImagePathToSku(imagePath, skuFolder) {
  const normalized = String(imagePath || '').trim();
  if (!normalized) return normalized;

  // Already in public SKU format
  if (/^\/images\/[A-Za-z0-9_-]+\//.test(normalized)) {
    return normalized;
  }

  const filename = path.basename(normalized);
  if (!filename) return normalized;

  const targetDir = path.join(__dirname, 'data', 'images', skuFolder);
  fs.ensureDirSync(targetDir);

  const sourceCandidates = [
    path.join(__dirname, normalized.replace(/^\//, '')),
    path.join(__dirname, 'data', normalized.replace(/^\/?data\//, ''))
  ];

  const sourcePath = sourceCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  });

  const targetPath = path.join(targetDir, filename);
  if (sourcePath && sourcePath !== targetPath) {
    try {
      fs.moveSync(sourcePath, targetPath, { overwrite: true });
    } catch (_) {
      // Keep normalization best-effort; path will still be rewritten.
    }
  }

  return toPublicSkuImagePath(skuFolder, filename);
}

function collectLegacyImagesForSku(skuFolder) {
  const dataRoot = path.join(__dirname, 'data');
  const targetDir = path.join(dataRoot, 'images', skuFolder);
  fs.ensureDirSync(targetDir);

  const migratedPublicPaths = [];
  const entries = fs.readdirSync(dataRoot, { withFileTypes: true });
  const hexDirs = entries.filter((entry) => entry.isDirectory() && /^[0-9a-f]{32}$/i.test(entry.name));

  for (const dir of hexDirs) {
    const legacyDir = path.join(dataRoot, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(legacyDir);
    } catch (_) {
      continue;
    }

    for (const file of files) {
      // Match filenames created by scraper: Strapey_{SKU}_..._enhanced.webp
      if (!new RegExp(`^Strapey_${skuFolder}_`, 'i').test(file)) {
        continue;
      }

      const sourcePath = path.join(legacyDir, file);
      const targetPath = path.join(targetDir, file);
      try {
        fs.moveSync(sourcePath, targetPath, { overwrite: true });
        migratedPublicPaths.push(toPublicSkuImagePath(skuFolder, file));
      } catch (_) {
        // Best-effort migration.
      }
    }

    // Remove empty legacy directory after migration.
    try {
      const remaining = fs.readdirSync(legacyDir);
      if (remaining.length === 0) {
        fs.removeSync(legacyDir);
      }
    } catch (_) {
      // Ignore cleanup errors.
    }
  }

  return migratedPublicPaths;
}

function normalizeProductImageStorage(product) {
  const skuFolder = sanitizeSkuFolderName(product.sku || product.customLabel || product.itemNumber || 'NoSKU') || 'NoSKU';

  const normalizeList = (list) => {
    if (!Array.isArray(list)) return [];
    const normalized = list
      .map((img) => migrateLegacyImagePathToSku(img, skuFolder))
      .filter(Boolean);
    return Array.from(new Set(normalized));
  };

  const normalizedSource = normalizeList(product.imageSourceUrls);
  const normalizedImages = normalizeList(product.images);
  const normalizedOriginal = normalizeList(product.imagesOriginal);
  const migratedFromLegacyFolders = collectLegacyImagesForSku(skuFolder);
  const merged = Array.from(new Set([
    ...normalizedSource,
    ...normalizedImages,
    ...normalizedOriginal,
    ...migratedFromLegacyFolders
  ]));

  product.imageSourceUrls = merged;
  product.images = merged;
  product.imagesOriginal = merged;
  product.imageFolderType = 'sku-based';
  product.lastImageMapDate = new Date().toISOString();

  return product;
}

// Save product to data.json with intelligent merging
// data.json is a single shared file that multiple concurrent scrape/save calls read
// and rewrite. Without serialization, one call's read can land mid-write of another
// call's write, see a truncated/partial file, and (if mishandled) write that emptiness
// back out - destroying the whole product catalog. dataFileWriteQueue forces every
// read-modify-write cycle against data.json through a single-file-at-a-time queue, and
// atomicWriteJsonSync ensures a reader can never observe a half-written file in the
// first place (write to temp file, then atomic rename).
let dataFileWriteQueue = Promise.resolve();
function withDataFileLock(fn) {
  const result = dataFileWriteQueue.then(fn, fn);
  dataFileWriteQueue = result.then(() => {}, () => {});
  return result;
}

function atomicWriteJsonSync(filePath, data, options = {}) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeJsonSync(tmpPath, data, options);
  fs.renameSync(tmpPath, filePath);
}

function readDataFileOrThrow(dataFile) {
  if (!fs.existsSync(dataFile)) {
    return {};
  }
  const content = fs.readFileSync(dataFile, 'utf8');
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`data.json did not contain a valid product object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
  }
  return parsed;
}

async function saveProductToData(productData) {
  return withDataFileLock(() => saveProductToDataUnlocked(productData));
}

async function saveProductToDataUnlocked(productData) {
  try {
    const dataFile = path.join(__dirname, 'data', 'data.json');

    // NOTE: intentionally NOT catching read/parse errors here and falling back to
    // `{}` - a transient bad read must abort the save, never proceed as if the
    // catalog were empty (that is exactly how a previous version of this function
    // wiped 1000+ products down to a handful during concurrent scraping).
    const existingData = readDataFileOrThrow(dataFile);
    const initialProductCount = Object.keys(existingData).length;

    const productKey = productData.url || productData.link || productData.id || productData.sku;
    if (!productKey) {
      throw new Error('Cannot save product: missing url/link/id/sku key');
    }

    const existingProduct = existingData[productKey];
    const isNewProduct = !existingProduct;
    
    const now = new Date().toISOString();
    
    // Intelligent merge: Keep ALL existing data, overlay new scraped data
    // CRITICAL: This preserves imported data (category IDs, pricing) while updating scraped content
    let mergedProduct = applyProductGroup({
      ...(existingProduct || {}),    // Start with ALL existing data
      ...productData,                 // Overlay new scraped data
      // Preserve critical imported fields if they exist and scraped data doesn't provide them
      itemNumber: productData.itemNumber || (existingProduct && existingProduct.itemNumber) || '',
      sku: productData.sku || (existingProduct && existingProduct.sku) || '',
      ebayCategoryId: productData.ebayCategoryId || (existingProduct && existingProduct.ebayCategoryId) || '',
      ebayCategory: productData.ebayCategory || (existingProduct && existingProduct.ebayCategory) || '',
      categoryId: productData.categoryId || (existingProduct && existingProduct.categoryId) || (existingProduct && existingProduct.ebayCategoryId) || '',
      weight: (productData.weight ?? (existingProduct && existingProduct.weight) ?? null),
      weightUnit: (productData.weightUnit ?? (existingProduct && existingProduct.weightUnit) ?? null),
      // Update timestamps
      lastUpdated: now,
      lastScrapedAt: now,
      // Track source
      source: isNewProduct ? 'scrape-new' : 'scrape-update'
    });

    // Enforce SKU-based image storage and paths for every write.
    mergedProduct = normalizeProductImageStorage(mergedProduct);
    
    // CRITICAL: ONLY upsert - never remove other products
    existingData[productKey] = mergedProduct;

    // SAFETY CHECK: Verify we're not about to lose products
    const finalProductCount = Object.keys(existingData).length;
    if (finalProductCount < initialProductCount) {
      const error = `⚠️  CRITICAL: Attempted to save would reduce product count from ${initialProductCount} to ${finalProductCount}. ABORTING WRITE to prevent data loss!`;
      console.error(error);
      throw new Error(error);
    }

    // Write with backup first - BUT ONLY if data size is reasonable
    const backupFile = dataFile + `.backup-${Date.now()}`;
    try {
      // CRITICAL: Before backing up, verify we're not backing up corrupted/empty data
      const beforeBackupSize = fs.statSync(dataFile).size;
      if (beforeBackupSize > 0 && beforeBackupSize < 1000) {
        // File is suspiciously small (<1KB = likely <50 products)
        console.warn(`⚠️ WARNING: Current data.json is only ${beforeBackupSize} bytes - NOT creating automatic backup to prevent corruption backup loops`);
      } else if (beforeBackupSize > 0) {
        // Size looks reasonable, create backup
        await fs.copy(dataFile, backupFile);
      }
    } catch (backupError) {
      console.warn('Could not create backup before save, but continuing:', backupError.message);
    }

    atomicWriteJsonSync(dataFile, existingData, { spaces: 2 });

    // Clean old automatic backups (keep last 5 GOOD backups)
    try {
      const dataDir = path.dirname(dataFile);
      const files = await fs.readdir(dataDir);
      const autoBackups = files
        .filter(f => f.startsWith('data.json.backup-') && /\d{13}$/.test(f))
        .map(f => {
          const fpath = path.join(dataDir, f);
          try {
            const stat = fs.statSync(fpath);
            return {
              name: f,
              path: fpath,
              time: parseInt(f.match(/\d{13}$/)[0]),
              size: stat.size
            };
          } catch (e) {
            return null; // Skip if file no longer exists
          }
        })
        .filter(b => b !== null && b.size > 10000) // Only keep reasonable-sized backups (>10KB = ~200+ products)
        .sort((a, b) => b.time - a.time);
      
      // Delete old backups beyond the last 5 good ones
      for (let i = 5; i < autoBackups.length; i++) {
        await fs.unlink(autoBackups[i].path);
      }
    } catch (cleanupError) {
      // Non-critical, just log
      console.debug('Backup cleanup skipped:', cleanupError.message);
    }
    
    if (isNewProduct) {
      console.log(`✓ New product saved: ${productData.title || productData.sku} (Total: ${finalProductCount})`);
    } else {
      console.log(`✓ Product updated: ${productData.title || productData.sku} (Total: ${finalProductCount})`);
    }
    
    return true;
  } catch (error) {
    console.error('Error saving product:', error);
    return false;
  }
}

app.post('/publish-ebay', async (req, res) => {
  const logger = createLogger('PublishEbayEndpoint');
  
  try {
    logger.info('Publish request received', { body: req.body });
    
    const link = String(req.body?.link || req.body?.url || '').trim();
    const categoryId = String(req.body?.categoryId || '').trim();
    const marketplaceId = String(req.body?.marketplaceId || '').trim();

    if (!link) {
      logger.warn('Missing link parameter');
      return res.status(400).json({ 
        error: 'link is required',
        logs: logger.getLogs()
      });
    }

    logger.info('Validating data store', { link });

    const dataFile = path.join('data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      logger.error('Data file not found', { dataFile });
      return res.status(404).json({ 
        error: 'data store not found. Scrape first.',
        logs: logger.getLogs()
      });
    }

    const allData = fs.readJsonSync(dataFile);
    let productData = allData[link];
    if (!productData) {
      logger.warn('Product not found in data store', { link });
      return res.status(404).json({ 
        error: 'Listing not found in data store for this link.',
        logs: logger.getLogs()
      });
    }

    productData = forceNewConditionDefaults(productData);
    allData[link] = productData;

    logger.info('Product found, initiating publish', {
      title: productData.title,
      price: productData.price,
      categoryId: productData.categoryId
    });

    const publishResult = await publishToEbay(productData, { categoryId: categoryId || undefined, marketplaceId: marketplaceId || undefined });
    
    logger.success('Publish operation completed', { action: publishResult.action });

    // Save the listing link, action, and metadata to data.json
    productData.publishedLink = publishResult.listingLink;
    productData.listingId = publishResult.listingId;
    productData.sku = publishResult.sku;
    productData.offerId = publishResult.offerId;
    productData.publishAction = publishResult.action || 'CREATED';  // Track action: CREATED, UPDATED, or UNCHANGED
    productData.publishedDate = new Date().toISOString();
    productData.media = publishResult.media || productData.media || null;
    productData.marketing = publishResult.marketing || productData.marketing || null;
    // Store inventory settings for future use
    productData.inventoryQuantity = publishResult.quantity || 3;
    productData.enableBackorder = publishResult.enableBackorder !== undefined ? publishResult.enableBackorder : true;
    productData.condition = 'NEW';
    productData.conditionDisplay = 'New';
    if (productData.itemSpecifics && typeof productData.itemSpecifics === 'object') {
      productData.itemSpecifics.Condition = 'New';
    }
    allData[link] = productData;
    fs.writeJsonSync(dataFile, allData);

    const environment = resolveEbayEnvironment();
    appendProductActivityLog({
      productId: String(productData.itemNumber || productData.sku || productData.customLabel || link),
      actionType: environment === 'production' ? 'PRODUCT_PUBLISHED_PRODUCTION' : 'PRODUCT_PUBLISHED_SANDBOX',
      actionDescription: `Product published to eBay ${environment}: Listing ID ${publishResult.listingId || 'unknown'}`,
      sourceSystem: 'publish-ebay-endpoint',
      newValue: {
        environment,
        listingId: publishResult.listingId || null,
        listingLink: publishResult.listingLink || null,
        action: publishResult.action || 'CREATED'
      }
    });
    
    logger.info('Data saved to data.json', { sku: publishResult.sku, inventory: productData.inventoryQuantity, backorder: productData.enableBackorder });
    
    const actionMessages = {
      'CREATED': '✅ New listing created and published',
      'UPDATED': '✏️ Existing listing updated with latest data',
      'UNCHANGED': 'ℹ️ Listing already exists with no changes needed'
    };

    const actionMsg = actionMessages[publishResult.action] || 'Published successfully';
    
    return res.json({ 
      success: true, 
      link, 
      ...publishResult,
      message: `${actionMsg}! View at: ${publishResult.listingLink || 'https://www.sandbox.ebay.com'}`,
      timestamp: new Date().toISOString(),
      logs: publishResult.logs || logger.getLogs()
    });
  } catch (error) {
    logger.error('Publish endpoint error', error);
    
    // Combine logs from publishToEbay (if available) with endpoint logs
    let combinedLogs = logger.getLogs();
    if (error._publisherLogs && Array.isArray(error._publisherLogs)) {
      combinedLogs = [...error._publisherLogs, ...combinedLogs];
    }
    
    const errorResponse = {
      success: false,
      error: error.message,
      code: error.code || 'PUBLISH_ERROR',
      status: error.response?.status || 500,
      timestamp: new Date().toISOString(),
      logs: combinedLogs
    };

    // Add eBay API error details if available
    if (error.response?.data) {
      errorResponse.ebayErrorDetails = error.response.data;
    }

    const statusCode = error.response?.status || 500;
    return res.status(statusCode).json(errorResponse);
  }
});

// ============================================================================
// BULK PUBLISH ENDPOINTS
// ============================================================================

// Helper: Validate if a product has all required data for publishing
function validateProductForPublishing(product) {
  const normalizedProduct = forceNewConditionDefaults(product || {});
  const issues = [];
  const warnings = [];

  // Required fields
  if (!normalizedProduct.title || String(normalizedProduct.title).trim() === '') {
    issues.push('Missing title');
  }
  if (!normalizedProduct.price || Number(normalizedProduct.price) <= 0) {
    issues.push('Missing or invalid price');
  }
  if (!normalizedProduct.description || String(normalizedProduct.description).trim() === '') {
    issues.push('Missing description');
  }
  if (!Array.isArray(normalizedProduct.imageSourceUrls) || normalizedProduct.imageSourceUrls.length === 0) {
    issues.push('No images');
  }
  if (!normalizedProduct.categoryId) {
    warnings.push('No category ID in product schema');
  }

  return {
    isValid: issues.length === 0,
    issues,
    warnings
  };
}

// Helper: Get all publishable products from data.json
function getPublishableProducts() {
  try {
    const dataFile = path.join(__dirname, 'data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      return [];
    }

    const content = fs.readFileSync(dataFile, 'utf8');
    const allData = JSON.parse(content) || {};
    
    const publishable = [];
    const skipped = [];

    Object.entries(allData).forEach(([link, product]) => {
      const normalizedProduct = forceNewConditionDefaults(product || {});
      const validation = validateProductForPublishing(normalizedProduct);
      
      if (validation.isValid) {
        publishable.push({
          link,
          product: normalizedProduct,
          sku: normalizedProduct.sku || normalizedProduct.itemNumber || buildPublishSku(normalizedProduct)
        });
      } else {
        skipped.push({
          link,
          issues: validation.issues,
          warnings: validation.warnings
        });
      }
    });

    return { publishable, skipped };
  } catch (error) {
    console.error('Error getting publishable products:', error);
    return { publishable: [], skipped: [] };
  }
}

// In-memory bulk job tracking
const bulkPublishJobs = new Map();

// Generate unique job ID
function generateJobId() {
  return 'bulk-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getPreflightHelpResources(ebayEnvironment, code) {
  const isProduction = ebayEnvironment === 'production';
  const sellerHubUrl = isProduction
    ? 'https://www.ebay.com/sh/ovw'
    : 'https://www.sandbox.ebay.com/sh/ovw';

  const oauthScopes = [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account'
  ];

  const actionPlan = [];

  if (code === 'AUTH_TOKEN_INVALID' || code === 'AUTH_TOKEN_ERROR') {
    actionPlan.push('Generate a new authorization URL via GET /api/ebay-auth-url.');
    actionPlan.push('Authorize the app in the correct eBay environment and copy the callback code.');
    actionPlan.push('Exchange the code using POST /api/ebay-exchange-code and update EBAY_REFRESH_TOKEN in .env.');
    actionPlan.push('Restart the server and rerun POST /publish-ebay/preflight.');
  } else if (code === 'ACCESS_DENIED_PERMISSIONS' || code === 'PRIVILEGE_CHECK_FAILED') {
    actionPlan.push('Sign in to Seller Hub with the same user behind EBAY_REFRESH_TOKEN.');
    actionPlan.push('Confirm seller account is enabled for listing and API access in this environment.');
    actionPlan.push('Reauthorize with Sell Account + Sell Inventory scopes and update EBAY_REFRESH_TOKEN.');
    actionPlan.push('Rerun POST /publish-ebay/preflight before starting /publish-ebay/bulk.');
  } else if (code === 'POLICY_CONFIGURATION_INVALID' || code === 'POLICY_CHECK_FAILED') {
    actionPlan.push('Fetch policies from GET /api/ebay-get-policies in the active environment.');
    actionPlan.push('Update EBAY_FULFILLMENT_POLICY_ID, EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID in .env.');
    actionPlan.push('Ensure policy IDs belong to the same seller account and environment.');
    actionPlan.push('Restart the server and rerun POST /publish-ebay/preflight.');
  }

  return {
    sellerHubUrl,
    oauthAuthorizeEndpoint: '/api/ebay-auth-url',
    oauthExchangeEndpoint: '/api/ebay-exchange-code',
    policyFetchEndpoint: '/api/ebay-get-policies',
    requiredOauthScopes: oauthScopes,
    actionPlan
  };
}

async function runBulkPublishPreflight(logger = null) {
  const ebayEnvironment = resolveEbayEnvironment();
  const ebayConfig = getEbayRuntimeConfig({ environment: ebayEnvironment });
  const marketplaceId = ebayConfig.marketplaceId || 'EBAY_US';
  const baseHelp = getPreflightHelpResources(ebayEnvironment, null);
  const diagnostics = {
    checkedAt: new Date().toISOString(),
    environment: ebayEnvironment,
    marketplaceId,
    configuration: {
      missing: [],
      present: {},
      sources: ebayConfig.sources
    },
    auth: {
      ok: false,
      error: null,
      oauthError: null,
      oauthDescription: null
    },
    privileges: {
      ok: false,
      statusCode: null,
      error: null,
      sellingLimit: null
    },
    policies: {
      ok: false,
      statusCode: null,
      error: null,
      configuredIds: {
        fulfillment: ebayConfig.fulfillmentPolicyId || null,
        payment: ebayConfig.paymentPolicyId || null,
        returns: ebayConfig.returnPolicyId || null
      },
      discoveredCounts: {
        fulfillment: 0,
        payment: 0,
        returns: 0
      },
      missingConfiguredPolicies: []
    }
  };

  const recommendations = [];
  const requiredConfig = [
    { key: 'clientId', labels: ['EBAY_CLIENT_ID', 'EBAY_PROD_CLIENT_ID'] },
    { key: 'clientSecret', labels: ['EBAY_CLIENT_SECRET', 'EBAY_PROD_CLIENT_SECRET'] },
    { key: 'refreshToken', labels: ['EBAY_REFRESH_TOKEN', 'EBAY_PROD_REFRESH_TOKEN'] },
    { key: 'fulfillmentPolicyId', labels: ['EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PROD_FULFILLMENT_POLICY_ID'] },
    { key: 'paymentPolicyId', labels: ['EBAY_PAYMENT_POLICY_ID', 'EBAY_PROD_PAYMENT_POLICY_ID'] },
    { key: 'returnPolicyId', labels: ['EBAY_RETURN_POLICY_ID', 'EBAY_PROD_RETURN_POLICY_ID'] }
  ];

  for (const field of requiredConfig) {
    const resolvedValuePresent = Boolean(ebayConfig[field.key]);
    const resolvedSource = ebayConfig.sources?.[field.key] || null;
    const present = ebayEnvironment === 'production'
      ? (resolvedValuePresent && Boolean(resolvedSource && resolvedSource.startsWith('EBAY_PROD_')))
      : resolvedValuePresent;
    const primaryLabel = ebayEnvironment === 'production' ? field.labels[1] : field.labels[0];
    diagnostics.configuration.present[primaryLabel] = present;
    if (!present) diagnostics.configuration.missing.push(primaryLabel);
  }

  if (diagnostics.configuration.missing.length > 0) {
    recommendations.push(`Set missing environment variables: ${diagnostics.configuration.missing.join(', ')}`);
  }

  let token = null;
  try {
    token = await getEbayAccessToken({ environment: ebayEnvironment });
    diagnostics.auth.ok = true;
  } catch (error) {
    const oauthError = String(error?.response?.data?.error || '').toLowerCase();
    const oauthDescription = String(error?.response?.data?.error_description || '').toLowerCase();

    diagnostics.auth.ok = false;
    diagnostics.auth.error = error.message;
    diagnostics.auth.oauthError = oauthError || null;
    diagnostics.auth.oauthDescription = oauthDescription || null;

    if (
      oauthError === 'invalid_grant' ||
      oauthDescription.includes('refresh token is invalid') ||
      oauthDescription.includes('issued to another client')
    ) {
      recommendations.push('Refresh EBAY_REFRESH_TOKEN using the OAuth authorization flow and restart the server.');
      return {
        ok: false,
        code: 'AUTH_TOKEN_INVALID',
        statusCode: 401,
        diagnostics,
        recommendations,
        help: getPreflightHelpResources(ebayEnvironment, 'AUTH_TOKEN_INVALID')
      };
    }

    recommendations.push('Fix OAuth token retrieval before bulk publishing.');
    return {
      ok: false,
      code: 'AUTH_TOKEN_ERROR',
      statusCode: 400,
      diagnostics,
      recommendations,
      help: getPreflightHelpResources(ebayEnvironment, 'AUTH_TOKEN_ERROR')
    };
  }

  const { apiBase } = getEbayBaseUrls({ environment: ebayEnvironment });
  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US'
  };

  try {
    const privilegeResponse = await axios.get(`${apiBase}/sell/account/v1/privilege`, {
      headers: commonHeaders,
      timeout: 20000
    });

    diagnostics.privileges.ok = true;
    diagnostics.privileges.statusCode = privilegeResponse.status;
    diagnostics.privileges.sellingLimit = privilegeResponse.data?.sellingLimit || null;
  } catch (error) {
    diagnostics.privileges.ok = false;
    diagnostics.privileges.statusCode = error.response?.status || null;
    diagnostics.privileges.error = error.response?.data?.errors?.[0]?.message || error.message;

    if (diagnostics.privileges.statusCode === 403) {
      recommendations.push('Grant Sell Inventory/Sell Account permissions for this OAuth user and verify Seller Hub account access.');
      recommendations.push('Confirm EBAY_ENV matches the account where business policies were created (sandbox vs production).');
      return {
        ok: false,
        code: 'ACCESS_DENIED_PERMISSIONS',
        statusCode: 403,
        diagnostics,
        recommendations,
        help: getPreflightHelpResources(ebayEnvironment, 'ACCESS_DENIED_PERMISSIONS')
      };
    }

    recommendations.push('Resolve seller privilege API access before starting bulk publish.');
    return {
      ok: false,
      code: 'PRIVILEGE_CHECK_FAILED',
      statusCode: 400,
      diagnostics,
      recommendations,
      help: getPreflightHelpResources(ebayEnvironment, 'PRIVILEGE_CHECK_FAILED')
    };
  }

  try {
    const [fulfillmentRes, paymentRes, returnRes] = await Promise.all([
      axios.get(`${apiBase}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, {
        headers: commonHeaders,
        timeout: 20000
      }),
      axios.get(`${apiBase}/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, {
        headers: commonHeaders,
        timeout: 20000
      }),
      axios.get(`${apiBase}/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, {
        headers: commonHeaders,
        timeout: 20000
      })
    ]);

    const fulfillmentPolicies = fulfillmentRes.data?.fulfillmentPolicies || [];
    const paymentPolicies = paymentRes.data?.paymentPolicies || [];
    const returnPolicies = returnRes.data?.returnPolicies || [];

    diagnostics.policies.discoveredCounts.fulfillment = fulfillmentPolicies.length;
    diagnostics.policies.discoveredCounts.payment = paymentPolicies.length;
    diagnostics.policies.discoveredCounts.returns = returnPolicies.length;

    const configured = diagnostics.policies.configuredIds;
    if (configured.fulfillment && !fulfillmentPolicies.some((p) => String(p.fulfillmentPolicyId) === String(configured.fulfillment))) {
      diagnostics.policies.missingConfiguredPolicies.push('EBAY_FULFILLMENT_POLICY_ID');
    }
    if (configured.payment && !paymentPolicies.some((p) => String(p.paymentPolicyId) === String(configured.payment))) {
      diagnostics.policies.missingConfiguredPolicies.push('EBAY_PAYMENT_POLICY_ID');
    }
    if (configured.returns && !returnPolicies.some((p) => String(p.returnPolicyId) === String(configured.returns))) {
      diagnostics.policies.missingConfiguredPolicies.push('EBAY_RETURN_POLICY_ID');
    }

    diagnostics.policies.ok = diagnostics.policies.missingConfiguredPolicies.length === 0;

    if (!diagnostics.policies.ok) {
      recommendations.push(`Configured policy IDs not found for marketplace ${marketplaceId}: ${diagnostics.policies.missingConfiguredPolicies.join(', ')}`);
      recommendations.push('Fetch policies via /api/ebay-get-policies and update .env with IDs from the same eBay environment/account.');
      return {
        ok: false,
        code: 'POLICY_CONFIGURATION_INVALID',
        statusCode: 400,
        diagnostics,
        recommendations,
        help: getPreflightHelpResources(ebayEnvironment, 'POLICY_CONFIGURATION_INVALID')
      };
    }
  } catch (error) {
    diagnostics.policies.ok = false;
    diagnostics.policies.statusCode = error.response?.status || null;
    diagnostics.policies.error = error.response?.data?.errors?.[0]?.message || error.message;

    if (diagnostics.policies.statusCode === 403) {
      recommendations.push('Policy API access denied. Verify Sell Account scope and seller permissions for this OAuth user.');
      return {
        ok: false,
        code: 'ACCESS_DENIED_PERMISSIONS',
        statusCode: 403,
        diagnostics,
        recommendations,
        help: getPreflightHelpResources(ebayEnvironment, 'ACCESS_DENIED_PERMISSIONS')
      };
    }

    recommendations.push('Resolve business policy API access before bulk publishing.');
    return {
      ok: false,
      code: 'POLICY_CHECK_FAILED',
      statusCode: 400,
      diagnostics,
      recommendations,
      help: getPreflightHelpResources(ebayEnvironment, 'POLICY_CHECK_FAILED')
    };
  }

  if (diagnostics.configuration.missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_CONFIGURATION',
      statusCode: 400,
      diagnostics,
      recommendations,
      help: getPreflightHelpResources(ebayEnvironment, 'MISSING_CONFIGURATION')
    };
  }

  if (logger) {
    logger.success('Bulk preflight passed', {
      environment: diagnostics.environment,
      marketplaceId: diagnostics.marketplaceId,
      policies: diagnostics.policies.discoveredCounts
    });
  }

  return {
    ok: true,
    code: 'PREFLIGHT_OK',
    statusCode: 200,
    diagnostics,
    recommendations,
    help: {
      ...baseHelp,
      actionPlan: ['Preflight checks passed. You can start POST /publish-ebay/bulk safely.']
    }
  };
}

// Validate products for bulk publishing
app.post('/publish-ebay/validate-bulk', async (req, res) => {
  try {
    const logger = createLogger('BulkPublishValidation');
    logger.info('Starting bulk validation');

    const { publishable, skipped } = getPublishableProducts();

    const validation = {
      timestamp: new Date().toISOString(),
      totalProducts: publishable.length + skipped.length,
      publishable: publishable.length,
      skipped: skipped.length,
      percentReady: ((publishable.length / (publishable.length + skipped.length)) * 100).toFixed(1),
      skippedDetails: skipped.slice(0, 20) // Return first 20 for review
    };

    logger.success('Bulk validation completed', validation);

    res.json({
      success: true,
      ...validation
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/publish-ebay/preflight', async (req, res) => {
  try {
    const logger = createLogger('BulkPublishPreflight');
    const preflight = await runBulkPublishPreflight(logger);

    if (!preflight.ok) {
      return res.status(preflight.statusCode || 400).json({
        success: false,
        code: preflight.code,
        error: 'Bulk publish preflight failed',
        diagnostics: preflight.diagnostics,
        recommendations: preflight.recommendations,
        help: preflight.help,
        timestamp: new Date().toISOString()
      });
    }

    return res.json({
      success: true,
      code: preflight.code,
      message: 'Bulk publish preflight passed',
      diagnostics: preflight.diagnostics,
      recommendations: preflight.recommendations,
      help: preflight.help,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'PREFLIGHT_ERROR',
      error: error.message
    });
  }
});

app.post('/publish-ebay/preflight', async (req, res) => {
  try {
    const logger = createLogger('BulkPublishPreflight');
    const preflight = await runBulkPublishPreflight(logger);

    if (!preflight.ok) {
      return res.status(preflight.statusCode || 400).json({
        success: false,
        code: preflight.code,
        error: 'Bulk publish preflight failed',
        diagnostics: preflight.diagnostics,
        recommendations: preflight.recommendations,
        help: preflight.help,
        timestamp: new Date().toISOString()
      });
    }

    return res.json({
      success: true,
      code: preflight.code,
      message: 'Bulk publish preflight passed',
      diagnostics: preflight.diagnostics,
      recommendations: preflight.recommendations,
      help: preflight.help,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'PREFLIGHT_ERROR',
      error: error.message
    });
  }
});

// Start bulk publishing job
app.post('/publish-ebay/bulk', async (req, res) => {
  try {
    const logger = createLogger('BulkPublishStart');
    const { limit = null, dryRun = false } = req.body || {};

    logger.info('Starting bulk publish job', { limit, dryRun });

    const { publishable, skipped } = getPublishableProducts();
    
    const productsToPublish = limit ? publishable.slice(0, limit) : publishable;

    // Preflight seller readiness validation to avoid queuing a large job when publish will fail.
    if (!dryRun) {
      const preflight = await runBulkPublishPreflight(logger);
      if (!preflight.ok) {
        logger.error('Bulk publish blocked by preflight checks', {
          code: preflight.code,
          statusCode: preflight.statusCode
        });
        return res.status(preflight.statusCode || 400).json({
          success: false,
          code: preflight.code,
          error: 'Bulk publish preflight failed',
          diagnostics: preflight.diagnostics,
          recommendations: preflight.recommendations,
          help: preflight.help,
          timestamp: new Date().toISOString()
        });
      }
    }

    const jobId = generateJobId();
    const job = {
      jobId,
      status: 'queued',
      startedAt: new Date().toISOString(),
      dryRun,
      totalProducts: productsToPublish.length,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      results: [],
      errors: []
    };

    bulkPublishJobs.set(jobId, job);

    logger.success('Bulk job created', { jobId, totalProducts: productsToPublish.length, dryRun });

    res.json({
      success: true,
      jobId,
      message: `Bulk publish job queued for ${productsToPublish.length} products${dryRun ? ' (DRY RUN)' : ''}`,
      totalProducts: productsToPublish.length,
      skipped: skipped.length,
      timestamp: new Date().toISOString()
    });

    // Process asynchronously
    setImmediate(async () => {
      await processBulkPublishJob(jobId, productsToPublish, dryRun);
    });

  } catch (error) {
    console.error('Bulk publish error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get bulk publish job status
app.get('/publish-ebay/bulk/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = bulkPublishJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    const progress = ((job.processedCount / job.totalProducts) * 100).toFixed(1);
    const engine = getSmartPublishingEngine();
    const engineStats = job.engineStats || engine.getPerformanceInsights();

    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        progress: `${progress}%`,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        totalProducts: job.totalProducts,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error || null,
        dryRun: job.dryRun,
        recentResults: job.results.slice(-10),
        recentErrors: job.errors.slice(-5),
        engineStats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process bulk publish job in background
async function processBulkPublishJob(jobId, productsToPublish, dryRun) {
  const logger = createLogger('BulkPublishProcessor');
  const job = bulkPublishJobs.get(jobId);
  const engine = getSmartPublishingEngine();

  if (!job) return;

  job.status = 'processing';

  try {
    logger.info('Starting batch processing with Smart Engine', { 
      jobId, 
      totalProducts: productsToPublish.length, 
      dryRun,
      maxRetries: engine.config.maxRetries,
      enableSelfHealing: engine.config.enableSelfHealing,
      enableLearning: engine.config.enableLearning
    });

    const publishConcurrency = Math.max(1, PUBLISH_CONCURRENCY);
    let authBlocked = false;

    await mapWithConcurrency(productsToPublish, publishConcurrency, async (entry, index) => {
      if (authBlocked) return;

      const { link, product, sku } = entry;
      let currentProduct = { ...product, sku };

      try {
        logger.info(`[${index + 1}/${productsToPublish.length}] Processing: ${sku || product.title}`);

        if (dryRun) {
          validateProductForPublishing(product);

          job.results.push({
            index: index + 1,
            sku,
            title: product.title,
            status: 'validated',
            link,
            message: 'Validation passed (DRY RUN - not published)',
            attempts: 1
          });

          job.successCount++;
          return;
        }

        const publishResult = await engine.retryWithLearning(
          async () => {
            return await publishToEbay(currentProduct, {});
          },
          currentProduct,
          { link, sku, title: product.title }
        );

        if (publishResult.success) {
          const result = publishResult.result;
          await withDataFileWriteLock(async () => {
            const dataFile = path.join(__dirname, 'data', 'data.json');
            const existingData = fs.readJsonSync(dataFile) || {};

            existingData[link] = {
              ...existingData[link],
              ...currentProduct,
              publishedLink: result.listingLink,
              listingId: result.listingId,
              offerId: result.offerId,
              publishAction: result.action,
              publishedDate: new Date().toISOString()
            };

            fs.writeJsonSync(dataFile, existingData, { spaces: 2 });
          });

          engine.trackSuccessfulPattern({
            sku: result.sku,
            link,
            action: result.action,
            attempts: publishResult.attempts,
            healed: publishResult.healed
          });

          job.results.push({
            index: index + 1,
            sku: result.sku,
            title: product.title,
            status: 'published',
            link,
            listingId: result.listingId,
            listingLink: result.listingLink,
            action: result.action,
            message: result.message,
            attempts: publishResult.attempts,
            healed: publishResult.healed
          });

          job.successCount++;
          logger.success(`[${index + 1}/${productsToPublish.length}] Published: ${result.listingLink || sku}`, {
            attempts: publishResult.attempts,
            healed: publishResult.healed
          });
        } else {
          job.failureCount++;

          const analysis = publishResult.analysis || {};
          const detectedIssue = analysis.pattern?.id;
          job.errors.push({
            index: index + 1,
            sku,
            title: product.title,
            link,
            error: publishResult.error.message,
            statusCode: publishResult.error.response?.status,
            detectedIssue,
            attempts: publishResult.attempts
          });

          logger.error(`[${index + 1}/${productsToPublish.length}] Failed after ${publishResult.attempts} attempts`, {
            sku,
            error: publishResult.error.message,
            detectedIssue,
            ebayErrors: publishResult.error.response?.data?.errors
          });

          if (detectedIssue === 'auth_token_invalid') {
            authBlocked = true;
            job.status = 'blocked_auth';
            job.error = 'OAuth token invalid_grant detected. Refresh EBAY_REFRESH_TOKEN and retry.';

            logger.error('Bulk publish halted due to OAuth token invalid_grant', {
              jobId,
              index: index + 1,
              sku,
              detectedIssue
            });
          }
        }
      } catch (error) {
        job.failureCount++;
        job.errors.push({
          index: index + 1,
          sku,
          title: product.title,
          link,
          error: error.message,
          type: 'unexpected_error'
        });

        logger.error(`[${index + 1}/${productsToPublish.length}] Unexpected error: ${error.message}`, { sku });
      } finally {
        job.processedCount = Math.min(job.totalProducts, (job.processedCount || 0) + 1);

        const batchDelay = Number(engine.config.batchDelay) || 0;
        if (batchDelay > 0) {
          await delay(batchDelay);
        }
      }
    });

    if (authBlocked) {
      job.completedAt = new Date().toISOString();
      job.engineStats = engine.getPerformanceInsights();
      engine.saveStats();
      return;
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.engineStats = engine.getPerformanceInsights();

    logger.success('Bulk publish job completed', {
      jobId,
      successCount: job.successCount,
      failureCount: job.failureCount,
      totalProcessed: job.processedCount,
      dryRun,
      engineStats: job.engineStats
    });

    // Save final stats
    engine.saveStats();

  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();

    logger.error('Bulk publish job failed', { jobId, error: error.message });
  }
}

// ============================================================================
// SMART ENGINE MONITORING ENDPOINTS
// ============================================================================

// Get publishing engine statistics
app.get('/publish-ebay/engine/stats', (req, res) => {
  try {
    const engine = getSmartPublishingEngine();
    const insights = engine.getPerformanceInsights();

    res.json({
      success: true,
      insights,
      config: {
        maxRetries: engine.config.maxRetries,
        initialDelay: engine.config.initialDelay,
        maxDelay: engine.config.maxDelay,
        backoffMultiplier: engine.config.backoffMultiplier,
        enableSelfHealing: engine.config.enableSelfHealing,
        enableLearning: engine.config.enableLearning
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get error patterns and learned fixes
app.get('/publish-ebay/engine/error-patterns', (req, res) => {
  try {
    const engine = getSmartPublishingEngine();

    res.json({
      success: true,
      patterns: engine.errorPatterns.patterns,
      resolutionHistoryCount: engine.errorPatterns.resolutionHistory.length,
      recentResolutions: engine.errorPatterns.resolutionHistory.slice(-10),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Reset engine statistics
app.post('/publish-ebay/engine/reset', (req, res) => {
  try {
    const engine = getSmartPublishingEngine();
    engine.reset();

    res.json({
      success: true,
      message: 'Engine statistics reset',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// DATA VALIDATION ENDPOINT
// ============================================================================
// Validate and clean existing data in data.json: remove scam images, suspicious content
app.post('/api/validate-and-clean-data', async (req, res) => {
  try {
    const logger = createLogger('DataValidation');
    const dataPath = 'data/data.json';
    
    logger.info('Starting data.json validation and cleanup');
    
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(rawData);
    
    const results = {
      itemsScanned: 0,
      itemsCleaned: 0,
      imagesRemoved: 0,
      contentWarnings: 0,
      items: []
    };
    
    // Iterate through each product in data.json
    Object.entries(data).forEach(([link, rawProductData]) => {
      results.itemsScanned++;
      const itemResult = { link, status: 'OK', issues: [] };

      let productData = forceNewConditionDefaults(rawProductData || {});
      const conditionChanged = JSON.stringify(productData) !== JSON.stringify(rawProductData || {});
      if (conditionChanged) {
        itemResult.issues.push('Condition normalized to New');
        results.itemsCleaned++;
      }

      // Validate images
      if (Array.isArray(productData.imageSourceUrls) && productData.imageSourceUrls.length > 0) {
        const validatedImages = validateSourceImageUrls(productData.imageSourceUrls);
        if (validatedImages.length < productData.imageSourceUrls.length) {
          const removed = productData.imageSourceUrls.length - validatedImages.length;
          itemResult.issues.push(`Removed ${removed} suspicious images`);
          productData.imageSourceUrls = validatedImages;
          results.imagesRemoved += removed;
          results.itemsCleaned++;
        }
      }

      // Validate content
      const contentValidation = validateProductContent(productData.title, productData.description);
      if (contentValidation.warnings.length > 0) {
        itemResult.issues.push(`Content warnings: ${contentValidation.warnings.join(', ')}`);
        results.contentWarnings += contentValidation.warnings.length;
      }

      if (contentValidation.errors.length > 0) {
        itemResult.issues.push(`Errors: ${contentValidation.errors.join(', ')}`);
        itemResult.status = 'ERROR';
        results.itemsCleaned++;
      }

      data[link] = productData;
      results.items.push(itemResult);
    });
    
    // Save cleaned data back to file
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
    logger.success('Data validation completed and saved', results);
    
    return res.json({
      success: true,
      message: 'Data validation and cleanup completed',
      summary: {
        itemsScanned: results.itemsScanned,
        itemsCleaned: results.itemsCleaned,
        imagesRemoved: results.imagesRemoved,
        contentWarnings: results.contentWarnings
      },
      details: results.items,
      savedToFile: true
    });
  } catch (error) {
    console.error('Data validation error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to validate and clean data',
      message: error.message
    });
  }
});

async function scrapeEbayProduct(url, itemNumber = '', sku = '', scrapeContext = {}) {
  console.log(`Starting scrape for URL: ${url}`);
  const maxRetries = 3;
  let browser = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Attempt ${attempt} for ${url}`);

    // Only one concurrent scrape can use the persistent, cookie-carrying profile at a
    // time (Chrome locks userDataDir to a single running instance); others fall back to
    // an ephemeral profile so concurrent scraping never collides on the lock.
    const claimedPersistentProfile = !persistentProfileInUse;
    if (claimedPersistentProfile) persistentProfileInUse = true;
    const releasePersistentProfile = () => {
      if (claimedPersistentProfile) persistentProfileInUse = false;
    };

    const launchOptions = getBrowserLaunchOptions(claimedPersistentProfile);
    try {
      console.log('[Puppeteer] Launching browser...');
      browser = await puppeteer.launch(launchOptions);
      console.log('[Puppeteer] Browser launched successfully');
    } catch (launchErr) {
      const err = launchErr;
      console.error('[Puppeteer] Launch failed. Full error:', {
        name: err.name,
        message: err.message,
        stack: err.stack,
        cause: err.cause ? String(err.cause) : undefined,
        ...(typeof err === 'object' && err !== null ? Object.fromEntries(
          Object.entries(err).filter(([k]) => !['stack', 'message', 'name', 'cause'].includes(k))
        ) : {})
      });
      releasePersistentProfile();
      const hint = 'Install Chrome, or run: npm install puppeteer (without PUPPETEER_SKIP_DOWNLOAD). See https://pptr.dev/troubleshooting';
      throw new Error(`Failed to launch the browser process: ${err.message}. ${hint}`);
    }

    console.log(`Browser launched for ${url}`);
    const page = await browser.newPage();
    // Use a current, real Chrome UA (the old hardcoded Chrome/91 string didn't match the
    // actual bundled Chromium version, which is a classic bot-detection tell) and mask
    // the most obvious headless-automation signals eBay's bot detection checks for.
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });
    console.log(`Page created for ${url}`);
    try {

      await delay(SCRAPE_DELAY_PROFILE.beforeNavigate);

      // Warm up the persistent-profile session by visiting eBay's homepage first,
      // like an organic visitor, instead of teleporting straight to a deep /itm/ link
      // with no referrer - that direct-to-deep-link pattern with a blank profile is
      // itself a bot signal. Only done on the persistent-profile path (once per scrape
      // slot) so it doesn't multiply request volume during concurrent bulk scraping.
      if (claimedPersistentProfile) {
        try {
          console.log('Warming up session via eBay homepage...');
          await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(1500 + Math.floor(Math.random() * 1500));
        } catch (warmupErr) {
          console.log('Homepage warm-up skipped:', warmupErr.message);
        }
      }

      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log(`Page loaded successfully for ${url}`);
      await delay(SCRAPE_DELAY_PROFILE.afterNavigate); // Wait for potential dynamic content
      console.log(`Waited 2 seconds for ${url}`);

      // Click the gallery expand button ("Opens image gallery") to load full image set
      try {
        const clickedGallery = await page.evaluate(() => {
          const selectors = [
            'button[aria-label="Opens image gallery"]',
            'button[aria-label*="image gallery" i]',
            'button.icon-btn[aria-label*="gallery" i]',
            'button.icon-btn .ux-expand-icon',
            '[data-testid="ux-image-carousel"] button[aria-label*="gallery" i]'
          ];

          for (const selector of selectors) {
            const node = document.querySelector(selector);
            const button = node?.closest ? (node.closest('button') || node) : node;
            if (button && typeof button.click === 'function') {
              button.click();
              return true;
            }
          }

          const xpath = '/html/body/div[2]/main/div[1]/div[1]/div[4]/div/div/div[1]/div[1]/div/div[1]/div[1]/div[2]/div[5]/button';
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const xpathButton = result.singleNodeValue;
          if (xpathButton && typeof xpathButton.click === 'function') {
            xpathButton.click();
            return true;
          }

          return false;
        });

        if (clickedGallery) {
          console.log('Gallery button clicked');
          await Promise.race([
            page.waitForSelector('.lightbox-dialog', { timeout: 7000 }),
            page.waitForSelector('[role="dialog"] img', { timeout: 7000 }),
            page.waitForSelector('.ux-image-carousel-item img', { timeout: 7000 })
          ]);
          console.log('Gallery dialog opened or gallery images available');
          await delay(SCRAPE_DELAY_PROFILE.gallerySettle);
        } else {
          console.log('Gallery button not found');
        }
      } catch (e) {
        console.log('Gallery button click or wait failed:', e.message);
      }

      // Scroll to load more images if needed
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await delay(SCRAPE_DELAY_PROFILE.postScroll);
      console.log('Scrolled to bottom');

      // Open "Description" tab first so we capture full description (not Item specifics)
      try {
        const clickedDesc = await page.evaluate(() => {
          const tab = document.querySelector('a[href="#viTabs_0_pan"]') ||
            Array.from(document.querySelectorAll('a[href^="#viTabs"], [data-tab]')).find(el => /description/i.test((el.getAttribute('href') || '') + (el.textContent || '')));
          if (tab) { tab.click(); return true; }
          return false;
        });
        if (clickedDesc) await delay(SCRAPE_DELAY_PROFILE.afterDescriptionTab);
      } catch (e) {
        console.log('Description tab click skipped:', e.message);
      }

      // Open "Item specifics" tab if present (for itemSpecifics extraction)
      try {
        const clicked = await page.evaluate(() => {
          const tab = document.querySelector('a[href="#viTabs_0_is"]') ||
            Array.from(document.querySelectorAll('a, button')).find(el => /item\s*specifics/i.test(el.textContent || ''));
          if (tab) { tab.click(); return true; }
          return false;
        });
        if (clicked) await delay(SCRAPE_DELAY_PROFILE.afterItemSpecificsTab);
      } catch (e) {
        console.log('Item specifics tab click skipped:', e.message);
      }

      // Extract data with page.evaluate
      console.log(`Extracting data for ${url}`);
      let extractedData = await page.evaluate((pageUrl) => {
        const validateImageUrls = (imageUrls) => {
          if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];

          const blockedImageIds = new Set([
            'hVoAAOSweURgZ6D4'
          ]);

          const suspiciousImagePatterns = [
            'logo', 'watermark', 'cash', 'money', 'crypto', 'bitcoin', 'qr code',
            'text overlay', 'copyright notice', 'sample', 'watermark text',
            'placeholder', 'coming soon', 'sold out', 'not available'
          ];

          const filtered = imageUrls.filter((url) => {
            try {
              if (!url || typeof url !== 'string') return false;
              if (!url.includes('ebayimg.com')) return false;
              if (/s-l(50|100|140|200)\./.test(url)) return false;
              if (/\.(gif|bmp|ico|svg)$/i.test(url)) return false;

              const idMatch = url.match(/\/images\/g\/([^/]+)/i);
              if (idMatch && blockedImageIds.has(idMatch[1])) return false;

              const urlLower = url.toLowerCase();
              if (suspiciousImagePatterns.some((pattern) => urlLower.includes(pattern))) {
                return false;
              }

              return true;
            } catch (e) {
              return false;
            }
          });

          return filtered.slice(0, 24);
        };

        // Extract item number from URL
        const urlMatch = pageUrl.match(/\/itm\/(\d+)/);
        const itemNumber = urlMatch ? urlMatch[1] : '';

        const title = (document.querySelector('h1#itemTitle')?.textContent.trim() || 
                     document.querySelector('h1.it-ttl')?.textContent.trim() || 
                     document.title.split(' | ')[0] || 'N/A').replace(/\s+/g, ' ').trim();

        const rawPrice = document.querySelector('#prcIsum')?.textContent.trim() ||
                        document.querySelector('[data-testid="x-price-primary"]')?.textContent.trim() || 'N/A';
        const priceMatch = rawPrice.match(/\$([\d.,]+)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : 'N/A';

        // Full description from Description tab/panel (NOT from Item specifics #viTabs_0_is)
        const descPanel = document.querySelector('#viTabs_0_pan') ||
          document.querySelector('.vim.item-desc') ||
          document.querySelector('#desc_wrapper') ||
          document.querySelector('.x-item-description') ||
          document.querySelector('[class*="item-description"]') ||
          document.querySelector('#viTabs_0_is'); // fallback only
        const rawDescription = descPanel?.textContent?.trim() || document.querySelector('#viTabs_0_pan')?.textContent?.trim() || '';
        const description = rawDescription
          .replace(/\s+/g, ' ')
          .trim();

        const collectImageCandidates = () => {
          const srcMap = new Map();
          const normalizeUrl = (src) => String(src || '')
            .trim()
            .replace(/&amp;/g, '&')
            .replace(/\\u002F/g, '/')
            .replace(/(\?|#).*$/, '')
            .replace(/s-l\d+\./i, 's-l1600.');

          const getImageKey = (src) => {
            const normalized = normalizeUrl(src);
            const imageIdMatch = normalized.match(/\/images\/g\/([^/]+)/i);
            if (imageIdMatch) return `g:${imageIdMatch[1]}`;

            const zIdMatch = normalized.match(/\/z\/([^/]+)/i);
            if (zIdMatch) return `z:${zIdMatch[1]}`;

            return `u:${normalized.toLowerCase()}`;
          };

          const scoreUrl = (src) => {
            const normalized = normalizeUrl(src).toLowerCase();
            let score = 0;
            if (normalized.includes('/images/g/')) score += 5;
            if (normalized.includes('s-l1600')) score += 4;
            if (normalized.endsWith('.webp')) score += 2;
            if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) score += 1;
            return score;
          };

          const pushUrl = (src) => {
            if (!src || typeof src !== 'string') return;
            if (!/https?:\/\//i.test(src)) return;
            if (!src.includes('ebayimg.com')) return;
            if (/s-l(50|100|140|200)\./i.test(src)) return;

            const normalized = normalizeUrl(src);
            const key = getImageKey(normalized);
            const existing = srcMap.get(key);

            if (!existing || scoreUrl(normalized) > scoreUrl(existing)) {
              srcMap.set(key, normalized);
            }
          };

          const gallerySelectors = [
            '.lightbox-dialog img',
            '[role="dialog"] img',
            '.ux-dialog img',
            '.ux-image-carousel-item img',
            '.ux-image-grid-item img',
            '[data-testid*="gallery"] img',
            '#icThumbs img',
            'img[data-image-index]',
            '#icImg',
            '#mainImgHldr img'
          ].join(', ');

          document.querySelectorAll(gallerySelectors).forEach((img) => {
            pushUrl(img.src);
            pushUrl(img.getAttribute('data-zoom-src'));
            pushUrl(img.getAttribute('data-src'));
            const srcSet = img.getAttribute('srcset');
            if (srcSet) {
              srcSet.split(',').forEach((entry) => {
                const candidate = entry.trim().split(' ')[0];
                pushUrl(candidate);
              });
            }
          });

          document.querySelectorAll('.lightbox-dialog [style*="background-image"], [role="dialog"] [style*="background-image"]').forEach((node) => {
            const style = node.getAttribute('style') || '';
            const match = style.match(/url\(["']?(.*?)["']?\)/i);
            if (match && match[1]) pushUrl(match[1]);
          });

          const jsonScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of jsonScripts) {
            try {
              const json = JSON.parse(script.textContent || '{}');
              const imageField = json?.image;
              if (Array.isArray(imageField)) imageField.forEach(pushUrl);
              else if (typeof imageField === 'string') pushUrl(imageField);
            } catch (e) {}
          }

          return Array.from(srcMap.values())
            .slice(0, 24);
        };

        const images = collectImageCandidates();
        
        // VALIDATE IMAGES: Filter out scam, logos, and suspicious images
        const validatedImages = validateImageUrls(images);
        const imageValidationLog = {
          collected: images.length,
          filtered: validatedImages.length,
          removed: images.length - validatedImages.length,
          details: images
            .filter((img, i) => !validatedImages.includes(img))
            .map((img, i) => ({ index: i, reason: 'Suspicious pattern or malformed' }))
        };

        // Item specifics: try multiple selectors (eBay DOM varies). Each attribute as own key.
        const itemSpecifics = {}; const cleanValue = (s) => (s || '')
          .replace(/\s*opens in a new window or tab\s*/gi, '')
          .replace(/\s*See all condition definitions\s*/gi, '')
          .replace(/\s*See the seller's listing for full details\.?\s*/gi, '')
          .trim()
          .replace(/\s+/g, ' ');

        const setSpec = (key, value) => {
          const k = key.replace(/:\s*$/, '').trim();
          if (k && value !== undefined && value !== '') itemSpecifics[k] = cleanValue(String(value));
        };

        // 1) Table inside Item specifics section (legacy)
        const specificsTables = document.querySelectorAll('#viTabs_0_is table, .ux-layout-section--item-specifics table, [class*="item-specifics"] table, .vim.d-item-specifics table');
        specificsTables.forEach(tbl => {
          tbl.querySelectorAll('tr').forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              setSpec(cells[0].textContent, cells[1].textContent);
            }
          });
        });

        // 2) dl/dt/dd pairs (common eBay pattern)
        document.querySelectorAll('dl.ux-labels-values, dl[class*="labels-values"], .ux-labels-values dl').forEach(dl => {
          const dts = dl.querySelectorAll('dt');
          const dds = dl.querySelectorAll('dd');
          dts.forEach((dt, i) => {
            const key = dt.textContent.trim();
            const val = dds[i] ? dds[i].textContent.trim() : '';
            if (key) setSpec(key, val);
          });
        });

        // 3) Div-based label/value (ux-labels-values__labels / __values)
        document.querySelectorAll('.ux-labels-values__content, [class*="ux-labels-values"]').forEach(container => {
          const labels = container.querySelectorAll('.ux-labels-values__labels, [class*="__labels"]');
          const values = container.querySelectorAll('.ux-labels-values__values, [class*="__values"]');
          if (labels.length && values.length) {
            labels.forEach((label, i) => {
              if (values[i]) setSpec(label.textContent, values[i].textContent);
            });
          }
        });

        // 4) Rows with label/value cells
        document.querySelectorAll('[data-testid="ux-labels-values"], .ux-labels-values').forEach(section => {
          section.querySelectorAll('.ux-labels-values__row, tr').forEach(row => {
            const labelEl = row.querySelector('.ux-labels-values__labels, td:first-child, th:first-child');
            const valueEl = row.querySelector('.ux-labels-values__values, td:last-child, td:nth-child(2)');
            if (labelEl && valueEl) setSpec(labelEl.textContent, valueEl.textContent);
          });
        });

        // 5) Any two-column table in main (fallback; specific selectors above take precedence)
        document.querySelectorAll('main table, #mainContent table, .vim table').forEach(tbl => {
          tbl.querySelectorAll('tr').forEach(row => {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              const key = cells[0].textContent.trim().replace(/:\s*$/, '');
              const value = cells[1].textContent.trim();
              if (key.length > 0 && key.length < 100) setSpec(key, value);
            }
          });
        });

        // Extract category ID from breadcrumbs or hidden data
        let categoryId = 'N/A';
        try {
          // Try JSON-LD structured data first
          const jsonScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of jsonScripts) {
            try {
              const data = JSON.parse(script.textContent);
              if (data.category && typeof data.category === 'string') {
                categoryId = data.category;
                break;
              }
              if (data.itemCategory && typeof data.itemCategory === 'string') {
                categoryId = data.itemCategory;
                break;
              }
            } catch (e) {}
          }
          
          // Try breadcrumb navigation if JSON-LD not found
          if (categoryId === 'N/A') {
            const breadcrumbs = document.querySelector('[data-test-id="breadcrumbs"]') ||
                              document.querySelector('.breadcrumbs') ||
                              document.querySelector('[role="navigation"]');
            if (breadcrumbs) {
              const links = breadcrumbs.querySelectorAll('a');
              if (links.length >= 2) {
                // Get the category from breadcrumbs (second link is usually category)
                const categoryLink = links[links.length - 2];
                const href = categoryLink?.href || '';
                const cIdMatch = href.match(/\/bn\/(\d+)/);
                if (cIdMatch) categoryId = cIdMatch[1];
              }
            }
          }
        } catch (e) {}

        // Additional fields
        const customLabel = itemSpecifics['Custom label'] || itemSpecifics['SKU'] || 'N/A';

        // Quantity: modern eBay listings hold the authoritative numeric quantity in the
        // qty stepper's <input value="N">, with a human label ("Last one", "3 available")
        // alongside it - not in the legacy #qtySubTxt/#qtyAvail IDs (which no longer exist
        // on current listing pages, hence quantity always came back as "N/A" before this).
        let availableQuantity = 'N/A';
        const qtyInput = document.querySelector('#qtyTextBox') || document.querySelector('input[name="quantity"]');
        if (qtyInput && qtyInput.value && /^\d+$/.test(qtyInput.value.trim())) {
          availableQuantity = parseInt(qtyInput.value.trim(), 10);
        } else {
          const availabilityText = (document.querySelector('#qtyAvailability')?.textContent ||
            document.querySelector('.x-quantity__availability')?.textContent || '').trim();
          if (/last one/i.test(availabilityText)) {
            availableQuantity = 1;
          } else {
            const numMatch = availabilityText.match(/(\d+)\s*available/i);
            if (numMatch) {
              availableQuantity = parseInt(numMatch[1], 10);
            } else {
              // Legacy fallback for older listing templates that may still use these IDs.
              const legacyText = document.querySelector('#qtySubTxt')?.textContent.trim() ||
                document.querySelector('#qtyAvail')?.textContent.trim() || '';
              const legacyMatch = legacyText.match(/(\d+)/);
              availableQuantity = legacyMatch ? parseInt(legacyMatch[1], 10) : 'N/A';
            }
          }
        }
        const format = document.querySelector('.u-flL .notranslate')?.textContent.trim() || 
                      (document.querySelector('#bidBtn_btn') ? 'Auction' : 'Buy It Now');
        const currency = rawPrice.includes('US $') ? 'USD' : 'N/A';
        // Start price: try #orgPrc, or parse from "Was" text, or current price
        const orgPrcText = document.querySelector('#orgPrc')?.textContent.trim();
        let startPrice = price;
        if (orgPrcText) {
          const orgMatch = orgPrcText.match(/\$([\d.,]+)/);
          startPrice = orgMatch ? parseFloat(orgMatch[1].replace(',', '')) : price;
        } else {
          // Look for "Was" price in page text
          const pageText = document.body.textContent;
          const wasMatch = pageText.match(/Was.*?\$([\d.,]+)/);
          if (wasMatch) {
            startPrice = parseFloat(wasMatch[1].replace(',', ''));
          }
        }

        // Variation details
        const variationDetails = {};
        const variationSelects = document.querySelectorAll('#msku-sel-1, #msku-sel-2, #msku-sel-3');
        variationSelects.forEach(select => {
          const label = select.previousElementSibling?.textContent.trim() || 'Variation';
          const options = Array.from(select.options).map(opt => opt.textContent.trim());
          variationDetails[label] = options;
        });

        return {
          itemNumber,
          title,
          price,
          description,
          images: validatedImages,
          imageValidationLog,
          customLabel,
          availableQuantity,
          format,
          currency,
          startPrice,
          variationDetails,
          itemSpecifics,
          categoryId
        };
      }, url);
      console.log(`Data extracted: ${extractedData.images.length} images found (${extractedData.imageValidationLog?.removed || 0} suspicious images filtered)`)

      // Guard against eBay serving an error/interstitial/CAPTCHA page instead of the
      // real listing (rate-limiting, bot detection, "pardon our interruption", etc).
      // Saving that as if it were real product data would overwrite good title/price/
      // description/images with garbage - throw so the retry loop (and callers) treat
      // this attempt as failed instead of persisting it.
      const rawTitleLower = String(extractedData.title || '').toLowerCase();
      const looksLikeErrorPage = /error page|robot check|pardon our interruption|security measure|verify you'?re human|are you a human|access denied|unusual traffic|captcha/i.test(rawTitleLower);
      const looksLikeEmptyExtraction = extractedData.images.length === 0 &&
        (!extractedData.description || String(extractedData.description).trim() === '') &&
        extractedData.price === 'N/A';
      if (looksLikeErrorPage || looksLikeEmptyExtraction) {
        throw new Error(`Scrape landed on a non-product page for ${url} (title: "${extractedData.title}") - likely an eBay rate-limit/CAPTCHA/interstitial page, not the real listing`);
      }

      // Modern eBay listings frequently render the seller's actual rich-text
      // description inside a separate iframe (commonly id="desc_ifr", domain
      // ebaydesc.com) rather than directly in the main page DOM. document.querySelector
      // inside page.evaluate() above can only ever see the heading/label text ("Item
      // description from the seller") in that case, never the real content - so grab
      // it here via Puppeteer's frame API (must happen before browser.close()) and use
      // it if it's more substantial than what the main-page extraction found.
      try {
        const descriptionFrame = page.frames().find((frame) => {
          const frameUrl = frame.url() || '';
          const frameName = frame.name() || '';
          return /desc/i.test(frameUrl) || /desc/i.test(frameName);
        });
        if (descriptionFrame) {
          const iframeText = await descriptionFrame.evaluate(() => (document.body ? document.body.innerText : ''));
          const cleanedIframeText = String(iframeText || '').replace(/\s+/g, ' ').trim();
          if (cleanedIframeText.length > (extractedData.description || '').length) {
            console.log(`Found richer description in iframe (${cleanedIframeText.length} chars vs ${(extractedData.description || '').length} from main page); using iframe content`);
            extractedData.description = cleanedIframeText;
          }
        }
      } catch (e) {
        console.log('Description iframe extraction skipped:', e.message);
      }

      // Apply SEO optimization with item specifics
      extractedData.itemSpecifics = {
        ...(extractedData.itemSpecifics || {}),
        Condition: 'New'
      };
      
      // CRITICAL: Sanitize all SHARD/competitor brand names and replace with Strapey
      extractedData = sanitizeProduct(extractedData);
      
      extractedData.title = makeSeoTitle(extractedData.title, extractedData.itemSpecifics);
      extractedData.description = makeSeoDescription(extractedData.description, extractedData.itemSpecifics, extractedData.title, extractedData);

      await browser.close();
      releasePersistentProfile();
      console.log(`Browser closed for ${url}`);

      // Helper function to create SEO-friendly filenames
      const sanitizeForFilename = (text) => {
        return text
          .replace(/[^a-zA-Z0-9\s-]/g, '') // Remove special characters
          .replace(/\s+/g, '_')             // Replace spaces with underscores
          .replace(/_+/g, '_')              // Replace multiple underscores with single
          .replace(/^_|_$/g, '')            // Remove leading/trailing underscores
          .substring(0, 50);                // Limit length to 50 chars
      };

      // Download and enhance images into SKU-based folder structure
      const sanitizeForPathSegment = (text) => {
        return String(text || '')
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .trim();
      };

      const finalSku = sku || extractedData.customLabel || 'NoSKU';
      const folderSku = sanitizeForPathSegment(finalSku) || 'NoSKU';
      const productDir = path.join('data', 'images', folderSku);
      fs.ensureDirSync(productDir);
      console.log(`Created directory: ${productDir}`);

      // Determine SKU and title for filename
      const finalTitle = extractedData.title || 'Product';
      const seoSku = sanitizeForFilename(finalSku);
      const seoTitle = sanitizeForFilename(finalTitle);

      // Look up any existing record for this listing BEFORE touching images, so we can
      // decide whether to skip (images unchanged), replace (images changed), or do a
      // fresh download (no local images yet). This is a best-effort, unlocked read: if
      // it races with another scrape's write and fails to parse, we simply treat the
      // product as having no prior record (worst case: an unnecessary re-download,
      // never data loss - the authoritative read+write below is lock-protected).
      const dataFile = path.join('data', 'data.json');
      let existing;
      try {
        existing = readDataFileOrThrow(dataFile)[url];
      } catch (_) {
        existing = undefined;
      }

      const newRemoteImageKeys = getRemoteImageKeySet(extractedData.images);
      const previousRemoteImageKeys = getRemoteImageKeySet(existing?.remoteImageKeys);
      const localImagesPresent = hasLocalSkuImages(folderSku);

      let imagesOriginal = [];
      let imageSourceUrls = [];
      // Defaults to this scrape's keys; overridden below when we deliberately keep the
      // prior image set untouched, so a failed/empty scrape can't poison future diffing.
      let remoteImageKeysToPersist = Array.from(newRemoteImageKeys);

      if (localImagesPresent && newRemoteImageKeys.size === 0) {
        // This scrape found zero images - almost always a sign eBay served an error/
        // interstitial/CAPTCHA page rather than the real listing, NOT that the seller
        // removed every photo. Never let a failed extraction wipe out good local
        // images; keep what we have and don't touch the recorded baseline.
        imageSourceUrls = existing?.imageSourceUrls || existing?.images || [];
        imagesOriginal = existing?.imagesOriginal || imageSourceUrls;
        remoteImageKeysToPersist = Array.isArray(existing?.remoteImageKeys) ? existing.remoteImageKeys : [];
        console.log(`Scrape returned 0 images for SKU ${folderSku} (likely a failed/blocked fetch); keeping ${imageSourceUrls.length} existing local images untouched`);
      } else if (localImagesPresent && imageKeySetsMatch(newRemoteImageKeys, previousRemoteImageKeys)) {
        // Same image set as last scrape (and we still have the files) - reuse local
        // copies as-is instead of re-downloading/re-enhancing images that haven't changed.
        imageSourceUrls = existing.imageSourceUrls || existing.images || [];
        imagesOriginal = existing.imagesOriginal || imageSourceUrls;
        console.log(`Images unchanged for SKU ${folderSku}; reusing ${imageSourceUrls.length} local images`);
      } else {
        // Either there are no local images yet, the recorded baseline doesn't match
        // what eBay is serving now, or there's no baseline at all (e.g. a product that
        // was only ever bulk-imported and never actually scraped before, so any local
        // images are unverified leftovers, not something a prior real scrape confirmed).
        // In every one of those cases this scrape just found a genuine, non-empty image
        // set (the 0-image case above already ruled out a failed/blocked fetch) - trust
        // it over untracked local files and do a full (re)download and replace.
        if (localImagesPresent) {
          console.log(`No confirmed-matching local images for SKU ${folderSku}; replacing with freshly scraped images`);
          clearSkuImageFolder(folderSku);
        }

        for (let i = 0; i < extractedData.images.length; i++) {
          const imgUrl = extractedData.images[i];
          const ext = path.extname(imgUrl) || '.jpg';
          // Create SEO-friendly filename: Strapey_{SKU}_{Title}_{index}.ext
          const seoFilename = `Strapey_${seoSku}_${seoTitle}_${i}${ext}`;
          const rawPath = path.join(productDir, seoFilename);
          try {
            console.log(`Downloading image ${i}: ${imgUrl}`);
            const response = await axios.get(imgUrl, { responseType: 'stream', timeout: 10000 });

            await new Promise((resolve, reject) => {
              const writer = fs.createWriteStream(rawPath);
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });

            console.log(`Downloaded image ${i} as ${seoFilename}`);
            imagesOriginal.push(rawPath);
            const enhancedPath = await processAndReplaceImage(rawPath);
            imageSourceUrls.push(`/images/${folderSku}/${path.basename(enhancedPath)}`);
            console.log(`Processed image ${i}`);
          } catch (e) {
            console.error(`Failed to download or process ${imgUrl}: ${e.message}`);
            if (fs.existsSync(rawPath)) {
              imageSourceUrls.push(`/images/${folderSku}/${path.basename(rawPath)}`);
            }
          }
        }
      }

      // Quantity: use the freshly scraped number when we got one (this is the whole
      // point of re-scraping - reflect eBay's current stock level). If extraction
      // couldn't parse a number this time (e.g. an unusual listing layout), preserve
      // whatever inventory value already existed rather than clobbering a good value
      // with "N/A".
      const scrapedQuantity = extractedData.availableQuantity;
      const hasFreshQuantity = typeof scrapedQuantity === 'number' && Number.isFinite(scrapedQuantity);
      const preservedQuantity = existing?.inventoryQuantity ?? existing?.inventory ?? existing?.availableQuantity;

      // Prepare data: include itemNumber and SKU; key by link (url)
      // Use provided SKU, or fall back to extracted customLabel from page
      // 'N/A' is the extractor's own "nothing found on the page" sentinel (see
      // categoryId init above) - it must never be treated as a real scraped value,
      // otherwise it wins the `||` fallback chain ahead of a real existing category.
      const cleanExtractedCategoryId = (extractedData.categoryId && extractedData.categoryId !== 'N/A')
        ? extractedData.categoryId
        : '';
      let productData = {
        ...extractedData,
        url,
        itemNumber: itemNumber || extractedData.itemNumber || '',
        sku: sku || extractedData.customLabel || '',
        customLabel: sku || extractedData.customLabel || '',
        // Category almost never comes from the page itself (eBay's breadcrumb/JSON-LD
        // category data is unreliable on modern listing pages - same story as the other
        // stale selectors fixed today), so this is really "don't lose whatever category
        // was already set" rather than "extract it fresh". Previously this only trusted
        // scrapeContext (whatever the caller happened to pass in) with no fallback to the
        // actual existing record, so if the caller ever failed to forward it, a real,
        // already-set category/categoryId would be silently wiped on save.
        category: scrapeContext.category || scrapeContext.ebayCategory || existing?.ebayCategory || existing?.category || '',
        ebayCategory: scrapeContext.category || scrapeContext.ebayCategory || existing?.ebayCategory || existing?.category || '',
        ebayCategoryId: scrapeContext.categoryId || scrapeContext.ebayCategoryId || cleanExtractedCategoryId || existing?.ebayCategoryId || existing?.categoryId || '',
        categoryId: scrapeContext.categoryId || scrapeContext.ebayCategoryId || cleanExtractedCategoryId || existing?.categoryId || existing?.ebayCategoryId || '',
        // Weight is rarely exposed as a page item-specific, so like category above, this
        // is "don't lose whatever weight was already recorded" rather than "extract it
        // fresh" - a rescrape that finds no weight label must not erase a known weight.
        weight: (extractedData.weight ?? existing?.weight ?? null),
        weightUnit: (extractedData.weightUnit ?? existing?.weightUnit ?? null),
        availableQuantity: hasFreshQuantity ? scrapedQuantity : (preservedQuantity ?? scrapedQuantity),
        inventoryQuantity: hasFreshQuantity ? scrapedQuantity : (preservedQuantity ?? 0),
        imageSourceUrls,
        images: imageSourceUrls,
        imagesOriginal,
        remoteImageKeys: remoteImageKeysToPersist,
        condition: 'NEW',
        conditionDisplay: 'New',
        lastUpdated: new Date().toISOString()
      };
      productData = applyProductGroup(forceNewConditionDefaults(productData));

      const priceChanged = existing && existing.price !== productData.price;
      const titleChanged = existing && existing.title !== productData.title;
      const descriptionChanged = existing && existing.description !== productData.description;
      const itemNumberChanged = existing && (existing.itemNumber || '') !== (productData.itemNumber || '');
      const skuChanged = existing && (existing.customLabel || '') !== (productData.customLabel || '');
      const inventoryChanged = existing && (existing.inventoryQuantity ?? existing.inventory ?? existing.availableQuantity) !== productData.inventoryQuantity;
      const existingSourceImages = Array.isArray(existing?.imageSourceUrls) ? existing.imageSourceUrls : [];
      const existingProcessedImages = Array.isArray(existing?.images) ? existing.images : [];
      const existingOriginalImages = Array.isArray(existing?.imagesOriginal) ? existing.imagesOriginal : [];
      const imagesChanged = existing && JSON.stringify(existingSourceImages) !== JSON.stringify(productData.imageSourceUrls || []);
      const processedImagesChanged = existing && JSON.stringify(existingProcessedImages) !== JSON.stringify(productData.images || []);
      const originalImagesChanged = existing && JSON.stringify(existingOriginalImages) !== JSON.stringify(productData.imagesOriginal || []);
      const productGroupChanged = existing && (existing.productGroup || '') !== (productData.productGroup || '');
      const ebayCategoryChanged = existing && (existing.ebayCategory || '') !== (productData.ebayCategory || '');
      const ebayCategoryIdChanged = existing && String(existing.ebayCategoryId || existing.categoryId || '') !== String(productData.ebayCategoryId || productData.categoryId || '');

      const hasChanges = priceChanged || titleChanged || descriptionChanged || itemNumberChanged || skuChanged ||
        inventoryChanged || imagesChanged || processedImagesChanged || originalImagesChanged || productGroupChanged ||
        ebayCategoryChanged || ebayCategoryIdChanged;

      if (!existing || hasChanges) {
        // Serialize against every other concurrent scrape/save call, and re-read the
        // file fresh right before merging so we never clobber another product's
        // update that landed while this scrape/download was in flight.
        await withDataFileLock(() => {
          const freshData = readDataFileOrThrow(dataFile);
          freshData[url] = productData;
          atomicWriteJsonSync(dataFile, freshData);
        });
        console.log(existing ? `Data updated for ${url} (core fields/image metadata/group/category changed)` : `New record inserted for ${url}`);
      } else {
        console.log(`No change for ${url}, skipped write`);
      }

      return productData;
    } catch (error) {
      console.error(`Error on attempt ${attempt} for ${url}:`, error.message);
      if (error.stack) console.error('Stack:', error.stack);
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr) {
          console.error('Error closing browser:', closeErr.message);
        }
        browser = null;
      }
      releasePersistentProfile();
      if (attempt === maxRetries) {
        console.error(`All attempts failed for ${url}`);
        throw error;
      }
      // Exponential-ish backoff instead of a flat 5s between attempts - hammering eBay
      // with fast retries looks more bot-like and worsens rate-limit/WAF suspicion.
      const backoffMs = 5000 * Math.pow(3, attempt - 1);
      console.log(`Retrying in ${backoffMs / 1000} seconds...`);
      await delay(backoffMs);
    }
  }
}

/**
 * Apply consistent theme grading: saturation, brightness, contrast, noise reduction
 */
async function applyThemeGrading(imageBuffer, theme) {
  if (!theme || !theme.enabled) {
    return imageBuffer;
  }

  try {
    let pipeline = sharp(imageBuffer);

    // Apply noise reduction if enabled
    if (theme.noiseReduction) {
      pipeline = pipeline.median(2);
    }

    // Apply modulate for saturation and brightness
    if (theme.saturation || theme.brightness) {
      const saturation = theme.saturation || 1.0;
      const brightness = theme.brightness || 1.0;
      pipeline = pipeline.modulate({
        saturation,
        brightness
      });
    }

    // Apply auto-level adjustment if enabled (enhances contrast)
    if (theme.autoAdjustLevels) {
      pipeline = pipeline.normalize();
    }

    const result = await pipeline.toBuffer();
    console.log('Theme grading applied');
    return result;
  } catch (error) {
    console.error('Theme grading error:', error.message);
    return imageBuffer; // Return original on error
  }
}

/**
 * Apply AI upscaling to enhance image quality.
 * Attempts upscayl CLI first, falls back to sharp-based enhancement (1.5x resize with lanczos3).
 */
async function applyAIUpscaling(imagePath) {
  const { enableAIUpscaling, upscaleModel, useUpscaylCLI } = IMAGE_CONFIG;

  if (!enableAIUpscaling) {
    return imagePath;
  }

  try {
    if (useUpscaylCLI) {
      // Try upscayl CLI approach
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execPromise = promisify(exec);

      const dir = path.dirname(imagePath);
      const base = path.basename(imagePath, path.extname(imagePath));
      const upscaledPath = path.join(dir, `${base}_upscaled.webp`);

      try {
        // Check if upscayl is available
        try {
          await execPromise('which upscayl');
        } catch {
          throw new Error('upscayl not found');
        }

        // Run upscayl: upscayl -i input -o output -s 2 -m realesrgan-x2
        const scale = upscaleModel === '4x' ? 4 : 2;
        const model = upscaleModel === '4x' ? 'realesrgan-x4-plus' : 'realesrgan-x2-plus';
        const cmd = `upscayl -i "${imagePath}" -o "${upscaledPath}" -s ${scale} -m ${model}`;

        console.log(`Executing upscayl: ${cmd}`);
        await execPromise(cmd, { timeout: 120000 });

        console.log('AI upscaling completed via upscayl:', upscaledPath);
        return upscaledPath;
      } catch (cliError) {
        console.log('upscayl CLI not available, using sharp enhancement fallback');
        // Fall through to sharp-based enhancement
      }
    }

    // Sharp-based enhancement as fallback
    const base = path.basename(imagePath, path.extname(imagePath));
    const dir = path.dirname(imagePath);
    const enhancedPath = path.join(dir, `${base}_upscaled.webp`);

    const buffer = await fs.readFile(imagePath);
    const metadata = await sharp(buffer).metadata();

    // Upscale by 1.5x using sharp's resize with lanczos3 kernel
    const newWidth = Math.round(metadata.width * 1.5);
    const newHeight = Math.round(metadata.height * 1.5);

    await sharp(buffer)
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3
      })
      .withMetadata()
      .webp({ quality: 98, effort: 6 })
      .toFile(enhancedPath);

    console.log('AI upscaling completed via sharp enhancement:', enhancedPath);
    return enhancedPath;
  } catch (error) {
    console.error('AI upscaling error:', error.message);
    return imagePath; // Return original on error
  }
}

/**
 * Enhance image: larger canvas, uniform background, higher quality.
 * Multi-step pipeline: rotate/resize → theme grading → sharpen/extend → AI upscaling
 * Keeps the original file; writes enhanced version to base_enhanced.webp.
 * Returns path to the enhanced .webp file.
 */
async function processAndReplaceImage(originalImagePath) {
  const dir = path.dirname(originalImagePath);
  const base = path.basename(originalImagePath, path.extname(originalImagePath));
  const outputPath = path.join(dir, `${base}_enhanced.webp`);

  try {
    let imageBuffer = await fs.readFile(originalImagePath);
    const { targetSize, background, sharpenSigma, webpQuality, webpEffort, allowEnlargement, theme } = IMAGE_CONFIG;

    // Step 0: Clean image - remove promotional banners and ads
    console.log('Cleaning image: removing promotional content...');
    imageBuffer = await cleanProductImage(imageBuffer, {
      removeTopBanner: true,
      removeBottomBanner: true,
      cropThreshold: 0.15
    });

    // Step 1: Rotate and resize with lanczos3 kernel for better quality
    const resizedBuffer = await sharp(imageBuffer)
      .rotate()
      .resize({
        width: targetSize,
        height: targetSize,
        fit: 'inside',
        withoutEnlargement: !allowEnlargement,
        kernel: sharp.kernel.lanczos3
      })
      .toBuffer();

    const resizedMeta = await sharp(resizedBuffer).metadata();
    const w = Number.isFinite(resizedMeta.width) ? resizedMeta.width : targetSize;
    const h = Number.isFinite(resizedMeta.height) ? resizedMeta.height : targetSize;
    const left = Math.max(0, Math.floor((targetSize - w) / 2));
    const right = Math.max(0, targetSize - w - left);
    const top = Math.max(0, Math.floor((targetSize - h) / 2));
    const bottom = Math.max(0, targetSize - h - top);

    // Step 2: Extend with background and sharpen
    let processedBuffer = await sharp(resizedBuffer)
      .extend({ top, bottom, left, right, background })
      .sharpen({ sigma: sharpenSigma })
      .toBuffer();

    // Step 3: Apply theme grading (saturation, brightness, contrast, noise reduction)
    if (theme && theme.enabled !== false) {
      processedBuffer = await applyThemeGrading(processedBuffer, theme);
    }

    // Step 4: Save to WebP
    await sharp(processedBuffer)
      .withMetadata()
      .webp({ quality: webpQuality, effort: webpEffort })
      .toFile(outputPath);

    console.log('Image processing complete:', outputPath);

    // Step 5: Apply AI upscaling if enabled
    let finalPath = outputPath;
    if (IMAGE_CONFIG.enableAIUpscaling) {
      const upscaledPath = await applyAIUpscaling(outputPath);
      // If upscaling succeeded, replace the enhanced image with upscaled version
      if (upscaledPath !== outputPath) {
        await fs.unlink(outputPath); // Remove non-upscaled version
        const finalOutputPath = path.join(dir, base + '_enhanced.webp');
        await fs.rename(upscaledPath, finalOutputPath);
        finalPath = finalOutputPath;
      }
    }

    return finalPath;
  } catch (error) {
    console.error('Image processing error:', error.message);
    throw error;
  }
}

// Update inventory settings for a product
app.post('/api/update-inventory-settings', (req, res) => {
  try {
    const { link, inventoryQuantity, enableBackorder } = req.body;
    
    if (!link) {
      return res.status(400).json({ error: 'link is required' });
    }

    const dataFile = path.join('data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      return res.status(404).json({ error: 'Data store not found' });
    }

    const allData = fs.readJsonSync(dataFile);
    const productData = allData[link];
    
    if (!productData) {
      return res.status(404).json({ error: 'Product not found in data store' });
    }

    // Update settings with defaults if not provided
    if (inventoryQuantity !== undefined && Number.isInteger(inventoryQuantity) && inventoryQuantity > 0) {
      productData.inventoryQuantity = inventoryQuantity;
    }
    
    if (enableBackorder !== undefined) {
      productData.enableBackorder = Boolean(enableBackorder);
    }

    fs.writeJsonSync(dataFile, allData);

    return res.json({
      success: true,
      message: 'Inventory settings updated',
      settings: {
        link,
        inventoryQuantity: productData.inventoryQuantity || 3,
        enableBackorder: productData.enableBackorder !== undefined ? productData.enableBackorder : true
      }
    });
  } catch (error) {
    console.error('Error updating inventory settings:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Get inventory settings for all products
app.get('/api/inventory-settings', (req, res) => {
  try {
    const dataFile = path.join('data', 'data.json');
    if (!fs.existsSync(dataFile)) {
      return res.status(404).json({ error: 'Data store not found' });
    }

    const allData = fs.readJsonSync(dataFile);
    const settings = {};

    for (const [link, productData] of Object.entries(allData)) {
      settings[link] = {
        sku: productData.customLabel || 'N/A',
        title: productData.title ? productData.title.substring(0, 50) : 'N/A',
        inventoryQuantity: productData.inventoryQuantity || 3,
        enableBackorder: productData.enableBackorder !== undefined ? productData.enableBackorder : true,
        publishedLink: productData.publishedLink || null
      };
    }

    return res.json({
      success: true,
      total: Object.keys(settings).length,
      settings
    });
  } catch (error) {
    console.error('Error retrieving inventory settings:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Admin configuration endpoints (Media + Marketing)
app.get('/api/admin/config', (req, res) => {
  try {
    const config = loadAdminConfig();
    return res.json({ success: true, config, source: fs.existsSync(ADMIN_CONFIG_PATH) ? 'file' : 'defaults' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/config', (req, res) => {
  try {
    const incoming = req.body || {};
    const saved = saveAdminConfig(incoming);
    return res.json({ success: true, message: 'Admin configuration saved', config: saved });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/config/apply', (req, res) => {
  try {
    const incoming = req.body || {};
    const saved = saveAdminConfig(incoming);

    process.env.ENABLE_MEDIA_VIDEO = String(saved.media.enableMediaVideo);
    process.env.MEDIA_API_BASE_URL = saved.media.mediaApiBaseUrl;
    process.env.MEDIA_API_KEY = saved.media.mediaApiKey;
    process.env.MEDIA_API_CREATE_PATH = saved.media.mediaCreatePath;
    process.env.MEDIA_MAX_IMAGES = String(saved.media.maxImagesForVideo);
    process.env.MEDIA_VIDEO_DURATION_SECONDS = String(saved.media.videoDurationSeconds);
    process.env.MEDIA_VIDEO_STYLE = saved.media.style;

    process.env.ENABLE_MARKETING_ENGINE = String(saved.marketing.enableMarketingEngine);
    process.env.MARKETING_WEBHOOK_URL = saved.marketing.marketingWebhookUrl;
    process.env.MARKETING_RETRY_ATTEMPTS = String(saved.marketing.marketingRetryAttempts);
    process.env.MARKETING_RETRY_DELAY_MS = String(saved.marketing.marketingRetryDelayMs);
    process.env.EBAY_MARKETPLACE_ID = saved.marketing.marketplaceId;

    process.env.EBAY_USE_EPS_IMAGES = String(saved.ebay.useEpsImages);
    process.env.EBAY_COMPATIBILITY_LEVEL = saved.ebay.compatibilityLevel;
    process.env.EBAY_SITE_ID = saved.ebay.siteId;

    return res.json({
      success: true,
      message: 'Admin configuration applied to runtime',
      applied: {
        media: {
          enableMediaVideo: saved.media.enableMediaVideo,
          mediaApiBaseUrl: saved.media.mediaApiBaseUrl,
          mediaCreatePath: saved.media.mediaCreatePath
        },
        marketing: {
          enableMarketingEngine: saved.marketing.enableMarketingEngine,
          marketingWebhookConfigured: !!saved.marketing.marketingWebhookUrl,
          marketplaceId: saved.marketing.marketplaceId
        },
        ebay: {
          useEpsImages: saved.ebay.useEpsImages,
          compatibilityLevel: saved.ebay.compatibilityLevel,
          siteId: saved.ebay.siteId
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/config/test-ebay', async (req, res) => {
  try {
    const token = await getEbayAccessToken();
    const { apiBase } = getEbayBaseUrls();
    const runtime = getRuntimeConfig();

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-US'
    };

    const tests = [];

    try {
      const inventoryResp = await axios.get(`${apiBase}/sell/inventory/v1/offer?limit=1`, { headers, timeout: 20000 });
      tests.push({ api: 'SELL_INVENTORY', endpoint: '/sell/inventory/v1/offer', status: 'SUCCESS', httpStatus: inventoryResp.status });
    } catch (error) {
      tests.push({ api: 'SELL_INVENTORY', endpoint: '/sell/inventory/v1/offer', status: 'FAILED', error: error.response?.data || error.message });
    }

    try {
      const mediaResp = await axios.get(`${apiBase}/commerce/media/v1_beta/video?limit=1`, { headers, timeout: 20000 });
      tests.push({ api: 'COMMERCE_MEDIA', endpoint: '/commerce/media/v1_beta/video', status: 'SUCCESS', httpStatus: mediaResp.status });
    } catch (error) {
      tests.push({ api: 'COMMERCE_MEDIA', endpoint: '/commerce/media/v1_beta/video', status: 'FAILED', error: error.response?.data || error.message });
    }

    try {
      const marketingResp = await axios.get(`${apiBase}/sell/marketing/v1/ad_campaign?limit=1`, { headers, timeout: 20000 });
      tests.push({ api: 'SELL_MARKETING', endpoint: '/sell/marketing/v1/ad_campaign', status: 'SUCCESS', httpStatus: marketingResp.status });
    } catch (error) {
      tests.push({ api: 'SELL_MARKETING', endpoint: '/sell/marketing/v1/ad_campaign', status: 'FAILED', error: error.response?.data || error.message });
    }

    return res.json({
      success: true,
      environment: resolveEbayEnvironment(),
      runtime,
      tests
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// MARKETING CAMPAIGNS API
// ============================================================================

const { EbayMarketingIntegration, setEbayAccessTokenFn } = require('./src/integrations/ebay-marketing');

// Inject the getEbayAccessToken function from server.js
setEbayAccessTokenFn(getEbayAccessToken);

const ebayMarketing = new EbayMarketingIntegration();

// List all campaigns (from eBay)
app.get('/api/marketing/campaigns', async (req, res) => {
  try {
    console.log('📢 Fetching marketing campaigns...');
    
    const ebayResult = await ebayMarketing.listCampaigns({
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });

    if (!ebayResult.success) {
      console.warn('eBay campaigns fetch warning:', ebayResult.error);
    }

    const ebayCampaigns = (ebayResult.campaigns || []).map(c => ({
      id: c.campaignId,
      ebay_campaign_id: c.campaignId,
      name: c.campaignName,
      status: c.campaignStatus,
      channel: 'ebay',
      marketplace: c.marketplaceId,
      start_date: c.startDate,
      end_date: c.endDate,
      funding_model: c.fundingStrategy?.fundingModel,
      bid_percentage: c.fundingStrategy?.bidPercentage,
      source: 'ebay'
    }));

    res.json({
      success: true,
      campaigns: ebayCampaigns,
      total: ebayResult.total || ebayCampaigns.length
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      campaigns: []
    });
  }
});

// Create a new campaign
app.post('/api/marketing/campaigns', async (req, res) => {
  try {
    const { name, startDate, endDate, bidPercentage, fundingModel, selectionRules, marketplaceId } = req.body;
    
    console.log('📢 Creating new campaign:', name);

    if (!name || !startDate) {
      return res.status(400).json({
        success: false,
        error: 'Campaign name and start date are required'
      });
    }

    const ebayResult = await ebayMarketing.createCampaign({
      name,
      startDate,
      endDate,
      bidPercentage: bidPercentage || '5.0',
      fundingModel: fundingModel || 'COST_PER_CLICK',
      selectionRules: selectionRules || [],
      marketplaceId: marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
    });

    if (!ebayResult.success) {
      return res.status(400).json({
        success: false,
        error: ebayResult.error
      });
    }

    console.log(`✅ Campaign created on eBay: ${ebayResult.campaignId}`);

    res.json({
      success: true,
      campaignId: ebayResult.campaignId,
      campaign: ebayResult.campaign
    });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update a campaign
app.put('/api/marketing/campaigns/:id', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { name, status, endDate, fundingStrategy } = req.body;
    
    console.log(`📢 Updating campaign: ${campaignId}`);

    const ebayResult = await ebayMarketing.updateCampaign(campaignId, {
      name,
      status,
      endDate,
      fundingStrategy
    });

    if (!ebayResult.success) {
      return res.status(400).json({
        success: false,
        error: ebayResult.error
      });
    }

    res.json({
      success: true,
      campaign: ebayResult.campaign
    });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete a campaign
app.delete('/api/marketing/campaigns/:id', async (req, res) => {
  try {
    const campaignId = req.params.id;
    console.log(`📢 Deleting campaign: ${campaignId}`);

    const ebayResult = await ebayMarketing.deleteCampaign(campaignId);

    if (!ebayResult.success) {
      return res.status(400).json({
        success: false,
        error: ebayResult.error
      });
    }

    res.json({
      success: true,
      message: 'Campaign deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Pause/resume campaign
app.post('/api/marketing/campaigns/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    console.log(`📢 ${action} campaign: ${id}`);

    const ebayResult = action === 'pause' 
      ? await ebayMarketing.pauseCampaign(id)
      : await ebayMarketing.resumeCampaign(id);

    if (!ebayResult.success) {
      return res.status(400).json({
        success: false,
        error: ebayResult.error
      });
    }

    res.json({
      success: true,
      campaign: ebayResult.campaign
    });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// SMART BULK SCRAPE & PUBLISH - CORE FEATURES
// ============================================================================

// Error Learning System - tracks patterns and improves over time
const ERROR_PATTERNS_FILE = path.join(__dirname, 'data', 'error-patterns.json');

function loadErrorPatterns() {
  try {
    if (fs.existsSync(ERROR_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(ERROR_PATTERNS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading error patterns:', error);
  }
  return {
    scrapeErrors: {},
    publishErrors: {},
    solutions: {},
    lastUpdated: new Date().toISOString()
  };
}

function saveErrorPattern(type, errorMessage, context, solution = null) {
  try {
    const patterns = loadErrorPatterns();
    const key = errorMessage.substring(0, 100);
    
    if (!patterns[type]) patterns[type] = {};
    if (!patterns[type][key]) {
      patterns[type][key] = {
        message: errorMessage,
        count: 0,
        firstSeen: new Date().toISOString(),
        contexts: [],
        solutions: []
      };
    }
    
    patterns[type][key].count++;
    patterns[type][key].lastSeen = new Date().toISOString();
    patterns[type][key].contexts.push({
      ...context,
      timestamp: new Date().toISOString()
    });
    
    if (solution) {
      patterns[type][key].solutions.push({
        solution,
        timestamp: new Date().toISOString()
      });
    }
    
    // Keep only last 10 contexts per error
    if (patterns[type][key].contexts.length > 10) {
      patterns[type][key].contexts = patterns[type][key].contexts.slice(-10);
    }
    
    patterns.lastUpdated = new Date().toISOString();
    fs.writeFileSync(ERROR_PATTERNS_FILE, JSON.stringify(patterns, null, 2));
  } catch (error) {
    console.error('Error saving error pattern:', error);
  }
}

// In-memory job tracking for bulk operations
const bulkScrapeJobs = new Map();
const bulkUploadJobs = new Map();

// Helper: Compare two products to detect meaningful changes
function detectProductChanges(oldProduct, newProduct) {
  const changes = [];
  const significantFields = ['title', 'price', 'description', 'imageSourceUrls', 'conditionDisplayName', 'quantityAvailable'];
  
  for (const field of significantFields) {
    const oldVal = oldProduct[field];
    const newVal = newProduct[field];
    
    if (field === 'imageSourceUrls') {
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes.push({ field, oldValue: oldVal?.length || 0, newValue: newVal?.length || 0 });
      }
    } else if (oldVal !== newVal) {
      changes.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }
  
  return changes;
}

// ============================================================================
// FEATURE 1: SMART BULK SCRAPE
// ============================================================================

// POST /api/products/scrape-all - Scrape all products that need updating
app.post('/api/products/scrape-all', async (req, res) => {
  const logger = createLogger('SmartBulkScrape');
  
  try {
    logger.info('Starting smart bulk scrape');
    
    const jobId = generateJobId();
    const dataFile = path.join(__dirname, 'data', 'data.json');
    
    if (!fs.existsSync(dataFile)) {
      return res.status(404).json({
        success: false,
        error: 'No products found. Data file does not exist.'
      });
    }
    
    const allData = JSON.parse(fs.readFileSync(dataFile, 'utf8')) || {};
    const products = Object.entries(allData);

    // Filter products that need scraping (24h stale) and have inventory to sell.
    // NOTE: we intentionally do NOT require complete product data (title/price/
    // description/images) here - scraping is exactly what fills in that missing
    // data, so gating on it would permanently exclude any product that has never
    // been successfully scraped (e.g. bulk-imported placeholders with no images).
    // Publish-readiness is still enforced separately at publish time.
    const productsNeedingScrape = [];
    let upToDate = 0;
    let filteredNoInventory = 0;

    for (const [link, product] of products) {
      if (!shouldScrapeProduct(product)) {
        upToDate++;
        continue;
      }

      const inventoryQty = getProductInventoryForScrape(product);
      if (inventoryQty <= 0) {
        filteredNoInventory++;
        continue;
      }

      productsNeedingScrape.push([link, product]);
    }

    if (productsNeedingScrape.length === 0) {
      return res.json({
        success: true,
        message: 'No products matched scrape criteria (24h stale + inventory > 0)',
        totalProducts: products.length,
        needsScrape: 0,
        upToDate,
        filteredNoInventory
      });
    }
    
    // Create job
    const job = {
      jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      totalProducts: productsNeedingScrape.length,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      unchangedCount: 0,
      updatedCount: 0,
      results: [],
      errors: [],
      changes: []
    };
    
    bulkScrapeJobs.set(jobId, job);
    
    logger.success('Bulk scrape job created', {
      jobId,
      totalProducts: productsNeedingScrape.length,
      upToDate,
      filteredNoInventory
    });

    res.json({
      success: true,
      jobId,
      message: `Started scraping ${productsNeedingScrape.length} products`,
      totalProducts: productsNeedingScrape.length,
      upToDate,
      filteredNoInventory
    });
    
    // Process scraping asynchronously
    setImmediate(async () => {
      await processBulkScrapeJob(jobId, productsNeedingScrape, logger);
    });
    
  } catch (error) {
    logger.error('Bulk scrape initialization failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/products/scrape-all/:jobId - Get scrape job status
app.get('/api/products/scrape-all/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = bulkScrapeJobs.get(jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    const progress = job.totalProducts > 0 
      ? ((job.processedCount / job.totalProducts) * 100).toFixed(1)
      : '0.0';
    
    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        progress: `${progress}%`,
        processedCount: job.processedCount,
        totalProducts: job.totalProducts,
        successCount: job.successCount,
        failureCount: job.failureCount,
        unchangedCount: job.unchangedCount,
        updatedCount: job.updatedCount,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        estimatedTimeRemaining: calculateETA(job),
        recentResults: job.results.slice(-10),
        recentErrors: job.errors.slice(-5),
        recentChanges: job.changes.slice(-10)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process bulk scrape job in background
async function processBulkScrapeJob(jobId, productsToScrape, logger) {
  const job = bulkScrapeJobs.get(jobId);
  if (!job) return;
  
  const concurrency = parseInt(process.env.SCRAPE_CONCURRENCY) || 4;
  const dataFile = path.join(__dirname, 'data', 'data.json');
  
  try {
    logger.info('Processing bulk scrape job', { jobId, total: productsToScrape.length, concurrency });
    
    // Process in batches
    for (let i = 0; i < productsToScrape.length; i += concurrency) {
      const batch = productsToScrape.slice(i, i + concurrency);
      
      await Promise.all(batch.map(async ([link, existingProduct]) => {
        try {
          const itemNumber = existingProduct.itemNumber || '';
          const sku = existingProduct.sku || existingProduct.customLabel || '';
          
          logger.info('Scraping product', { link, itemNumber, sku });
          
          // Scrape the product
          const newData = await scrapeEbayProduct(link, itemNumber, sku, existingProduct);
          
          // Detect changes
          const changes = detectProductChanges(existingProduct, newData);
          
          if (changes.length > 0) {
            // Update only if there are changes
            await saveProductToData(newData);
            
            job.updatedCount++;
            job.changes.push({
              link,
              sku: sku || itemNumber,
              changeCount: changes.length,
              changes: changes.slice(0, 3), // Keep first 3 changes for summary
              timestamp: new Date().toISOString()
            });
            
            logger.success('Product updated with changes', { link, changeCount: changes.length });
          } else {
            // No changes, just update timestamp
            const allData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            if (allData[link]) {
              allData[link].lastScrapedAt = new Date().toISOString();
              fs.writeFileSync(dataFile, JSON.stringify(allData, null, 2));
            }
            
            job.unchangedCount++;
            logger.info('Product unchanged, timestamp updated', { link });
          }
          
          job.successCount++;
          job.results.push({
            link,
            sku: sku || itemNumber,
            status: 'success',
            hasChanges: changes.length > 0,
            changeCount: changes.length
          });
          
        } catch (error) {
          job.failureCount++;
          job.errors.push({
            link,
            error: error.message,
            timestamp: new Date().toISOString()
          });
          
          saveErrorPattern('scrapeErrors', error.message, { link, jobId });
          logger.error('Scrape failed for product', { link, error: error.message });
        } finally {
          job.processedCount++;
        }
      }));
      
      // Small delay between batches to avoid overwhelming eBay
      if (i + concurrency < productsToScrape.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    
    logger.success('Bulk scrape job completed', {
      jobId,
      processed: job.processedCount,
      success: job.successCount,
      failures: job.failureCount,
      updated: job.updatedCount,
      unchanged: job.unchangedCount
    });
    
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    
    logger.error('Bulk scrape job failed', error);
  }
}

// ============================================================================
// FEATURE 2: BULK UPLOAD TO EBAY (NEW LISTINGS ONLY)
// ============================================================================

// POST /api/products/publish-all-to-ebay - Publish all unpublished products
app.post('/api/products/publish-all-to-ebay', async (req, res) => {
  const logger = createLogger('BulkUploadToEbay');
  
  try {
    logger.info('Starting bulk upload to eBay');
    
    const { dryRun = false, environment = null } = req.body || {};
    
    // Get current environment
    const config = getRuntimeEnvironmentPayload();
    const currentEnv = environment || config.serviceTargets.ebay;
    const isProduction = currentEnv === 'production';
    
    logger.info('Environment check', { environment: currentEnv, isProduction, dryRun });
    
    // Run preflight checks
    if (!dryRun) {
      const preflight = await runBulkPublishPreflight(logger);
      if (!preflight.ok) {
        return res.status(preflight.statusCode || 400).json({
          success: false,
          code: preflight.code,
          error: 'Bulk publish preflight failed',
          diagnostics: preflight.diagnostics,
          recommendations: preflight.recommendations
        });
      }
    }
    
    // Get publishable products
    const { publishable, skipped } = getPublishableProducts();
    
    if (publishable.length === 0) {
      return res.json({
        success: true,
        message: 'No products ready for publishing',
        totalProducts: 0,
        skipped: skipped.length
      });
    }
    
    // Filter to only include products not already published to target environment
    const unpublishedProducts = publishable.filter(({ product }) => {
      if (isProduction) {
        return !product.publishedToProduction && !product.productionListingId;
      } else {
        return !product.publishedToSandbox && !product.sandboxListingId;
      }
    });
    
    if (unpublishedProducts.length === 0) {
      return res.json({
        success: true,
        message: `All products already published to ${currentEnv}`,
        totalProducts: 0,
        alreadyPublished: publishable.length,
        skipped: skipped.length
      });
    }
    
    const jobId = generateJobId();
    const job = {
      jobId,
      status: 'running',
      environment: currentEnv,
      dryRun,
      startedAt: new Date().toISOString(),
      totalProducts: unpublishedProducts.length,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      results: [],
      errors: []
    };
    
    bulkUploadJobs.set(jobId, job);
    
    logger.success('Bulk upload job created', {
      jobId,
      totalProducts: unpublishedProducts.length,
      environment: currentEnv,
      dryRun
    });
    
    res.json({
      success: true,
      jobId,
      message: `Started publishing ${unpublishedProducts.length} products to ${currentEnv}`,
      totalProducts: unpublishedProducts.length,
      alreadyPublished: publishable.length - unpublishedProducts.length,
      skipped: skipped.length,
      environment: currentEnv,
      dryRun
    });
    
    // Process publishing asynchronously
    setImmediate(async () => {
      await processBulkUploadJob(jobId, unpublishedProducts, currentEnv, dryRun, logger);
    });
    
  } catch (error) {
    logger.error('Bulk upload initialization failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/products/publish-all-to-ebay/:jobId - Get upload job status
app.get('/api/products/publish-all-to-ebay/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = bulkUploadJobs.get(jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    const progress = job.totalProducts > 0
      ? ((job.processedCount / job.totalProducts) * 100).toFixed(1)
      : '0.0';
    
    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        progress: `${progress}%`,
        environment: job.environment,
        dryRun: job.dryRun,
        processedCount: job.processedCount,
        totalProducts: job.totalProducts,
        successCount: job.successCount,
        failureCount: job.failureCount,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        estimatedTimeRemaining: calculateETA(job),
        recentResults: job.results.slice(-10),
        recentErrors: job.errors.slice(-5)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process bulk upload job in background
async function processBulkUploadJob(jobId, productsToPublish, environment, dryRun, logger) {
  const job = bulkUploadJobs.get(jobId);
  if (!job) return;
  
  const concurrency = parseInt(process.env.PUBLISH_CONCURRENCY) || 2;
  const dataFile = path.join(__dirname, 'data', 'data.json');
  const isProduction = environment === 'production';
  
  try {
    logger.info('Processing bulk upload job', { 
      jobId, 
      total: productsToPublish.length, 
      concurrency,
      environment,
      dryRun 
    });
    
    // Process in batches with concurrency control
    for (let i = 0; i < productsToPublish.length; i += concurrency) {
      const batch = productsToPublish.slice(i, i + concurrency);
      
      await Promise.all(batch.map(async ({ link, product, sku }) => {
        const startTime = Date.now();
        
        try {
          if (dryRun) {
            // Dry run - just validate
            logger.info('DRY RUN - would publish', { link, sku });
            
            job.successCount++;
            job.results.push({
              link,
              sku,
              status: 'dry_run_success',
              message: 'Would be published',
              duration: Date.now() - startTime
            });
          } else {
            // Actual publish
            logger.info('Publishing product to eBay', { link, sku, environment });
            
            // Use smart retry/self-healing around the existing publish function.
            const engine = getSmartPublishingEngine();
            const publishResponse = await engine.retryWithLearning(
              () => publishToEbay(product, { environment }),
              product,
              { link, sku, environment, source: 'bulk-upload' }
            );

            if (publishResponse.success) {
              const result = publishResponse.result;
              // Update data.json with listing info
              const allData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
              if (allData[link]) {
                if (isProduction) {
                  allData[link].productionListingId = result.listingId;
                  allData[link].publishedToProduction = true;
                  allData[link].lastPublishedToProdAt = new Date().toISOString();
                } else {
                  allData[link].sandboxListingId = result.listingId;
                  allData[link].publishedToSandbox = true;
                  allData[link].lastPublishedToSandboxAt = new Date().toISOString();
                }
                fs.writeFileSync(dataFile, JSON.stringify(allData, null, 2));
              }
              
              job.successCount++;
              job.results.push({
                link,
                sku,
                listingId: result.listingId,
                status: 'success',
                duration: Date.now() - startTime
              });
              
              logger.success('Product published successfully', { 
                link, 
                sku, 
                listingId: result.listingId,
                duration: Date.now() - startTime 
              });
            } else {
              const errMsg = publishResponse.error?.message || publishResponse.analysis?.errorMessage || 'Publish failed';
              throw new Error(errMsg);
            }
          }
          
        } catch (error) {
          job.failureCount++;
          job.errors.push({
            link,
            sku,
            error: error.message,
            timestamp: new Date().toISOString()
          });
          
          saveErrorPattern('publishErrors', error.message, { 
            link, 
            sku, 
            jobId, 
            environment 
          });
          
          logger.error('Publish failed for product', { 
            link, 
            sku, 
            error: error.message 
          });
        } finally {
          job.processedCount++;
        }
      }));
      
      // Delay between batches to respect rate limits
      if (i + concurrency < productsToPublish.length) {
        const delayMs = parseInt(process.env.PUBLISH_BATCH_DELAY_MS) || 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    
    logger.success('Bulk upload job completed', {
      jobId,
      processed: job.processedCount,
      success: job.successCount,
      failures: job.failureCount,
      environment: job.environment
    });
    
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    
    logger.error('Bulk upload job failed', error);
  }
}

// Helper: Calculate estimated time remaining
function calculateETA(job) {
  if (job.status !== 'running' || job.processedCount === 0) {
    return null;
  }
  
  const startTime = new Date(job.startedAt).getTime();
  const now = Date.now();
  const elapsed = now - startTime;
  const rate = job.processedCount / (elapsed / 1000); // items per second
  const remaining = job.totalProducts - job.processedCount;
  const etaSeconds = remaining / rate;
  
  if (etaSeconds < 60) {
    return `${Math.round(etaSeconds)}s`;
  } else if (etaSeconds < 3600) {
    return `${Math.round(etaSeconds / 60)}m`;
  } else {
    return `${Math.round(etaSeconds / 3600)}h`;
  }
}

// ============================================================================
// FEATURE 3: EBAY -> LOCAL RECONCILIATION SYNC
// Pulls the seller's real offer state from eBay, matches by SKU against
// data.json, flags already-live products as Published, and pushes any local
// price/quantity/content edits that haven't made it to eBay yet.
// ============================================================================

const ebaySyncJobs = new Map();

function generateEbaySyncJobId() {
  return 'ebay-sync-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// POST /api/products/sync-from-ebay - Reconcile local catalog against live eBay offers
app.post('/api/products/sync-from-ebay', async (req, res) => {
  const logger = createLogger('EbaySyncFromEbay');

  try {
    const { dryRun = true, environment = 'production', pushUpdates = true } = req.body || {};

    logger.info('Starting eBay reconciliation sync', { dryRun, environment });

    const token = await getEbayAccessToken({ environment });
    const { apiBase } = getEbayBaseUrls({ environment });

    const ebayInventorySkus = await fetchAllEbayInventorySkus(token, apiBase, { logger });
    logger.info('Fetched eBay inventory SKUs', { totalSkus: ebayInventorySkus.size });

    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.json({ success: true, message: 'No local products to sync', totalMatched: 0 });
    }

    const allData = readDataFileOrThrow(DATA_FILE_PATH);

    // Only fetch offer details (price/qty/status/listingId) for SKUs that exist
    // both locally and on eBay - GET /offer requires a sku param per call, so we
    // avoid one round-trip per eBay SKU that has no local counterpart.
    const localSkuEntries = Object.entries(allData)
      .map(([key, product]) => ({ key, product, sku: product.sku || product.customLabel }))
      .filter(({ sku }) => sku && ebayInventorySkus.has(sku));

    const ebayOffersBySku = new Map();
    const offerLookupConcurrency = parseInt(process.env.PUBLISH_CONCURRENCY) || 2;
    for (let i = 0; i < localSkuEntries.length; i += offerLookupConcurrency) {
      const batch = localSkuEntries.slice(i, i + offerLookupConcurrency);
      await Promise.all(batch.map(async ({ sku }) => {
        try {
          const offer = await fetchOfferForSku(sku, token, apiBase);
          if (offer) ebayOffersBySku.set(sku, offer);
        } catch (error) {
          logger.warn('Failed to look up eBay offer for SKU', { sku, error: error.message });
        }
      }));
    }
    logger.info('Resolved eBay offer details', { matchedSkus: ebayOffersBySku.size });

    const matchedSkus = new Set();
    const toMarkPublished = [];
    const toPushUpdate = [];
    let unchangedCount = 0;

    Object.entries(allData).forEach(([key, product]) => {
      const sku = product.sku || product.customLabel;
      if (!sku) return;
      const offer = ebayOffersBySku.get(sku);
      if (!offer) return;

      matchedSkus.add(sku);

      const isPublishedOnEbay = offer.status === 'PUBLISHED';
      const alreadyReconciled = product.publishStatus === 'Published' && product.productionListingId === offer.listingId;

      if (isPublishedOnEbay && !alreadyReconciled) {
        toMarkPublished.push({ key, sku, offer });
      }

      if (isPublishedOnEbay) {
        const localPrice = typeof product.price === 'number' ? product.price : Number(product.price);
        const localQty = Number(product.inventoryQuantity ?? product.availableQuantity ?? product.inventory);
        const priceChanged = offer.price !== null && Number.isFinite(localPrice) && Math.abs(offer.price - localPrice) > 0.001;
        const quantityChanged = offer.quantity !== null && Number.isFinite(localQty) && localQty !== offer.quantity;
        // Only trust the content-drift timestamp comparison once a real publish/sync
        // baseline exists for this SKU. Without it, every never-before-reconciled
        // product (the common case for this first run) would compare lastUpdated
        // against epoch 0 and look "changed" even though nothing actually drifted.
        const lastPushed = product.lastPublishedToProdAt || product.lastSyncedFromEbay;
        const contentChanged = Boolean(lastPushed) && Boolean(product.lastUpdated) && new Date(product.lastUpdated) > new Date(lastPushed);

        if (priceChanged || quantityChanged || contentChanged) {
          toPushUpdate.push({ key, sku, product, reasons: { priceChanged, quantityChanged, contentChanged } });
        } else {
          unchangedCount++;
        }
      }
    });

    const unmatchedOnEbay = Array.from(ebayInventorySkus).filter((sku) => !matchedSkus.has(sku));

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        totalEbayOffers: ebayInventorySkus.size,
        totalMatched: matchedSkus.size,
        toMarkPublished: toMarkPublished.map(({ sku, offer }) => ({ sku, listingId: offer.listingId })),
        toPushUpdate: toPushUpdate.map(({ sku, reasons }) => ({ sku, reasons })),
        unchangedCount,
        unmatchedOnEbayCount: unmatchedOnEbay.length,
        unmatchedOnEbaySample: unmatchedOnEbay.slice(0, 20)
      });
    }

    // Cheap status-reconciliation writes (no eBay calls needed) applied immediately.
    if (toMarkPublished.length > 0) {
      await withDataFileLock(async () => {
        const dataFile = path.join(__dirname, 'data', 'data.json');
        const beforeSize = fs.existsSync(dataFile) ? fs.statSync(dataFile).size : 0;
        if (beforeSize > 1000) {
          await fs.copy(dataFile, dataFile + `.backup-${Date.now()}`);
        }

        const currentData = readDataFileOrThrow(dataFile);
        const initialCount = Object.keys(currentData).length;

        toMarkPublished.forEach(({ key, offer }) => {
          if (!currentData[key]) return;
          currentData[key].publishStatus = 'Published';
          currentData[key].status = 'Published';
          currentData[key].productionListingId = offer.listingId;
          currentData[key].productionLink = offer.listingId
            ? `https://www.ebay.com/itm/${offer.listingId}`
            : currentData[key].productionLink;
          currentData[key].publishedToProduction = true;
          currentData[key].latestPublishedListingId = offer.listingId || currentData[key].latestPublishedListingId || null;
          currentData[key].latestPublishedLink = currentData[key].productionLink || currentData[key].latestPublishedLink || null;
          currentData[key].lastPublishEnvironment = 'production';
          currentData[key].lastSyncedFromEbay = new Date().toISOString();
        });

        const finalCount = Object.keys(currentData).length;
        if (finalCount < initialCount) {
          throw new Error(`Sync aborted: product count would drop from ${initialCount} to ${finalCount}`);
        }

        atomicWriteJsonSync(dataFile, currentData, { spaces: 2 });
      });

      logger.success('Marked products as Published from eBay reconciliation', { count: toMarkPublished.length });
    }

    if (toPushUpdate.length === 0 || !pushUpdates) {
      return res.json({
        success: true,
        dryRun: false,
        totalEbayOffers: ebayInventorySkus.size,
        totalMatched: matchedSkus.size,
        newlyPublishedCount: toMarkPublished.length,
        updatedCount: 0,
        skippedPushCount: pushUpdates ? 0 : toPushUpdate.length,
        unchangedCount,
        unmatchedOnEbayCount: unmatchedOnEbay.length,
        message: !pushUpdates && toPushUpdate.length > 0
          ? `Marked ${toMarkPublished.length} product(s) as Published. Skipped pushing ${toPushUpdate.length} drifted product(s) to eBay (pushUpdates=false).`
          : toMarkPublished.length > 0
          ? `Marked ${toMarkPublished.length} product(s) as Published. No price/quantity/content drift detected.`
          : 'No changes needed. Local data is already in sync with eBay.'
      });
    }

    const jobId = generateEbaySyncJobId();
    const job = {
      jobId,
      status: 'running',
      environment,
      startedAt: new Date().toISOString(),
      totalProducts: toPushUpdate.length,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      newlyPublishedCount: toMarkPublished.length,
      unchangedCount,
      unmatchedOnEbayCount: unmatchedOnEbay.length,
      results: [],
      errors: []
    };
    ebaySyncJobs.set(jobId, job);

    res.json({
      success: true,
      dryRun: false,
      jobId,
      totalEbayOffers: ebayInventorySkus.size,
      totalMatched: matchedSkus.size,
      newlyPublishedCount: toMarkPublished.length,
      toUpdateCount: toPushUpdate.length,
      unchangedCount,
      unmatchedOnEbayCount: unmatchedOnEbay.length,
      message: `Marked ${toMarkPublished.length} product(s) as Published. Pushing ${toPushUpdate.length} update(s) to eBay...`
    });

    setImmediate(async () => {
      await processEbaySyncPushJob(jobId, toPushUpdate, environment, logger);
    });

  } catch (error) {
    logger.error('eBay reconciliation sync failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/products/sync-from-ebay/:jobId - Poll reconciliation push job status
app.get('/api/products/sync-from-ebay/:jobId', (req, res) => {
  const job = ebaySyncJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  const progress = job.totalProducts > 0
    ? ((job.processedCount / job.totalProducts) * 100).toFixed(1)
    : '100.0';

  res.json({
    success: true,
    job: {
      jobId: job.jobId,
      status: job.status,
      progress: `${progress}%`,
      environment: job.environment,
      processedCount: job.processedCount,
      totalProducts: job.totalProducts,
      successCount: job.successCount,
      failureCount: job.failureCount,
      newlyPublishedCount: job.newlyPublishedCount,
      unchangedCount: job.unchangedCount,
      unmatchedOnEbayCount: job.unmatchedOnEbayCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      estimatedTimeRemaining: calculateETA(job),
      recentResults: job.results.slice(-10),
      recentErrors: job.errors.slice(-5)
    }
  });
});

// Push local price/quantity/content drift to eBay for already-matched, already-published SKUs.
async function processEbaySyncPushJob(jobId, itemsToUpdate, environment, logger) {
  const job = ebaySyncJobs.get(jobId);
  if (!job) return;

  const concurrency = parseInt(process.env.PUBLISH_CONCURRENCY) || 2;
  const dataFile = path.join(__dirname, 'data', 'data.json');

  try {
    for (let i = 0; i < itemsToUpdate.length; i += concurrency) {
      const batch = itemsToUpdate.slice(i, i + concurrency);

      await Promise.all(batch.map(async ({ key, sku, product, reasons }) => {
        const startTime = Date.now();
        try {
          const engine = getSmartPublishingEngine();
          const publishResponse = await engine.retryWithLearning(
            () => publishToEbay(product, { environment }),
            product,
            { link: key, sku, environment, source: 'ebay-reconciliation-sync' }
          );

          if (!publishResponse.success) {
            throw new Error(publishResponse.error?.message || publishResponse.analysis?.errorMessage || 'Publish failed');
          }

          const result = publishResponse.result;

          await withDataFileLock(async () => {
            const currentData = readDataFileOrThrow(dataFile);
            if (currentData[key]) {
              currentData[key].productionListingId = result.listingId || currentData[key].productionListingId;
              currentData[key].productionLink = result.listingLink || currentData[key].productionLink;
              currentData[key].publishedToProduction = true;
              currentData[key].publishStatus = 'Published';
              currentData[key].status = 'Published';
              currentData[key].lastPublishEnvironment = 'production';
              currentData[key].lastPublishedToProdAt = new Date().toISOString();
              currentData[key].lastSyncedFromEbay = new Date().toISOString();
              atomicWriteJsonSync(dataFile, currentData, { spaces: 2 });
            }
          });

          job.successCount++;
          job.results.push({ sku, reasons, status: 'updated', duration: Date.now() - startTime });
          logger.success('Pushed local changes to eBay', { sku, reasons });
        } catch (error) {
          job.failureCount++;
          job.errors.push({ sku, error: error.message, timestamp: new Date().toISOString() });
          logger.error('Failed to push local changes to eBay', { sku, error: error.message });
        } finally {
          job.processedCount++;
        }
      }));

      if (i + concurrency < itemsToUpdate.length) {
        const delayMs = parseInt(process.env.PUBLISH_BATCH_DELAY_MS) || 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    logger.error('eBay reconciliation push job failed', error);
  }
}

// ============================================================================
// ERROR PATTERNS & ANALYTICS
// ============================================================================

// GET /api/error-patterns - Get error learning data
app.get('/api/error-patterns', async (req, res) => {
  try {
    const patterns = loadErrorPatterns();
    
    // Aggregate statistics
    const stats = {
      scrapeErrorTypes: Object.keys(patterns.scrapeErrors || {}).length,
      publishErrorTypes: Object.keys(patterns.publishErrors || {}).length,
      totalScrapeErrors: Object.values(patterns.scrapeErrors || {}).reduce((sum, e) => sum + e.count, 0),
      totalPublishErrors: Object.values(patterns.publishErrors || {}).reduce((sum, e) => sum + e.count, 0),
      lastUpdated: patterns.lastUpdated
    };
    
    // Top errors
    const topScrapeErrors = Object.entries(patterns.scrapeErrors || {})
      .map(([key, data]) => ({ key, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    const topPublishErrors = Object.entries(patterns.publishErrors || {})
      .map(([key, data]) => ({ key, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    res.json({
      success: true,
      stats,
      topScrapeErrors,
      topPublishErrors,
      patterns
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// SERVER START
// ============================================================================

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Run browser resolution once at startup for troubleshooting
  console.log('--- Browser diagnostic (startup) ---');
  getBrowserLaunchOptions();
  console.log('--- End diagnostic ---');
});