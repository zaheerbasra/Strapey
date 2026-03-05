# Content & Image Validation Guide

## Overview
The application includes comprehensive validation to detect and filter out **scam images**, **malicious content**, and **suspicious product data** before publishing to eBay.

This protection system keeps your eBay account safe by:
✅ Filtering logos, watermarks, and non-product images  
✅ Detecting scam keywords and suspicious patterns  
✅ Validating content for spam and manipulation  
✅ Cleaning existing data.json to remove bad images  
✅ Blocking publication of suspicious listings  

---

## Image Validation

### What Gets Filtered Out

**Automatically Removed During Scraping & Publishing:**

1. **Watermarks & Logos**
   - Images containing "watermark", "logo", "copyright notice"
   - Cash/money symbols, crypto references
   - Text overlays on product images

2. **Placeholder Images**
   - QR codes, "coming soon", sample images
   - "Placeholder" or test images
   - Suspicious file types (GIF, BMP, ICO, SVG)

3. **Malformed Images**
   - Images not from eBay infrastructure (non-ebayimg.com URLs)
   - Thumbnail sizes (s-l50, s-l100, s-l140, s-l200)
   - Invalid or broken URLs

4. **Known Scam Patterns**
   - Images with "cash", "money", "logo" in URL
   - Images with cryptographic references
   - Images with suspicious domain artifacts

### Image Validation in Action

**During Scraping:**
```
Data extracted: 12 images collected
Image validation: 12 images collected, 0 filtered, 12 valid ✓
```

**During Publishing (if issues found):**
```
[WARN] Suspicious images removed: {
  "total": 15,
  "valid": 12,
  "removed": 3
}
```

### Image Validation Function

Location: [server.js lines 245-263]

```javascript
function validateImageUrls(imageUrls) {
  // Filters out suspicious images
  // Returns only clean, product-related images
  // Max 24 images per eBay limits
}
```

---

## Content Validation

### Scam Keywords Detected

The system blocks or warns about listings containing these keywords:

**Business Scams:**
- "drop shipping", "dropshipping", "wholesale"
- "bulk order", "white label", "reseller kit"
- "affiliate", "mlm", "pyramid"

**Get Rich Quick:**
- "make money", "get rich", "earn money fast"
- "free money", "free item", "too good to be true"
- "click here", "call now", "act now"

**Counterfeits & Fakes:**
- "counterfeit", "knock off", "replica"
- "unauthorized", "not genuine", "imitation"
- "fake brand", "stolen account"

**Account Issues:**
- "amazon reseller", "reddit reseller", "tiktok shop"

### Content Validation Checks

1. **Title Validation**
   - Minimum 5 characters
   - Cannot be empty
   - Excessive punctuation (3+ !! or ??) = warning

2. **Description Validation**
   - Scans for suspicious keywords
   - Detects contact info (emails/phone numbers)
   - Flags unusually formatted text patterns

3. **Combined Analysis**
   - Full product text checked for keyword combinations
   - False positives logged as warnings (non-blocking)
   - Real scams result in publication errors

### Validation Levels

**🔴 ERRORS** (Block Publication)
- Title missing or too short
- Confirmed scam content
- No valid images

**🟡 WARNINGS** (Allow but Log)
- Suspicious keywords found
- Contact information detected
- Unusual formatting

---

## Validation Endpoints

### 1. Validate & Clean Existing Data
**Endpoint:** `POST /api/validate-and-clean-data`

Scans your entire `data.json` file and removes:
- Suspicious images
- Content warnings
- Invalid data

**Request:**
```bash
curl -X POST http://localhost:3001/api/validate-and-clean-data \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "message": "Data validation and cleanup completed",
  "summary": {
    "itemsScanned": 5,
    "itemsCleaned": 2,
    "imagesRemoved": 8,
    "contentWarnings": 3
  },
  "details": [
    {
      "link": "https://www.ebay.com/itm/123456789",
      "status": "OK",
      "issues": []
    },
    {
      "link": "https://www.ebay.com/itm/987654321",
      "status": "OK",
      "issues": ["Removed 3 suspicious images", "Content warnings: Contains suspicious keyword: \"cash\""]
    }
  ],
  "savedToFile": true
}
```

### 2. Publish with Validation
**Endpoint:** `POST /publish-ebay`

Automatically validates before publishing:
- Content checks
- Image quality checks
- Scam detection

**Request:**
```bash
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{
    "link": "https://www.ebay.com/itm/302710852493",
    "categoryId": 15687,
    "marketplaceId": "EBAY_US"
  }'
```

