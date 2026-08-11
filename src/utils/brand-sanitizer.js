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
 * Remove trademark symbols used in listing copy.
 */
function stripTrademarkSymbols(text) {
  if (!text || typeof text !== 'string') {
    return text || '';
  }

  return text
    .replace(/[™®]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Tags that must never survive into a stored/displayed description - they can
 * execute code (script, event handlers via inline attributes) or pull in
 * external resources we don't control (iframe/object/embed/form/link/meta).
 * Descriptions can come from admin edits or scraped third-party eBay listings,
 * and are later rendered with innerHTML in the admin UI, so untrusted markup
 * has to be stripped before it's ever saved.
 */
const HTML_DISALLOWED_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'noscript', 'svg', 'math'
];

/**
 * Strip dangerous tags/attributes from an HTML description while preserving
 * ordinary formatting markup (bold/italic/lists/headings/tables/images/links/
 * inline styles). This is a pragmatic denylist-based pass (no HTML parser
 * dependency), not a full HTML sanitizer - good enough for content edited by
 * trusted admin users or scraped from eBay, rendered only in our own admin UI.
 */
function sanitizeDescriptionHtml(html) {
  if (!html || typeof html !== 'string') {
    return html || '';
  }

  let sanitized = html;

  // Remove disallowed tags together with their contents (script/style bodies
  // are never safe to keep even as text).
  HTML_DISALLOWED_TAGS.forEach((tag) => {
    const pairPattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    sanitized = sanitized.replace(pairPattern, '');
    const selfClosingPattern = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    sanitized = sanitized.replace(selfClosingPattern, '');
  });

  // Strip HTML comments (can hide markup or be used for legacy conditional-
  // comment based exploits).
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // Strip inline event-handler attributes (onclick=, onerror=, onload=, ...).
  sanitized = sanitized.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Neutralize javascript:/vbscript: URIs on href/src.
  sanitized = sanitized.replace(
    /\s(href|src)\s*=\s*("|')\s*(javascript|vbscript):[^"']*\2/gi,
    ''
  );

  return sanitized.trim();
}

/**
 * Sanitize product title - remove competitor brands only. Does not force-add
 * or remove "Strapey" - that's a content decision left to the caller/editor,
 * not something this function should silently override on every save.
 */
function sanitizeTitle(title) {
  if (!title || typeof title !== 'string') {
    return title || '';
  }

  // Remove competitor brands
  let sanitized = sanitizeBrandNames(title, { replaceWithStrapey: false });

  // Clean up and return
  return stripTrademarkSymbols(sanitized);
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

  return stripTrademarkSymbols(sanitized);
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
    sanitized.description = sanitizeDescriptionHtml(sanitizeDescription(sanitized.description));
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
  stripTrademarkSymbols,
  sanitizeTitle,
  sanitizeDescription,
  sanitizeDescriptionHtml,
  sanitizeItemSpecifics,
  sanitizeProduct,
  BRANDS_TO_REMOVE
};
