import { query } from '../../../core/db/pg';

export class SocialService {
	async list(limit = 50) {
		return query('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT $1', [limit]);
	}

	async createPost(input: any) {
		const rows = await query(
			`INSERT INTO social_posts(platform, product_id, caption, media, scheduled_time, status, engagement_metrics)
			 VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) RETURNING *`,
			[
				input.platform,
				input.product_id || null,
				input.caption,
				JSON.stringify(input.media || []),
				input.scheduled_time || null,
				input.status || 'scheduled',
				JSON.stringify(input.engagement_metrics || {})
			]
		);
		return rows[0];
	}
}
