const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { applyProductGroup, getProductGroupLabel, isPistolGripGroup } = require('../utils/product-grouping');
const { generateWordPressPost, generateBrandedDescription, getBrandConfig } = require('../utils/brand-content');

function safeBaseUrl() {
  return String(process.env.WP_BASE_URL || 'https://strapey.com').replace(/\/+$/, '');
}

function getWpAuthHeader() {
  const username = String(process.env.WP_USERNAME || '').trim();
  const appPassword = String(process.env.WP_APP_PASSWORD || '').trim();
  if (!username || !appPassword) return null;
  const token = Buffer.from(`${username}:${appPassword}`).toString('base64');
  return `Basic ${token}`;
}

function getWooConsumerAuthParams() {
  const key = String(process.env.WC_CONSUMER_KEY || '').trim();
  const secret = String(process.env.WC_CONSUMER_SECRET || '').trim();
  if (!key || !secret) return null;
  return { consumer_key: key, consumer_secret: secret };
}

function assertWpConfig() {
  const authHeader = getWpAuthHeader();
  if (!authHeader) {
    throw new Error('Missing WP credentials. Set WP_USERNAME and WP_APP_PASSWORD in .env.');
  }
  return { baseUrl: safeBaseUrl(), authHeader };
}

function assertWooConfig() {
  const baseUrl = safeBaseUrl();
  const authHeader = getWpAuthHeader();
  const consumerAuth = getWooConsumerAuthParams();

  if (!authHeader && !consumerAuth) {
    throw new Error('Missing WooCommerce credentials. Set WC_CONSUMER_KEY/WC_CONSUMER_SECRET or WP_USERNAME/WP_APP_PASSWORD.');
  }

  return { baseUrl, authHeader, consumerAuth };
}

