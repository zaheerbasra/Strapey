"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wordpressPlugin = void 0;
exports.wordpressPlugin = {
    key: 'wordpress',
    channelName: 'WordPress/WooCommerce',
    async createListing(payload) { return { provider: 'wordpress', action: 'createProduct', payload }; },
    async updateListing(payload) { return { provider: 'wordpress', action: 'updateProduct', payload }; },
    async pauseListing(payload) { return { provider: 'wordpress', action: 'setDraft', payload }; },
    async relistItem(payload) { return { provider: 'wordpress', action: 'setPublish', payload }; },
    async deleteListing(payload) { return { provider: 'wordpress', action: 'deleteProduct', payload }; },
    async syncOrders() { return { provider: 'wordpress', action: 'syncOrders', queued: true }; },
    async syncInventory(payload) { return { provider: 'wordpress', action: 'syncInventory', payload, queued: true }; },
    async syncPricing(payload) { return { provider: 'wordpress', action: 'syncPricing', payload, queued: true }; }
};
