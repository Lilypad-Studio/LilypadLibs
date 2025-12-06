/**
 * Determines whether a cached value is stale based on its expiration time.
 *
 * @param retrieval - The cached value object containing the expiration time.
 * @returns `true` if the current time is greater than or equal to the expiration time, indicating the value is stale; otherwise, `false`.
 */
function isStale(retrieval) {
    return Date.now() >= retrieval.expirationTime;
}
/**
 * A generic in-memory cache with time-to-live (TTL) support, error fallback, and protection for specific keys.
 *
 * `LilypadCache` provides a flexible caching mechanism for asynchronous or synchronous data, supporting:
 * - Automatic expiration of entries based on TTL.
 * - Prevention of duplicate concurrent fetches for the same key.
 * - Optional fallback to previous values on fetch errors.
 * - Protection of specific keys from deletion or clearing.
 * - Automatic periodic cleanup of expired entries.
 *
 * @typeParam K - The type of the cache keys.
 * @typeParam V - The type of the cache values.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache<string, number>(60000);
 * cache.set('foo', 42);
 * const value = cache.get('foo'); // 42
 * ```
 *
 * @example
 * ```typescript
 * // Using getOrSet with async fetch and error fallback
 * const cache = new LilypadCache<string, string>();
 * const value = await cache.getOrSet('user:1', async () => fetchUserFromDb(1), {
 *   returnOldOnError: true,
 *   errorFn: ({ error }) => 'defaultUser'
 * });
 * ```
 *
 * @see {@link getOrSet}
 * @see {@link addProtectedKeys}
 * @see {@link purgeExpired}
 * @see {@link dispose}
 */
