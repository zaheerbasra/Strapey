import { enqueue } from '../queue';

export async function evaluateAutomationRules(context: {
  inventory?: number;
  sku?: string;
  channel?: string;
  newOrder?: { order_id: string; channel: string };
  competitorPrice?: number;
  currentPrice?: number;
}) {
  const actions: Array<{ rule: string; action: string }> = [];

  if (typeof context.inventory === 'number' && context.inventory < 5 && context.sku && context.channel) {
    await enqueue('listingSync', 'listing.pause.low_inventory', { sku: context.sku, channel: context.channel });
    actions.push({ rule: 'IF inventory < 5', action: 'pause listing' });
  }

  if (context.newOrder?.order_id) {
    await enqueue('shipping', 'shipping.label.generate', { orderId: context.newOrder.order_id });
    actions.push({ rule: 'IF new order detected', action: 'generate shipping label' });
  }

  if (
    typeof context.competitorPrice === 'number' &&
    typeof context.currentPrice === 'number' &&
    context.competitorPrice < context.currentPrice
  ) {
    await enqueue('listingSync', 'pricing.adjust.competitor_drop', {
      targetPrice: context.competitorPrice,
      sku: context.sku,
      channel: context.channel
    });
    actions.push({ rule: 'IF competitor price drops', action: 'adjust listing price' });
  }

  return actions;
}
