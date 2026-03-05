/**
 * In-memory cache implementation using Node.js Map
 * Replaces Redis for development/testing without external dependencies
 */

interface CacheEntry {
  value: unknown;
  expiresAt?: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Clean up expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check if expired
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }

    return JSON.stringify(entry.value);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return 0;
    }
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return Array.from(this.store.keys()).filter((key) =>
      regex.test(key)
    );
  }

  async lpush(key: string, ...values: unknown[]): Promise<number> {
    let list = this.store.get(key)?.value as unknown[];
    if (!list || !Array.isArray(list)) list = [];
    list.unshift(...values);
    this.store.set(key, { value: list });
    return list.length;
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    let list = this.store.get(key)?.value as unknown[];
    if (!list || !Array.isArray(list)) list = [];
    list.push(...values);
    this.store.set(key, { value: list });
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.store.get(key)?.value as unknown[];
    if (!list || !Array.isArray(list) || list.length === 0) return null;
    const value = list.shift();
    if (list.length === 0) {
      this.store.delete(key);
    } else {
      this.store.set(key, { value: list });
    }
    return JSON.stringify(value);
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.store.get(key)?.value as unknown[];
    if (!list || !Array.isArray(list) || list.length === 0) return null;
    const value = list.pop();
    if (list.length === 0) {
      this.store.delete(key);
    } else {
      this.store.set(key, { value: list });
    }
    return JSON.stringify(value);
  }

  async lrange(key: string, start: number, stop: number): Promise<unknown[]> {
    const list = this.store.get(key)?.value as unknown[];
    if (!list || !Array.isArray(list)) return [];
    return list.slice(start, stop + 1);
  }

  async hset(key: string, field: string, value: unknown): Promise<number> {
    let hash = this.store.get(key)?.value as Record<string, unknown>;
    if (!hash || typeof hash !== 'object' || Array.isArray(hash)) hash = {};
    const isNew = !(field in hash);
    hash[field] = value;
    this.store.set(key, { value: hash });
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.store.get(key)?.value as Record<string, unknown>;
    if (!hash || typeof hash !== 'object') return null;
    const value = hash[field];
    return value !== undefined ? JSON.stringify(value) : null;
  }

  async hgetall(key: string): Promise<Record<string, unknown>> {
    const hash = this.store.get(key)?.value as Record<string, unknown>;
    if (!hash || typeof hash !== 'object' || Array.isArray(hash)) return {};
    return hash;
  }

  async hkeys(key: string): Promise<string[]> {
    const hash = this.store.get(key)?.value as Record<string, unknown>;
    if (!hash || typeof hash !== 'object' || Array.isArray(hash)) return [];
    return Object.keys(hash);
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.store.get(key)?.value as Set<unknown>;
    if (!set || !(set instanceof Set)) return [];
    return Array.from(set).map((v) => JSON.stringify(v));
  }

  async sadd(key: string, ...members: unknown[]): Promise<number> {
    let set = this.store.get(key)?.value as Set<unknown>;
    if (!set || !(set instanceof Set)) set = new Set();
    const sizeBefore = set.size;
    members.forEach((m) => set.add(m));
    this.store.set(key, { value: set });
    return set.size - sizeBefore;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.store.delete(key);
      }
    }
  }

  async quit(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

export const memoryCache = new MemoryCache();
