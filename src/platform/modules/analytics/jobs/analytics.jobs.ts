import { enqueue } from '../../../core/queue';

export async function enqueueDailyRollup() {
  return enqueue('marketing', 'analytics.daily.rollup', { at: new Date().toISOString() });
}
