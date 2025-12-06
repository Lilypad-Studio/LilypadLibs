export type LilypadCacheGetOptions<K, V> = {
  // Optional TTL (in milliseconds) for the cached value.
  ttl?: number;

  // If true, bypasses the cache and always calls `valueFn` to get a fresh value.
  skipCache?: boolean;
  
  /**
   * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
   * `getOrSet` will return the currently cached value (if any) instead of
   * rethrowing the error. If there is no cached value the error is rethrown.
   */
  returnOldOnError?: boolean;
  // Optional function that is called when an error occurs and `returnOldOnError` is true.
  errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | undefined;
  // Optional TTL to use when caching the old value on error. Only used if `returnOldOnError` is true.
  errorTtl?: number;

  // Optional additional data that can be used by errorFn.
  data?: unknown;
}

type LilypadCacheGetOptionsErrorFn<K, V> = {
  key: K;
  error: unknown;
  options: LilypadCacheGetOptions<K, V>;
  cache: LilypadCache<K, V>;
}

type LilypadCacheValue<V> = {
  value: V;
  expirationTime: number;
}

type LilypadCacheValueRetrieval<V> = (
  | { type: 'hit' | 'expired' } & LilypadCacheValue<V>
  | { type: 'miss' }
)

function isStale<V>(retrieval: LilypadCacheValue<V>): boolean {
  return Date.now() >= retrieval.expirationTime;
}

class LilypadCache<K, V> {
  private store: Map<K, LilypadCacheValue<V>>;
  private defaultTtl: number; // time to live in milliseconds
  private defaultErrorTtl: number; // default error TTL in milliseconds
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  private pendingPromises: Map<K, Promise<V>> = new Map();

  private protectedKeys: Set<K> = new Set();

  constructor(ttl: number = 60000, options: { autoCleanupInterval?: number, defaultErrorTtl?: number } = {}) {
    this.store = new Map();
    this.defaultTtl = ttl;
    this.defaultErrorTtl = options.defaultErrorTtl ?? 5 * 60 * 1000; // 5 minutes;

    if (options.autoCleanupInterval) {
      if (!Number.isFinite(options.autoCleanupInterval) || options.autoCleanupInterval <= 0) {
        throw new Error('autoCleanupInterval must be a positive finite number');
      }
      this.cleanupIntervalId = setInterval(() => this.purgeExpired(), options.autoCleanupInterval);
      // prevent keeping the Node.js event loop alive when running in Node.js
      if (this.cleanupIntervalId && typeof (this.cleanupIntervalId as any).unref === 'function') {
        (this.cleanupIntervalId as any).unref();
      }
    }
  }

  private createExpirationTime(ttl?: number): number {
    return Date.now() + (ttl ?? this.defaultTtl);
  }
  set(key: K, value: V, ttl?: number) {
    this.store.set(key, { value, expirationTime: this.createExpirationTime(ttl) });
  }

  get(key: K): V | undefined {
    const cacheValue = this.store.get(key);
    if (cacheValue && !isStale(cacheValue)) {
      return cacheValue.value;
    } else {
      this.delete(key);
      return undefined;
    }
  }

  getComprehensive(key: K): LilypadCacheValueRetrieval<V> {
    const cacheValue = this.store.get(key);
    if (cacheValue && !isStale(cacheValue)) {
      return { ...cacheValue, type: 'hit' };
    } else {
      if (cacheValue) {
        return { ...cacheValue, type: 'expired' };
      }
      return { type: 'miss' };
    }
  }

  async getOrSet(
    key: K,
    valueFn: () => Promise<V>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<V> {
    const fetched = this.getComprehensive(key);
    if (!options.skipCache && fetched.type === 'hit') {
      return fetched.value;
    }

    // Check for pending promise to avoid duplicate calls. If there's a
    // pending promise and the caller requested fallback-on-error, return a
    // wrapped promise that falls back to `existing` on rejection.
    const pending = this.pendingPromises.get(key);
    if (pending) {
      if (options.returnOldOnError && fetched.type !== 'miss') {
        return pending.catch((error) => {
          if (options.errorFn) {
            const res = options.errorFn({ key, error, options, cache: this });
            if (res !== undefined) {
              return res;
            }
          }
          return fetched.value;
        });
      }
      return pending;
    }

    const promise = valueFn();
    this.pendingPromises.set(key, promise);

    try {
      const value = await promise;
      this.set(key, value, options.ttl);
      return value;
    } catch (error) {
      if (options.returnOldOnError && fetched.type !== 'miss') {
        if (options.errorFn) {
          const res = options.errorFn({ key, error, options, cache: this });
          if (res !== undefined) {
            return res;
          }
        }
        this.set(key, fetched.value, options.errorTtl ?? this.defaultErrorTtl);
        return fetched.value;
      }
      throw error;
    } finally {
      this.pendingPromises.delete(key);
    }
  }
  
  addProtectedKeys(keys: K[]) {
    for (const key of keys) {
      this.protectedKeys.add(key);
    }
    return this;
  }
  removeProtectedKeys(keys: K[]) {
    for (const key of keys) {
      this.protectedKeys.delete(key);
    }
    return this;
  }

  delete(key: K) {
    if (this.protectedKeys.has(key)) {
      return;
    }
    this.store.delete(key);
  }

  clear() {
    for (const key of this.store.keys()) {
      this.delete(key);
    }
  }

  purgeExpired() {
    const now = Date.now();
    for (const [key, cacheValue] of this.store.entries()) {
      if (now >= cacheValue.expirationTime) {
        this.delete(key);
      }
    }
  }

  private stopCleanupInterval() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
  }

  dispose() {
    this.stopCleanupInterval();
    this.removeProtectedKeys(Array.from(this.protectedKeys));
    this.clear();
  }
}
export default LilypadCache;
