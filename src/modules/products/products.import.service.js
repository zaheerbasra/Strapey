/**
 * Products Import Service
 * Handles bulk import of eBay product data
 */

const fs = require('fs-extra');
const path = require('path');
const logger = require('../../core/logger')('products.import');
const { detectProductGroup, getProductGroupLabel } = require('../../utils/product-grouping');

class ProductsImportService {
  /**
   * Parse TSV/CSV data from string
   * Handles the eBay product import format
   */
  parseProductData(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('No data to import. Expected at least a header row and one data row.');
    }

    // Detect delimiter (tab or comma)
    const headerLine = lines[0];
    const delimiter = headerLine.includes('\t') ? '\t' : ',';

    // Parse header
    const headers = headerLine.split(delimiter).map(h => h.trim());
    logger.info('Detected headers:', headers);

    // Map of expected headers to field names
    const headerMap = {
      'item number': 'itemNumber',
      'link': 'link',
      'custom label (sku)': 'sku',
      'title': 'title',
      'available quantity': 'availableQuantity',
      'currency': 'currency',
      'start price': 'price',
      'ebay category 1 name': 'ebayCategory',
      'ebay category 1 number': 'ebayCategoryId',
      // Alternative header names
      'item #': 'itemNumber',
      'sku': 'sku',
      'product title': 'title',
      'quantity': 'availableQuantity',
      'price': 'price',
      'category': 'ebayCategory',
      'category id': 'ebayCategoryId',
      'category #': 'ebayCategoryId'
    };

    // Map headers to field names
    const fieldIndices = {};
    headers.forEach((header, index) => {
      const normalizedHeader = header.toLowerCase();
      const fieldName = Object.entries(headerMap).find(([key]) => 
        normalizedHeader.includes(key)
      )?.[1];
      
      if (fieldName) {
        fieldIndices[fieldName] = index;
      }
    });

    logger.info('Field mapping:', fieldIndices);

    // Parse data rows
    const products = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // Skip empty lines

      const values = line.split(delimiter).map(v => v.trim());
      const rawQuantity = values[fieldIndices.availableQuantity];
      const parsedQuantity = parseInt(rawQuantity, 10);
      const quantity = rawQuantity === undefined || rawQuantity === ''
        ? 1
        : (Number.isFinite(parsedQuantity) ? Math.max(0, parsedQuantity) : 1);
      
