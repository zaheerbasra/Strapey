# eBay Publishing Guide

## Overview
This guide explains how to configure and use the eBay publishing functionality to list scraped products on eBay.

## Current Configuration Status ✓

### Credentials Configured
- ✅ **Client ID**: StrapeyI-StrapeyA-SBX-**REDACTED**
- ✅ **Client Secret**: SBX-**REDACTED**
- ✅ **Dev ID**: **REDACTED**
- ✅ **Environment**: Sandbox
- ✅ **OAuth Token Generation**: Working

### Missing Configuration ⚠️
- ❌ **EBAY_REFRESH_TOKEN** - User authorization required
- ❌ **EBAY_CATEGORY_ID** - Product category
- ❌ **EBAY_FULFILLMENT_POLICY_ID** - Shipping policy
- ❌ **EBAY_PAYMENT_POLICY_ID** - Payment policy
- ❌ **EBAY_RETURN_POLICY_ID** - Return policy
- ❌ **EBAY_LOCATION_KEY** - Inventory location

---

## Which Seller Account Will Publish?

**Important**: Listings will be published to **the eBay seller account that authorizes the app**.

The app uses **OAuth 2.0 User Token** authentication, which means:
1. A seller must visit an authorization URL and grant permission
2. The app receives a refresh token tied to that specific seller account
3. All listings created will appear under that seller's account

### Current Status
- **No seller account authorized yet** (no refresh token configured)
- **Action required**: Complete the OAuth flow below

---

## Required Schema for Publishing

### 1. Scraped Data (automatically collected)
```json
{
  "title": "string (max 80 chars)",
  "description": "string (max 4000 chars)",
  "price": "number (positive)",
  "currency": "string (e.g., USD)",
  "availableQuantity": "number or string",
  "imageSourceUrls": ["array of image URLs (max 24)"],
  "itemSpecifics": {
    "Brand": "value",
    "MPN": "value",
    "Color": "value"
    // key-value pairs for product attributes
  }
}
```

### 2. Environment Variables (must be configured)
```bash
# Authentication
EBAY_CLIENT_ID=StrapeyI-StrapeyA-SBX-**REDACTED**
EBAY_CLIENT_SECRET=SBX-**REDACTED**
EBAY_DEV_ID=**REDACTED**
EBAY_REFRESH_TOKEN=<USER_TOKEN_FROM_OAUTH>

# Marketplace
EBAY_ENV=sandbox
EBAY_MARKETPLACE_ID=EBAY_US

# Listing Configuration
EBAY_CATEGORY_ID=<category_id>
EBAY_FULFILLMENT_POLICY_ID=<shipping_policy_id>
EBAY_PAYMENT_POLICY_ID=<payment_policy_id>
EBAY_RETURN_POLICY_ID=<return_policy_id>
EBAY_LOCATION_KEY=<location_key>
```

### 3. API Request
```bash
POST /publish-ebay
Content-Type: application/json

{
  "link": "https://www.ebay.com/itm/123456789",
  "categoryId": "optional_override",
  "marketplaceId": "optional_override"
}
```

---

## Setup Process

### Step 1: Get User Authorization (Refresh Token)

#### 1.1 Get Authorization URL
```bash
curl http://localhost:3001/api/ebay-auth-url
```

**Example Response:**
```json
{
  "authUrl": "https://auth.sandbox.ebay.com/oauth2/authorize?client_id=...",
  "redirectUri": "http://localhost:3001/api/ebay-callback",
  "environment": "sandbox"
}
```

#### 1.2 Visit the Authorization URL
1. Copy the `authUrl` from the response
2. Open it in your browser
3. Log in with your **eBay Sandbox seller account**
4. Authorize the application
5. You'll be redirected to the callback URL with a `code` parameter

#### 1.3 Exchange Code for Refresh Token
```bash
curl -X POST "https://api.sandbox.ebay.com/identity/v1/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Authorization: Basic $(echo -n 'CLIENT_ID:CLIENT_SECRET' | base64)" \
  -d "grant_type=authorization_code" \
  -d "code=YOUR_CODE_FROM_CALLBACK" \
  -d "redirect_uri=http://localhost:3001/api/ebay-callback"
```

#### 1.4 Add Refresh Token to .env
```bash
EBAY_REFRESH_TOKEN=v^1.1#i^1#...
```

### Step 2: Create Business Policies

You must create policies in eBay Seller Hub:

#### Sandbox Seller Hub
🔗 https://www.sandbox.ebay.com/sh/ovw/seller

#### Create These Policies:
1. **Fulfillment Policy** (Shipping)
   - Set shipping options, handling time, etc.
   - Copy the policy ID