**Response on Success:**
```json
{
  "success": true,
  "action": "CREATED",
  "listingId": "110589128143",
  "listingLink": "https://sandbox.ebay.com/itm/110589128143",
  "logs": [
    {
      "timestamp": "2026-03-05T08:30:15.142Z",
      "level": "INFO",
      "text": "Content validation checks passed"
    },
    {
      "timestamp": "2026-03-05T08:30:15.200Z",
      "level": "DEBUG",
      "text": "Using validated images",
      "data": {"total": 3, "willUse": 3}
    }
  ]
}
```

**Response on Validation Failure:**
```json
{
  "success": false,
  "error": "Cannot publish: Title is too short or missing",
  "code": "VALIDATION_ERROR",
  "status": 400
}
```

---

## Validation in Scraping

### Scraper Output

When scraping a product, the system now includes validation metrics:

**Console Output:**
```
[Scraper] Data extracted: 12 images found (0 suspicious images filtered)
[Scraper] Image validation log:
  - Collected: 12
  - Filtered: 0
  - Removed: 0
```

**In data.json:**
```json
{
  "https://www.ebay.com/itm/302710852493": {
    "title": "Product Title",
    "imageSourceUrls": [...],
    "imageValidationLog": {
      "collected": 12,
      "filtered": 12,
      "removed": 0,
      "details": []
    }
  }
}
```

---

## Workflow: Safe Publishing

### Step 1: Scrape Product
```bash
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "link": "https://www.ebay.com/itm/302710852493",
      "categoryId": 15687
    }]
  }'
```
✅ Images automatically filtered during scraping

### Step 2: Review Data (Optional)
```bash
curl -X POST http://localhost:3001/api/validate-and-clean-data
```
✅ Review what was removed
✅ Clean old data

### Step 3: Publish
```bash
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{
    "link": "https://www.ebay.com/itm/302710852493",
    "categoryId": 15687
  }'
```
✅ Content validated
✅ Images double-checked
✅ Publication blocked if suspicious

---

## Customization

### Modify Scam Keywords

Edit in [server.js lines 230-238]:

```javascript
const SCAM_KEYWORDS = [
  'drop shipping', 'dropshipping',
  'wholesale', 'bulk order',
  'white label', 'reseller kit',
  // Add more keywords here
];
```

### Add Image Patterns

Edit in [server.js lines 240-245]:

```javascript
const SUSPICIOUS_IMAGE_PATTERNS = [
  'logo', 'watermark', 'cash', 'money',
  'crypto', 'bitcoin', 'qr code',
  // Add more patterns here
];
```

### Adjust Validation Rules

Edit in [server.js line 279] `validateProductContent()` function:

```javascript
function validateProductContent(title = '', description = '') {
  // Modify checks here
  // Add custom validation logic
}
```

---

## Logging & Monitoring

### Validation Logs

All validation events are logged:

**In console:**
```
[PublishToEbay] Content validation checks passed
[PublishToEbay] Suspicious images removed: {total: 15, valid: 12, removed: 3}
```

**In publish response:**
```json
"logs": [
  {
    "timestamp": "2026-03-05T08:30:15.142Z",
    "level": "WARN",
    "text": "Suspicious images removed",
    "data": {"total": 15, "valid": 12, "removed": 3}
  }
]
```

---

## Best Practices

✅ **Do:**
- Run validation weekly: `POST /api/validate-and-clean-data`
- Review warnings in publish logs
- Adjust keywords for your product type
- Test with real eBay URLs first

❌ **Don't:**
- Disable validation in production
- Add legitimate keywords to blacklist
- Publish unreviewed scraped data
- Mix scam and legitimate product content

---

## File Locations

- **Validation Functions:** [server.js](server.js#L221)
- **Scam Keywords:** [server.js](server.js#L230)
- **Image Patterns:** [server.js](server.js#L240)
- **Content Validation:** [server.js](server.js#L265)
- **Image Validation:** [server.js](server.js#L245)
- **Data Cleanup Endpoint:** [server.js](server.js#L2521)
- **Publish Validation:** [server.js](server.js#L500)

---

## Troubleshooting

### Q: Why is my image being filtered?
**A:** Check if URL contains:  
- Thumbnail sizes (s-l50, s-l100, s-l140, s-l200)
- Suspicious keywords (logo, cash, watermark)
- Non-ebayimg.com domain
- Invalid file types (GIF, BMP, SVG, ICO)

### Q: Why is publish being blocked?
**A:** Check logs for:
- Missing or short title
- Scam keywords in content
- No valid images after filtering
- Contact info in description

### Q: How do I trust the validation?
**A:** Review source code:
1. Check [SCAM_KEYWORDS](server.js#L230) list
2. Review [SUSPICIOUS_IMAGE_PATTERNS](server.js#L240)
3. Examine [validateProductContent()](server.js#L265) function
4. Test with known good/bad products

---

## Updates & Changes

**v1.0 (March 5, 2026):**
- Initial image validation
- Content keyword checking
- Data cleanup endpoint
- Integration with scraper & publish
