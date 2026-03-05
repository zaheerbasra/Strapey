import { enqueue } from '../../../core/queue';
import { query } from '../../../core/db/pg';

export class MarketingService {
  async listCampaigns(limit = 50) {
    return query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT $1', [limit]);
  }

  async createCampaign(input: any) {
    const rows = await query(
      `INSERT INTO marketing_campaigns(campaign_name, channel, discount_type, discount_value, schedule_at, status, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [
        input.campaign_name,
        input.channel,
        input.discount_type || 'percentage',
        Number(input.discount_value || 0),
        input.schedule_at || null,
        input.status || 'scheduled',
        JSON.stringify(input.metadata || {})
      ]
    );

    const result: any = rows[0];
    await enqueue('marketing', 'marketing.campaign.execute', { campaign_id: result.campaign_id });
    return result;
  }
}
