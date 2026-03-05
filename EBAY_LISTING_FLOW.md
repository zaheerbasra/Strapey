# eBay Inventory API - Create Listing Flow

## Overview
Based on eBay's official Selling Apps documentation, here's the complete flow to create a listing using the Inventory API.

---

## The 5-Step Listing Creation Process

### Step 1: Get User OAuth Token ✓
**Endpoint**: `POST /identity/v1/oauth2/token`
- **Authentication**: User OAuth (requires refresh token)
- **Purpose**: Obtain access token with selling permissions
- **Scopes Required**:
  - `https://api.ebay.com/oauth/api_scope/sell.inventory`
  - `https://api.ebay.com/oauth/api_scope/sell.account`

### Step 2: Create Inventory Location
**Endpoint**: `POST /sell/inventory/v1/location/{merchantLocationKey}`
- **Purpose**: Define where inventory is located (warehouse, store, etc.)
- **Required Fields**:
  ```json
  {
    "location": {
      "address": {
        "postalCode": "95125",
        "stateOrProvince": "CA",
        "country": "US"
      }
    },
    "name": "Test Warehouse",
    "merchantLocationStatus": "ENABLED",
    "locationTypes": ["WAREHOUSE"]
  }
  ```
- **Note**: Only needs to be done once. Can reuse for multiple listings.

### Step 3: Create Inventory Item
**Endpoint**: `PUT /sell/inventory/v1/inventory_item/{sku}`
- **Purpose**: Define the product details
- **Required Fields**:
  ```json
  {
    "availability": {
      "shipToLocationAvailability": {
        "quantity": 1
      }
    },
    "condition": "NEW",
    "product": {
      "title": "Product Title (max 80 chars)",
      "description": "Product description (max 4000 chars)",
      "imageUrls": ["https://..."],
      "aspects": {
        "Brand": ["Brand Name"],
        "Model": ["Model Number"]
      }
    }
  }
  ```
- **SKU**: Seller-defined stock-keeping unit (unique identifier)

### Step 4: Create Offer
**Endpoint**: `POST /sell/inventory/v1/offer`
- **Purpose**: Create a publishable offer with pricing and policies
- **Required Fields**:
  ```json
  {
    "sku": "your-sku",
    "marketplaceId": "EBAY_US",
    "format": "FIXED_PRICE",
    "availableQuantity": 1,
    "categoryId": "176985",
    "listingDescription": "Description",
    "merchantLocationKey": "your-location-key",
    "pricingSummary": {
      "price": {
        "value": "9.99",
        "currency": "USD"
      }
    },
    "listingPolicies": {
      "fulfillmentPolicyId": "...",
      "paymentPolicyId": "...",
      "returnPolicyId": "..."
    }
  }
  ```
- **Returns**: `offerId` (needed for publishing)

### Step 5: Publish Offer
**Endpoint**: `POST /sell/inventory/v1/offer/{offerId}/publish`
- **Purpose**: Publish the offer to create a live eBay listing
- **Request Body**: Empty `{}`
- **Returns**: `listingId` (eBay item number)
- **Result**: Live listing on eBay!

---

## Prerequisites

### Required Configuration
```bash
# User Authentication
EBAY_REFRESH_TOKEN=v^1.1#i^1#...  # From OAuth flow

# Business Policies (create in Seller Hub)
EBAY_FULFILLMENT_POLICY_ID=12345678
EBAY_PAYMENT_POLICY_ID=87654321
EBAY_RETURN_POLICY_ID=11223344

# Listing Configuration
EBAY_CATEGORY_ID=176985  # Category for your product
EBAY_MARKETPLACE_ID=EBAY_US
```

