import { IntegrationPlugin } from '../../core/plugin/plugin-manager';

export const socialPlugin: IntegrationPlugin = {
  key: 'social',
  channelName: 'Social Automation',
  async createListing(payload) { return { provider: 'social', action: 'createPost', payload }; },
  async updateListing(payload) { return { provider: 'social', action: 'updatePost', payload }; },
  async pauseListing(payload) { return { provider: 'social', action: 'pausePost', payload }; },
  async relistItem(payload) { return { provider: 'social', action: 'reschedulePost', payload }; },
  async deleteListing(payload) { return { provider: 'social', action: 'deletePost', payload }; },
  async syncOrders() { return { provider: 'social', action: 'noop' }; },
  async syncInventory(payload) { return { provider: 'social', action: 'syncCatalog', payload }; },
  async syncPricing(payload) { return { provider: 'social', action: 'syncPricing', payload }; }
};
