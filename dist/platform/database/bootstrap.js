"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySchema = applySchema;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sqlite_1 = require("../core/db/sqlite");
async function applySchema() {
    const filePath = path_1.default.join(process.cwd(), 'src', 'platform', 'database', 'schema-sqlite.sql');
    const sql = fs_1.default.readFileSync(filePath, 'utf-8');
    (0, sqlite_1.exec)(sql);
    return { applied: true };
}
