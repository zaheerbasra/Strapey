import { enqueue } from '../../../core/queue';

export async function enqueuePriceOptimizationJob(productId: string) {
  return enqueue('listingSync', 'product.price.optimize', { productId });
}
