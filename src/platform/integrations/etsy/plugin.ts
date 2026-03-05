import { IntegrationPlugin } from '../../core/plugin/plugin-manager';

export const etsyPlugin: IntegrationPlugin = {
  key: 'etsy',
  channelName: 'Etsy',
  async createListing(payload) { return { provider: 'etsy', action: 'createListing', payload }; },
  async updateListing(payload) { return { provider: 'etsy', action: 'updateListing', payload }; },
  async pauseListing(payload) { return { provider: 'etsy', action: 'pauseListing', payload }; },
  async relistItem(payload) { return { provider: 'etsy', action: 'relistItem', payload }; },
  async deleteListing(payload) { return { provider: 'etsy', action: 'deleteListing', payload }; },
  async syncOrders() { return { provider: 'etsy', action: 'syncOrders', queued: true }; },
  async syncInventory(payload) { return { provider: 'etsy', action: 'syncInventory', payload, queued: true }; },
  async syncPricing(payload) { return { provider: 'etsy', action: 'syncPricing', payload, queued: true }; }
};
