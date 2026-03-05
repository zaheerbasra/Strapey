"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAudit = logAudit;
const pg_1 = require("../db/pg");
async function logAudit(params) {
    await (0, pg_1.query)(`INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
     VALUES($1,$2,$3,$4,$5::jsonb)`, [params.actor_id || null, params.action, params.resource_type, params.resource_id || null, JSON.stringify(params.metadata || {})]);
}
