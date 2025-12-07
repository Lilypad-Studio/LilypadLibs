"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
    store;
    defaultTtl; // time to live in milliseconds
    defaultErrorTtl; // default error TTL in milliseconds
    cleanupIntervalId;
    pendingPromises = new Map();
    protectedKeys = new Set();
    logger;
    constructor(ttl = 60000, options = {}) {
        this.store = new Map();
        this.defaultTtl = ttl;
        this.defaultErrorTtl = options.defaultErrorTtl ? options.defaultErrorTtl : 5 * 60 * 1000; // 5 minutes;
        this.logger = options.logger;
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
        return Date.now() + (ttl ?? this.defaultTtl);
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
     * Handles error scenarios during cache retrieval by determining an appropriate value to return.
     *
     * The method follows this order:
     * 1. If `options.errorFn` is provided and returns a value, that value is used and cached.
     * 2. If `options.returnOldOnError` is true and a previous value exists (`fetched.type !== 'miss'`), the old value is used.
     * 3. If no fallback value is determined, the original error is rethrown.
     *
     * The chosen value (from errorFn or old value) is cached with a TTL specified by `options.errorTtl` or the default error TTL.
     *
     * @param error - The error encountered during cache retrieval.
     * @param options - The cache get options, including error handling strategies.
     * @param key - The cache key associated with the retrieval.
     * @param fetched - The result of the cache value retrieval, including type and value.
     * @returns The determined fallback value to return.
     * @throws Rethrows the original error if no fallback value is determined.
     */
    errorReturn(error, options, key, fetched) {
        this.logger?.error(`Error fetching cache key "${String(key)}": `, error);
        let valueToReturn = undefined;
        const errorFnRes = options.errorFn?.({ key, error, options, cache: this });
        if (errorFnRes !== undefined) {
            // 1. errorFn returned a value, use it (and cache it)
            valueToReturn = errorFnRes;
        }
        if (fetched.type !== 'miss' && options.returnOldOnError && valueToReturn === undefined) {
            // 2. errorFn not provided or returned undefined, use old value
            valueToReturn = fetched.value;
        }
        if (valueToReturn === undefined) {
            throw error; // rethrow if no fallback value determined
        }
        // Cache the value determined above (either from errorFn or the old value)
        this.set(key, valueToReturn, options.errorTtl ?? this.defaultErrorTtl);
        return valueToReturn; // Return the determined value
    }
    /**
     * Gets a value from the cache, or sets it using the provided function if not found.
     *
     * Implements a cache-aside pattern with support for concurrent request deduplication.
     * If the key exists in the cache and skipCache is not enabled, the cached value is returned immediately.
     * If another request for the same key is already pending, that promise is reused instead of creating a duplicate.
     *
     * @template K - The type of the cache key
     * @template V - The type of the cached value
     * @param key - The cache key
     * @param valueFn - An async function that produces the value to cache if it doesn't exist or is expired
     * @param options - Optional configuration for cache behavior and error handling
     * @returns A promise that resolves to the cached value or the value produced by valueFn
     * @throws Will not throw, but will return a handled error value if valueFn rejects and error handling is configured
     */
    async getOrSet(key, valueFn, options = {}) {
        const fetched = this.getComprehensive(key);
        if (!options.skipCache && fetched.type === 'hit') {
            return fetched.value;
        }
        const pending = this.pendingPromises.get(key);
        if (pending) {
            return pending.catch((error) => this.errorReturn(error, options, key, fetched));
        }
        const promise = valueFn();
        this.pendingPromises.set(key, promise);
        try {
            const value = await promise;
            this.set(key, value, options.ttl);
            return value;
        }
        catch (error) {
            return this.errorReturn(error, options, key, fetched);
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
        this.logger = undefined;
        this.stopCleanupInterval();
        this.clear({ force: true });
    }
}
exports.default = LilypadCache;