2. **Payment Policy**
   - Configure payment methods
   - Copy the policy ID

3. **Return Policy**
   - Set return acceptance, return period
   - Copy the policy ID

4. **Inventory Location**
   - Create a merchant location
   - Copy the location key

#### Add Policy IDs to .env
```bash
EBAY_FULFILLMENT_POLICY_ID=12345678
EBAY_PAYMENT_POLICY_ID=87654321
EBAY_RETURN_POLICY_ID=11223344
EBAY_LOCATION_KEY=warehouse-1
```

### Step 3: Determine Category ID

Find the correct eBay category for your products:

#### Option 1: Use eBay's Category API
```bash
curl -X GET "https://api.sandbox.ebay.com/commerce/taxonomy/v1/category_tree/0" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

#### Option 2: Find Category on eBay
1. Search for similar products on eBay
2. Check the category in listing details
3. Use the category ID number

#### Add to .env
```bash
EBAY_CATEGORY_ID=9355  # Example: Cell Phones & Smartphones
```

---

## API Publishing Flow

### Step 1: Create Inventory Item
```
PUT /sell/inventory/v1/inventory_item/{sku}
```
Creates an inventory item with product details.

**Payload:**
```json
{
  "condition": "NEW",
  "availability": {
    "shipToLocationAvailability": {
      "quantity": 10
    }
  },
  "product": {
    "title": "Product Title",
    "description": "Product description",
    "imageUrls": ["https://..."],
    "aspects": {
      "Brand": ["Apple"],
      "Model": ["iPhone"]
    }
  }
}
```

### Step 2: Create Offer
```
POST /sell/inventory/v1/offer
```
Creates an offer with pricing and policies.

**Payload:**
```json
{
  "sku": "sku-abc123",
  "marketplaceId": "EBAY_US",
  "format": "FIXED_PRICE",
  "availableQuantity": 10,
  "categoryId": "9355",
  "listingDescription": "Product description",
  "merchantLocationKey": "warehouse-1",
  "pricingSummary": {
    "price": {
      "value": "299.99",
      "currency": "USD"
    }
  },
  "listingPolicies": {
    "fulfillmentPolicyId": "12345678",
    "paymentPolicyId": "87654321",
    "returnPolicyId": "11223344"
  }
}
```

### Step 3: Publish Listing
```
POST /sell/inventory/v1/offer/{offerId}/publish
```
Publishes the offer to create an active listing.

---

## Testing the Setup

### 1. Check Configuration Status
```bash
curl http://localhost:3001/api/ebay-publish-schema | python3 -m json.tool
```

### 2. Validate Credentials
```bash
curl http://localhost:3001/api/validate-ebay-credentials | python3 -m json.tool
```

### 3. Test Publishing (after scraping)
```bash
curl -X POST http://localhost:3001/publish-ebay \
  -H "Content-Type: application/json" \
  -d '{
    "link": "https://www.ebay.com/itm/304569312160",
    "categoryId": "9355"
  }'
```

---

## Common Issues

### Issue: "Missing eBay credentials"
**Solution**: Complete OAuth flow to get refresh token (Step 1)

### Issue: "Missing eBay policy/config values"
**Solution**: Create policies in Seller Hub and add IDs to .env (Step 2)

### Issue: "Invalid category ID"
**Solution**: Use eBay's category taxonomy API to find correct ID (Step 3)

### Issue: "Token expired"
**Solution**: Refresh tokens last for 18 months. Get a new one if expired.

---

## Security Notes

1. **Never commit .env file** - Contains sensitive credentials
2. **Use .env.example** - Template without secrets
3. **Rotate credentials** - If compromised, rotate in eBay Developer Portal
4. **Production vs Sandbox** - Use separate credentials for each environment

---

## Useful Links

- **Sandbox Seller Hub**: https://www.sandbox.ebay.com/sh/ovw/seller
- **Production Seller Hub**: https://www.ebay.com/sh/ovw/seller
- **eBay Developer Portal**: https://developer.ebay.com
- **API Documentation**: https://developer.ebay.com/api-docs/sell/inventory/overview.html
- **OAuth Guide**: https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html

---

## Current Status Summary

✅ **Working:**
- Sandbox credentials validated
- OAuth token generation successful
- API connectivity confirmed

⚠️ **Needs Setup:**
- User authorization (refresh token)
- Business policies (fulfillment, payment, return)
- Category selection
- Inventory location

🎯 **Next Steps:**
1. Visit OAuth URL to authorize seller account
2. Exchange code for refresh token
3. Create policies in Sandbox Seller Hub
4. Add all IDs to .env file
5. Test publishing with a scraped product
