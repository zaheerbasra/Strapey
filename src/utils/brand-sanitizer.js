/**
 * Brand Sanitizer for Strapey
 * Removes competitor/source brand names and replaces with Strapey branding
 */

/**
 * List of brand names to remove from scraped content
 */
const BRANDS_TO_REMOVE = [
  'SHARD BLADE',
  'SHARDBLADE',
  'SHARD',
  'SHARD™',
  'SHARD®',
  'SHARD ®',
  'SHARD ™',
  'SCD', // Another brand in the catalog
];

/**
 * Remove competitor brand names from text and optionally replace with Strapey
 * @param {string} text - Text to sanitize
 * @param {Object} options - Sanitization options
 * @returns {string} - Sanitized text
 */
function sanitizeBrandNames(text, options = {}) {
  const {
    replaceWithStrapey = true,
    preserveContext = true // Keep surrounding text meaningful
  } = options;

  if (!text || typeof text !== 'string') {
    return text || '';
  }

  let sanitized = text;

  // Remove each brand name
  BRANDS_TO_REMOVE.forEach(brand => {
    // Case-insensitive replacement
    const regex = new RegExp(`\\b${escapeRegex(brand)}\\b`, 'gi');
    
    if (replaceWithStrapey) {
      // Replace with Strapey, maintaining case pattern if possible
      sanitized = sanitized.replace(regex, (match) => {
        // If original was all caps, make Strapey all caps
        if (match === match.toUpperCase()) {
          return 'STRAPEY';
        }
        // Otherwise use normal case
        return 'Strapey';
      });
    } else {
      // Just remove the brand name
      sanitized = sanitized.replace(regex, '');
    }
  });

  // Clean up any double spaces or awkward spacing
  sanitized = sanitized
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();

  return sanitized;
}

/**
 * Sanitize product title - remove brands and add Strapey if not present
 */
function sanitizeTitle(title) {
  if (!title || typeof title !== 'string') {
    return title || '';
  }

  // Remove competitor brands
  let sanitized = sanitizeBrandNames(title, { replaceWithStrapey: false });

  // Add Strapey at the beginning if not already present
  if (!sanitized.toLowerCase().includes('strapey')) {
    sanitized = `Strapey ${sanitized}`;
  }

  // Clean up and return
  return sanitized
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Sanitize product description - remove brands and add Strapey context
 */
function sanitizeDescription(description) {
  if (!description || typeof description !== 'string') {
    return description || '';
  }

  // Remove competitor brands and replace with Strapey
  let sanitized = sanitizeBrandNames(description, { replaceWithStrapey: true });

  return sanitized;
}

/**
 * Sanitize item specifics object
 */
function sanitizeItemSpecifics(itemSpecifics) {
  if (!itemSpecifics || typeof itemSpecifics !== 'object') {
    return itemSpecifics || {};
  }

  const sanitized = { ...itemSpecifics };

  // Update Brand field to Strapey
  if (sanitized.Brand || sanitized.brand) {
    sanitized.Brand = 'Strapey';
    delete sanitized.brand;
  }

  // Sanitize any text fields that might contain competitor brands
  Object.keys(sanitized).forEach(key => {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = sanitizeBrandNames(sanitized[key], { replaceWithStrapey: true });
    }
  });

  return sanitized;
}

/**
 * Sanitize entire product object
 */
function sanitizeProduct(product) {
  if (!product || typeof product !== 'object') {
    return product || {};
  }

  const sanitized = { ...product };

  // Sanitize title
  if (sanitized.title) {
    sanitized.title = sanitizeTitle(sanitized.title);
  }

  // Sanitize description
  if (sanitized.description) {
    sanitized.description = sanitizeDescription(sanitized.description);
  }

  // Sanitize item specifics
  if (sanitized.itemSpecifics) {
    sanitized.itemSpecifics = sanitizeItemSpecifics(sanitized.itemSpecifics);
  }

  // Ensure brand is set to Strapey
  if (!sanitized.itemSpecifics) {
    sanitized.itemSpecifics = {};
  }
  sanitized.itemSpecifics.Brand = 'Strapey';

  return sanitized;
}

/**
 * Helper to escape regex special characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  sanitizeBrandNames,
  sanitizeTitle,
  sanitizeDescription,
  sanitizeItemSpecifics,
  sanitizeProduct,
  BRANDS_TO_REMOVE
};