function normalizeSku(value) {
  return String(value || '').trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function sanitizePlainText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHtml(value) {
  let html = String(value || '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<\/?span[^>]*>/gi, '');
  html = html.replace(/<p>\s*<\/p>/gi, '');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

function parseLocalProducts(dataFilePath) {
  const allData = fs.existsSync(dataFilePath) ? fs.readJsonSync(dataFilePath) : {};
  const entries = Object.entries(allData).map(([key, product]) => ({ key, product: product || {} }));
  return { allData, entries };
}

function getImageUrls(product) {
  const source = Array.isArray(product.imageSourceUrls) && product.imageSourceUrls.length > 0
    ? product.imageSourceUrls
    : (Array.isArray(product.images) ? product.images : []);
  return source.filter((x) => String(x || '').startsWith('http')).slice(0, 8);
}

function getNumericPrice(product) {
  const parsed = Number(product.price);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
}

function requiredProductGaps(product) {
  const gaps = [];
  const sku = normalizeSku(product.sku || product.customLabel);
  const price = getNumericPrice(product);
  if (!sku) gaps.push('sku');
  if (!product.title) gaps.push('title');
  if (!price) gaps.push('price');
  if (!product.description) gaps.push('description');
  if (getImageUrls(product).length === 0) gaps.push('imageSourceUrls');
  return gaps;
}

async function wpRequest({ method, endpoint, params, data, timeout = 60000 }) {
  const { baseUrl, authHeader } = assertWpConfig();
  const url = `${baseUrl}/wp-json/wp/v2${endpoint}`;
  const response = await axios({
    method,
    url,
    params,
    data,
    timeout,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json'
    }
  });
  return response.data;
}

async function wooRequest({ method, endpoint, params, data, timeout = 60000 }) {
  const { baseUrl, authHeader, consumerAuth } = assertWooConfig();
  const url = `${baseUrl}/wp-json/wc/v3${endpoint}`;
  const mergedParams = { ...(params || {}) };
  if (consumerAuth) {
    mergedParams.consumer_key = consumerAuth.consumer_key;
    mergedParams.consumer_secret = consumerAuth.consumer_secret;
  }

  const response = await axios({
    method,
    url,
    params: mergedParams,
    data,
    timeout,
    headers: {
      ...(authHeader ? { Authorization: authHeader } : {}),
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

async function findWooProductBySku(sku) {
  const norm = normalizeSku(sku);
  if (!norm) return null;
  const items = await wooRequest({ method: 'GET', endpoint: '/products', params: { sku: norm, per_page: 50 } });
  if (!Array.isArray(items) || !items.length) return null;
  return items.find((p) => normalizeSku(p.sku) === norm) || items[0];
}

function buildWooPayloadFromLocal(product, status = 'publish') {
  const sku = normalizeSku(product.sku || product.customLabel);
  const price = getNumericPrice(product);
  const imageUrls = getImageUrls(product);
  const ebayLink = String(product.productionLink || '').trim();
  const baseDescription = cleanHtml(product.description || '');
  const ebayCtaHtml = ebayLink
    ? `<p><a href="${ebayLink}" target="_blank" rel="noopener nofollow">Buy on eBay</a></p>`
    : '';
  const description = [baseDescription, ebayCtaHtml].filter(Boolean).join('\n');
  const shortText = sanitizePlainText(product.description || '').slice(0, 200);
  const shortDescription = ebayLink
    ? `${shortText}${shortText ? ' ' : ''}Buy on eBay: ${ebayLink}`.slice(0, 240)
    : shortText;

  return {
    name: String(product.title || '').slice(0, 160),
    type: 'simple',
    status: status === 'draft' ? 'draft' : 'publish',
    sku,
    regular_price: String(price),
    description,
    short_description: shortDescription,
    images: imageUrls.map((src) => ({ src })),
    meta_data: [
      { key: '_strapey_source_item_number', value: product.itemNumber || '' },
      { key: '_strapey_ebay_prod_link', value: product.productionLink || '' },
      { key: '_strapey_ebay_prod_listing_id', value: product.productionListingId || '' }
    ]
  };
}

function buildSeoArticle(product, options = {}) {
  const sku = normalizeSku(product.sku || product.customLabel);
  const title = sanitizePlainText(product.title || sku || 'Product');
  const description = sanitizePlainText(product.description || '');
  const keywords = Array.isArray(product.seoKeywords) ? product.seoKeywords.slice(0, 8) : [];
  const price = getNumericPrice(product);
  const ebayLink = product.productionLink || '';
  const includeEbayLink = options.includeEbayLink !== false;

  const bullets = [
    `<li><strong>SKU:</strong> ${sku || 'N/A'}</li>`,
    `<li><strong>Condition:</strong> ${sanitizePlainText(product.conditionDisplay || product.condition || 'New')}</li>`,
    `<li><strong>Price:</strong> ${price ? `$${price.toFixed(2)}` : 'N/A'}</li>`
  ].join('');

  const keywordLine = keywords.length ? `<p><em>Keywords:</em> ${keywords.join(', ')}</p>` : '';
  const ebayCta = includeEbayLink && ebayLink
    ? `<p><a href="${ebayLink}" target="_blank" rel="noopener nofollow">View this item on eBay</a></p>`
    : '';

  return {
    title: `Buying Guide: ${title}`.slice(0, 150),
    slug: slugify(`guide-${sku || title}`),
    excerpt: `${title} buying guide, product highlights, and care tips.`.slice(0, 260),
    content: [
      `<h2>${title}</h2>`,
      `<p>${description || 'This product is selected for quality, durability, and practical use.'}</p>`,
      `<h3>Product Highlights</h3>`,
      `<ul>${bullets}</ul>`,
      `<h3>What Makes This Product Worth Buying</h3>`,
      `<p>This item is chosen from high-demand catalog data and optimized for clear product information, reliable pricing, and fast buyer decision-making.</p>`,
      keywordLine,
      ebayCta
    ].filter(Boolean).join('\n')
  };
}

async function withApiError(res, fn) {
  try {
    return await fn();
  } catch (error) {
    const status = error?.response?.status || 500;
    const details = error?.response?.data || { message: error.message };
    return res.status(status).json({ success: false, error: 'WordPress integration error', details });
  }
}

function pickProducts(entries, options = {}) {
  const skus = Array.isArray(options.skus) ? new Set(options.skus.map(normalizeSku).filter(Boolean)) : null;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : null;

  let rows = entries;
  if (skus && skus.size > 0) {
    rows = rows.filter(({ product }) => skus.has(normalizeSku(product.sku || product.customLabel)));
  }
  if (limit) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

function shouldExcludeFromWordpress(product, options = {}) {
  if (options.includePistolGrips === true) {
    return false;
  }
  return isPistolGripGroup(product);
}

function registerWordpressIntegrationRoutes(app, deps = {}) {
  const dataFilePath = deps.DATA_FILE_PATH || path.join('data', 'data.json');

  app.get('/api/wordpress/preflight', async (req, res) => {
    return withApiError(res, async () => {
      const wpConfigured = !!getWpAuthHeader();
      const wooConfigured = !!(getWooConsumerAuthParams() || getWpAuthHeader());

      let wpConnected = false;
      let wooConnected = false;

      if (wpConfigured) {
        try {
          const me = await wpRequest({ method: 'GET', endpoint: '/users/me' });
          wpConnected = !!me?.id;
        } catch {
          wpConnected = false;
        }
      }

      if (wooConfigured) {
        try {
          const products = await wooRequest({ method: 'GET', endpoint: '/products', params: { per_page: 1 } });
          wooConnected = Array.isArray(products);
        } catch {
          wooConnected = false;
        }
      }

      return res.json({
        success: true,
        baseUrl: safeBaseUrl(),
        configured: { wpConfigured, wooConfigured },
        connected: { wpConnected, wooConnected }
      });
    });
  });

  app.post('/api/wordpress/products/sync-missing', async (req, res) => {
    return withApiError(res, async () => {
      const { allData, entries } = parseLocalProducts(dataFilePath);
      const dryRun = req.body?.dryRun !== false;
      const publishStatus = req.body?.publishStatus === 'draft' ? 'draft' : 'publish';
      const selected = pickProducts(entries, req.body || {});
      const results = [];

      for (const row of selected) {
        const product = applyProductGroup(row.product);
        allData[row.key] = { ...(allData[row.key] || {}), ...product };
        const sku = normalizeSku(product.sku || product.customLabel);

        if (shouldExcludeFromWordpress(product, req.body || {})) {
          results.push({
            sku,
            status: 'excluded_product_group',
            productGroup: product.productGroup,
            productGroupLabel: getProductGroupLabel(product.productGroup)
          });
          continue;
        }

        const gaps = requiredProductGaps(product);

        if (gaps.length > 0) {
          results.push({ sku, status: 'missing_required_data', missing: gaps });
          continue;
        }

        const existing = await findWooProductBySku(sku);
        if (existing) {
          results.push({ sku, status: 'already_exists', wordpressProductId: existing.id, permalink: existing.permalink || null });
          continue;
        }

        const payload = buildWooPayloadFromLocal(product, publishStatus);
        if (dryRun) {
          results.push({ sku, status: 'would_create', payloadPreview: { name: payload.name, regular_price: payload.regular_price, status: payload.status } });
          continue;
        }

        const created = await wooRequest({ method: 'POST', endpoint: '/products', data: payload });
        allData[row.key].wordpressProductId = created.id;
        allData[row.key].wordpressPermalink = created.permalink || null;
        allData[row.key].wordpressSyncedAt = new Date().toISOString();

        results.push({ sku, status: 'created', wordpressProductId: created.id, permalink: created.permalink || null });
      }

      if (!dryRun) {
        fs.writeJsonSync(dataFilePath, allData, { spaces: 2 });
      }

      const summary = results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      return res.json({ success: true, dryRun, total: selected.length, summary, results });
    });
  });

  app.post('/api/wordpress/products/sync-pricing', async (req, res) => {
    return withApiError(res, async () => {
      const { allData, entries } = parseLocalProducts(dataFilePath);
      const dryRun = req.body?.dryRun !== false;
      const selected = pickProducts(entries, req.body || {});
      const results = [];

      for (const row of selected) {
        const product = applyProductGroup(row.product);
        allData[row.key] = { ...(allData[row.key] || {}), ...product };
        const sku = normalizeSku(product.sku || product.customLabel);
        const localPrice = getNumericPrice(product);

        if (shouldExcludeFromWordpress(product, req.body || {})) {
          results.push({
            sku,
            status: 'excluded_product_group',
            productGroup: product.productGroup,
            productGroupLabel: getProductGroupLabel(product.productGroup)
          });
          continue;
        }

        if (!sku || !localPrice) {
          results.push({ sku, status: 'missing_required_data', missing: ['sku_or_price'] });
          continue;
        }

        const existing = await findWooProductBySku(sku);
        if (!existing) {
          results.push({ sku, status: 'not_found_in_wordpress' });
          continue;
        }

        const remotePrice = Number(existing.regular_price);
        if (Number.isFinite(remotePrice) && remotePrice === localPrice) {
          results.push({ sku, status: 'unchanged', wordpressProductId: existing.id, price: localPrice });
          continue;
        }

        if (dryRun) {
          results.push({ sku, status: 'would_update_price', wordpressProductId: existing.id, from: existing.regular_price, to: String(localPrice) });
          continue;
        }

        const updated = await wooRequest({
          method: 'PUT',
          endpoint: `/products/${existing.id}`,
          data: { regular_price: String(localPrice) }
        });

        allData[row.key].wordpressProductId = updated.id;
        allData[row.key].wordpressPriceSyncedAt = new Date().toISOString();

        results.push({ sku, status: 'price_updated', wordpressProductId: updated.id, from: existing.regular_price, to: updated.regular_price });
      }

      if (!dryRun) {
        fs.writeJsonSync(dataFilePath, allData, { spaces: 2 });
      }

      const summary = results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      return res.json({ success: true, dryRun, total: selected.length, summary, results });
    });
  });

  app.post('/api/wordpress/products/sync-ebay-links', async (req, res) => {
    return withApiError(res, async () => {
      const { allData, entries } = parseLocalProducts(dataFilePath);
      const dryRun = req.body?.dryRun !== false;
      const selected = pickProducts(entries, req.body || {});
      const results = [];

      for (const row of selected) {
        const product = applyProductGroup(row.product);
        allData[row.key] = { ...(allData[row.key] || {}), ...product };
        const sku = normalizeSku(product.sku || product.customLabel);
        const ebayLink = String(product.productionLink || '').trim();

        if (shouldExcludeFromWordpress(product, req.body || {})) {
          results.push({
            sku,
            status: 'excluded_product_group',
            productGroup: product.productGroup,
            productGroupLabel: getProductGroupLabel(product.productGroup)
          });
          continue;
        }

        if (!sku) {
          results.push({ sku, status: 'missing_sku' });
          continue;
        }

        if (!ebayLink) {
          results.push({ sku, status: 'missing_production_link' });
          continue;
        }

        const existing = await findWooProductBySku(sku);
        if (!existing) {
          results.push({ sku, status: 'not_found_in_wordpress' });
          continue;
        }

        const currentDescription = cleanHtml(existing.description || '');
        const ctaPattern = /<p><a href="[^"]+" target="_blank" rel="noopener nofollow">Buy on eBay<\/a><\/p>/i;
        const ctaHtml = `<p><a href="${ebayLink}" target="_blank" rel="noopener nofollow">Buy on eBay</a></p>`;
        const nextDescription = ctaPattern.test(currentDescription)
          ? currentDescription.replace(ctaPattern, ctaHtml)
          : [currentDescription, ctaHtml].filter(Boolean).join('\n');

        const shortText = sanitizePlainText(existing.short_description || existing.description || '').replace(/Buy on eBay:\s*https?:\/\/\S+/gi, '').trim();
        const nextShortDescription = `${shortText}${shortText ? ' ' : ''}Buy on eBay: ${ebayLink}`.slice(0, 240);

        if (dryRun) {
          results.push({ sku, status: 'would_update_ebay_link', wordpressProductId: existing.id, ebayLink });
          continue;
        }

        await wooRequest({
          method: 'PUT',
          endpoint: `/products/${existing.id}`,
          data: {
            description: nextDescription,
            short_description: nextShortDescription,
            meta_data: [
              { key: '_strapey_ebay_prod_link', value: ebayLink },
              { key: '_strapey_ebay_prod_listing_id', value: product.productionListingId || '' }
            ]
          }
        });

        allData[row.key].wordpressProductId = existing.id;
        allData[row.key].wordpressEbayLinkSyncedAt = new Date().toISOString();

        results.push({ sku, status: 'ebay_link_updated', wordpressProductId: existing.id, ebayLink });
      }

      if (!dryRun) {
        fs.writeJsonSync(dataFilePath, allData, { spaces: 2 });
      }

      const summary = results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      return res.json({ success: true, dryRun, total: selected.length, summary, results });
    });
  });

  app.post('/api/wordpress/content/cleanup', async (req, res) => {
    return withApiError(res, async () => {
      const dryRun = req.body?.dryRun !== false;
      const limit = Number(req.body?.limit || 50);
      const target = String(req.body?.target || 'both');
      const results = [];

      if (target === 'products' || target === 'both') {
        const products = await wooRequest({ method: 'GET', endpoint: '/products', params: { per_page: Math.min(limit, 100), page: 1 } });
        for (const product of products) {
          const cleanedDescription = cleanHtml(product.description || '');
          const cleanedShort = cleanHtml(product.short_description || '');
          const changed = cleanedDescription !== String(product.description || '') || cleanedShort !== String(product.short_description || '');
          if (!changed) continue;

          if (!dryRun) {
            await wooRequest({
              method: 'PUT',
              endpoint: `/products/${product.id}`,
              data: { description: cleanedDescription, short_description: cleanedShort }
            });
          }

          results.push({
            type: 'product',
            id: product.id,
            sku: product.sku || null,
            status: dryRun ? 'would_clean' : 'cleaned'
          });
        }
      }

      if (target === 'posts' || target === 'both') {
        const posts = await wpRequest({ method: 'GET', endpoint: '/posts', params: { per_page: Math.min(limit, 100), page: 1, context: 'edit' } });
        for (const post of posts) {
          const rawContent = String(post?.content?.raw || post?.content?.rendered || '');
          const cleaned = cleanHtml(rawContent);
          if (cleaned === rawContent) continue;

          if (!dryRun) {
            await wpRequest({ method: 'PUT', endpoint: `/posts/${post.id}`, data: { content: cleaned } });
          }

          results.push({
            type: 'post',
            id: post.id,
            slug: post.slug,
            status: dryRun ? 'would_clean' : 'cleaned'
          });
        }
      }

      const summary = results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      return res.json({ success: true, dryRun, target, summary, results });
    });
  });

  app.post('/api/wordpress/articles/publish-seo', async (req, res) => {
    return withApiError(res, async () => {
      const { entries } = parseLocalProducts(dataFilePath);
      const dryRun = req.body?.dryRun !== false;
      const selected = pickProducts(entries, req.body || {});
      const publishStatus = req.body?.publishStatus === 'publish' ? 'publish' : 'draft';
      const includeEbayLink = req.body?.includeEbayLink !== false;
      const results = [];

      for (const row of selected) {
        const product = applyProductGroup(row.product);
        const sku = normalizeSku(product.sku || product.customLabel);

        if (shouldExcludeFromWordpress(product, req.body || {})) {
          results.push({
            sku,
            status: 'excluded_product_group',
            productGroup: product.productGroup,
            productGroupLabel: getProductGroupLabel(product.productGroup)
          });
          continue;
        }

        if (!sku || !product.title) {
          results.push({ sku, status: 'missing_required_data', missing: ['sku_or_title'] });
          continue;
        }

        const article = buildSeoArticle(product, { includeEbayLink });
        const existing = await wpRequest({ method: 'GET', endpoint: '/posts', params: { slug: article.slug, per_page: 1, context: 'edit' } });
        if (Array.isArray(existing) && existing.length > 0) {
          results.push({ sku, status: 'article_exists', postId: existing[0].id, slug: article.slug });
          continue;
        }

        if (dryRun) {
          results.push({ sku, status: 'would_create_article', slug: article.slug, title: article.title });
          continue;
        }

        const created = await wpRequest({
          method: 'POST',
          endpoint: '/posts',
          data: {
            title: article.title,
            slug: article.slug,
            status: publishStatus,
            excerpt: article.excerpt,
            content: article.content
          }
        });

        results.push({ sku, status: 'article_created', postId: created.id, slug: created.slug, link: created.link || null });
      }

      const summary = results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      return res.json({ success: true, dryRun, publishStatus, summary, results });
    });
  });

  app.post('/api/wordpress/promotions/share-ebay-links', async (req, res) => {
    return withApiError(res, async () => {
      const { entries } = parseLocalProducts(dataFilePath);
      const dryRun = req.body?.dryRun !== false;
      const publishStatus = req.body?.publishStatus === 'publish' ? 'publish' : 'draft';
      const limit = Number(req.body?.limit || 25);

      const picked = pickProducts(entries, req.body || {})
        .map(({ product }) => applyProductGroup(product))
        .filter((p) => !shouldExcludeFromWordpress(p, req.body || {}))
        .filter((p) => p.productionLink && normalizeSku(p.sku || p.customLabel))
        .slice(0, Math.max(1, limit));

      if (picked.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No products with production eBay links were found for the selected filter.'
        });
      }

      // Generate branded content using brand-content utility
      const brandConfig = getBrandConfig();
      const today = new Date().toISOString().slice(0, 10);
      const title = req.body?.title || `${brandConfig.name} - Featured Products - ${today}`;
      const content = generateWordPressPost(picked, {
        title,
        includeImages: true,
        productGroup: req.body?.productGroup || null
      });

      if (dryRun) {
        return res.json({
          success: true,
          dryRun: true,
          status: 'would_create_promotion_post',
          title,
          productCount: picked.length
        });
      }

      const created = await wpRequest({
        method: 'POST',
        endpoint: '/posts',
        data: {
          title,
          status: publishStatus,
          content,
          excerpt: `${brandConfig.tagline} - Featured ${picked.length} premium hand-forged products now live.`
        }
      });

      return res.json({
        success: true,
        dryRun: false,
        status: 'promotion_post_created',
        postId: created.id,
        link: created.link || null,
        productCount: picked.length
      });
    });
  });
}

module.exports = {
  registerWordpressIntegrationRoutes
};
