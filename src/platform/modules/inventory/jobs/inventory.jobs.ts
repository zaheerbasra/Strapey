import { enqueue } from '../../../core/queue';

export async function enqueueInventorySync(channel: string, sku: string, quantity: number) {
  return enqueue('listingSync', 'inventory.sync', { channel, sku, quantity });
}
