export type LilypadCacheGetOptions<K, V> = {
    /**
     * Optional TTL (time to live) in milliseconds for the cached value.
     * If not provided, the cache's default TTL will be used.
     */
    ttl?: number;
    /**
     * If true, bypasses the cache and always calls `valueFn` to get a fresh value.
     */
    skipCache?: boolean;
    /**
     * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
     * `getOrSet` will return the currently cached value (if any) instead of
     * rethrowing the error. If there is no cached value the error is rethrown.
     */
    returnOldOnError?: boolean;
    /**
     * Optional function that is called when an error occurs and `returnOldOnError` is true.
     */
    errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | undefined;
    /**
     * Optional TTL to use when caching the old value on error. Only used if `returnOldOnError` is true.
     */
    errorTtl?: number;
    /**
     * Optional additional data that can be passed to the errorFn
     */
    data?: unknown;
};
/**
 * Represents the error context passed to an error handler function when a cache get operation fails.
 *
 * @template K - The type of the cache key.
 * @template V - The type of the cache value.
 * @property {K} key - The cache key for which the error occurred.
 * @property {unknown} error - The error that was thrown during the get operation.
 * @property {LilypadCacheGetOptions<K, V>} options - The options used for the cache get operation.
 * @property {LilypadCache<K, V>} cache - The cache instance where the error occurred.
 */
type LilypadCacheGetOptionsErrorFn<K, V> = {
    key: K;
    error: unknown;
    options: LilypadCacheGetOptions<K, V>;
    cache: LilypadCache<K, V>;
};
/**
 * Represents a cached value along with its expiration time.
 *
 * @template V The type of the value being cached.
 * @property value The actual value stored in the cache.
 * @property expirationTime The UNIX timestamp (in milliseconds) indicating when the cached value expires.
 */
type LilypadCacheValue<V> = {
    value: V;
    expirationTime: number;
};
/**
 * Represents the result of attempting to retrieve a value from the cache.
 *
 * - If the cache contains the value and it is valid, returns an object with `type: 'hit'` and the cached value.
 * - If the cache contains the value but it has expired, returns an object with `type: 'expired'` and the expired value.
 * - If the cache does not contain the value, returns an object with `type: 'miss'`.
 *
 * @template V The type of the cached value.
 */
type LilypadCacheValueRetrieval<V> = ({
    type: 'hit' | 'expired';
} & LilypadCacheValue<V> | {
    type: 'miss';
});
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
declare class LilypadCache<K, V> {
    private store;
    private defaultTtl;
    private defaultErrorTtl;
    private cleanupIntervalId?;
    private pendingPromises;
    private protectedKeys;
    constructor(ttl?: number, options?: {
        autoCleanupInterval?: number;
        defaultErrorTtl?: number;
    });
    /**
     * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
     *
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
     * @returns The expiration time as a Unix timestamp in milliseconds.
     */
    private createExpirationTime;
    /**
     * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
     *
     * @param key - The key to associate with the cached value.
     * @param value - The value to store in the cache.
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the value will not expire.
     */
    set(key: K, value: V, ttl?: number): void;
    /**
     * Retrieves a value from the cache associated with the specified key.
     * If the cached value has expired or does not exist, it returns `undefined`.
     * If the value is expired, it is also removed from the cache, as a side effect.
     *
     * @param key - The key associated with the cached value.
     * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
     */
    get(key: K, removeOld?: boolean): V | undefined;
    /**
     * Retrieves a comprehensive cache value for the specified key, indicating whether the value is a cache hit, expired, or a miss.
     *
     * @param key - The key to retrieve from the cache.
     * @returns An object representing the cache retrieval result:
     * - If the value exists and is not stale, returns the cache value with `type: 'hit'`.
     * - If the value exists but is stale, returns the cache value with `type: 'expired'`.
     * - If the value does not exist, returns an object with `type: 'miss'`.
     */
    getComprehensive(key: K): LilypadCacheValueRetrieval<V>;
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
    getOrSet(key: K, valueFn: () => Promise<V>, options?: LilypadCacheGetOptions<K, V>): Promise<V>;
    /**
     * Adds the specified keys to the set of protected keys.
     * Protected keys are typically excluded from certain cache operations
     * such as eviction or deletion to ensure their persistence.
     *
     * @param keys - An array of keys to mark as protected.
     * @returns The current instance for method chaining.
     */
    addProtectedKeys(keys: K[]): this;
    /**
     * Removes the specified keys from the set of protected keys.
     *
     * @param keys - An array of keys to be removed from the protected keys set.
     * @returns The current instance for method chaining.
     */
    removeProtectedKeys(keys: K[]): this;
    /**
     * Invalidates the cache entry for the specified key.
     *
     * If the cache contains a valid entry for the given key, this method marks it as expired
     * by setting its value with a negative expiration time.
     *
     * @param key - The key of the cache entry to invalidate.
     */
    invalidate(key: K): void;
    /**
     * Deletes the specified key from the cache.
     *
     * If the key is present in the set of protected keys, the deletion is skipped.
     *
     * @param key - The key to be deleted from the cache.
     * @param options - Optional settings for deletion.
     * @param options.force - If true, forces deletion even if the key is protected.
     */
    delete(key: K, options?: {
        force?: boolean;
    }): void;
    /**
     * Removes all entries from the cache.
     *
     * Iterates over all keys in the cache store and deletes each entry.
     * The deletion behavior can be customized using the `options` parameter.
     *
     * @param options - Optional settings for the clear operation.
     * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
     */
    clear(options?: {
        force?: boolean;
    }): void;
    /**
     * Removes all expired entries from the cache.
     *
     * Iterates through the cache store and deletes any entries whose expiration time has passed.
     * Optionally, the deletion can be forced by providing the `force` option.
     *
     * @param options - Optional settings for the purge operation.
     * @param options.force - If true, forces deletion of expired entries regardless of other conditions.
     */
    purgeExpired(options?: {
        force?: boolean;
    }): void;
    /**
     * Stops the periodic cleanup interval if it is currently running.
     * Clears the interval using its ID and resets the interval ID to `undefined`.
     * This method is typically used to halt automatic cache cleanup operations.
     */
    private stopCleanupInterval;
    /**
     * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
     * This method should be called when the cache is no longer needed to free up resources.
     */
    dispose(): void;
}
export default LilypadCache;
