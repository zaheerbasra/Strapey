/**
 * Scraper Engine
 * Core scraping functionality with anti-blocking measures
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
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
      this.browser = await puppeteerExtra.launch({
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

      // Navigate to page with detailed logging
      this.logger.info(`[Scraper] Navigating to ${url} for SKU ${sku}`);
      const response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      if (response) {
        this.logger.info(`[Scraper] Navigation response status: ${response.status()} for SKU ${sku}`);
        this.logger.info(`[Scraper] Final URL after navigation: ${page.url()} for SKU ${sku}`);
      } else {
        this.logger.warn(`[Scraper] No response received from navigation for SKU ${sku}`);
      }

      // Check for blocking
      const isBlocked = await this.detectBlocking(page, url);
      if (isBlocked === 'challenge') {
        throw new Error('eBay bot protection/challenge page detected');
      } else if (isBlocked) {
        throw new Error('Bot detection or rate limiting detected');
      }


      // Wait for content
      await page.waitForSelector('.x-item-title', { timeout: 10000 }).catch(() => {
        this.logger.warn(`[Scraper] Title selector not found for SKU ${sku}, attempting extraction anyway`);
      });

      // Dump HTML for debugging if SKU is 1911Grip35
      if (sku === '1911Grip35') {
        const html = await page.content();
        const fs = require('fs');
        fs.writeFileSync(`./data/1911Grip35_debug.html`, html, 'utf8');
        this.logger.info(`[Scraper] Dumped HTML for 1911Grip35 to ./data/1911Grip35_debug.html`);
        this.logger.info(`[Scraper] Current page URL: ${page.url()}`);
      }

      // Extract data
      const data = await this.extractListingData(page, url, sku);

      // Download images
      if (data.images && data.images.length > 0) {
        const imageFolder = await this.downloadImages(data.images, data.itemNumber, sku);
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

    // Detect eBay bot protection/challenge page
    if (lowerContent.includes('checking your browser before you access ebay') ||
        lowerContent.includes('please wait... reference id:')) {
      this.logger.error('eBay bot protection/challenge page detected', { url });
      return 'challenge';
    }

    for (const indicator of this.config.antiBlocking.blockingIndicators) {
      if (lowerContent.includes(indicator.toLowerCase())) {
        this.logger.logBlocking(url, indicator);
        return true;
      }
    }

    return false;
  }

  async extractListingData(page, url, sku) {
    // Wait for product gallery or large images to load (up to 5 seconds)
    let retries = 0;
    let data = null;
    let lastError = null;
    while (retries < 3 && (!data || !data.images || data.images.length === 0)) {
      try {
        await page.waitForTimeout(2000 + retries * 1000);
        await page.waitForSelector('img[src*="ebayimg"], img[src*="s-l1600"], img[src*="s-l1200"], img[src*="s-l960"], .ux-image-carousel-item img, .lightbox-dialog img, [role="dialog"] img', {timeout: 4000 + retries * 1000}).catch(() => {});

        // Enhanced extraction: main gallery, srcset, seller description iframe, URL normalization, deep fallback
        data = await page.evaluate(async (url, sku) => {
          function toAbsoluteUrl(src, base) {
            try {
              return new URL(src, base).href;
            } catch {
              return src;
            }
          }

          function getBestSrcFromSrcset(srcset) {
            if (!srcset) return null;
            // Parse srcset and pick the largest width
            return srcset.split(',')
              .map(s => s.trim())
              .map(s => {
                const [url, size] = s.split(/\s+/);
                const width = size && size.endsWith('w') ? parseInt(size) : 0;
                return { url, width };
              })
              .sort((a, b) => b.width - a.width)[0]?.url || null;
          }

          const result = {
            url,
            itemNumber: null,
            customLabel: sku || 'N/A',
            title: null,
            price: null,
            description: 'Item description from the seller',
            images: [],
            availableQuantity: '0',
            format: 'Buy It Now',
            currency: 'USD',
            startPrice: null,
            variationDetails: {},
            itemSpecifics: {},
            weight: null,
            weightUnit: null,
            dimensions: {
              length: null,
              width: null,
              height: null,
              unit: 'in'
            }
          };

          // Extract item number from URL
          const itemNumMatch = url.match(/\/itm\/(\d+)/);
          if (itemNumMatch) {
            result.itemNumber = itemNumMatch[1];
          }

          // Title
          const titleEl = document.querySelector('.x-item-title__mainTitle, h1[class*="title"], h1#itemTitle, h1.it-ttl');
          if (titleEl) {
            result.title = titleEl.textContent.trim();
          }

          // Price
          const priceEl = document.querySelector('.x-price-primary, .x-price__primary, [itemprop="price"], #prcIsum, [data-testid="x-price-primary"]');
          if (priceEl) {
            const priceText = priceEl.textContent.trim().replace(/[^0-9.]/g, '');
            result.price = parseFloat(priceText) || null;
          }

          // Special-case: Use XPath for 1911Grip35
          if (sku === '1911Grip35') {
            try {
              const xpath = '/html/body/div[3]/main/div[1]/div[1]/div[4]/div/div/div[1]/div[1]/div/div[1]/div[2]/div/div[2]/div[3]/div[1]/div/div[2]/div[1]/img';
              const imgElem = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (imgElem && imgElem.src) {
                result.images.push(imgElem.src);
              }
            } catch (e) {
              // Ignore XPath errors
            }
          }

          // Fallback: All <img> tags with src or data-src containing 'ebayimg.com', use best srcset
          const allImgs = Array.from(document.querySelectorAll('img'));
          allImgs.forEach((img) => {
            let src = img.src || img.getAttribute('data-src');
            let srcset = img.getAttribute('srcset');
            let bestSrc = src;
            if (srcset) {
              const best = getBestSrcFromSrcset(srcset);
              if (best) bestSrc = best;
            }
            if (bestSrc && bestSrc.includes('ebayimg.com') && !result.images.includes(bestSrc)) {
              result.images.push(bestSrc);
            }
          });

          // Gallery images in <noscript> or data attributes
          const noscripts = Array.from(document.querySelectorAll('noscript'));
          noscripts.forEach(ns => {
            const html = ns.innerHTML;
            const matches = html.match(/https:\/\/i\.ebayimg\.com\/[^\"]+/g);
            if (matches) {
              matches.forEach(src => {
                if (!result.images.includes(src)) {
                  result.images.push(src);
                }
              });
            }
          });

          // Deep fallback: background-image styles
          document.querySelectorAll('[style*="background-image"]').forEach(node => {
            const style = node.getAttribute('style') || '';
            const match = style.match(/url\(["']?(.*?)["']?\)/i);
            if (match && match[1] && match[1].includes('ebayimg.com')) {
              if (!result.images.includes(match[1])) {
                result.images.push(match[1]);
              }
            }
          });

          // JSON-LD scripts
          const jsonScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of jsonScripts) {
            try {
              const json = JSON.parse(script.textContent || '{}');
              const imageField = json?.image;
              if (Array.isArray(imageField)) imageField.forEach((u) => { if (!result.images.includes(u)) result.images.push(u); });
              else if (typeof imageField === 'string' && !result.images.includes(imageField)) result.images.push(imageField);
            } catch (e) {}
          }

          // --- Seller Description iframe extraction ---
          try {
            const descIframe = document.querySelector('#desc_ifr');
            if (descIframe && descIframe.contentDocument) {
              const base = descIframe.contentDocument.baseURI || url;
              const descImgs = Array.from(descIframe.contentDocument.querySelectorAll('img'));
              descImgs.forEach((img) => {
                let src = img.src || img.getAttribute('data-src');
                let srcset = img.getAttribute('srcset');
                let bestSrc = src;
                if (srcset) {
                  const best = getBestSrcFromSrcset(srcset);
                  if (best) bestSrc = best;
                }
                if (bestSrc) {
                  bestSrc = toAbsoluteUrl(bestSrc, base);
                  if (!result.images.includes(bestSrc)) {
                    result.images.push(bestSrc);
                  }
                }
              });
            }
          } catch (e) {
            // Ignore iframe errors
          }

          // Normalize all image URLs to absolute
          result.images = result.images.map(src => toAbsoluteUrl(src, url));

          // Deduplicate and prefer largest images (by URL length as proxy)
          result.images = Array.from(new Set(result.images)).sort((a, b) => b.length - a.length);

          // Item Specifics with Weight & Dimensions parsing (unchanged)
          const specificsContainer = document.querySelectorAll('[class*="ux-labels-values"], .ux-layout-section__row');
          specificsContainer.forEach((row) => {
            const label = row.querySelector('[class*="ux-labels-values__labels"]');
            const value = row.querySelector('[class*="ux-labels-values__values"]');
            if (label && value) {
              const labelText = label.textContent.trim().replace(':', '').trim();
              const valueText = value.textContent.trim();
              if (labelText && valueText) {
                result.itemSpecifics[labelText] = valueText;
                // Parse Weight
                if (labelText.toLowerCase().includes('weight')) {
                  const weightMatch = valueText.match(/^([\d.]+)\s*(lb|oz|pounds|ounces)?/i);
                  if (weightMatch) {
                    result.weight = parseFloat(weightMatch[1]);
                    let unit = weightMatch[2] || 'lb';
                    result.weightUnit = unit.toLowerCase().startsWith('oz') ? 'oz' : 'lb';
                  }
                }
                // Parse Dimensions (L x W x H)
                if (labelText.toLowerCase().includes('dimension') || labelText.toLowerCase().includes('size')) {
                  const dimMatch = valueText.match(/^([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i);
                  if (dimMatch) {
                    result.dimensions.length = parseFloat(dimMatch[1]);
                    result.dimensions.width = parseFloat(dimMatch[2]);
                    result.dimensions.height = parseFloat(dimMatch[3]);
                    result.dimensions.unit = 'in';
                    const unitMatch = valueText.match(/(in|inch|cm|mm|ft|feet)\b/i);
                    if (unitMatch) {
                      const detectedUnit = unitMatch[1].toLowerCase();
                      if (detectedUnit.includes('cm')) {
                        result.dimensions.unit = 'cm';
                      } else if (detectedUnit.includes('mm')) {
                        result.dimensions.unit = 'mm';
                      } else if (detectedUnit.includes('ft') || detectedUnit.includes('feet')) {
                        result.dimensions.unit = 'ft';
                      } else {
                        result.dimensions.unit = 'in';
                      }
                    }
                  }
                }
              }
            }
          });

          return result;
        }, url, sku);
        if (data && data.images && data.images.length > 0) break;
      } catch (err) {
        lastError = err;
      }
      retries++;
    }
    if (!data || !data.images || data.images.length === 0) {
      this.logger.error('Image extraction failed after retries', { url, sku, lastError: lastError ? lastError.message : undefined });
    }
    // Validate and apply fallbacks
    return this.validateData(data || {});
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

  async downloadImages(imageUrls, itemNumber, sku) {
    // Use SKU-based folder structure: data/images/{SKU}/
    // Fallback to itemNumber if SKU is not provided
    const folderName = sku || itemNumber;
    const imageFolder = path.join(this.config.output.imagePath, 'images', folderName);

    if (!fs.existsSync(imageFolder)) {
      fs.mkdirSync(imageFolder, { recursive: true });
    }

    const imagePaths = [];
    const { findOrRegisterImage } = require('../src/utils/image-deduplication');

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const imageUrl = imageUrls[i];
        const page = await this.browser.newPage();
        
        const viewSource = await page.goto(imageUrl);
        const buffer = await viewSource.buffer();
        
        const extension = imageUrl.includes('.webp') ? 'webp' : 'jpg';
        const proposedPath = path.join(imageFolder, `image_${i}.${extension}`);
        
        // Check if this image already exists (by content/perceptual hash)
        const result = await findOrRegisterImage(
          buffer, 
          proposedPath, 
          this.config.output.imagePath
        );
        
        if (result.isDuplicate) {
          // Reuse existing image, don't write to disk
          imagePaths.push(result.path);
          this.logger.info(`Reusing existing image: ${result.path}`);
        } else {
          // New image, write to disk
          fs.writeFileSync(proposedPath, buffer);
          imagePaths.push(result.path);
          this.logger.info(`Downloaded new image: ${result.path}`);
        }
        
        await page.close();
      } catch (error) {
        this.logger.warn(`Failed to download image ${i}`, { error: error.message });
      }
    }

    return imagePaths;
  }
}

module.exports = ScraperEngine;
