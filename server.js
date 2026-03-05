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

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// --- Browser launch logging and fallback ---
function getBrowserLaunchOptions() {
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
  return opts;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const DATA_FILE_PATH = path.join('data', 'data.json');
const ADMIN_CONFIG_PATH = path.join('data', 'admin-config.json');

// API: Get all products
app.get('/api/products', (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return res.json([]);
    }
    const allData = fs.readJsonSync(DATA_FILE_PATH);
    const products = Object.values(allData).map(product => ({
      id: product.itemNumber || product.sku || 'unknown',
      sku: product.sku || product.customLabel,
      title: product.title,
      price: product.price,
      currency: product.currency || 'USD',
      description: product.description,
      images: product.imagesOriginal || product.images || [],
      url: product.url,
      publishedLink: product.publishedLink,
      listingId: product.listingId,
      inventory: product.inventoryQuantity,
      lastUpdated: product.lastUpdated,
      publishedDate: product.publishedDate,
      publishAction: product.publishAction
    }));
    res.json(products);
  } catch (error) {
    console.error('Error reading products:', error);
    res.status(500).json({ error: 'Failed to load products' });
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
    res.json(product);
  } catch (error) {
    console.error('Error reading product:', error);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

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
  if (!raw || typeof raw !== 'string') return 'Untitled Listing';
  
  let t = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*[|\-–—]\s*$/i, '')
    .trim();
  
  // Remove common eBay clutter
  t = t.replace(/\s*(New Listing|Free shipping|Best offer|\d+\s*available)\s*$/gi, '').trim();
  
  // Extract and enhance with key attributes from itemSpecifics
  const brand = itemSpecifics.Brand || itemSpecifics.brand || '';
  const material = itemSpecifics['Blade Material'] || itemSpecifics['Material'] || '';
  const type = itemSpecifics.Type || itemSpecifics.type || '';
  
  // If title doesn't already contain brand, prepend it for SEO
  if (brand && !t.toLowerCase().includes(brand.toLowerCase())) {
    t = `${brand} ${t}`;
  }
  
  // Optimize length: ideal 50-60 chars for search results, max 70
  if (t.length > 70) {
    // Try to cut at word boundary
    let truncated = t.substring(0, 67).trim();
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 50) {
      truncated = truncated.substring(0, lastSpace).trim();
    }
    t = (truncated.length > 0 ? truncated : t.substring(0, 67).trim()) + '...';
  }
  
  return t || 'Untitled Listing';
}

/** SEO-friendly description: structure, keywords, full content, remove eBay boilerplate */
const DESCRIPTION_MAX_LENGTH = 20000;

