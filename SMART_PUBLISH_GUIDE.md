# Smart Publish to eBay - Implementation Guide

## Overview

The publish flow now intelligently manages listings by:
1. **Checking for existing listings** by SKU before publishing
2. **Updating** existing listings if data has changed (price, quantity, title, images)
3. **Skipping publish** if listing exists and no data changed
4. **Creating new listings** only when they don't exist

This eliminates duplicate listings and keeps your eBay inventory accurate.

---

## Architecture

### Step 1: Find Existing Offer by SKU

**Function:** `findExistingOffer(sku)`

The function searches your eBay Sandbox offers to find if a listing already exists with the given SKU.

```javascript
async function findExistingOffer(sku) {
  // Calls GET /sell/inventory/v1/offer
  // Searches through all offers
  // Returns: { found: true/false, offerId, listingId, status, currentPrice, currentQuantity }
}
```

**API Used:**
- `GET /sell/inventory/v1/offer?format=FIXED_PRICE&limit=100`
- Filters by SKU match
- Returns matching offer details or null

---

### Step 2: Smart Publish Logic

**Function:** `publishToEbay(productData, overrides)`

The enhanced function implements conditional logic:

```javascript
async function publishToEbay(productData, ...) {
  // 1. BUILD DATA (SKU, price, quantity, etc.)
  const sku = buildPublishSku(productData);
  const price = productData.price;
  const quantity = parseQuantity(productData.availableQuantity);
  
  // 2. CHECK FOR EXISTING LISTING
  const existingOffer = await findExistingOffer(sku);
  
  if (existingOffer.found) {
    // 3a. LISTING EXISTS - Check for changes
    const priceChanged = existingOffer.currentPrice !== price;
    const quantityChanged = existingOffer.currentQuantity !== quantity;
    
    if (priceChanged || quantityChanged) {
      // 3b. DATA CHANGED - Update inventory and offer
      await UPDATE_INVENTORY(sku, newData);
      await UPDATE_OFFER(offerId, newPrice, newQuantity);
      
      return {
        action: 'UPDATED',
        offerId: existingOffer.offerId,
        listingLink: existingLink,
        message: 'Updated existing listing'
      };
    } else {
      // 3c. NO CHANGES - Return existing link
      return {
        action: 'UNCHANGED',
        offerId: existingOffer.offerId,
        listingLink: existingLink,
        message: 'Listing already exists, no changes'
      };
    }
  } else {
    // 4. LISTING DOESN'T EXIST - Create new
    await CREATE_INVENTORY(sku, data);
    const offerId = await CREATE_OFFER(sku, marketplaceId, ...);
    await PUBLISH_OFFER(offerId);
    
    return {
      action: 'CREATED',
      offerId: newOfferId,
      listingId: newListingId,
      listingLink: newLink,
      message: 'New listing created'
    };
  }
}
```

---

## Decision Tree

```
🔍 User clicks "Publish to eBay"
                     ↓
         ✓ Extract SKU from product
                     ↓
    🔎 Search for existing offer by SKU
                     ↓
        ┌─────────────┴─────────────┐
        ↓                           ↓
   FOUND                      NOT FOUND
        ↓                           ↓
   Check Changes              Create New
        ↓                       ↓
    ┌───┴───┐      ✓ Inventory Item
    ↓       ↓      ✓ Offer
 YES   NO  ✓ Publish
    ↓       ↓      ✓ Get Listing ID
 UPDATE  SKIP      ✓ Build Link
    ↓       ↓           ↓
    └───┬───┘       CREATED
        ↓
    UPDATED or UNCHANGED
        ↓
  📊 Save to data.json
        ↓
  🎯 Return action & link
```

---

## Action Types

### CREATED ✅
- **When:** Listing doesn't exist in eBay Sandbox
- **Actions Taken:**
  1. Creates inventory item
  2. Creates offer
  3. Publishes offer
  4. Generates listing link
- **Result in UI:** ✅ Created & Published • View on Sandbox
- **data.json update:**
  ```json
  {
    "publishAction": "CREATED",
    "publishedLink": "https://www.sandbox.ebay.com/itm/123456",
    "listingId": "123456",
    "offerId": "abc123",
    "publishedDate": "2026-03-05T..."
  }
  ```

### UPDATED ✏️
- **When:** Listing exists AND price/quantity changed
- **Actions Taken:**
  1. Updates inventory item (title, description, images)
  2. Updates offer (price, quantity)
  3. Listing remains active (no republish needed)
- **Result in UI:** ✏️ Updated Listing • View on Sandbox
- **data.json update:**
  ```json
  {
    "publishAction": "UPDATED",
    "publishedLink": "https://www.sandbox.ebay.com/itm/123456",
    "listingId": "123456",
    "publishedDate": "2026-03-05T..."
  }
  ```

### UNCHANGED ℹ️
- **When:** Listing exists AND no price/quantity changes
- **Actions Taken:**
  - None (listing is left as-is)