      const product = {
        itemNumber: values[fieldIndices.itemNumber] || null,
        link: values[fieldIndices.link] || null,
        sku: values[fieldIndices.sku] || `IMPORT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: values[fieldIndices.title] || 'Imported Product',
        availableQuantity: quantity,
        inventoryQuantity: quantity,
        currency: values[fieldIndices.currency] || 'USD',
        price: parseFloat(values[fieldIndices.price]) || 0,
        ebayCategory: values[fieldIndices.ebayCategory] || null,
        ebayCategoryId: values[fieldIndices.ebayCategoryId] || null
      };

      product.productGroup = detectProductGroup(product);
      product.productGroupLabel = getProductGroupLabel(product.productGroup);

      // Validate required fields
      if (!product.sku) {
        throw new Error(`Row ${i + 1}: SKU is required`);
      }

      products.push(product);
    }

    logger.info(`Parsed ${products.length} products from data`);
    return products;
  }

  /**
   * Detect if product fields have changed (for change detection)
   */
  hasProductChanged(existingProduct, newProduct) {
    const fieldsToCompare = [
      'title', 'price', 'availableQuantity', 'currency', 
      'ebayCategory', 'ebayCategoryId', 'itemNumber'
    ];
    
    for (const field of fieldsToCompare) {
      const existingValue = existingProduct[field];
      const newValue = newProduct[field];
      
      // Skip if new value is null/undefined (not provided in import)
      if (newValue === null || newValue === undefined || newValue === '') continue;
      
      // Compare values (handle type differences)
      if (String(existingValue) !== String(newValue)) {
        logger.debug(`Field changed: ${field}`, { 
          old: existingValue, 
          new: newValue,
          sku: newProduct.sku 
        });
        return true;
      }
    }
    
    return false;
  }

  /**
   * Find existing product by multiple keys (link, url, sku, itemNumber)
   */
  findExistingProduct(allData, product) {
    // Try by link/url first (most reliable)
    if (product.link) {
      const byLink = allData[product.link];
      if (byLink) return { key: product.link, product: byLink };
    }
    
    // Try to find by SKU or itemNumber in existing data
    for (const [key, existing] of Object.entries(allData)) {
      // Match by itemNumber if both have it
      if (product.itemNumber && existing.itemNumber && 
          String(product.itemNumber) === String(existing.itemNumber)) {
        logger.debug('Found by itemNumber', { itemNumber: product.itemNumber, key });
        return { key, product: existing };
      }
      
      // Match by SKU if both have it
      if (product.sku && existing.sku && 
          String(product.sku).toLowerCase() === String(existing.sku).toLowerCase()) {
        logger.debug('Found by SKU', { sku: product.sku, key });
        return { key, product: existing };
      }
    }
    
    return null;
  }

  /**
   * Import products from parsed data with intelligent upsert logic
   * Only updates products if changes are detected, preserves all existing products
   */
  async importProducts(productData, options = {}) {
    const {
      updateExisting = true,  // If true, update products with same SKU/itemNumber
      keepScrapedData = true  // If true, keep scraped data if import doesn't provide it
    } = options;

    const results = {
      created: [],
      updated: [],
      skipped: [],  // Products that exist but have no changes
      failed: [],
      total: productData.length
    };

    // Use data.json for now (legacy storage)
    const DATA_FILE_PATH = path.join(__dirname, '../../../data/data.json');
    let allData = {};
    
    if (fs.existsSync(DATA_FILE_PATH)) {
      allData = fs.readJsonSync(DATA_FILE_PATH);
      logger.info(`Loaded ${Object.keys(allData).length} existing products from database`);
    }
    
    const initialProductCount = Object.keys(allData).length;

    logger.info(`Starting import of ${productData.length} products with updateExisting=${updateExisting}, keepScrapedData=${keepScrapedData}`);

    // Helper to map images from disk if missing
    function getImagesForSku(sku) {
      if (!sku) return [];
      const imagesDir = path.join(__dirname, '../../../data/images', sku);
      if (!fs.existsSync(imagesDir)) return [];
      const files = fs.readdirSync(imagesDir).filter(f =>
        /\.(jpe?g|png|webp|gif|bmp)$/i.test(f)
      );
      return files.map(f => `/images/${sku}/${f}`);
    }

    for (const product of productData) {
      try {
        // Find existing product by link, itemNumber, or SKU
        const found = this.findExistingProduct(allData, product);
        
        if (found && updateExisting) {
          const { key: productKey, product: existingProduct } = found;
          // Check if product has actually changed
          if (!this.hasProductChanged(existingProduct, product)) {
            logger.debug('Product unchanged, skipping update', { sku: product.sku, itemNumber: product.itemNumber });
            results.skipped.push({
              sku: product.sku,
              itemNumber: product.itemNumber,
              reason: 'No changes detected'
            });
            continue;
          }
          // Update existing product - merge new data while preserving scraped content
          let mergedImages = existingProduct.images || [];
          if ((!mergedImages || mergedImages.length === 0) && product.sku) {
            mergedImages = getImagesForSku(product.sku);
          }
          const updatedProduct = {
            ...existingProduct,
            // Update with new import data (only if provided)
            itemNumber: product.itemNumber || existingProduct.itemNumber,
            sku: product.sku || existingProduct.sku,
            title: product.title || existingProduct.title,
            price: product.price !== undefined ? product.price : existingProduct.price,
            availableQuantity: product.availableQuantity !== undefined ? product.availableQuantity : existingProduct.availableQuantity,
            inventoryQuantity: product.availableQuantity !== undefined ? product.availableQuantity : (existingProduct.inventoryQuantity ?? existingProduct.availableQuantity),
            currency: product.currency || existingProduct.currency,
            // eBay category is CRITICAL - always update if provided
            ebayCategory: product.ebayCategory || existingProduct.ebayCategory,
            ebayCategoryId: product.ebayCategoryId || existingProduct.ebayCategoryId,
            productGroup: product.productGroup || existingProduct.productGroup || detectProductGroup({ ...existingProduct, ...product }),
            productGroupLabel: getProductGroupLabel(product.productGroup || existingProduct.productGroup || detectProductGroup({ ...existingProduct, ...product })),
            // CRITICAL: Keep all scraped data (description, images, specifics)
            description: existingProduct.description || '',
            images: mergedImages,
            imagesOriginal: existingProduct.imagesOriginal || [],
            itemSpecifics: existingProduct.itemSpecifics || {},
            // Preserve additional scraped metadata
            condition: existingProduct.condition,
            conditionDisplay: existingProduct.conditionDisplay,
            format: existingProduct.format,
            variationDetails: existingProduct.variationDetails,
            imageSourceUrls: existingProduct.imageSourceUrls,
            imageValidationLog: existingProduct.imageValidationLog,
            // Update the URL/link if provided in import
            url: product.link || existingProduct.url || existingProduct.link,
            link: product.link || existingProduct.link || existingProduct.url,
            // Metadata
            importedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            source: 'bulk-import-update'
          };
          // Use the correct key (prefer URL over sku-based key)
          const finalKey = product.link || productKey;
          allData[finalKey] = updatedProduct;
          // If key changed (e.g., link was added), remove old key
          if (finalKey !== productKey) {
            logger.info('Product key changed, removing old key', { oldKey: productKey, newKey: finalKey });
            delete allData[productKey];
          }
          results.updated.push({
            sku: product.sku,
            itemNumber: product.itemNumber,
            category: product.ebayCategory,
            categoryId: product.ebayCategoryId,
            productGroup: updatedProduct.productGroup
          });
          logger.info('Product updated', { sku: product.sku, itemNumber: product.itemNumber });
        } else if (!found) {
          // Create new product
          const productKey = product.link || `sku:${product.sku}`;
          let newImages = [];
          if (product.sku) {
            newImages = getImagesForSku(product.sku);
          }
          const newProduct = {
            itemNumber: product.itemNumber,
            sku: product.sku,
            title: product.title,
            description: '',
            price: product.price,
            availableQuantity: product.availableQuantity,
            inventoryQuantity: product.availableQuantity,
            currency: product.currency,
            ebayCategory: product.ebayCategory,
            ebayCategoryId: product.ebayCategoryId,
            productGroup: product.productGroup || detectProductGroup(product),
            productGroupLabel: getProductGroupLabel(product.productGroup || detectProductGroup(product)),
            images: newImages,
            itemSpecifics: {},
            url: product.link || '',
            link: product.link || '',
            importedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            source: 'bulk-import-new'
          };
          allData[productKey] = newProduct;
          results.created.push({
            sku: product.sku,
            itemNumber: product.itemNumber,
            category: product.ebayCategory,
            categoryId: product.ebayCategoryId,
            productGroup: newProduct.productGroup
          });
          logger.info('New product created', { sku: product.sku, itemNumber: product.itemNumber, key: productKey });
        } else {
          // Product exists but updateExisting is false
          logger.debug('Product exists but updateExisting=false, skipping', { sku: product.sku });
          results.skipped.push({
            sku: product.sku,
            itemNumber: product.itemNumber,
            reason: 'Exists but updateExisting=false'
          });
        }
      } catch (error) {
        results.failed.push({
          sku: product.sku,
          error: error.message
        });
        logger.error(`Failed to import product: ${product.sku}`, error);
      }
    }

    const finalProductCount = Object.keys(allData).length;

    // Save to data.json - CRITICAL: This writes ALL products (existing + new/updated)
    fs.writeJsonSync(DATA_FILE_PATH, allData, { spaces: 2 });
    
    logger.info('Import completed', {
      total: results.total,
      created: results.created.length,
      updated: results.updated.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
      initialCount: initialProductCount,
      finalCount: finalProductCount,
      productsPreserved: finalProductCount >= initialProductCount ? '✓' : '✗ WARNING: Products lost!'
    });

    return results;
  }

  /**
   * Get import template with example format
   */
  getImportTemplate() {
    return `Item number\tLink\tCustom label (SKU)\tTitle\tAvailable quantity\tCurrency\tStart price\teBay category 1 name\teBay category 1 number
304569312160\thttps://www.ebay.com/itm/304569312160\tUSL\t1911 Classic Wood Grips Full Size W/ Screws Embossed U.S. fits Springfield Colt\t4\tUSD\t23.28\tPistol Parts\t73944
302710852493\thttps://www.ebay.com/itm/302710852493\tRD-Bar\t10X2 HAND FORGED DAMASCUS STEEL Annealed Billet/Bar Knife Making Supply Any Tool\t6\tUSD\t29.99\tCustom & Handmade\t43325
304053796929\thttps://www.ebay.com/itm/304053796929\tLD-Bar\t10X2" HAND FORGED DAMASCUS STEEL Billet/Bar Knife Making Supply Ladder Patterns\t0\tUSD\t29.99\tCustom & Handmade\t43325`;
  }
}

module.exports = new ProductsImportService();
