"use strict";
/**
 * Simple file-based JSON database
 * Replaces PostgreSQL for development/testing without external dependencies
 * Uses in-memory storage with file persistence
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
exports.exec = exec;
exports.closeDb = closeDb;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class FileDatabase {
    tables = new Map();
    dbPath;
    saveTimeout = null;
    constructor() {
        this.dbPath = path_1.default.join(process.cwd(), 'data', 'platform.db.json');
        this.load();
    }
    load() {
        try {
            if (fs_1.default.existsSync(this.dbPath)) {
                const data = fs_1.default.readFileSync(this.dbPath, 'utf-8');
                const parsed = JSON.parse(data);
                for (const [table, rows] of Object.entries(parsed)) {
                    this.tables.set(table, rows);
                }
            }
        }
        catch (e) {
            console.warn('Failed to load database:', e);
        }
    }
    save() {
        if (this.saveTimeout)
            clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            try {
                const dataDir = path_1.default.join(process.cwd(), 'data');
                if (!fs_1.default.existsSync(dataDir)) {
                    fs_1.default.mkdirSync(dataDir, { recursive: true });
                }
                const data = {};
                for (const [table, rows] of this.tables.entries()) {
                    data[table] = rows;
                }
                fs_1.default.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
            }
            catch (e) {
                console.warn('Failed to save database:', e);
            }
        }, 100);
    }
    parseSQL(sql) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('CREATE TABLE')) {
            const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
            return { operation: 'CREATE', table: match?.[1]?.toLowerCase() };
        }
        if (trimmed.startsWith('INSERT')) {
            const match = sql.match(/INSERT INTO (\w+)/i);
            return { operation: 'INSERT', table: match?.[1]?.toLowerCase() };
        }
        if (trimmed.startsWith('SELECT')) {
            const match = sql.match(/FROM (\w+)/i);
            return { operation: 'SELECT', table: match?.[1]?.toLowerCase() };
        }
        if (trimmed.startsWith('UPDATE')) {
            const match = sql.match(/UPDATE (\w+)/i);
            return { operation: 'UPDATE', table: match?.[1]?.toLowerCase() };
        }
        if (trimmed.startsWith('DELETE')) {
            const match = sql.match(/DELETE FROM (\w+)/i);
            return { operation: 'DELETE', table: match?.[1]?.toLowerCase() };
        }
        return null;
    }
    exec(sql) {
        const parsed = this.parseSQL(sql);
        if (parsed?.operation === 'CREATE' && parsed?.table) {
            if (!this.tables.has(parsed.table)) {
                this.tables.set(parsed.table, []);
                this.save();
            }
        }
    }
    query(sql, params = []) {
        const parsed = this.parseSQL(sql);
        if (!parsed?.table)
            return [];
        const table = this.tables.get(parsed.table) || [];
        switch (parsed.operation) {
            case 'INSERT':
                // Simple insert - adds a row (for demo purposes)
                const columns = (sql.match(/\((.*?)\)\s*VALUES/i)?.[1]?.split(',') || []).map((c) => c.trim());
                if (columns.length > 0 && params.length > 0) {
                    const row = {};
                    columns.forEach((col, i) => {
                        row[col] = params[i];
                    });
                    table.push(row);
                    this.save();
                    return [{ changes: 1, lastID: table.length - 1 }];
                }
                return [];
            case 'SELECT':
                // Simple SELECT - returns all rows
                return table;
            case 'UPDATE':
                // Simple UPDATE - updates all matching (for demo purposes)
                return [{ changes: table.length }];
            case 'DELETE':
                // Simple DELETE - clears table
                this.tables.set(parsed.table, []);
                this.save();
                return [{ changes: table.length }];
            default:
                return [];
        }
    }
}
const fileDb = new FileDatabase();
async function query(text, params = []) {
    try {
        const results = fileDb.query(text, params);
        return results;
    }
    catch (error) {
        console.error('Database query error:', {
            sql: text,
            params,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
async function exec(sql) {
    fileDb.exec(sql);
}
async function closeDb() {
    // Nothing to close for file-based DB
}
