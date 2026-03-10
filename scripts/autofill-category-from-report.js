const fs = require('fs');
const path = require('path');

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/autofill-category-from-report.js <report.json>');
  process.exit(1);
}

const dataPath = path.join(process.cwd(), 'data', 'data.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const blocked = report.results.filter((r) => {
  return r.status === 'publish_failed' && String(r?.error?.error || '').includes('product.categoryId');
});

let updated = 0;
const changes = [];

for (const row of blocked) {
  const sku = String(row.sku || '').trim();
  const key = Object.keys(data).find((k) => {
    const item = data[k] || {};
    return item.sku === sku || item.customLabel === sku;
  });

  if (!key) continue;

  const item = data[key] || {};
  const existingCategory = String(item.categoryId || '').trim();
  if (existingCategory && existingCategory.toUpperCase() !== 'N/A') continue;

  const title = String(item.title || '').toLowerCase();
  const skuLower = sku.toLowerCase();
  const isGripLike = skuLower.includes('1911') || skuLower.includes('grip') || title.includes('1911') || title.includes('grip');
  const categoryId = isGripLike ? '73944' : '15687';

  item.categoryId = categoryId;
  item.lastUpdated = new Date().toISOString();
  data[key] = item;

  updated += 1;
  changes.push({ sku, categoryId, key });
}

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

const outPath = `/tmp/category_autofill_${Date.now()}.json`;
fs.writeFileSync(outPath, JSON.stringify({
  reportPath,
  blockedCount: blocked.length,
  updated,
  changes
}, null, 2));

console.log(JSON.stringify({ outPath, blockedCount: blocked.length, updated }, null, 2));