- **Result in UI:** ℹ️ No Changes • View on Sandbox
- **data.json update:**
  ```json
  {
    "publishAction": "UNCHANGED",
    "publishedLink": "https://www.sandbox.ebay.com/itm/123456",
    "listingId": "123456",
    "publishedDate": "2026-03-05T..." (updated timestamp)
  }
  ```

---

## API Endpoints Called

### 1. Search for Offers (Check Existence)
```
GET /sell/inventory/v1/offer
Parameters: format=FIXED_PRICE&limit=100
Returns: Array of offers
```

### 2. Create/Update Inventory Item
```
PUT /sell/inventory/v1/inventory_item/{sku}
Body: { condition, availability, product: { title, description, imageUrls, aspects } }
```

### 3. Create Offer (Only if New)
```
POST /sell/inventory/v1/offer
Body: { sku, marketplaceId, format, categoryId, pricingSummary, listingPolicies, ... }
Returns: { offerId }
```

### 4. Update Offer (Only if Changed)
```
PUT /sell/inventory/v1/offer/{offerId}
Body: { availableQuantity, pricingSummary }
```

### 5. Publish Offer (Only if New)
```
POST /sell/inventory/v1/offer/{offerId}/publish
Returns: { listingId }
```

---

## Data Persistence in data.json

Each product now tracks publish history:

```json
{
  "https://www.ebay.com/itm/304569312160": {
    "url": "...",
    "itemNumber": "304569312160",
    "title": "SHARD BLADE 1911 Classic Wood Grips...",
    "price": 25.99,
    "categoryId": "15687",
    "customLabel": "USL",
    "sku": "usl-304569312160",
    
    // PUBLISH METADATA (NEW)
    "publishedLink": "https://www.sandbox.ebay.com/itm/123456789",
    "listingId": "123456789",
    "offerId": "offer-abc123",
    "publishAction": "UPDATED",
    "publishedDate": "2026-03-05T12:34:56.789Z",
    
    // ... other fields (images, description, etc.)
  }
}
```

---

## Use Cases

### Case 1: First Time Publish
```
1. User scrapes eBay listing
   → categoryId extracted and saved
   
2. User clicks "Publish"
   → App checks for existing offer by SKU
   → Not found
   → Creates new inventory + offer + publishes
   
3. Result: ✅ Created & Published
   → Listing link saved
   → publishAction = "CREATED"
```

### Case 2: Price Update
```
1. Original publish created listing with price $25.99
   
2. User re-scrapes same product (price now $23.99)
   
3. User clicks "Publish"
   → App checks for existing offer by SKU
   → Found! (same SKU)
   → Price changed ($25.99 → $23.99)
   → Updates inventory + offer price
   → Listing stays active (no republish)
   
4. Result: ✏️ Updated Listing
   → Same listing link
   → publishAction = "UPDATED"
```

### Case 3: Quantity Adjustment
```
1. Listing exists with quantity 10
   
2. Quantity in scraped data changes to 8
   
3. User clicks "Publish"
   → App checks for existing offer by SKU
   → Found! Same listing
   → Quantity changed (10 → 8)
   → Updates offer quantity
   
4. Result: ✏️ Updated Listing
```

### Case 4: No Changes
```
1. Listing already published with exact same data
   
2. User re-scrapes and publishes again (no actual changes)
   
3. Result: ℹ️ No Changes
   → Listing left unchanged
   → publishAction = "UNCHANGED"
   → publishedDate timestamp still updated for audit
```

---

## Benefits

✅ **Prevents Duplicates**
   - Never creates duplicate listings for same SKU
   - Only one active listing per product

✅ **Smart Updates**
   - Automatically updates when price/quantity change
   - Keeps eBay inventory accurate

✅ **Efficient**
   - No unnecessary republish operations
   - Saves API calls and time

✅ **Audit Trail**
   - Tracks what action was taken
   - Timestamp shows when last published/updated
   - SKU and ListingID saved for reference

✅ **User Friendly**
   - Clear feedback in UI (Created/Updated/Unchanged)
   - Clickable link to view listing
   - Smart status messages

---

## Error Handling

If searching for existing offers fails:
```javascript
try {
  const existingOffer = await findExistingOffer(sku);
  // Use result...
} catch (error) {
  console.log('Could not search, will create new listing');
  // Proceeds to create new listing (safe fallback)
}
```

This ensures the publish never fails due to search issues.

---

## Testing the Feature

### Scenario 1: Create New Listing
1. Scrape a product
2. Click "Publish"
3. See: ✅ Created & Published
4. Click link to verify on sandbox
5. Check data.json → publishAction = "CREATED"

### Scenario 2: Update Price
1. Edit product data (change price in JSON if needed)
2. Click "Publish" same product
3. See: ✏️ Updated Listing
4. Check data.json → publishAction = "UPDATED"

### Scenario 3: Same Listing, No Changes
1. Click "Publish" for already-published product (no data change)
2. See: ℹ️ No Changes
3. Check data.json → publishAction = "UNCHANGED"

---

## Future Enhancements

Possible additions:
- Automatic re-listing when item sells
- Bulk publish/update all
- Listing status monitoring
- Price history tracking
- Multi-SKU variants support
- Automatic inventory sync from eBay
