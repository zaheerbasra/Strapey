import { createWorker } from '../../../core/queue';

export function registerMarketingWorkers() {
  return createWorker('marketing', async (job) => {
    if (job.name === 'marketing.campaign.execute') {
      return { ok: true, campaign_id: (job.data as any)?.campaign_id };
    }
  });
}
