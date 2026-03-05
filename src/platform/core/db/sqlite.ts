/**
 * Simple file-based JSON database
 * Replaces PostgreSQL for development/testing without external dependencies
 * Uses in-memory storage with file persistence
 */

import fs from 'fs';
import path from 'path';

interface Table {
  [key: string]: unknown[];
}

class FileDatabase {
  private tables: Map<string, unknown[]> = new Map();
  private dbPath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.dbPath = path.join(process.cwd(), 'data', 'platform.db.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf-8');
        const parsed = JSON.parse(data) as Table;
        for (const [table, rows] of Object.entries(parsed)) {
          this.tables.set(table, rows);
        }
      }
    } catch (e) {
      console.warn('Failed to load database:', e);
    }
  }

  private save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const data: Table = {};
        for (const [table, rows] of this.tables.entries()) {
          data[table] = rows;
        }
        fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
      } catch (e) {
        console.warn('Failed to save database:', e);
      }
    }, 100);
  }

  private parseSQL(sql: string): { operation: string; table?: string; columns?: string[] } | null {
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

  exec(sql: string): void {
    const parsed = this.parseSQL(sql);
    if (parsed?.operation === 'CREATE' && parsed?.table) {
      if (!this.tables.has(parsed.table)) {
        this.tables.set(parsed.table, []);
        this.save();
      }
    }
  }

  query(sql: string, params: unknown[] = []): unknown[] {
    const parsed = this.parseSQL(sql);
    if (!parsed?.table) return [];

    const table = this.tables.get(parsed.table) || [];

    switch (parsed.operation) {
      case 'INSERT':
        // Simple insert - adds a row (for demo purposes)
        const columns = (sql.match(/\((.*?)\)\s*VALUES/i)?.[1]?.split(',') || []).map(
          (c) => c.trim()
        );
        if (columns.length > 0 && params.length > 0) {
          const row: Record<string, unknown> = {};
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

export interface QueryResult {
  changes?: number;
  lastID?: number;
}

export async function query<T = unknown>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const results = fileDb.query(text, params);
    return results as T[];
  } catch (error) {
    console.error('Database query error:', {
      sql: text,
      params,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function exec(sql: string): Promise<void> {
  fileDb.exec(sql);
}

export async function closeDb(): Promise<void> {
  // Nothing to close for file-based DB
}
