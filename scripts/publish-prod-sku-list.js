const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEFAULT_TSV_PATH = path.join(ROOT, 'data', 'prod_sku_list.tsv');
const ENV_PATH = path.join(ROOT, '.env');

function parseEnv(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function httpJson(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, headers: res.headers, json };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRows(tsvPath) {
  const raw = fs.readFileSync(tsvPath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [itemNumber, link, sku] = line.split('\t');
    if (!itemNumber || !link || !sku) continue;
    rows.push({ itemNumber: itemNumber.trim(), link: link.trim(), sku: sku.trim() });
  }
  return rows;
}

function requiredFieldGaps(product) {
  const gaps = [];
  if (!product) {
    return ['product_not_found'];
  }
  if (!product.title) gaps.push('title');
  if (product.price === undefined || product.price === null || Number.isNaN(Number(product.price))) gaps.push('price');
  if (!product.description) gaps.push('description');
  const imageSourceUrls = Array.isArray(product.imageSourceUrls) ? product.imageSourceUrls : [];
  const images = Array.isArray(product.images) ? product.images : [];
  if (imageSourceUrls.length === 0 && images.length === 0) gaps.push('images');
  if (!product.categoryId) gaps.push('categoryId');
  if (!(product.sku || product.customLabel)) gaps.push('sku');
  return gaps;
}

async function setRuntimeMode(mode) {
  const res = await httpJson('http://localhost:3001/api/runtime/environment', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  }, 30000);
  if (!res.ok || !res.json?.success) {
    throw new Error(`Failed to set runtime=${mode}: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function getLocalProductBySku(sku) {
  const res = await httpJson(`http://localhost:3001/api/products/${encodeURIComponent(sku)}`, {
    method: 'GET'
  }, 30000);
  if (!res.ok) return null;
  return res.json;
}

async function publishSku(sku) {
  return httpJson(`http://localhost:3001/api/products/${encodeURIComponent(sku)}/publish/production`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }, 240000);
}

(async function main() {
  const startedAt = new Date().toISOString();
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TSV_PATH;
  const rows = readRows(inputPath);

  if (!rows.length) {
    throw new Error('No rows found in TSV input.');
  }

  const results = [];
  const seenSku = new Map();

  await setRuntimeMode('prod');

  try {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const sku = row.sku;

      if (seenSku.has(sku)) {
        results.push({
          index: i + 1,
          ...row,
          status: 'skipped_duplicate_input',
          basedOnIndex: seenSku.get(sku)
        });
        continue;
      }
      seenSku.set(sku, i + 1);

      const product = await getLocalProductBySku(sku);
      const gaps = requiredFieldGaps(product);
      if (gaps.length > 0) {
        results.push({
          index: i + 1,
          ...row,
          status: 'missing_required_data',
          missing: gaps
        });
        continue;
      }

      const publishRes = await publishSku(sku);
      if (!publishRes.ok) {
        results.push({
          index: i + 1,
          ...row,
          status: 'publish_failed',
          httpStatus: publishRes.status,
          error: publishRes.json
        });
        continue;
      }

      const action = String(publishRes.json?.action || '').toUpperCase();
      const status = action === 'CREATED' ? 'published_new' : 'already_exists_in_prod';

      results.push({
        index: i + 1,
        ...row,
        status,
        action: publishRes.json?.action || null,
        offerId: publishRes.json?.offerId || null,
        listingId: publishRes.json?.listingId || null,
        listingLink: publishRes.json?.listingLink || null,
        message: publishRes.json?.message || null
      });

      await sleep(250);
    }
  } finally {
    try {
      await setRuntimeMode('stage');
    } catch (err) {
      console.error('WARN: failed to restore runtime to stage:', err.message);
    }
  }

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    inputPath,
    inputRows: rows.length,
    uniqueSkus: seenSku.size,
    summary,
    results
  };

  const outPath = `/tmp/prod_publish_report_${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    outPath,
    inputRows: rows.length,
    uniqueSkus: seenSku.size,
    summary
  }, null, 2));
})();
