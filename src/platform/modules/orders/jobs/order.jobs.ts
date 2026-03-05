import { enqueue } from '../../../core/queue';

export async function enqueueOrderSync(channel: string) {
  return enqueue('orderSync', 'orders.sync.channel', { channel });
}
