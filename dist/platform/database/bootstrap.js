"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySchema = applySchema;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pg_1 = require("../core/db/pg");
async function applySchema() {
    const filePath = path_1.default.join(process.cwd(), 'src', 'platform', 'database', 'schema.sql');
    const sql = fs_1.default.readFileSync(filePath, 'utf-8');
    await pg_1.pgPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    await pg_1.pgPool.query(sql);
    return { applied: true };
}
