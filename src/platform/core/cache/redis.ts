import { memoryCache } from './memory';

// Re-export memory cache as redis for backward compatibility
export const redis = memoryCache;
