# Des Plaines Warehouse - Single Warehouse Configuration

## Overview
The application uses **only one warehouse location** for all eBay inventory management:

**Des Plaines, Illinois, United States**

All products are automatically configured to ship from this location.

## Warehouse Details
- **Name:** Des Plaines Primary Warehouse
- **Location Key:** `des-plaines-il-primary`
- **Address:** Des Plaines, Illinois, United States
- **Status:** ENABLED
- **Availability:** All products ship from this location only

## Setup Instructions

### 1. Initialize Warehouse (One-Time Setup)
Run this endpoint to configure the Des Plaines warehouse:

```bash
curl -X POST http://localhost:3001/api/warehouse/setup-default \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "message": "Des Plaines warehouse configured as default",
  "warehouse": {
    "name": "Des Plaines Primary Warehouse",
    "address": {
      "city": "Des Plaines",
      "state": "IL",
      "country": "US"
    },
    "locationKey": "des-plaines-il-primary",
    "status": "ENABLED"
  }
}
```

### 2. Make It Permanent
To persist the warehouse location across server restarts, add this to your `.env` file:

```
EBAY_LOCATION_KEY=des-plaines-il-primary
```

Then restart the server:

```bash
npm start
```

**Note:** Once set in `.env`, the warehouse will be automatically applied to all listings on startup.

### 3. Verify Configuration
The warehouse location is automatically included in all product publishes. You can verify it's being used by checking the publish logs:

```bash
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{"link":"https://www.ebay.com/itm/[ITEM_ID]","categoryId":15687,"marketplaceId":"EBAY_US"}' \
  | jq '.logs[] | select(.text | contains("Creating inventory")) | .data.locationKey'
```

Response will show: `"des-plaines-il-primary"`

## How It Works

### Automatic Integration
The Des Plaines warehouse location is automatically applied to:
- **All Inventory Items:** Every product created is registered to Des Plaines
- **Fulfillment:** Items are marked as shipped from Des Plaines, Illinois
- **eBay Listings:** The location displays on all product listings as "Ships from Des Plaines, Illinois"

### No Manual Warehouse Selection
- No endpoint accepts warehouse parameters
- No warehouse switching capability
- All products use the same location
- Simple, consistent fulfillment workflow

### Publishing with Des Plaines (Default)
Every time you publish a product using the `/publish-ebay` endpoint:

```bash
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{
    "link": "https://www.ebay.com/itm/[ITEM_ID]",
    "categoryId": 15687,
    "marketplaceId": "EBAY_US"
  }'
```

The system will:
1. Extract product data from the source eBay listing (via scraper)
2. Create/update inventory item at Des Plaines warehouse
3. Create offer and publish to Sandbox/Production
4. Return success with listing link
5. All images attached to the Des Plaines location

## Environment Variables

**Required for warehouse setup:**
- `EBAY_CLIENT_ID` - Your eBay app's Client ID
- `EBAY_CLIENT_SECRET` - Your eBay app's Client Secret
- `EBAY_REFRESH_TOKEN` - OAuth refresh token for user account

**Optional for persistent warehouse:**
- `EBAY_LOCATION_KEY=des-plaines-il-primary` (recommended)

## Example: Publishing with Des Plaines Location

```javascript
// All publishes automatically use Des Plaines location
const response = await fetch('/publish-ebay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    link: 'https://www.ebay.com/itm/302710852493',
    categoryId: 15687,
    marketplaceId: 'EBAY_US'
  })
});

const result = await response.json();
// Result:
// - listingId: Published listing ID
// - listingLink: Sandbox or Production link
// - Warehouse: Automatically Des Plaines, Illinois
// - Images: All attached to Des Plaines location
```

## Testing

### Quick Test
```bash
# Setup warehouse
curl -X POST http://localhost:3001/api/warehouse/setup-default

# Publish a test product (automatically uses Des Plaines)
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{"link":"https://www.ebay.com/itm/302710852493","categoryId":15687,"marketplaceId":"EBAY_US"}'
```

### Verify in data.json
```bash
jq '.["https://www.ebay.com/itm/302710852493"]' data/data.json
```

Will show:
```json
{
  "publishAction": "CREATED",
  "listingId": "110589128143",
  "publishedLink": "https://sandbox.ebay.com/itm/110589128143",
  "warehouseLocation": "des-plaines-il-primary"
}
```

## Troubleshooting

### Missing Credentials
If you get `"error": "eBay credentials not fully configured"`:
- Verify `.env` has `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`
- Restart the server after updating `.env`

### Endpoint Returns 500
- Check server logs for API error details
- Ensure eBay sandbox/production credentials are valid
- Verify fulfillment, payment, and return policies are configured

### Location Not Showing in Listing
- Verify `EBAY_LOCATION_KEY=des-plaines-il-primary` in `.env` if using persistent config
- Check that inventory item creation logs show correct `locationKey`
- Ensure the warehouse is properly initialized via `/api/warehouse/setup-default`

## Key Benefits

✅ **Simplicity:** Single warehouse, no configuration choices  
✅ **Consistency:** All products ship from same location  
✅ **Reliability:** No warehouse selection errors  
✅ **Scalability:** Easy to manage inventory across all SKUs  
✅ **Transparency:** Clear shipping expectations for customers

## Additional Resources
- [eBay Inventory API Locations](https://developer.ebay.com/Devzone/inventory/Concepts/CurrencyManagement.html)
- [eBay Sell Merchant Locations](https://sell.ebay.com/manage/ShipFromLocations)

