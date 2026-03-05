"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pgPool = void 0;
exports.query = query;
const pg_1 = require("pg");
const env_1 = require("../../config/env");
exports.pgPool = new pg_1.Pool({
    connectionString: env_1.env.postgresUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
async function query(text, params = []) {
    const result = await exports.pgPool.query(text, params);
    return result.rows;
}
