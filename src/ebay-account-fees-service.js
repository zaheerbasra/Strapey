/**
 * eBay Account Fees Service
 * Uses the legacy Trading API's GetAccount call (authenticated with the existing OAuth
 * access token via the X-EBAY-API-IAF-TOKEN header - no extra OAuth scope needed) to pull
 * per-order Ad Fee (Promoted Listings) and Final Value Fee entries, keyed by OrderId.
 * This is the only verified source for ad fee data - the Fulfillment API doesn't expose it,
 * and the Finances API requires a sell.finances OAuth scope this account doesn't have.
 */

const axios = require('axios');

const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes - GetAccount pagination is expensive
const MAX_PAGES = 15; // ~3000 entries; empirically covers 1-2 weeks of activity on this account
const ENTRIES_PER_PAGE = 200;

class EbayAccountFeesService {
  constructor(getEbayRuntimeConfig, getEbayAccessToken) {
    this.getEbayRuntimeConfig = getEbayRuntimeConfig;
    this.getEbayAccessToken = getEbayAccessToken;
    this.cache = {
      sandbox: { data: null, timestamp: null },
      production: { data: null, timestamp: null }
    };
  }

  isCacheValid(environment) {
    const cached = this.cache[environment];
    if (!cached.data || !cached.timestamp) return false;
    return (Date.now() - cached.timestamp) < CACHE_DURATION_MS;
  }

  /**
   * Fetch the account fee ledger and return a map of orderId -> { adFee, transactionFee }.
   * Pages through GetAccount (most-recent-first) until every orderId in `orderIds` has been
   * found or MAX_PAGES is hit - whichever comes first.
   */
  async fetchAccountFeesMap(options = {}) {
    const { environment: envOverride, orderIds = [], forceRefresh = false } = options;
    const ebayConfig = this.getEbayRuntimeConfig({ environment: envOverride });
    const environment = ebayConfig.environment;

    if (!forceRefresh && this.isCacheValid(environment)) {
      return this.cache[environment].data;
    }

    const accessToken = await this.getEbayAccessToken({ environment: envOverride });
    const apiBase = environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-DEV-NAME': ebayConfig.devId,
      'X-EBAY-API-APP-NAME': ebayConfig.clientId,
      'X-EBAY-API-CERT-NAME': ebayConfig.certId,
      'X-EBAY-API-CALL-NAME': 'GetAccount',
      'X-EBAY-API-SITEID': ebayConfig.siteId || '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml'
    };

    const feesByOrderId = {};
    const wantedOrderIds = new Set(orderIds);
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= MAX_PAGES) {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<GetAccountRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <AccountEntrySortType>AccountEntryCreatedTimeDescending</AccountEntrySortType>
  <ExcludeBalance>true</ExcludeBalance>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Pagination>
    <EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetAccountRequest>`;

      const response = await axios.post(`${apiBase}/ws/api.dll`, body, { headers, timeout: 30000 });
      const xml = response.data;

      const ackMatch = /<Ack>([^<]+)<\/Ack>/.exec(xml);
      if (ackMatch && ackMatch[1] === 'Failure') {
        const errMsg = /<LongMessage>([^<]+)<\/LongMessage>/.exec(xml);
        throw new Error(`GetAccount failed: ${errMsg ? errMsg[1] : 'unknown error'}`);
      }

      const blocks = xml.split('<AccountEntry>').slice(1)
        .map(s => '<AccountEntry>' + s.split('</AccountEntry>')[0] + '</AccountEntry>');

      for (const block of blocks) {
        const orderIdMatch = /<OrderId>([^<]+)<\/OrderId>/.exec(block);
        if (!orderIdMatch) continue;
        const orderId = orderIdMatch[1];

        const typeMatch = /<AccountDetailsEntryType>([^<]+)<\/AccountDetailsEntryType>/.exec(block);
        const amountMatch = /<GrossDetailAmount[^>]*>([^<]+)<\/GrossDetailAmount>/.exec(block);
        const type = typeMatch ? typeMatch[1] : null;
        const amount = amountMatch ? Number(amountMatch[1]) : 0;
        if (!type) continue;

        if (!feesByOrderId[orderId]) {
          feesByOrderId[orderId] = { adFee: 0, transactionFee: 0 };
        }
        if (type === 'FeeAd') {
          feesByOrderId[orderId].adFee += amount;
        } else if (type === 'FinalValueFee' || type === 'FinalValueFeeFixedFeePerOrder') {
          feesByOrderId[orderId].transactionFee += amount;
        }
      }

      const hasMoreMatch = /<HasMoreEntries>(true|false)<\/HasMoreEntries>/.exec(xml);
      hasMore = hasMoreMatch ? hasMoreMatch[1] === 'true' : false;

      if (wantedOrderIds.size > 0 && [...wantedOrderIds].every(id => feesByOrderId[id])) {
        break;
      }

      page++;
    }

    this.cache[environment] = { data: feesByOrderId, timestamp: Date.now() };
    return feesByOrderId;
  }
}

module.exports = EbayAccountFeesService;
