/**
 * eBay Orders Service
 * Handles fetching and caching orders from eBay Fulfillment API
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

// Cache configuration
const CACHE_FILE_SANDBOX = path.join(__dirname, '../data/ebay-orders-sandbox-cache.json');
const CACHE_FILE_PRODUCTION = path.join(__dirname, '../data/ebay-orders-production-cache.json');
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes cache

class EbayOrdersService {
  constructor(getEbayRuntimeConfig, getEbayAccessToken) {
    this.getEbayRuntimeConfig = getEbayRuntimeConfig;
    this.getEbayAccessToken = getEbayAccessToken;
    this.cache = {
      sandbox: { data: null, timestamp: null },
      production: { data: null, timestamp: null }
    };
    this.loadCacheFromDisk();
  }

  /**
   * Load cache from disk on startup
   */
  loadCacheFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE_SANDBOX)) {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE_SANDBOX, 'utf8'));
        this.cache.sandbox = cached;
      }
      if (fs.existsSync(CACHE_FILE_PRODUCTION)) {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE_PRODUCTION, 'utf8'));
        this.cache.production = cached;
      }
    } catch (error) {
      console.error('[EbayOrdersService] Error loading cache from disk:', error.message);
    }
  }

  /**
   * Save cache to disk
   */
  saveCacheToDisk(environment) {
    try {
      const cacheFile = environment === 'production' ? CACHE_FILE_PRODUCTION : CACHE_FILE_SANDBOX;
      const cacheData = this.cache[environment];
      fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      console.error('[EbayOrdersService] Error saving cache to disk:', error.message);
    }
  }

  /**
   * Check if cache is valid
   */
  isCacheValid(environment) {
    const cached = this.cache[environment];
    if (!cached.data || !cached.timestamp) return false;
    
    const now = Date.now();
    const age = now - cached.timestamp;
    return age < CACHE_DURATION_MS;
  }

  /**
   * Get cached orders if available and valid
   */
  getCachedOrders(environment) {
    if (this.isCacheValid(environment)) {
      console.log(`[EbayOrdersService] Returning cached orders for ${environment}`);
      return this.cache[environment].data;
    }
    return null;
  }

  /**
   * Update cache with fresh data
   */
  updateCache(environment, data) {
    this.cache[environment] = {
      data,
      timestamp: Date.now()
    };
    this.saveCacheToDisk(environment);
  }

  /**
   * Clear cache for specific environment
   */
  clearCache(environment) {
    if (environment) {
      this.cache[environment] = { data: null, timestamp: null };
      const cacheFile = environment === 'production' ? CACHE_FILE_PRODUCTION : CACHE_FILE_SANDBOX;
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
      }
    } else {
      // Clear all caches
      this.cache.sandbox = { data: null, timestamp: null };
      this.cache.production = { data: null, timestamp: null };
      [CACHE_FILE_SANDBOX, CACHE_FILE_PRODUCTION].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
    }
  }

  /**
   * Fetch orders from eBay Fulfillment API
   * @param {Object} options - { environment, limit, orderStatus, forceRefresh }
   */
  async fetchOrders(options = {}) {
    const {
      environment: envOverride,
      limit = 200,
      orderStatus = null,
      forceRefresh = false
    } = options;

    try {
      // Get eBay config for the target environment
      const ebayConfig = this.getEbayRuntimeConfig({ environment: envOverride });
      const environment = ebayConfig.environment;

      console.log(`[EbayOrdersService] Fetching orders for environment: ${environment}`);

      // Check cache first unless force refresh
      if (!forceRefresh) {
        const cachedOrders = this.getCachedOrders(environment);
        if (cachedOrders) {
          return {
            success: true,
            cached: true,
            environment,
            orders: cachedOrders.orders,
            total: cachedOrders.total,
            cacheAge: Date.now() - this.cache[environment].timestamp
          };
        }
      }

      // Get access token
      const accessToken = await this.getEbayAccessToken({ environment: envOverride });
      
      // Build API URL
      const apiBase = environment === 'production'
        ? 'https://api.ebay.com'
        : 'https://api.sandbox.ebay.com';

      let apiUrl = `${apiBase}/sell/fulfillment/v1/order?limit=${limit}`;
      
      // Add order status filter if specified
      if (orderStatus) {
        apiUrl += `&filter=orderfulfillmentstatus:${orderStatus}`;
      }

      console.log(`[EbayOrdersService] API URL: ${apiUrl}`);

      // Make API request
      const response = await axios.get(apiUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': ebayConfig.marketplaceId || 'EBAY_US'
        }
      });

      const orders = response.data.orders || [];
      const total = response.data.total || orders.length;

      console.log(`[EbayOrdersService] Fetched ${orders.length} orders (total: ${total})`);

      // Transform orders to a consistent format
      const transformedOrders = orders.map(order => this.transformOrder(order, environment));

      // Update cache
      const result = {
        orders: transformedOrders,
        total,
        timestamp: new Date().toISOString()
      };
      
      this.updateCache(environment, result);

      return {
        success: true,
        cached: false,
        environment,
        orders: transformedOrders,
        total,
        cacheAge: 0
      };

    } catch (error) {
      console.error('[EbayOrdersService] Error fetching orders:', error.message);
      
      // Check if it's an OAuth/permissions error
      const isOAuthError = error.response?.data?.errors?.some(e => 
        e.domain === 'OAuth' || 
        e.message?.toLowerCase().includes('token') ||
        e.message?.toLowerCase().includes('authorization')
      );
      
      const isScopeError = error.response?.data?.errors?.some(e =>
        e.message?.toLowerCase().includes('scope') ||
        e.message?.toLowerCase().includes('permission')
      );

      // If we have cached data, return it even if expired
      const cachedOrders = this.cache[envOverride || 'sandbox'].data;
      if (cachedOrders) {
        return {
          success: false,
          cached: true,
          stale: true,
          environment: envOverride || 'sandbox',
          orders: cachedOrders.orders,
          total: cachedOrders.total,
          error: error.message,
          errorType: isOAuthError ? 'oauth' : isScopeError ? 'scope' : 'api',
          suggestion: isOAuthError || isScopeError 
            ? 'Your eBay token may not have the sell.fulfillment scope. Please regenerate your OAuth token.'
            : null
        };
      }

      // Enhance error message for OAuth/scope issues
      if (isOAuthError || isScopeError) {
        const enhancedError = new Error(
          `OAuth/Permission Error: ${error.message}. Your eBay token may not have the required 'sell.fulfillment' scope. Please visit /api/ebay-auth-url to regenerate your token with the correct permissions.`
        );
        enhancedError.response = error.response;
        enhancedError.errorType = isOAuthError ? 'oauth' : 'scope';
        throw enhancedError;
      }

      throw error;
    }
  }

  /**
   * Transform eBay order to standardized format
   */
  transformOrder(ebayOrder, environment) {
    const lineItems = ebayOrder.lineItems || [];
    const buyer = ebayOrder.buyer || {};
    const fulfillmentStartInstructions = ebayOrder.fulfillmentStartInstructions || [{}];
    const shippingAddress = fulfillmentStartInstructions[0]?.shippingStep?.shipTo || {};

    return {
      orderId: ebayOrder.orderId,
      legacyOrderId: ebayOrder.legacyOrderId,
      orderFulfillmentStatus: ebayOrder.orderFulfillmentStatus,
      orderPaymentStatus: ebayOrder.orderPaymentStatus,
      creationDate: ebayOrder.creationDate,
      lastModifiedDate: ebayOrder.lastModifiedDate,
      
      // Buyer information
      buyer: {
        username: buyer.username,
        buyerRegistrationDate: buyer.buyerRegistrationDate
      },

      // Shipping address
      shippingAddress: {
        fullName: shippingAddress.fullName,
        contactAddress: shippingAddress.contactAddress,
        primaryPhone: shippingAddress.primaryPhone,
        email: shippingAddress.email
      },

      // Line items (products)
      lineItems: lineItems.map(item => ({
        lineItemId: item.lineItemId,
        legacyItemId: item.legacyItemId,
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
        total: item.total,
        deliveryCost: item.deliveryCost,
        lineItemFulfillmentStatus: item.lineItemFulfillmentStatus
      })),

      // Pricing
      pricingSummary: ebayOrder.pricingSummary,
      
      // Metadata
      source: 'ebay',
      environment,
      salesRecordReference: ebayOrder.salesRecordReference,
      
      // Raw data for reference
      _raw: ebayOrder
    };
  }

  /**
   * Get order counts by status
   */
  async getOrderCounts(environment) {
    try {
      const result = await this.fetchOrders({ environment });
      const orders = result.orders || [];

      const counts = {
        total: orders.length,
        notStarted: 0,
        inProgress: 0,
        fulfilled: 0,
        cancelled: 0,
        other: 0
      };

      orders.forEach(order => {
        const status = order.orderFulfillmentStatus;
        if (status === 'NOT_STARTED') counts.notStarted++;
        else if (status === 'IN_PROGRESS') counts.inProgress++;
        else if (status === 'FULFILLED') counts.fulfilled++;
        else if (status === 'CANCELLED') counts.cancelled++;
        else counts.other++;
      });

      return counts;
    } catch (error) {
      console.error('[EbayOrdersService] Error getting order counts:', error.message);
      return {
        total: 0,
        notStarted: 0,
        inProgress: 0,
        fulfilled: 0,
        cancelled: 0,
        other: 0,
        error: error.message
      };
    }
  }
}

module.exports = EbayOrdersService;
