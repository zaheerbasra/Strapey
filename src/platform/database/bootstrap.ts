import fs from 'fs';
import path from 'path';
import { exec } from '../core/db/sqlite';

export async function applySchema() {
  const filePath = path.join(process.cwd(), 'src', 'platform', 'database', 'schema-sqlite.sql');
  const sql = fs.readFileSync(filePath, 'utf-8');
  exec(sql);
  return { applied: true };
}
