/**
 * eBay Marketing API Integration
 * Manages promotional campaigns, ad campaigns, and promotions
 */

const axios = require('axios');

// Get eBay token - will be injected at runtime from server.js
let getEbayAccessTokenFn = null;

function setEbayAccessTokenFn(fn) {
  getEbayAccessTokenFn = fn;
}

async function getEbayAccessToken() {
  if (!getEbayAccessTokenFn) {
    throw new Error('eBay Access Token function not configured. Call setEbayAccessTokenFn() first.');
  }
  return getEbayAccessTokenFn();
}

class EbayMarketingIntegration {
  constructor() {
    this.baseUrl = 'https://api.ebay.com/sell/marketing/v1';
  }

  /**
   * Get authorization headers for eBay API
   */
  async getHeaders() {
    const token = await getEbayAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * List all ad campaigns from eBay
   */
  async listCampaigns(params = {}) {
    try {
      const headers = await this.getHeaders();
      const queryParams = new URLSearchParams({
        limit: params.limit || 50,
        offset: params.offset || 0,
        ...params
      });

      const response = await axios.get(
        `${this.baseUrl}/ad_campaign?${queryParams}`,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        campaigns: response.data.campaigns || [],
        total: response.data.total || 0,
        href: response.data.href
      };
    } catch (error) {
      console.error('Error listing eBay campaigns:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message,
        campaigns: []
      };
    }
  }

  /**
   * Get a specific campaign by ID
   */
  async getCampaign(campaignId) {
    try {
      const headers = await this.getHeaders();
      const response = await axios.get(
        `${this.baseUrl}/ad_campaign/${campaignId}`,
        { headers, timeout: 10000 }
      );

      return {
        success: true,
        campaign: response.data
      };
    } catch (error) {
      console.error('Error getting eBay campaign:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Create a new ad campaign on eBay
   */
  async createCampaign(campaignData) {
    try {
      const headers = await this.getHeaders();
      
      const payload = {
        campaignName: campaignData.name,
        campaignCriterion: {
          selectionRules: campaignData.selectionRules || []
        },
        fundingStrategy: {
          fundingModel: campaignData.fundingModel || 'COST_PER_CLICK',
          bidPercentage: campaignData.bidPercentage || '5.0'
        },
        startDate: campaignData.startDate,
        endDate: campaignData.endDate || null,
        marketplaceId: campaignData.marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      };

      const response = await axios.post(
        `${this.baseUrl}/ad_campaign`,
        payload,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        campaignId: response.data.campaignId,
        campaign: response.data
      };
    } catch (error) {
      console.error('Error creating eBay campaign:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Update an existing campaign
   */
  async updateCampaign(campaignId, updateData) {
    try {
      const headers = await this.getHeaders();
      
      const payload = {
        campaignName: updateData.name,
        campaignStatus: updateData.status || 'ACTIVE',
        fundingStrategy: updateData.fundingStrategy || {},
        endDate: updateData.endDate || null
      };

      const response = await axios.put(
        `${this.baseUrl}/ad_campaign/${campaignId}`,
        payload,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        campaign: response.data
      };
    } catch (error) {
      console.error('Error updating eBay campaign:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Delete/End a campaign
   */
  async deleteCampaign(campaignId) {
    try {
      const headers = await this.getHeaders();
      await axios.delete(
        `${this.baseUrl}/ad_campaign/${campaignId}`,
        { headers, timeout: 10000 }
      );

      return {
        success: true,
        message: 'Campaign deleted successfully'
      };
    } catch (error) {
      console.error('Error deleting eBay campaign:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Pause a campaign
   */
  async pauseCampaign(campaignId) {
    return this.updateCampaign(campaignId, { status: 'PAUSED' });
  }

  /**
   * Resume a campaign
   */
  async resumeCampaign(campaignId) {
    return this.updateCampaign(campaignId, { status: 'RUNNING' });
  }

  /**
   * Get campaign performance report
   */
  async getCampaignReport(campaignId, dateRange = {}) {
    try {
      const headers = await this.getHeaders();
      const queryParams = new URLSearchParams({
        campaign_ids: campaignId,
        start_date: dateRange.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: dateRange.endDate || new Date().toISOString(),
        ...dateRange
      });

      const response = await axios.get(
        `${this.baseUrl}/ad_report?${queryParams}`,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        report: response.data
      };
    } catch (error) {
      console.error('Error getting campaign report:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Sync campaigns from eBay to local database
   */
  async syncCampaignsFromEbay() {
    try {
      const result = await this.listCampaigns({ limit: 200 });
      if (!result.success) {
        return result;
      }

      const synced = [];
      for (const campaign of result.campaigns) {
        synced.push({
          ebay_campaign_id: campaign.campaignId,
          name: campaign.campaignName,
          status: campaign.campaignStatus,
          marketplace: campaign.marketplaceId,
          start_date: campaign.startDate,
          end_date: campaign.endDate,
          funding_model: campaign.fundingStrategy?.fundingModel,
          bid_percentage: campaign.fundingStrategy?.bidPercentage,
          synced_at: new Date().toISOString()
        });
      }

      return {
        success: true,
        synced: synced.length,
        campaigns: synced
      };
    } catch (error) {
      console.error('Error syncing campaigns:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create item promotion (e.g., percentage off, buy one get one)
   */
  async createItemPromotion(promotionData) {
    try {
      const headers = await this.getHeaders();
      
      const payload = {
        name: promotionData.name,
        promotionType: promotionData.type || 'ORDER_DISCOUNT',
        marketplaceId: promotionData.marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
        priority: promotionData.priority || 'UNSPECIFIED',
        startDate: promotionData.startDate,
        endDate: promotionData.endDate,
        discountBenefit: {
          amountOffItem: promotionData.discount?.amount,
          percentageOffItem: promotionData.discount?.percentage
        },
        inventoryCriterion: {
          inventoryItems: promotionData.items || []
        }
      };

      const response = await axios.post(
        `${this.baseUrl}/item_promotion`,
        payload,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        promotionId: response.data.promotionId,
        promotion: response.data
      };
    } catch (error) {
      console.error('Error creating item promotion:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * List all promotions
   */
  async listPromotions(params = {}) {
    try {
      const headers = await this.getHeaders();
      const queryParams = new URLSearchParams({
        limit: params.limit || 50,
        offset: params.offset || 0,
        marketplace_id: params.marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      });

      const response = await axios.get(
        `${this.baseUrl}/item_promotion?${queryParams}`,
        { headers, timeout: 15000 }
      );

      return {
        success: true,
        promotions: response.data.promotions || [],
        total: response.data.total || 0
      };
    } catch (error) {
      console.error('Error listing promotions:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message,
        promotions: []
      };
    }
  }
}

module.exports = { EbayMarketingIntegration, setEbayAccessTokenFn };
