/**
 * Brand Content Generator for SHARD BLADE
 * Vision: "Crafted for the Wild"
 * 
 * Provides branded content templates, descriptions, and social media posts
 * that maintain consistent brand voice across all channels.
 */

const fs = require('fs');
const path = require('path');

// Load brand configuration
let brandConfig;
try {
  const configPath = path.join(__dirname, '../brand/brand-config.json');
  brandConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.warn('Brand config not found, using defaults');
  brandConfig = {
    name: 'SHARD BLADE',
    tagline: 'Crafted for the Wild',
    vision: 'Premium hand-forged blades for outdoor enthusiasts'
  };
}

/**
 * Minimal HTML escaper for interpolating plain-text values into the
 * description template below (item specifics, plain-text source copy).
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap plain-text source copy into paragraph markup so it renders with the
 * same line/paragraph breaks the seller originally wrote, instead of eBay
 * collapsing it into one run-on block of text.
 */
function textToHtmlParagraphs(text) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return '';
  return paragraphs
    .map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Generate a branded, HTML-formatted product description. eBay listing
 * descriptions render as HTML, so this outputs a self-contained block with
 * inline styles (external stylesheets never reach the listing page) instead
 * of plain text - the same content that used to rely on unicode symbols
 * (✦, ▸, ───) for "formatting" now gets real visual structure that survives
 * both the admin preview and the published eBay listing.
 */
