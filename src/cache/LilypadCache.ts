export interface LilypadCacheGetOptions {
  ttl?: number;
  skipCache?: boolean;
  /**
   * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
   * `getOrSet` will return the currently cached value (if any) instead of
   * rethrowing the error. If there is no cached value the error is rethrown.
   */
  returnOldOnError?: boolean;
  errorTtl?: number;
}

class LilypadCache<K, V> {
  private store: Map<K, V>;
  private defaultTtl: number; // time to live in milliseconds
  private defaultErrorTtl: number; // default error TTL in milliseconds
  private timeMap: Map<K, number>;
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  private pendingPromises: Map<K, Promise<V>> = new Map();

  constructor(ttl: number = 60000, options: { autoCleanupInterval?: number, defaultErrorTtl?: number } = {}) {
    this.store = new Map();
    this.defaultTtl = ttl;
    this.defaultErrorTtl = options.defaultErrorTtl ?? 5 * 60 * 1000; // 5 minutes;
    this.timeMap = new Map();

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

  set(key: K, value: V, ttl?: number) {
    this.store.set(key, value);
    this.timeMap.set(key, Date.now() + (ttl ?? this.defaultTtl));
  }

  get(key: K): V | undefined {
    const expirationTime = this.timeMap.get(key);
    if (expirationTime && Date.now() < expirationTime) {
      return this.store.get(key);
    } else {
      this.store.delete(key);
      this.timeMap.delete(key);
      return undefined;
    }
  }

  async getOrSet(
    key: K,
    valueFn: () => Promise<V>,
    options: LilypadCacheGetOptions = {}
  ): Promise<V> {
    const { skipCache, returnOldOnError } = options;

    // Capture an existing (non-expired) value for early return or fallback
    let oldValue: V | undefined;
    if (returnOldOnError) {
      oldValue = this.store.get(key);
    }

    if (!skipCache) {
      const existing = this.get(key);
      if (existing !== undefined) {
        return existing;
      }
    }

    // Check for pending promise to avoid duplicate calls. If there's a
    // pending promise and the caller requested fallback-on-error, return a
    // wrapped promise that falls back to `existing` on rejection.
    const pending = this.pendingPromises.get(key);
    if (pending) {
      if (returnOldOnError && oldValue !== undefined) {
        return pending.catch(() => oldValue);
      }
      return pending;
    }

    const promise = valueFn();
    this.pendingPromises.set(key, promise);

    try {
      const value = await promise;
      this.set(key, value, options.ttl);
      return value;
    } catch (err) {
      if (returnOldOnError && oldValue !== undefined) {
        this.set(key, oldValue, options.errorTtl ?? this.defaultErrorTtl);
        return oldValue;
      }
      throw err;
    } finally {
      this.pendingPromises.delete(key);
    }
  }

  delete(key: K) {
    this.store.delete(key);
    this.timeMap.delete(key);
  }

  clear() {
    this.store.clear();
    this.timeMap.clear();
  }

  purgeExpired() {
    const now = Date.now();
    for (const [key, timeStored] of this.timeMap.entries()) {
      if (now >= timeStored) {
        this.store.delete(key);
        this.timeMap.delete(key);
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
    this.clear();
  }
}
export default LilypadCache;