class LilypadCache {
    constructor(ttl = 60000, options = {}) {
        var _a;
        this.pendingPromises = new Map();
        this.protectedKeys = new Set();
        this.store = new Map();
        this.defaultTtl = ttl;
        this.defaultErrorTtl = (_a = options.defaultErrorTtl) !== null && _a !== void 0 ? _a : 5 * 60 * 1000; // 5 minutes;
        if (options.autoCleanupInterval) {
            if (!Number.isFinite(options.autoCleanupInterval) || options.autoCleanupInterval <= 0) {
                throw new Error('autoCleanupInterval must be a positive finite number');
            }
            this.cleanupIntervalId = setInterval(() => this.purgeExpired(), options.autoCleanupInterval);
            // prevent keeping the Node.js event loop alive when running in Node.js
            if (this.cleanupIntervalId && typeof this.cleanupIntervalId.unref === 'function') {
                this.cleanupIntervalId.unref();
            }
        }
    }
    /**
     * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
     *
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
     * @returns The expiration time as a Unix timestamp in milliseconds.
     */
    createExpirationTime(ttl) {
        return Date.now() + (ttl !== null && ttl !== void 0 ? ttl : this.defaultTtl);
    }
    /**
     * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
     *
     * @param key - The key to associate with the cached value.
     * @param value - The value to store in the cache.
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the value will not expire.
     */
    set(key, value, ttl) {
        this.store.set(key, { value, expirationTime: this.createExpirationTime(ttl) });
    }
    /**
     * Retrieves a value from the cache associated with the specified key.
     * If the cached value has expired or does not exist, it returns `undefined`.
     * If the value is expired, it is also removed from the cache, as a side effect.
     *
     * @param key - The key associated with the cached value.
     * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
     */
    get(key, removeOld = true) {
        const cacheValue = this.store.get(key);
        if (cacheValue && !isStale(cacheValue)) {
            return cacheValue.value;
        }
        else {
            if (removeOld) {
                this.delete(key);
            }
            return undefined;
        }
    }
    /**
     * Retrieves a comprehensive cache value for the specified key, indicating whether the value is a cache hit, expired, or a miss.
     *
     * @param key - The key to retrieve from the cache.
     * @returns An object representing the cache retrieval result:
     * - If the value exists and is not stale, returns the cache value with `type: 'hit'`.
     * - If the value exists but is stale, returns the cache value with `type: 'expired'`.
     * - If the value does not exist, returns an object with `type: 'miss'`.
     */
    getComprehensive(key) {
        const cacheValue = this.store.get(key);
        if (cacheValue && !isStale(cacheValue)) {
            return { ...cacheValue, type: 'hit' };
        }
        else {
            if (cacheValue) {
                return { ...cacheValue, type: 'expired' };
            }
            return { type: 'miss' };
        }
    }
    /**
     * Retrieves a value from the cache for the given key, or computes and stores it if not present or if cache is skipped.
     *
     * - If the value is cached and `skipCache` is not set, returns the cached value.
     * - If a value is being computed for the key, returns the pending promise to avoid duplicate computations.
     * - If computation fails and `returnOldOnError` is set, returns the previous cached value (if available).
     * - Supports custom error handling via `errorFn`.
     *
     * @param key - The cache key to retrieve or set.
     * @param valueFn - An async function that computes the value if not cached or if cache is skipped.
     * @param options - Optional settings for cache retrieval and error handling.
     * @returns A promise resolving to the value for the given key.
     */
    async getOrSet(key, valueFn, options = {}) {
        var _a;
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
        }
        catch (error) {
            if (options.returnOldOnError && fetched.type !== 'miss') {
                if (options.errorFn) {
                    const res = options.errorFn({ key, error, options, cache: this });
                    if (res !== undefined) {
                        return res;
                    }
                }
                this.set(key, fetched.value, (_a = options.errorTtl) !== null && _a !== void 0 ? _a : this.defaultErrorTtl);
                return fetched.value;
            }
            throw error;
        }
        finally {
            this.pendingPromises.delete(key);
        }
    }
    /**
     * Adds the specified keys to the set of protected keys.
     * Protected keys are typically excluded from certain cache operations
     * such as eviction or deletion to ensure their persistence.
     *
     * @param keys - An array of keys to mark as protected.
     * @returns The current instance for method chaining.
     */
    addProtectedKeys(keys) {
        for (const key of keys) {
            this.protectedKeys.add(key);
        }
        return this;
    }
    /**
     * Removes the specified keys from the set of protected keys.
     *
     * @param keys - An array of keys to be removed from the protected keys set.
     * @returns The current instance for method chaining.
     */
    removeProtectedKeys(keys) {
        for (const key of keys) {
            this.protectedKeys.delete(key);
        }
        return this;
    }
    /**
     * Invalidates the cache entry for the specified key.
     *
     * If the cache contains a valid entry for the given key, this method marks it as expired
     * by setting its value with a negative expiration time.
     *
     * @param key - The key of the cache entry to invalidate.
     */
    invalidate(key) {
        const comprehensive = this.getComprehensive(key);
        if (comprehensive.type === 'hit') {
            this.set(key, comprehensive.value, -1); // sets to expired
        }
    }
    /**
     * Deletes the specified key from the cache.
     *
     * If the key is present in the set of protected keys, the deletion is skipped.
     *
     * @param key - The key to be deleted from the cache.
     * @param options - Optional settings for deletion.
     * @param options.force - If true, forces deletion even if the key is protected.
     */
    delete(key, options = {}) {
        if (this.protectedKeys.has(key) && !options.force) {
            return;
        }
        this.store.delete(key);
    }
    /**
     * Removes all entries from the cache.
     *
     * Iterates over all keys in the cache store and deletes each entry.
     * The deletion behavior can be customized using the `options` parameter.
     *
     * @param options - Optional settings for the clear operation.
     * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
     */
    clear(options = {}) {
        for (const key of this.store.keys()) {
            this.delete(key, options);
        }
    }
    /**
     * Removes all expired entries from the cache.
     *
     * Iterates through the cache store and deletes any entries whose expiration time has passed.
     * Optionally, the deletion can be forced by providing the `force` option.
     *
     * @param options - Optional settings for the purge operation.
     * @param options.force - If true, forces deletion of expired entries regardless of other conditions.
     */
    purgeExpired(options = {}) {
        const now = Date.now();
        for (const [key, cacheValue] of this.store.entries()) {
            if (now >= cacheValue.expirationTime) {
                this.delete(key, options);
            }
        }
    }
    /**
     * Stops the periodic cleanup interval if it is currently running.
     * Clears the interval using its ID and resets the interval ID to `undefined`.
     * This method is typically used to halt automatic cache cleanup operations.
     */
    stopCleanupInterval() {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = undefined;
        }
    }
    /**
     * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
     * This method should be called when the cache is no longer needed to free up resources.
     */
    dispose() {
        this.stopCleanupInterval();
        this.clear({ force: true });
    }
}
export default LilypadCache;
