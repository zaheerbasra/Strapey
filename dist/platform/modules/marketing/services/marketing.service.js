"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketingService = void 0;
const queue_1 = require("../../../core/queue");
const pg_1 = require("../../../core/db/pg");
class MarketingService {
    async listCampaigns(limit = 50) {
        return (0, pg_1.query)('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT $1', [limit]);
    }
    async createCampaign(input) {
        const rows = await (0, pg_1.query)(`INSERT INTO marketing_campaigns(campaign_name, channel, discount_type, discount_value, schedule_at, status, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`, [
            input.campaign_name,
            input.channel,
            input.discount_type || 'percentage',
            Number(input.discount_value || 0),
            input.schedule_at || null,
            input.status || 'scheduled',
            JSON.stringify(input.metadata || {})
        ]);
        const result = rows[0];
        await (0, queue_1.enqueue)('marketing', 'marketing.campaign.execute', { campaign_id: result.campaign_id });
        return result;
    }
}
exports.MarketingService = MarketingService;