### How to Get Business Policies
1. Visit [Sandbox Seller Hub](https://www.sandbox.ebay.com/sh/ovw/seller)
2. Create business policies:
   - **Fulfillment Policy**: Shipping options, handling time
   - **Payment Policy**: Payment methods
   - **Return Policy**: Return acceptance, period
3. Copy the policy IDs and add to `.env`

---

## Test Endpoint Created

### POST `/api/ebay-create-test-listing`

Creates a complete test listing following the 5-step Inventory API flow.

**Features:**
- ✅ Validates all prerequisites are configured
- ✅ Follows official eBay Inventory API flow exactly
- ✅ Creates location, inventory item, offer, and publishes
- ✅ Provides detailed step-by-step results
- ✅ Returns listing URL if successful
- ✅ Detailed error messages for troubleshooting

**Usage:**
```bash
curl -X POST http://localhost:3001/api/ebay-create-test-listing \
  -H "Content-Type: application/json"
```

**Success Response:**
```json
{
  "success": true,
  "message": "Test listing created successfully!",
  "listingId": "110123456789",
  "listingUrl": "https://sandbox.ebay.com/itm/110123456789",
  "sku": "test-sku-1234567890",
  "offerId": "10123456789",
  "merchantLocationKey": "test-location-1234567890",
  "steps": [
    { "step": 1, "name": "Get User OAuth Token", "status": "success" },
    { "step": 2, "name": "Create Inventory Location", "status": "success" },
    { "step": 3, "name": "Create Inventory Item", "status": "success" },
    { "step": 4, "name": "Create Offer", "status": "success" },
    { "step": 5, "name": "Publish Offer", "status": "success" }
  ],
  "note": "This is a live test listing. You should end/delete it from Seller Hub after testing."
}
```

**Error Response (Missing Config):**
```json
{
  "success": false,
  "error": "Missing required configuration",
  "missingConfig": [
    "EBAY_REFRESH_TOKEN",
    "EBAY_FULFILLMENT_POLICY_ID",
    "EBAY_PAYMENT_POLICY_ID",
    "EBAY_RETURN_POLICY_ID"
  ],
  "message": "Please complete OAuth flow and configure business policies."
}
```

---

## Key Differences: Client Credentials vs User Token

| Feature | Client Credentials Token | User OAuth Token |
|---------|-------------------------|------------------|
| **Authentication** | App ID + Client Secret | User authorization flow |
| **Permissions** | Limited (public APIs) | Full (seller account access) |
| **Can List Items** | ❌ No | ✅ Yes |
| **Can Get Inventory** | ❌ No | ✅ Yes |
| **Can Manage Orders** | ❌ No | ✅ Yes |
| **Expires** | Short-lived | Refresh token lasts 18 months |
| **Use Case** | Testing, public data | Production selling |

---

## Common Errors & Solutions

### Error 1100: Access denied
**Cause**: Using client credentials token instead of user token  
**Solution**: Complete OAuth flow to get refresh token

### Missing business policies
**Cause**: Policies not configured in `.env`  
**Solution**: Create policies in Seller Hub, add IDs to `.env`

### Invalid category
**Cause**: Category ID doesn't exist or wrong marketplace  
**Solution**: Use [Taxonomy API](https://developer.ebay.com/api-docs/sell/taxonomy/overview.html) to find valid categories

### Missing required aspects
**Cause**: Category requires specific item specifics  
**Solution**: Use `getItemAspectsForCategory` to see required aspects for your category

---

## What Makes This Different from AddItem (Trading API)?

### Inventory API (Modern - REST)
- ✅ Modular: Separate inventory from listings
- ✅ Batch operations supported
- ✅ Better for inventory management systems
- ✅ Required for multi-location inventory
- ✅ Easier updates and bulk operations
- **Requires**: Business policies (mandatory)

### Trading API AddItem (Legacy - XML)
- Older XML-based API
- Single call creates listing
- Business policies optional
- Less flexible for updates
- Being phased out for new features

---

## Next Steps

1. **Complete OAuth Flow** (if not done):
   ```bash
   curl http://localhost:3001/api/ebay-auth-url
   ```
   Visit the URL, authorize, get refresh token

2. **Create Business Policies** in Seller Hub

3. **Test the Endpoint**:
   ```bash
   curl -X POST http://localhost:3001/api/ebay-create-test-listing
   ```

4. **Verify Listing** in [Sandbox Seller Hub](https://www.sandbox.ebay.com/sh/lst/active)

5. **Delete Test Listing** after verification

---

## API Endpoints Summary

### Testing Endpoints
- `GET /api/validate-ebay-credentials` - Validate API credentials
- `GET /api/ebay-publish-schema` - Get schema requirements
- `GET /api/ebay-auth-url` - Get OAuth authorization URL
- `GET /api/ebay-test-get-inventory` - Test GET inventory items
- `POST /api/ebay-test-listing` - Test API connectivity
- `POST /api/ebay-create-test-listing` - **Create complete test listing** ⭐

### Production Endpoints
- `POST /publish-ebay` - Publish scraped product to eBay

---

## Documentation References

- [eBay Inventory API](https://developer.ebay.com/api-docs/sell/inventory/overview.html)
- [Listing Creation Guide](https://developer.ebay.com/develop/guides-v2/listing-creation/listing-creation)
- [Business Policies](https://developer.ebay.com/api-docs/sell/account/overview.html)
- [Taxonomy API](https://developer.ebay.com/api-docs/sell/taxonomy/overview.html)
- [Sandbox Testing](https://developer.ebay.com/DevZone/sandboxuser/default.aspx)
