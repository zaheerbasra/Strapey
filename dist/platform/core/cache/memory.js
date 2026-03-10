"use strict";
/**
 * In-memory cache implementation using Node.js Map
 * Replaces Redis for development/testing without external dependencies
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryCache = void 0;
class MemoryCache {
    store = new Map();
    cleanupInterval = null;
    constructor() {
        // Clean up expired entries every 60 seconds
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }
    async get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        // Check if expired
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return null;
        }
        return JSON.stringify(entry.value);
    }
    async set(key, value, ttlSeconds) {
        const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
        this.store.set(key, { value, expiresAt });
    }
    async del(key) {
        return this.store.delete(key) ? 1 : 0;
    }
    async exists(key) {
        const entry = this.store.get(key);
        if (!entry)
            return 0;
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return 0;
        }
        return 1;
    }
    async keys(pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return Array.from(this.store.keys()).filter((key) => regex.test(key));
    }
    async lpush(key, ...values) {
        let list = this.store.get(key)?.value;
        if (!list || !Array.isArray(list))
            list = [];
        list.unshift(...values);
        this.store.set(key, { value: list });
        return list.length;
    }
    async rpush(key, ...values) {
        let list = this.store.get(key)?.value;
        if (!list || !Array.isArray(list))
            list = [];
        list.push(...values);
        this.store.set(key, { value: list });
        return list.length;
    }
    async lpop(key) {
        const list = this.store.get(key)?.value;
        if (!list || !Array.isArray(list) || list.length === 0)
            return null;
        const value = list.shift();
        if (list.length === 0) {
            this.store.delete(key);
        }
        else {
            this.store.set(key, { value: list });
        }
        return JSON.stringify(value);
    }
    async rpop(key) {
        const list = this.store.get(key)?.value;
        if (!list || !Array.isArray(list) || list.length === 0)
            return null;
        const value = list.pop();
        if (list.length === 0) {
            this.store.delete(key);
        }
        else {
            this.store.set(key, { value: list });
        }
        return JSON.stringify(value);
    }
    async lrange(key, start, stop) {
        const list = this.store.get(key)?.value;
        if (!list || !Array.isArray(list))
            return [];
        return list.slice(start, stop + 1);
    }
    async hset(key, field, value) {
        let hash = this.store.get(key)?.value;
        if (!hash || typeof hash !== 'object' || Array.isArray(hash))
            hash = {};
        const isNew = !(field in hash);
        hash[field] = value;
        this.store.set(key, { value: hash });
        return isNew ? 1 : 0;
    }
    async hget(key, field) {
        const hash = this.store.get(key)?.value;
        if (!hash || typeof hash !== 'object')
            return null;
        const value = hash[field];
        return value !== undefined ? JSON.stringify(value) : null;
    }
    async hgetall(key) {
        const hash = this.store.get(key)?.value;
        if (!hash || typeof hash !== 'object' || Array.isArray(hash))
            return {};
        return hash;
    }
    async hkeys(key) {
        const hash = this.store.get(key)?.value;
        if (!hash || typeof hash !== 'object' || Array.isArray(hash))
            return [];
        return Object.keys(hash);
    }
    async smembers(key) {
        const set = this.store.get(key)?.value;
        if (!set || !(set instanceof Set))
            return [];
        return Array.from(set).map((v) => JSON.stringify(v));
    }
    async sadd(key, ...members) {
        let set = this.store.get(key)?.value;
        if (!set || !(set instanceof Set))
            set = new Set();
        const sizeBefore = set.size;
        members.forEach((m) => set.add(m));
        this.store.set(key, { value: set });
        return set.size - sizeBefore;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAt && entry.expiresAt < now) {
                this.store.delete(key);
            }
        }
    }
    async quit() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.store.clear();
    }
}
exports.memoryCache = new MemoryCache();