function makeSeoDescription(raw, itemSpecifics = {}, title = '') {
  if (!raw || typeof raw !== 'string') return '';
  
  // Clean up eBay boilerplate
  let d = raw
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
  
  // Build enhanced description with structure
  let enhanced = d;
  
  // Add key specifications if available
  const specs = [];
  if (itemSpecifics.Brand) specs.push(`Brand: ${itemSpecifics.Brand}`);
  if (itemSpecifics['Blade Material']) specs.push(`Material: ${itemSpecifics['Blade Material']}`);
  if (itemSpecifics['Blade Type']) specs.push(`Type: ${itemSpecifics['Blade Type']}`);
  if (itemSpecifics.Color) specs.push(`Color: ${itemSpecifics.Color}`);
  if (itemSpecifics.Condition) specs.push(`Condition: ${itemSpecifics.Condition.split(':')[0]}`);
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

function validateImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];

  const filtered = imageUrls.filter((url) => {
    try {
      // Must be valid URL
      if (!url || typeof url !== 'string') return false;
      if (!url.includes('ebayimg.com')) return false;

      // Filter out thumbnail sizes
      if (/s-l(50|100|140|200)\./.test(url)) return false;

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

const EBAY_ENV = (process.env.EBAY_ENV || 'sandbox').toLowerCase();

function getEbayBaseUrls() {
  if (EBAY_ENV === 'production') {
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

async function getEbayAccessToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing eBay credentials. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN.');
  }

  console.log('[Token Debug] Token first 100 chars:', refreshToken.substring(0, 100));
  console.log('[Token Debug] Contains #f^0#p^:', refreshToken.includes('#f^0#p^'));
  console.log('[Token Debug] Contains #r^0#:', refreshToken.includes('#r^0#'));

  // Check if it's a direct user token (starts with v^1.1#i^1#f^0#p^)
  // User tokens have r^0, refresh tokens have r^1
  if (refreshToken.includes('#f^0#p^') || refreshToken.includes('#r^0#')) {
    console.log('Using direct OAuth User Token (2-hour expiry)');
    return refreshToken;
  }

  // Otherwise, exchange refresh token for access token
  const scope = process.env.EBAY_SCOPE || [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account'
  ].join(' ');

  const { identityBase } = getEbayBaseUrls();
  const tokenBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(`${identityBase}/identity/v1/oauth2/token`, tokenBody.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 30000
  });

  return response.data.access_token;
}

function parseQuantity(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(1, Math.floor(raw));
  const text = String(raw || '');
  const match = text.match(/\d+/);
  if (!match) return 1;
  return Math.max(1, parseInt(match[0], 10));
}

function buildPublishSku(productData) {
  const base = String(productData.customLabel || productData.itemNumber || '').trim();
  if (base) return base.substring(0, 50);
  return `sku-${crypto.createHash('md5').update(productData.url).digest('hex').substring(0, 16)}`;
}

function shouldUseEbayHostedImages() {
  const runtime = getRuntimeConfig();
  return runtime.ebay.useEpsImages;
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
  const hosted = [];

  for (const imageUrl of imageUrls) {
    try {
      const hostedUrl = await uploadImageUrlToEbayEps(imageUrl, token);
      hosted.push(hostedUrl);
      if (logger) logger.debug('EPS image uploaded', { source: imageUrl, hosted: hostedUrl });
    } catch (error) {
      if (logger) logger.warn('EPS upload failed, falling back to source image URL', { source: imageUrl, error: error.message });
      hosted.push(imageUrl);
    }
  }

  return hosted;
}

/**
 * Check if an offer/listing already exists for the given SKU
 */
async function findExistingOffer(sku) {
  const token = await getEbayAccessToken();
  const { apiBase } = getEbayBaseUrls();

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

async function publishToEbay(productData, overrides = {}) {
  const logger = createLogger('PublishToEbay');
  
  try {
    logger.info('Starting publish process', { sku: productData.customLabel });
    
    // ==================================================================================
    // VALIDATE: Check content for scams, suspicious keywords, and malicious patterns
    // ==================================================================================
    const contentValidation = validateProductContent(productData.title, productData.description);
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
    const sourceImageUrlsFromData = Array.isArray(productData.imageSourceUrls) ? productData.imageSourceUrls : [];
    const validatedImages = validateImageUrls(sourceImageUrlsFromData);
    
    if (validatedImages.length === 0) {
      const errorMsg = 'Cannot publish: no valid product images. Images may have been filtered as suspicious.';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    if (validatedImages.length < sourceImageUrlsFromData.length) {
      const removed = sourceImageUrlsFromData.length - validatedImages.length;
      logger.warn('Suspicious images removed', { 
        total: sourceImageUrlsFromData.length, 
        valid: validatedImages.length,
        removed 
      });
    }
    
    const token = await getEbayAccessToken();
    const { apiBase, listingBase } = getEbayBaseUrls();

    const marketplaceId = overrides.marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    logger.debug('Marketplace ID', { marketplaceId });
    
    // Try to use categoryId from productData first, then from overrides, then from .env
    let categoryId = productData.categoryId || overrides.categoryId || process.env.EBAY_CATEGORY_ID;
    
    // If categoryId is still 'N/A', try to use a default or fail gracefully
    if (categoryId === 'N/A') {
      categoryId = process.env.EBAY_CATEGORY_ID;
    }
    
    const fulfillmentPolicyId = process.env.EBAY_FULFILLMENT_POLICY_ID;
    const paymentPolicyId = process.env.EBAY_PAYMENT_POLICY_ID;
    const returnPolicyId = process.env.EBAY_RETURN_POLICY_ID;
    const merchantLocationKey = process.env.EBAY_LOCATION_KEY || 'des-plaines-il-primary';

    logger.debug('Policy IDs', {
      categoryId,
      fulfillmentPolicyId: fulfillmentPolicyId ? 'SET' : 'MISSING',
      paymentPolicyId: paymentPolicyId ? 'SET' : 'MISSING',
      returnPolicyId: returnPolicyId ? 'SET' : 'MISSING'
    });

    if (!categoryId || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      const missing = [];
      if (!categoryId) missing.push('EBAY_CATEGORY_ID');
      if (!fulfillmentPolicyId) missing.push('EBAY_FULFILLMENT_POLICY_ID');
      if (!paymentPolicyId) missing.push('EBAY_PAYMENT_POLICY_ID');
      if (!returnPolicyId) missing.push('EBAY_RETURN_POLICY_ID');
      
      const errorMsg = `Missing eBay policy/config values: ${missing.join(', ')}`;
      logger.error(errorMsg, { missing });
      throw new Error(errorMsg);
    }

    const sku = buildPublishSku(productData);
    // Always use 3 units for inventory, regardless of available quantity on source
    const quantity = 3;
    const currency = productData.currency || 'USD';
    const price = typeof productData.price === 'number' ? productData.price : Number(productData.price);
    // Load or set default backorder/overselling flag
    const enableBackorder = productData.enableBackorder !== undefined ? productData.enableBackorder : true;

    logger.debug('Product data extracted', { sku, quantity: '3 units', currency, price, enableBackorder });

    if (!Number.isFinite(price) || price <= 0) {
      const errorMsg = `Invalid price: ${productData.price}`;
      logger.error(errorMsg, { rawPrice: productData.price, parsedPrice: price });
      throw new Error('Cannot publish: invalid numeric price in scraped data.');
    }

    const sourceImageUrls = validatedImages;
    let imageUrls = sourceImageUrls.slice(0, 24);
    logger.debug(`Using validated images`, { total: validatedImages.length, willUse: imageUrls.length });

    if (imageUrls.length === 0) {
      const errorMsg = 'Cannot publish: no source image URLs found. Re-scrape this listing first to populate imageSourceUrls.';
      logger.error(errorMsg, { sku, link: productData.url || productData.link || null });
      throw new Error(errorMsg);
    }

    if (shouldUseEbayHostedImages()) {
      logger.info('EBAY_USE_EPS_IMAGES is enabled. Uploading images to eBay Picture Services...');
      imageUrls = await convertToEbayHostedImageUrls(imageUrls, token, logger);
      logger.debug('EPS image URL set prepared', { total: imageUrls.length });
    }

    let videoAsset = { enabled: false, reason: 'Not generated' };
    try {
      videoAsset = await generateMarketingVideoWithMediaApi({
        sku,
        title: productData.title,
        description: productData.description,
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
    const existingOffer = await findExistingOffer(sku);

    if (existingOffer.found) {
      logger.success(`Found existing offer:${existingOffer.offerId}`, { offerId: existingOffer.offerId, status: existingOffer.status });
      
      // Build aspects with defaults for common missing fields
      const aspects = Object.fromEntries(
        Object.entries(productData.itemSpecifics || {}).map(([key, value]) => [
          key,
          [String(value).substring(0, 65)]
        ])
      );
      
      // Add default values for commonly required fields in collectible categories
      const defaultAspects = {
        'Size Type': 'Large',
        'Size': 'One Size',
        'Color': 'Silver',
        'Blade Material': 'Steel',
        'Type': 'Knife',
        'Department': 'Unisex'
      };
      
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
            title: String(productData.title || '').substring(0, 80),
            description: String(productData.description || '').substring(0, 4000),
            imageUrls,
            aspects
          }
        };

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

      // Return existing listing link
      const listingLink = existingOffer.listingId ? `${listingBase}/itm/${existingOffer.listingId}` : null;
      
      logger.success(`Publish operation completed: ${dataChanged ? 'UPDATED' : 'UNCHANGED'}`, { listingLink });
      return {
        offerId: existingOffer.offerId,
        sku,
        listingId: existingOffer.listingId,
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
      Object.entries(productData.itemSpecifics || {}).map(([key, value]) => [
        key, 
        [String(value).substring(0, 65)]
      ])
    );
    
    // Add default values for commonly required fields in collectible categories
    const defaultAspects = {
      'Size Type': 'Large',
      'Size': 'One Size',
      'Color': 'Silver',
      'Blade Material': 'Steel',
      'Type': 'Knife',
      'Department': 'Unisex'
    };
    
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
        title: String(productData.title || '').substring(0, 80),
        description: String(productData.description || '').substring(0, 4000),
        imageUrls,
        aspects
      }
    };

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
      listingDescription: String(productData.description || '').substring(0, 4000),
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
          productData,
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

    return {
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
      environment: EBAY_ENV,
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
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const devId = process.env.EBAY_DEV_ID;
    const ebayEnv = process.env.EBAY_ENV || 'sandbox';

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
    const { identityBase } = getEbayBaseUrls();
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
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const refreshToken = process.env.EBAY_REFRESH_TOKEN;
    const ebayEnv = process.env.EBAY_ENV || 'sandbox';
    
    // Check configuration status
    const configStatus = {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken,
      hasFulfillmentPolicy: !!process.env.EBAY_FULFILLMENT_POLICY_ID,
      hasPaymentPolicy: !!process.env.EBAY_PAYMENT_POLICY_ID,
      hasReturnPolicy: !!process.env.EBAY_RETURN_POLICY_ID,
      hasCategoryId: !!process.env.EBAY_CATEGORY_ID,
      hasLocationKey: !!process.env.EBAY_LOCATION_KEY,
      environment: ebayEnv
    };

    let sellerInfo = null;
    let userToken = null;

    // Try to get user info if refresh token is available
    if (refreshToken && clientId && clientSecret) {
      try {
        userToken = await getEbayAccessToken();
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
  const clientId = process.env.EBAY_CLIENT_ID;
  const redirectUri = process.env.EBAY_REDIRECT_URI || 'Strapey_Inc-StrapeyI-Strape-xmqocvrv';
  const ebayEnv = process.env.EBAY_ENV || 'sandbox';
  
  if (!clientId) {
    return res.status(400).json({ error: 'EBAY_CLIENT_ID not configured' });
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

        <script>
          function copyCode() {
            navigator.clipboard.writeText('${code}');
            alert('Authorization code copied to clipboard!');
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

    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const redirectUri = process.env.EBAY_REDIRECT_URI || 'Strapey_Inc-StrapeyI-Strape-xmqocvrv';
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({ 
        success: false, 
        error: 'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured' 
      });
    }

    const { identityBase } = getEbayBaseUrls();
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
        step2: 'Add it to your .env file as EBAY_REFRESH_TOKEN=<token>',
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
    const accessToken = await getEbayAccessToken();
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Failed to obtain access token',
        hint: 'Check EBAY_REFRESH_TOKEN in .env'
      });
    }

    const { apiBase } = getEbayBaseUrls();
    const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
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
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const refreshToken = process.env.EBAY_REFRESH_TOKEN;

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
    const merchantLocationKey = 'des-plaines-il-primary';

    // Get OAuth token
    const { identityBase } = getEbayBaseUrls();
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
    const { apiBase } = getEbayBaseUrls();
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
      environment: process.env.EBAY_ENV || 'sandbox'
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

// Simple test endpoint to verify eBay API connectivity and test creating a listing
app.post('/api/ebay-test-listing', async (req, res) => {
  try {
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    
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
      const { identityBase } = getEbayBaseUrls();
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
      
      const { apiBase } = getEbayBaseUrls();
      
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
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: 'eBay credentials not configured'
      });
    }

    const { identityBase, apiBase } = getEbayBaseUrls();
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
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const refreshToken = process.env.EBAY_REFRESH_TOKEN;
    const fulfillmentPolicyId = process.env.EBAY_FULFILLMENT_POLICY_ID;
    const paymentPolicyId = process.env.EBAY_PAYMENT_POLICY_ID;
    const returnPolicyId = process.env.EBAY_RETURN_POLICY_ID;
    const categoryId = process.env.EBAY_CATEGORY_ID || '179776'; // Default: Fixed Blade Knives (leaf category)
    const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    
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
      
      const { apiBase } = getEbayBaseUrls();
      const timestamp = Date.now();
      const merchantLocationKey = process.env.EBAY_LOCATION_KEY || `test-location-${timestamp}`;
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
              listingUrl: `https://${process.env.EBAY_ENV === 'sandbox' ? 'sandbox.' : ''}ebay.com/itm/${listingId}`
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

    logger.info('Processing items', { totalItems: items.length });
    const results = [];
    
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const link = (item.link || item.url || (typeof item === 'string' ? item : '')).trim();
      const itemNumber = String(item.itemNumber != null ? item.itemNumber : '').trim();
      const sku = String(item.sku != null ? item.sku : (item.customLabel || '')).trim();
      
      logger.debug('Processing item', { index, link, itemNumber, sku });
      
      if (!link) {
        logger.warn('Item missing link', { index, itemNumber, sku });
        results.push({ link: '', itemNumber, customLabel: sku, error: 'Link is required', timestamp: new Date().toISOString() });
        continue;
      }
      
      try {
        logger.info('Starting scrape for item', { index, link });
        const data = await scrapeEbayProduct(link, itemNumber, sku);
        logger.success('Item scraped successfully', { index, link, imageCount: (data.images || []).length, title: data.title });
        results.push({ ...data, timestamp: new Date().toISOString() });
      } catch (error) {
        logger.error('Scrape error for item', error);
        logger.debug('Error details for item', { 
          index, 
          link, 
          errorMessage: error.message, 
          errorCode: error.code,
          itemNumber,
          sku
        });
        const errorResponse = logger.getErrorResponse('ItemScrape', error);
        results.push({ 
          url: link, 
          link, 
          itemNumber, 
          customLabel: sku, 
          error: error.message,
          ...errorResponse,
          timestamp: new Date().toISOString()
        });
      }

      if (index < items.length - 1) {
        logger.info('Waiting 3 seconds before next item', { currentIndex: index, totalItems: items.length });
        await delay(3000);
      }
    }

    logger.success('Scrape batch completed', { totalItems: items.length, successCount: results.filter(r => !r.error).length, errorCount: results.filter(r => r.error).length });
    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.filter(r => !r.error).length,
        failed: results.filter(r => r.error).length
      },
      timestamp: new Date().toISOString(),
      logs: logger.getLogs()
    });
  } catch (err) {
    logger.error('Scrape route error', err);
    const errorResponse = logger.getErrorResponse('ScrapeRoute', err);
    res.status(500).json({ 
      success: false,
      error: err.message || 'Server error during scrape',
      ...errorResponse,
      timestamp: new Date().toISOString(),
      logs: logger.getLogs()
    });
  }
});

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
    const productData = allData[link];
    if (!productData) {
      logger.warn('Product not found in data store', { link });
      return res.status(404).json({ 
        error: 'Listing not found in data store for this link.',
        logs: logger.getLogs()
      });
    }

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
    fs.writeJsonSync(dataFile, allData);
    
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
    Object.entries(data).forEach(([link, productData]) => {
      results.itemsScanned++;
      const itemResult = { link, status: 'OK', issues: [] };
      
      // Validate images
      if (Array.isArray(productData.imageSourceUrls) && productData.imageSourceUrls.length > 0) {
        const validatedImages = validateImageUrls(productData.imageSourceUrls);
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

async function scrapeEbayProduct(url, itemNumber = '', sku = '') {
  console.log(`Starting scrape for URL: ${url}`);
  const maxRetries = 3;
  let browser = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Attempt ${attempt} for ${url}`);

    const launchOptions = getBrowserLaunchOptions();
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
      const hint = 'Install Chrome, or run: npm install puppeteer (without PUPPETEER_SKIP_DOWNLOAD). See https://pptr.dev/troubleshooting';
      throw new Error(`Failed to launch the browser process: ${err.message}. ${hint}`);
    }

    console.log(`Browser launched for ${url}`);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    console.log(`Page created for ${url}`);
    try {
      
      await delay(3000);

      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log(`Page loaded successfully for ${url}`);
      await delay(3000); // Wait for potential dynamic content
      console.log(`Waited 2 seconds for ${url}`);

      // Click the gallery button to open full images
      try {
        const galleryButton = await page.$x('/html/body/div[2]/main/div[1]/div[1]/div[4]/div/div/div[1]/div[1]/div/div[1]/div[1]/div[2]/div[5]/button');
        if (galleryButton.length) {
          await galleryButton[0].click();
          console.log('Gallery button clicked');
          await page.waitForSelector('.lightbox-dialog', { timeout: 5000 });
          console.log('Gallery dialog opened');
          await delay(3000); // Wait for images to load
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
      await delay(1000);
      console.log('Scrolled to bottom');

      // Open "Description" tab first so we capture full description (not Item specifics)
      try {
        const clickedDesc = await page.evaluate(() => {
          const tab = document.querySelector('a[href="#viTabs_0_pan"]') ||
            Array.from(document.querySelectorAll('a[href^="#viTabs"], [data-tab]')).find(el => /description/i.test((el.getAttribute('href') || '') + (el.textContent || '')));
          if (tab) { tab.click(); return true; }
          return false;
        });
        if (clickedDesc) await delay(1200);
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
        if (clicked) await delay(800);
      } catch (e) {
        console.log('Item specifics tab click skipped:', e.message);
      }

      // Extract data with page.evaluate
      console.log(`Extracting data for ${url}`);
      const extractedData = await page.evaluate((pageUrl) => {
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
          const srcSet = new Set();
          const pushUrl = (src) => {
            if (!src || typeof src !== 'string') return;
            if (!src.includes('ebayimg.com')) return;
            if (src.includes('s-l50') || src.includes('s-l100') || src.includes('s-l140')) return;
            srcSet.add(src);
          };

          document.querySelectorAll('.ux-image-carousel-item img, .ux-image-grid-item img, img[data-image-index], img.u-flL, #icThumbs img, .zoom img, .gallery img, [data-testid="gallery-image"], img').forEach((img) => {
            pushUrl(img.src);
            pushUrl(img.getAttribute('data-zoom-src'));
            pushUrl(img.getAttribute('data-src'));
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

          return Array.from(srcSet)
            .map((src) => src.replace(/s-l\d+\./, 's-l1600.'))
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
        const availableQuantity = document.querySelector('#qtySubTxt')?.textContent.trim() || 
                                document.querySelector('#qtyAvail')?.textContent.trim() || 'N/A';
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

      // Apply SEO optimization with item specifics
      extractedData.title = makeSeoTitle(extractedData.title, extractedData.itemSpecifics);
      extractedData.description = makeSeoDescription(extractedData.description, extractedData.itemSpecifics, extractedData.title);

      await browser.close();
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

      // Download and enhance images
      const productId = crypto.createHash('md5').update(url).digest('hex');
      const productDir = path.join('data', productId);
      fs.ensureDirSync(productDir);
      console.log(`Created directory: ${productDir}`);

      // Determine SKU and title for filename
      const finalSku = sku || extractedData.customLabel || 'NoSKU';
      const finalTitle = extractedData.title || 'Product';
      const seoSku = sanitizeForFilename(finalSku);
      const seoTitle = sanitizeForFilename(finalTitle);

      const imagesOriginal = [];
      const imagesEnhanced = [];
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
          imagesEnhanced.push(enhancedPath);
          console.log(`Processed image ${i}`);
        } catch (e) {
          console.error(`Failed to download or process ${imgUrl}: ${e.message}`);
        }
      }

      // Prepare data: include itemNumber and SKU; key by link (url)
      // Use provided SKU, or fall back to extracted customLabel from page
      const productData = {
        ...extractedData,
        url,
        itemNumber: itemNumber || extractedData.itemNumber || '',
        customLabel: sku || extractedData.customLabel || '',
        imageSourceUrls: extractedData.images,
        images: imagesEnhanced,
        imagesOriginal,
        lastUpdated: new Date().toISOString()
      };

      const dataFile = path.join('data', 'data.json');
      let allData = {};
      if (fs.existsSync(dataFile)) {
        allData = fs.readJsonSync(dataFile);
      }

      const existing = allData[url];
      const priceChanged = existing && existing.price !== productData.price;
      const titleChanged = existing && existing.title !== productData.title;
      const descriptionChanged = existing && existing.description !== productData.description;
      const itemNumberChanged = existing && (existing.itemNumber || '') !== (productData.itemNumber || '');
      const skuChanged = existing && (existing.customLabel || '') !== (productData.customLabel || '');
      const existingSourceImages = Array.isArray(existing?.imageSourceUrls) ? existing.imageSourceUrls : [];
      const imagesChanged = existing && JSON.stringify(existingSourceImages) !== JSON.stringify(productData.imageSourceUrls || []);

      if (!existing) {
        allData[url] = productData;
        fs.writeJsonSync(dataFile, allData);
        console.log(`New record inserted for ${url}`);
      } else if (priceChanged || titleChanged || descriptionChanged || itemNumberChanged || skuChanged || imagesChanged) {
        allData[url] = productData;
        fs.writeJsonSync(dataFile, allData);
        console.log(`Data updated for ${url} (price/title/description/itemNumber/sku/images changed)`);
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
      if (attempt === maxRetries) {
        console.error(`All attempts failed for ${url}`);
        throw error;
      }
      console.log(`Retrying in 5 seconds...`);
      await delay(5000);
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
    const imageBuffer = await fs.readFile(originalImagePath);
    const { width: targetSize, background, sharpenSigma, webpQuality, webpEffort, allowEnlargement, theme } = IMAGE_CONFIG;

    // Step 1: Rotate and resize with lanczos3 kernel for better quality
    const resized = await sharp(imageBuffer)
      .rotate()
      .resize({
        width: targetSize,
        height: targetSize,
        fit: 'inside',
        withoutEnlargement: !allowEnlargement,
        kernel: sharp.kernel.lanczos3
      })
      .toBuffer({ resolveWithObject: true });

    const w = resized.info.width;
    const h = resized.info.height;
    const left = Math.floor((targetSize - w) / 2);
    const right = targetSize - w - left;
    const top = Math.floor((targetSize - h) / 2);
    const bottom = targetSize - h - top;

    // Step 2: Extend with background and sharpen
    let processedBuffer = await sharp(resized.data)
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
        await fs.promises.unlink(outputPath); // Remove non-upscaled version
        const finalOutputPath = path.join(dir, base + '_enhanced.webp');
        await fs.promises.rename(upscaledPath, finalOutputPath);
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
      environment: EBAY_ENV,
      runtime,
      tests
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Run browser resolution once at startup for troubleshooting
  console.log('--- Browser diagnostic (startup) ---');
  getBrowserLaunchOptions();
  console.log('--- End diagnostic ---');
});