import { query } from '../db/pg';

export async function logAudit(params: {
  actor_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
     VALUES($1,$2,$3,$4,$5::jsonb)`,
    [params.actor_id || null, params.action, params.resource_type, params.resource_id || null, JSON.stringify(params.metadata || {})]
  );
}
