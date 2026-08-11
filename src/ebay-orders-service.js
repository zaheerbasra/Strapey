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
// eBay's orderfulfillmentstatus filter only supports specific two-value combos, not exact
// single-status matches - so we fetch this many raw orders per request and filter/paginate
// ourselves (see fetchOrders). Known limitation: once total order volume exceeds this cap,
// older orders outside this fetch window won't be included in status-filtered results.
const EBAY_FETCH_CAP = 200;

class EbayOrdersService {
    /**
     * Inject finance service for granular fee extraction
     */
    setFinanceService(financeService) {
      this.financeService = financeService;
    }
    /**
     * Inject account fees service (Trading API GetAccount) for ad fee + transaction fee extraction
     */
    setAccountFeesService(accountFeesService) {
      this.accountFeesService = accountFeesService;
    }
  constructor(getEbayRuntimeConfig, getEbayAccessToken) {
    this.getEbayRuntimeConfig = getEbayRuntimeConfig;
    this.getEbayAccessToken = getEbayAccessToken;
    // Keyed by cache key (status/limit/offset combo) - see buildCacheKey(). A single blob per
    // environment would silently ignore whatever filters were actually requested.
    this.cache = { sandbox: {}, production: {} };
    this.loadCacheFromDisk();
  }

  /**
   * Load cache from disk on startup
   */
  loadCacheFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE_SANDBOX)) {
        this.cache.sandbox = JSON.parse(fs.readFileSync(CACHE_FILE_SANDBOX, 'utf8')) || {};
      }
      if (fs.existsSync(CACHE_FILE_PRODUCTION)) {
        this.cache.production = JSON.parse(fs.readFileSync(CACHE_FILE_PRODUCTION, 'utf8')) || {};
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
      fs.writeFileSync(cacheFile, JSON.stringify(this.cache[environment], null, 2));
    } catch (error) {
      console.error('[EbayOrdersService] Error saving cache to disk:', error.message);
    }
  }

  /**
   * Cache key incorporating every filter that changes what eBay actually returns -
   * without this, a cache hit for one filter combo would be served for a different one.
   */
  buildCacheKey({ orderStatus, limit, offset }) {
    return `${orderStatus || 'ALL'}::${limit}::${offset || 0}`;
  }

  /**
   * Check if cache is valid
   */
  isCacheValid(environment, cacheKey) {
    const entry = this.cache[environment]?.[cacheKey];
    if (!entry || !entry.data || !entry.timestamp) return false;

    const now = Date.now();
    const age = now - entry.timestamp;
    return age < CACHE_DURATION_MS;
  }

  /**
   * Get cached orders if available and valid
   */
  getCachedOrders(environment, cacheKey) {
    if (this.isCacheValid(environment, cacheKey)) {
      console.log(`[EbayOrdersService] Returning cached orders for ${environment} (${cacheKey})`);
      return this.cache[environment][cacheKey].data;
    }
    return null;
  }

  /**
   * Update cache with fresh data
   */
  updateCache(environment, cacheKey, data) {
    if (!this.cache[environment]) this.cache[environment] = {};
    this.cache[environment][cacheKey] = {
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
      this.cache[environment] = {};
      const cacheFile = environment === 'production' ? CACHE_FILE_PRODUCTION : CACHE_FILE_SANDBOX;
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
      }
    } else {
      // Clear all caches
      this.cache.sandbox = {};
      this.cache.production = {};
      [CACHE_FILE_SANDBOX, CACHE_FILE_PRODUCTION].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
    }
  }

  /**
   * Fetch orders from eBay Fulfillment API
   * @param {Object} options - { environment, limit, offset, orderStatus, forceRefresh }
   */
  async fetchOrders(options = {}) {
    const {
      environment: envOverride,
      limit = 10,
      offset = 0,
      orderStatus = null,
      forceRefresh = false
    } = options;

    let environment;
    let cacheKey;

    try {
      // Get eBay config for the target environment
      const ebayConfig = this.getEbayRuntimeConfig({ environment: envOverride });
      environment = ebayConfig.environment;
      cacheKey = this.buildCacheKey({ orderStatus, limit, offset });

      console.log(`[EbayOrdersService] Fetching orders for environment: ${environment} (status=${orderStatus || 'ALL'}, limit=${limit}, offset=${offset})`);

      // Check cache first unless force refresh
      if (!forceRefresh) {
        const cachedOrders = this.getCachedOrders(environment, cacheKey);
        if (cachedOrders) {
          return {
            success: true,
            cached: true,
            environment,
            orders: cachedOrders.orders,
            total: cachedOrders.total,
            limit,
            offset,
            cacheAge: Date.now() - this.cache[environment][cacheKey].timestamp
          };
        }
      }

      // Get access token
      const accessToken = await this.getEbayAccessToken({ environment: envOverride });

      // Build API URL
      const apiBase = environment === 'production'
        ? 'https://api.ebay.com'
        : 'https://api.sandbox.ebay.com';

      // eBay's orderfulfillmentstatus filter rejects bare single values (confirmed: passing
      // just "NOT_STARTED" returns error 30800 "Invalid filter value") - it only supports two
      // specific two-value combos. CANCELLED isn't part of this enum at all - cancellation is
      // tracked via the separate cancelStatus.cancelState field. Simplest correct fix: fetch an
      // unfiltered superset from eBay (capped) and match the exact requested status ourselves,
      // then apply our own offset/limit slice for pagination - this also means the expensive
      // per-order fee enrichment below only ever runs on the `limit` orders actually being
      // displayed, not the whole superset.
      const apiUrl = `${apiBase}/sell/fulfillment/v1/order?limit=${EBAY_FETCH_CAP}`;

      console.log(`[EbayOrdersService] API URL: ${apiUrl}`);

      // Make API request
      const response = await axios.get(apiUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': ebayConfig.marketplaceId || 'EBAY_US'
        }
      });

      const rawOrders = response.data.orders || [];

      const matchesStatus = (order) => {
        if (!orderStatus) return true;
        if (orderStatus === 'CANCELLED') {
          return !!(order.cancelStatus?.cancelState && order.cancelStatus.cancelState !== 'NONE_REQUESTED');
        }
        return order.orderFulfillmentStatus === orderStatus;
      };

      const matchingOrders = rawOrders.filter(matchesStatus);
      const total = matchingOrders.length;
      const orders = matchingOrders.slice(offset, offset + limit);

      console.log(`[EbayOrdersService] Fetched ${rawOrders.length} orders from eBay, ${total} match status=${orderStatus || 'ALL'}, returning page of ${orders.length}`);

      // Transform orders to a consistent format
      let transformedOrders = orders.map(order => this.transformOrder(order, environment));

      // If financeService is injected, enrich each order with granular fees
      if (this.financeService) {
        // Fetch granular fees for each order
        const feePromises = orders.map(order => {
          if (order.orderId) {
            return this.financeService.fetchOrderFees(order.orderId, environment).catch(() => []);
          }
          return Promise.resolve([]);
        });
        const allFees = await Promise.all(feePromises);
        // Map granular fees to transformed orders
        transformedOrders = transformedOrders.map((order, idx) => ({
          ...order,
          granularFees: allFees[idx] || []
        }));
      }

      // If accountFeesService is injected, enrich with ad fee + transaction fee from GetAccount ledger
      if (this.accountFeesService) {
        try {
          const orderIds = transformedOrders.map(o => o.orderId).filter(Boolean);
          const feesByOrderId = await this.accountFeesService.fetchAccountFeesMap({ environment, orderIds });
          transformedOrders = transformedOrders.map(order => this.applyAccountFees(order, feesByOrderId[order.orderId]));
        } catch (error) {
          console.error('[EbayOrdersService] Error fetching account fees:', error.message);
        }
      }

      // Update cache
      const result = {
        orders: transformedOrders,
        total,
        timestamp: new Date().toISOString()
      };

      this.updateCache(environment, cacheKey, result);

      return {
        success: true,
        cached: false,
        environment,
        orders: transformedOrders,
        total,
        limit,
        offset,
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

      // If we have cached data for this same filter combo, return it even if expired
      const fallbackEnv = environment || envOverride || 'sandbox';
      const cachedEntry = cacheKey ? this.cache[fallbackEnv]?.[cacheKey] : null;
      if (cachedEntry?.data) {
        return {
          success: false,
          cached: true,
          stale: true,
          environment: fallbackEnv,
          orders: cachedEntry.data.orders,
          total: cachedEntry.data.total,
          limit,
          offset,
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

    // Extract payment details
    const pricing = ebayOrder.pricingSummary || {};
    const marketplaceFee = ebayOrder.totalMarketplaceFee?.value || null;
    const shippingLabel = ebayOrder.shippingLabelCost?.value || null;
    // Sales tax
    let salesTax = null;
    if (lineItems[0]?.ebayCollectAndRemitTaxes && Array.isArray(lineItems[0].ebayCollectAndRemitTaxes)) {
      const taxObj = lineItems[0].ebayCollectAndRemitTaxes.find(t => t.taxType === 'STATE_SALES_TAX');
      salesTax = taxObj ? Number(taxObj.amount?.value || 0) : null;
    }
    // Order total: pricingSummary.total excludes marketplace-collected sales tax, but
    // totalMarketplaceFee is calculated against totalFeeBasisAmount, which already includes it -
    // that's the figure that matches the "Order total" eBay shows the buyer/seller.
    const orderTotal = ebayOrder.totalFeeBasisAmount?.value != null
      ? Number(ebayOrder.totalFeeBasisAmount.value)
      : Number(pricing.total?.value || 0) + (salesTax || 0);
    // eBay charges: everything eBay collects/deducts from the order.
    // adFee starts null here - applyAccountFees() fills it in from the GetAccount ledger
    // (Trading API) after this order list comes back, since ad fee isn't in the Fulfillment
    // API at all. shippingLabel stays unavailable - not exposed by any eBay API when the
    // label wasn't purchased through eBay's own label service (see feesNote).
    let ebayCharges = 0;
    if (salesTax) ebayCharges += Number(salesTax);
    if (marketplaceFee) ebayCharges += Number(marketplaceFee);
    if (shippingLabel) ebayCharges += Number(shippingLabel);
    // Order earnings: order total minus everything eBay charges (mirrors eBay's own math)
    const orderEarnings = Number((orderTotal - ebayCharges).toFixed(2));
    // Sale price
    const salePrice = lineItems[0]?.total?.value || pricing.total?.value || null;
    // Buyer name
    const buyerName = shippingAddress.fullName || buyer.username || '';

    // Finance API integration for granular fees
    // Actual granularFees are injected in fetchOrders

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
        buyerRegistrationDate: buyer.buyerRegistrationDate,
        name: buyerName
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
      pricingSummary: pricing,
      // New fields for UI
      orderEarnings,
      ebayCharges: ebayCharges.toFixed(2),
      salesTax,
      salePrice,
      orderTotal,
      // Fee breakdown columns - transactionFee is confirmed accurate (Fulfillment API).
      // adFee is filled in by applyAccountFees() from the GetAccount ledger when available.
      // shippingLabelFee is always null - not exposed by any eBay API for labels not
      // purchased through eBay's own shipping service.
      transactionFee: marketplaceFee != null ? Number(marketplaceFee) : null,
      adFee: null,
      shippingLabelFee: null,
      // False until shipping label cost can be sourced - eBay Charges/Order Earnings are
      // understated by that amount until then
      feesComplete: false,
      feesNote: 'Missing shipping label cost (not purchased via eBay label service - not exposed by any eBay API)',
      // Metadata
      source: 'ebay',
      environment,
      salesRecordReference: ebayOrder.salesRecordReference,
      // Granular fees (populated in fetchOrders)
      granularFees: [],
      // Raw data for reference
      _raw: ebayOrder
    };
  }

  /**
   * Merge ad fee + transaction fee found in the GetAccount ledger into a transformed order,
   * and recompute eBay Charges / Order Earnings from the more complete figures.
   * Leaves the order untouched if no ledger entry was found for it (e.g. too old for the
   * page window fetched) - falling back to the sales-tax + Fulfillment-API-fee-only estimate.
   */
  applyAccountFees(order, ledgerFees) {
    if (!ledgerFees) return order;

    const salesTax = order.salesTax || 0;
    // Ledger's FinalValueFee + FinalValueFeeFixedFeePerOrder should equal Fulfillment API's
    // totalMarketplaceFee - prefer the ledger figure since it's itemized, fall back otherwise.
    const transactionFee = ledgerFees.transactionFee || order.transactionFee || 0;
    const adFee = ledgerFees.adFee || 0;
    const ebayCharges = Number((salesTax + transactionFee + adFee).toFixed(2));
    const orderEarnings = Number((order.orderTotal - ebayCharges).toFixed(2));

    return {
      ...order,
      transactionFee: Number(transactionFee.toFixed(2)),
      adFee: Number(adFee.toFixed(2)),
      ebayCharges: ebayCharges.toFixed(2),
      orderEarnings,
      feesNote: 'Missing shipping label cost (not purchased via eBay label service - not exposed by any eBay API)'
    };
  }

  /**
   * Get order counts by status
   */
  async getOrderCounts(environment) {
    try {
      const result = await this.fetchOrders({ environment, limit: 200 });
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
