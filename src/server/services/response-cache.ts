import { LRUCache } from '../../core/cache.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const responseCache = new LRUCache<any>({ maxSize: 200, defaultTTL: 5 * 60 * 1000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedResponse(key: string): any | null {
  return responseCache.get(key) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedResponse(key: string, data: any): void {
  responseCache.set(key, data);
}

export { responseCache };
