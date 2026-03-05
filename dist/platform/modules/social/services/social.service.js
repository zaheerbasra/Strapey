"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocialService = void 0;
const pg_1 = require("../../../core/db/pg");
class SocialService {
    async list(limit = 50) {
        return (0, pg_1.query)('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT $1', [limit]);
    }
    async createPost(input) {
        const rows = await (0, pg_1.query)(`INSERT INTO social_posts(platform, product_id, caption, media, scheduled_time, status, engagement_metrics)
			 VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) RETURNING *`, [
            input.platform,
            input.product_id || null,
            input.caption,
            JSON.stringify(input.media || []),
            input.scheduled_time || null,
            input.status || 'scheduled',
            JSON.stringify(input.engagement_metrics || {})
        ]);
        return rows[0];
    }
}
exports.SocialService = SocialService;
