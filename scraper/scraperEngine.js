/**
 * Scraper Engine
 * Core scraping functionality with anti-blocking measures
 */

const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ScraperEngine {
  constructor(config, logger, retryHandler) {
    this.config = config;
    this.logger = logger;
    this.retryHandler = retryHandler;
    this.browser = null;
    this.currentUserAgentIndex = 0;
  }

  async initialize() {
    if (!this.browser) {
      this.logger.info('Initializing browser');
      this.browser = await puppeteer.launch({
        headless: this.config.browser.headless,
        args: this.config.browser.args,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });
    }
  }

  async close() {
    if (this.browser) {
      this.logger.info('Closing browser');
      await this.browser.close();
      this.browser = null;
    }
  }

  async scrapeEbayListing(url, sku) {
    return this.retryHandler.executeWithRetry(
      async () => await this._scrapeListingInternal(url, sku),
      { url, sku }
    );
  }

  async _scrapeListingInternal(url, sku) {
    const page = await this.browser.newPage();

    try {
      // Anti-blocking measures
      await this.applyAntiBlockingMeasures(page);

      // Navigate to page
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Check for blocking
      const isBlocked = await this.detectBlocking(page, url);
      if (isBlocked) {
        throw new Error('Bot detection or rate limiting detected');
      }

      // Wait for content
      await page.waitForSelector('.x-item-title', { timeout: 10000 }).catch(() => {
        this.logger.warn('Title selector not found, attempting extraction anyway');
      });

      // Extract data
      const data = await this.extractListingData(page, url, sku);

      // Download images
      if (data.images && data.images.length > 0) {
        const imageFolder = await this.downloadImages(data.images, data.itemNumber);
        data.imagesOriginal = imageFolder;
      }

      return data;
    } finally {
      await page.close();
    }
  }

  async applyAntiBlockingMeasures(page) {
    // Set viewport
    await page.setViewport(this.config.browser.viewport);

    // Rotate user agent
    const userAgent = this.getUserAgent();
    await page.setUserAgent(userAgent);

    // Set additional headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    // Mask automation
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      // Mock chrome runtime
      window.chrome = {
        runtime: {},
      };

      // Mock permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    });
  }

  getUserAgent() {
    if (this.config.antiBlocking.rotateUserAgent) {
      const agents = this.config.antiBlocking.userAgents;
      const userAgent = agents[this.currentUserAgentIndex];
      this.currentUserAgentIndex = (this.currentUserAgentIndex + 1) % agents.length;
      return userAgent;
    }
    return this.config.antiBlocking.userAgents[0];
  }

  async detectBlocking(page, url) {
    if (!this.config.antiBlocking.detectBlocking) {
      return false;
    }

    const content = await page.content();
    const lowerContent = content.toLowerCase();

    for (const indicator of this.config.antiBlocking.blockingIndicators) {
      if (lowerContent.includes(indicator.toLowerCase())) {
        this.logger.logBlocking(url, indicator);
        return true;
      }
    }

    return false;
  }

  async extractListingData(page, url, sku) {
    const data = await page.evaluate((url, sku) => {
      const result = {
        url,
        itemNumber: null,
        customLabel: sku || 'N/A',
        title: null,
        price: null,
        description: 'Item description from the seller',
        images: [],
        availableQuantity: 'N/A',
        format: 'Buy It Now',
        currency: 'USD',
        startPrice: null,
        variationDetails: {},
        itemSpecifics: {},
      };

      // Extract item number from URL
      const itemNumMatch = url.match(/\/itm\/(\d+)/);
      if (itemNumMatch) {
        result.itemNumber = itemNumMatch[1];
      }

      // Title
      const titleEl = document.querySelector('.x-item-title__mainTitle, h1[class*="title"]');
      if (titleEl) {
        result.title = titleEl.textContent.trim();
      }

      // Price
      const priceEl = document.querySelector('.x-price-primary, .x-price__primary, [itemprop="price"]');
      if (priceEl) {
        const priceText = priceEl.textContent.trim().replace(/[^0-9.]/g, '');
        result.price = parseFloat(priceText) || null;
      }

      // Images
      const imageEls = document.querySelectorAll('img[src*="ebayimg"], [class*="image"] img');
      imageEls.forEach((img) => {
        let src = img.src || img.dataset.src;
        if (src && src.includes('ebayimg.com') && !result.images.includes(src)) {
          result.images.push(src);
        }
      });

      // Item Specifics
      const specificsContainer = document.querySelectorAll('[class*="ux-labels-values"], .ux-layout-section__row');
      specificsContainer.forEach((row) => {
        const label = row.querySelector('[class*="ux-labels-values__labels"]');
        const value = row.querySelector('[class*="ux-labels-values__values"]');
        if (label && value) {
          const labelText = label.textContent.trim().replace(':', '');
          const valueText = value.textContent.trim();
          if (labelText && valueText) {
            result.itemSpecifics[labelText] = valueText;
          }
        }
      });

      return result;
    }, url, sku);

    // Validate and apply fallbacks
    return this.validateData(data);
  }

  validateData(data) {
    const fallbacks = this.config.validation.fallbackValues;

    // Apply fallbacks for missing fields
    for (const [field, fallback] of Object.entries(fallbacks)) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        data[field] = fallback;
      }
    }

    // Validate required fields
    for (const field of this.config.validation.requiredFields) {
      if (!data[field]) {
        this.logger.warn(`Missing required field: ${field}`, { url: data.url });
      }
    }

    // Add timestamp
    data.lastUpdated = new Date().toISOString();

    return data;
  }

  async downloadImages(imageUrls, itemNumber) {
    const hash = crypto.createHash('md5').update(itemNumber).digest('hex');
    const imageFolder = path.join(this.config.output.imagePath, hash);

    if (!fs.existsSync(imageFolder)) {
      fs.mkdirSync(imageFolder, { recursive: true });
    }

    const imagePaths = [];

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const imageUrl = imageUrls[i];
        const page = await this.browser.newPage();
        
        const viewSource = await page.goto(imageUrl);
        const buffer = await viewSource.buffer();
        
        const extension = imageUrl.includes('.webp') ? 'webp' : 'jpg';
        const imagePath = path.join(imageFolder, `image_${i}.${extension}`);
        
        fs.writeFileSync(imagePath, buffer);
        imagePaths.push(imagePath.replace(this.config.output.imagePath + '/', ''));
        
        await page.close();
      } catch (error) {
        this.logger.warn(`Failed to download image ${i}`, { error: error.message });
      }
    }

    return imagePaths;
  }
}

module.exports = ScraperEngine;
