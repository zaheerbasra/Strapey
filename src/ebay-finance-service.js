/**
 * eBay Finance Service
 * Fetches and maps granular fees for orders using /sell/finances/v1/transaction
 */

const axios = require('axios');

class EbayFinanceService {
  constructor(getEbayRuntimeConfig, getEbayAccessToken) {
    this.getEbayRuntimeConfig = getEbayRuntimeConfig;
    this.getEbayAccessToken = getEbayAccessToken;
  }

  /**
   * Fetch finance transactions for a given orderId
   * Returns array of fee breakdowns (transaction fees, shipping label, sales tax, promotional fees, refund fees)
   */
  async fetchOrderFees(orderId, environment = 'production') {
    const ebayConfig = this.getEbayRuntimeConfig({ environment });
    const accessToken = await this.getEbayAccessToken({ environment });
    const apiBase = environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
    const apiUrl = `${apiBase}/sell/finances/v1/transaction?filter=orderId:${orderId}`;
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': ebayConfig.marketplaceId || 'EBAY_US'
      }
    });
    // Parse transactions
    const transactions = response.data.transactions || [];
    const fees = [];
    for (const tx of transactions) {
      if (tx.transactionType === 'SALE') {
        // Transaction fees
        if (tx.feeDetail) {
          for (const fee of tx.feeDetail) {
            fees.push({
              type: fee.feeType,
              amount: fee.amount.value,
              currency: fee.amount.currency
            });
          }
        }
      }
      if (tx.transactionType === 'SHIPPING_LABEL') {
        // Shipping label fee
        fees.push({
          type: 'SHIPPING_LABEL',
          amount: tx.amount.value,
          currency: tx.amount.currency
        });
      }
      if (tx.transactionType === 'TAX') {
        // Sales tax
        fees.push({
          type: 'SALES_TAX',
          amount: tx.amount.value,
          currency: tx.amount.currency
        });
      }
      // Add more transaction types as needed
    }
    return fees;
  }
}

module.exports = EbayFinanceService;
