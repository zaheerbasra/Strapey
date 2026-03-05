# eBay Category ID & Publishing Link Implementation

## Changes Made

### 1. ✅ Extract Category ID During Scraping
**File:** `/server.js` (page.evaluate function)

Added category ID extraction from eBay product pages:
- Tries JSON-LD structured data first (most reliable)
- Falls back to breadcrumb navigation href parsing
- Extracts category ID from URL pattern `/bn/{categoryId}`
- Returns category ID in the extraction result

```javascript
// Extract category ID from breadcrumbs or hidden data
let categoryId = 'N/A';
try {
  // Try JSON-LD structured data first
  const jsonScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  // ... parsing logic
  
  // Try breadcrumb navigation if JSON-LD not found
  const breadcrumbs = document.querySelector('[data-test-id="breadcrumbs"]');
  // ... breadcrumb parsing logic
}
```

### 2. ✅ Save Category ID to data.json
**File:** `/server.js`

- Category ID is now extracted and included in the returned product data
- Automatically saved to `data/data.json` along with other product fields
- Structure: Each product entry includes `categoryId` field

**Example data.json structure:**
```json
{
  "https://www.ebay.com/itm/...": {
    "url": "https://www.ebay.com/itm/...",
    "title": "Product Title",
    "price": 25.99,
    "categoryId": "15687",  // ← NEW FIELD
    "customLabel": "USL-TEST",
    "itemNumber": "304569312160",
    "publishedLink": "https://www.sandbox.ebay.com/itm/123456",  // ← AFTER PUBLISH
    "listingId": "123456",
    "sku": "usL-test-304569312160",
    "publishedDate": "2026-03-05T..."
  }
}
```

### 3. ✅ Update Publish Endpoint to Use Saved Category ID
**File:** `/server.js` → `publishToEbay()` function

Modified the publish function to:
- Use `categoryId` from product data first
- Fall back to overrides parameter
- Finally fall back to `.env` variable
- No longer requires `EBAY_CATEGORY_ID` in `.env` if scraped from page

```javascript
// Try to use categoryId from productData first
let categoryId = productData.categoryId || overrides.categoryId || process.env.EBAY_CATEGORY_ID;

if (categoryId === 'N/A') {
  categoryId = process.env.EBAY_CATEGORY_ID;
}
```

### 4. ✅ Return Published Link
**File:** `/server.js` → `publishToEbay()` function & `/publish-ebay` endpoint

Now returns the eBay Sandbox listing link:
- Constructs link from `listingId`: `https://www.sandbox.ebay.com/itm/{listingId}`
- Returns in API response as `listingLink`
- Also includes in success message to user

```javascript
const listingLink = listingId ? `${sandboxListingUrl}/itm/${listingId}` : null;

return {
  offerId,
  sku,
  listingId,
  listingLink,  // ← NEW FIELD
  status: 'PUBLISHED',
  message: `Published successfully! View at: ${listingLink}`
};
```

### 5. ✅ Save Published Link to data.json
**File:** `/server.js` → `/publish-ebay` endpoint

After successful publish:
- Saves `publishedLink` to data.json
- Saves `listingId` for reference
- Saves `sku` for tracking
- Saves `publishedDate` timestamp

```javascript
if (publishResult.listingLink) {
  productData.publishedLink = publishResult.listingLink;
  productData.listingId = publishResult.listingId;
  productData.sku = publishResult.sku;
  productData.publishedDate = new Date().toISOString();
  fs.writeJsonSync(dataFile, allData);
}
```

### 6. ✅ Update UI to Display Published Link
**File:** `/public/index.html`

Added interactive published link display:
- After successful publish, shows clickable link: **"✅ View on eBay Sandbox"**
- Link opens in new tab (target="_blank")
- Styled with teal color and hover effects
- Replaces generic "Published successfully" message

**CSS Styling:**
```css
.published-link {
  color: #0891b2;
  text-decoration: none;
  font-weight: 500;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  background-color: rgba(6, 182, 212, 0.1);
  display: inline-block;
  transition: all 0.2s ease;
}

.published-link:hover {
  background-color: rgba(6, 182, 212, 0.2);
  text-decoration: underline;
}
```

## How It Works - Flow Diagram

```
1. USER SCRAPES PRODUCTS
   ↓
   Input: Item URL (e.g., https://www.ebay.com/itm/304569312160)
   
2. SCRAPER EXTRACTS DATA
   ↓
   - Title → SEO optimized
   - Price → Validated
   - Images → Downloaded & enhanced
   - Category ID → NEW! Extracted from breadcrumbs/JSON-LD
   - Item Specifics → Extracted & stored
   
3. DATA SAVED TO data.json
   ↓
   {
     "url": "...",
     "categoryId": "15687",  ← Automatically saved
     "images": [...],
     ...
   }
   
4. USER CLICKS "PUBLISH TO eBay"
   ↓
   No need to manually set EBAY_CATEGORY_ID anymore!
   
5. PUBLISH PROCESS
   ↓
   - Uses categoryId from data.json (scraped value)
   - Creates inventory item
   - Creates offer
   - Publishes listing to eBay Sandbox
   
6. RESPONSE WITH LINK
   ↓
   {
     "success": true,
     "listingLink": "https://www.sandbox.ebay.com/itm/123456789",
     "listingId": "123456789",
     "message": "Published successfully! View at: ..."
   }
   
7. UI DISPLAYS CLICKABLE LINK
   ↓
   ✅ View on eBay Sandbox  ← User can click to view listing
   
8. LINK SAVED TO data.json
   ↓
   {
     "publishedLink": "https://www.sandbox.ebay.com/itm/123456789",
     "listingId": "123456789",
     "publishedDate": "2026-03-05T..."
   }
```

## Testing the Flow

1. **Scrape a product** — Enter an eBay item URL and scrape
2. **Check data.json** — Verify `categoryId` is saved
3. **Click Publish** — Click "Publish to eBay" button
4. **See the link** — Click the teal "View on eBay Sandbox" link
5. **Verify save** — Check data.json for `publishedLink` and `publishedDate`

## Error Handling

The endpoint now provides helpful error messages:

```
Before: "Missing eBay policy/config values. Set EBAY_CATEGORY_ID..."
After:  "Missing eBay policy/config values. Ensure EBAY_CATEGORY_ID 
        (scraped from product page or set in .env), EBAY_FULFILLMENT_POLICY_ID, 
        EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID are all set."
```

## Data Persistence

Now when you:
- ✅ Scrape a product → Category ID saved
- ✅ Publish successfully → Link saved
- ✅ Re-run scrapes → Existing data merged (updated if price/title changed)

All data persists in `data/data.json` with timestamps for audit trail.

## Next Steps (Optional)

If you want to enhance further:
- Add listing management (relist, revise, end listing)
- Display inventory status from eBay
- Track publish history with multiple links per product
- Bulk operations (publish all, unpublish all)
