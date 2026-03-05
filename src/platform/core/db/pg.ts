// Import SQLite as the database backend
export { query, exec as executeRaw, getDb, closeDb } from './sqlite';

// Legacy interface compatibility
export const pgPool = {
  query: async (text: string, params: unknown[] = []) => {
    const results = await import('./sqlite').then(m => m.query(text, params));
    return { rows: results };
  }
};
