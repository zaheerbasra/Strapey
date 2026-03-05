"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateAutomationRules = evaluateAutomationRules;
const queue_1 = require("../queue");
async function evaluateAutomationRules(context) {
    const actions = [];
    if (typeof context.inventory === 'number' && context.inventory < 5 && context.sku && context.channel) {
        await (0, queue_1.enqueue)('listingSync', 'listing.pause.low_inventory', { sku: context.sku, channel: context.channel });
        actions.push({ rule: 'IF inventory < 5', action: 'pause listing' });
    }
    if (context.newOrder?.order_id) {
        await (0, queue_1.enqueue)('shipping', 'shipping.label.generate', { orderId: context.newOrder.order_id });
        actions.push({ rule: 'IF new order detected', action: 'generate shipping label' });
    }
    if (typeof context.competitorPrice === 'number' &&
        typeof context.currentPrice === 'number' &&
        context.competitorPrice < context.currentPrice) {
        await (0, queue_1.enqueue)('listingSync', 'pricing.adjust.competitor_drop', {
            targetPrice: context.competitorPrice,
            sku: context.sku,
            channel: context.channel
        });
        actions.push({ rule: 'IF competitor price drops', action: 'adjust listing price' });
    }
    return actions;
}