function generateBrandedDescription(product, options = {}) {
  const {
    title = '',
    description = '',
    productGroup = 'other',
    itemSpecifics = {},
    includeSpecs = true,
    includeBrand = true
  } = product;

  const category = brandConfig.productCategories?.[productGroup] || {};
  const categoryTagline = category.tagline || '';

  // Descriptions may already be HTML (manually edited by an admin, or
  // captured from the seller's original eBay listing) - if so, use it as-is
  // (it's sanitized before it ever reaches this function); otherwise wrap
  // plain text into paragraphs so it still displays with real structure.
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(String(description || ''));
  const bodyHtml = looksLikeHtml ? description : textToHtmlParagraphs(description);

  const sections = [];

  if (includeBrand) {
    sections.push(`
      <div style="text-align:center;padding:20px 16px;background:linear-gradient(135deg,#1a4d2e 0%,#2d5016 100%);border-radius:10px 10px 0 0;">
        <h1 style="margin:0;color:#d4af37;font-size:26px;letter-spacing:3px;">${escapeHtml(brandConfig.name.toUpperCase())}</h1>
        <p style="margin:6px 0 0;color:#f5f5dc;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;">${escapeHtml(brandConfig.tagline)}</p>
      </div>`);
  }

  if (categoryTagline) {
    sections.push(`<p style="margin:16px 0 0;text-align:center;font-style:italic;color:#555;font-size:15px;">${escapeHtml(categoryTagline)}</p>`);
  }

  sections.push(`<div style="margin:20px 0;color:#333;font-size:15px;line-height:1.7;">${bodyHtml}</div>`);

  if (includeSpecs && itemSpecifics && Object.keys(itemSpecifics).length > 0) {
    const specs = [];
    if (itemSpecifics.Brand) specs.push(['Brand', itemSpecifics.Brand]);
    if (itemSpecifics['Blade Material']) specs.push(['Blade Material', itemSpecifics['Blade Material']]);
    if (itemSpecifics['Blade Type']) specs.push(['Blade Type', itemSpecifics['Blade Type']]);
    if (itemSpecifics['Blade Length']) specs.push(['Blade Length', itemSpecifics['Blade Length']]);
    if (itemSpecifics['Overall Length']) specs.push(['Overall Length', itemSpecifics['Overall Length']]);
    if (itemSpecifics['Handle Material']) specs.push(['Handle Material', itemSpecifics['Handle Material']]);
    if (itemSpecifics.Color) specs.push(['Color', itemSpecifics.Color]);
    if (itemSpecifics.Handmade) specs.push(['Handmade', itemSpecifics.Handmade]);
    if (itemSpecifics['Country/Region of Manufacture']) specs.push(['Made In', itemSpecifics['Country/Region of Manufacture']]);
    specs.push(['Condition', 'New']); // Business rule: all outbound listings are published as New condition.

    sections.push(`
      <div style="background:#f5f5dc;border:1px solid #d4af37;border-radius:8px;padding:18px 20px;margin-bottom:20px;">
        <h3 style="margin:0 0 12px;color:#1a4d2e;font-size:17px;">🗡️ Specifications</h3>
        <ul style="margin:0;padding-left:20px;color:#333;font-size:14px;">
          ${specs.map(([label, value]) => `<li style="margin-bottom:6px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`).join('')}
        </ul>
      </div>`);
  }

  const benefits = ['Hand-forged excellence', 'Premium materials', 'Built to last a lifetime', 'Authentic craftsmanship'];
  if (productGroup === 'hunting-knives') {
    benefits.push('Field-tested durability', 'Wilderness-ready performance');
  } else if (productGroup === 'kitchen-chef-sets') {
    benefits.push('Razor-sharp precision', 'Professional-grade quality');
  }

  sections.push(`
    <div style="background:#1a4d2e;border-radius:8px;padding:18px 20px;">
      <h3 style="margin:0 0 12px;color:#d4af37;font-size:17px;">⚡ The ${escapeHtml(brandConfig.name)} Promise</h3>
      <ul style="margin:0;padding-left:20px;color:#f5f5dc;font-size:14px;">
        ${benefits.map((b) => `<li style="margin-bottom:6px;">${escapeHtml(b)}</li>`).join('')}
      </ul>
    </div>`);

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:0 auto;">${sections.join('')}</div>`;
}

/**
 * Generate SEO-optimized title
 */
function generateSeoTitle(product) {
  const { title = '', productGroup = 'other' } = product;
  const category = brandConfig.productCategories?.[productGroup] || {};
  
  // Clean up existing title
  let seoTitle = title;
  
  // Add brand if not present
  if (!seoTitle.toLowerCase().includes('strapey')) {
    seoTitle = `${brandConfig.name} ${seoTitle}`;
  }
  
  // Add category keywords for SEO
  if (productGroup === 'hunting-knives' && !seoTitle.toLowerCase().includes('hunting')) {
    seoTitle += ' - Hunting Knife';
  } else if (productGroup === 'kitchen-chef-sets' && !seoTitle.toLowerCase().includes('kitchen') && !seoTitle.toLowerCase().includes('chef')) {
    seoTitle += ' - Chef Knife';
  }
  
  // Truncate to optimal length (60-70 chars for SEO)
  if (seoTitle.length > 70) {
    seoTitle = seoTitle.substring(0, 67) + '...';
  }
  
  return seoTitle;
}

/**
 * Generate WordPress blog post content for product promotion
 */
function generateWordPressPost(products, options = {}) {
  const {
    title = `Featured Products from ${brandConfig.name}`,
    includeImages = true,
    productGroup = null
  } = options;
  
  let content = [];
  
  // Hero section
  content.push(`<div style="background: linear-gradient(135deg, #1a4d2e 0%, #2d5016 100%); padding: 40px; color: #f5f5dc; text-align: center; margin-bottom: 30px;">`);
  content.push(`<h1 style="color: #d4af37; font-size: 42px; margin: 0 0 10px 0; letter-spacing: 3px;">${brandConfig.name}</h1>`);
  content.push(`<p style="font-size: 20px; letter-spacing: 2px; margin: 0; text-transform: uppercase;">${brandConfig.tagline}</p>`);
  content.push(`</div>`);
  
  // Introduction
  content.push(`<p style="font-size: 18px; line-height: 1.8; color: #333;">${brandConfig.vision}</p>`);
  
  if (productGroup && brandConfig.productCategories?.[productGroup]) {
    const category = brandConfig.productCategories[productGroup];
    content.push(`<p style="font-size: 16px; line-height: 1.8; color: #555;"><strong>${category.tagline}:</strong> ${category.description}</p>`);
  }
  
  // Products section
  content.push(`<h2 style="color: #1a4d2e; border-bottom: 2px solid #d4af37; padding-bottom: 10px; margin-top: 40px;">Featured Products</h2>`);
  
  products.forEach((product, index) => {
    const sku = product.sku || product.customLabel || `Product ${index + 1}`;
    const title = product.title || sku;
    const price = product.price ? `$${parseFloat(product.price).toFixed(2)}` : 'Price Available Soon';
    const link = product.productionLink || product.publishedLink || '#';
    const imageUrl = Array.isArray(product.imageSourceUrls) && product.imageSourceUrls[0] ? product.imageSourceUrls[0] : '';
    
    content.push(`<div style="margin: 30px 0; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fafafa;">`);
    
    if (includeImages && imageUrl) {
      content.push(`<div style="text-align: center; margin-bottom: 20px;">`);
      content.push(`<img src="${imageUrl}" alt="${title}" style="max-width: 100%; height: auto; border-radius: 8px;" />`);
      content.push(`</div>`);
    }
    
    content.push(`<h3 style="color: #1a4d2e; margin-top: 0;"><a href="${link}" target="_blank" rel="noopener" style="color: #1a4d2e; text-decoration: none;">${title}</a></h3>`);
    content.push(`<p style="font-size: 24px; color: #8b4513; font-weight: bold; margin: 10px 0;">${price}</p>`);
    
    if (product.description) {
      const shortDesc = product.description.substring(0, 200).trim();
      content.push(`<p style="color: #555; line-height: 1.6;">${shortDesc}${product.description.length > 200 ? '...' : ''}</p>`);
    }
    
    content.push(`<a href="${link}" target="_blank" rel="noopener" style="display: inline-block; background: #1a4d2e; color: #f5f5dc; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 10px;">View on eBay →</a>`);
    content.push(`</div>`);
  });
  
  // Call to action
  content.push(`<div style="background: #f5f5dc; padding: 30px; text-align: center; margin-top: 40px; border-radius: 8px; border: 2px solid #d4af37;">`);
  content.push(`<h3 style="color: #1a4d2e; margin-top: 0;">Experience the SHARD BLADE Difference</h3>`);
  content.push(`<p style="color: #555; font-size: 16px;">Hand-forged excellence • Built for the wilderness • Crafted without compromise</p>`);
  content.push(`</div>`);
  
  return content.join('\n');
}

/**
 * Generate social media post content
 */
function generateSocialPost(product, platform = 'instagram') {
  const { title = '', price, productGroup = 'other', productionLink } = product;
  const category = brandConfig.productCategories?.[productGroup] || {};
  const hashtags = brandConfig.socialMedia?.hashtags || [];
  
  let content = [];
  
  if (platform === 'instagram' || platform === 'facebook') {
    content.push(`✦ ${title} ✦\n`);
    content.push(`${category.tagline || brandConfig.tagline}\n`);
    
    if (price) {
      content.push(`💰 $${parseFloat(price).toFixed(2)}\n`);
    }
    
    content.push(`Hand-forged Damascus steel craftsmanship that stands the test of time.\n`);
    
    if (productionLink) {
      content.push(`🔗 Shop now: ${productionLink}\n`);
    }
    
    content.push(`\n${hashtags.slice(0, 10).join(' ')}`);
  } else if (platform === 'pinterest') {
    content.push(`${title}\n\n`);
    content.push(`${brandConfig.name} - ${brandConfig.tagline}\n\n`);
    content.push(`Premium hand-forged Damascus steel. Built for outdoor enthusiasts and professionals who demand excellence.\n\n`);
    
    if (productionLink) {
      content.push(`Shop: ${productionLink}`);
    }
  }
  
  return content.join('');
}

/**
 * Get brand colors for theming
 */
function getBrandColors() {
  return brandConfig.colors || {};
}

/**
 * Get brand configuration
 */
function getBrandConfig() {
  return brandConfig;
}

module.exports = {
  generateBrandedDescription,
  generateSeoTitle,
  generateWordPressPost,
  generateSocialPost,
  getBrandColors,
  getBrandConfig
};
