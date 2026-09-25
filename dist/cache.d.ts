import { LilypadFlowControl } from './flow.js';
import { L as LilypadLibLogger } from './LilypadLibLogger-DPBngeVh.js';
import { LilypadPlatform, LilypadSharedStore, LilypadInvalidationEvent } from './platform.js';

/**
 * The keys accepted by the cache. Keys are compared by their string form, so `42` and `'42'`
 * address the same entry.
 */
type LilypadCacheKey = string | number;
type LilypadCacheGetOptions<K extends LilypadCacheKey, V> = {
    /**
     * Optional TTL (time to live) in milliseconds for the cached value.
     * If not provided, the cache's default TTL will be used.
     * Concurrent calls share one fetch: the value is cached with the TTL of the call that started it.
     */
    ttl?: number;
    /**
     * If true, bypasses the cache and always calls `valueFn` to get a fresh value.
     */
    skipCache?: boolean;
    /**
     * How long after its expiration a value is still returned at once, while it is refreshed in the
     * background. Overrides the cache's `staleWhileRevalidate`.
     */
    staleWhileRevalidate?: number;
    /**
     * Timeout of the fetch, in milliseconds. Overrides the cache's `flowControlTimeout`. Concurrent
     * calls share the timeout of the call that started the fetch.
     */
    timeout?: number;
    /**
     * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
     * `getOrSet` will return the currently cached value (if any) instead of
     * rethrowing the error. If there is no cached value the error is rethrown.
     */
    returnOldOnError?: boolean;
    /**
     * Optional function called when fetching the value fails, whether or not `returnOldOnError` is set.
     * A value other than `undefined` is returned and cached (with `errorTtl`); `undefined` falls back
     * to `returnOldOnError`, then to rethrowing the error.
     */
    errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | null | undefined;
    /**
     * Optional TTL of the fallback value cached on error (from `errorFn` or `returnOldOnError`).
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
 */
type LilypadCacheGetOptionsErrorFn<K extends LilypadCacheKey, V> = {
    key: K;
    error: unknown;
    options: LilypadCacheGetOptions<K, V>;
};
type LilypadCachedValueType<V> = V | null;
/**
 * Where the value returned by `getOrSetDetailed` comes from:
 * - `L1-HIT`: a fresh value in the memory of this instance;
 * - `L2-HIT`: a fresh value from the shared level;
 * - `STALE`: an expired value within `staleWhileRevalidate`, being refreshed in the background;
 * - `MISS`: fetched now (or a fallback, if the fetch failed).
 */
type LilypadCacheStatus = 'L1-HIT' | 'L2-HIT' | 'STALE' | 'MISS';
type LilypadCacheResult<V> = {
    value: LilypadCachedValueType<V>;
    status: LilypadCacheStatus;
    /**
     * The last fetch of the key failed: the value is a stale copy, or a fallback chosen after the
     * error (`errorFn`, `returnOldOnError`), also while that fallback is cached.
     */
    refreshFailed: boolean;
};
/**
 * Converts values to and from what the shared store can hold (usually JSON).
 */
type LilypadSharedCodec<V> = {
    encode(value: V): unknown;
    /** Returns `null` when the stored value does not have the expected shape: it is then ignored. */
    decode(raw: unknown): V | null;
};
type LilypadCacheSharedOptions<V> = {
    /** Defaults to the `shared` store of the cache's `platform`. */
    store?: LilypadSharedStore;
    /**
     * Without a codec, values are stored as they are: this suits JSON-compatible values only
     * (e.g. a `Date` comes back as a string). A codec also validates what comes back.
     */
    codec?: LilypadSharedCodec<V>;
    /** Beyond this time (ms) a shared store operation counts as failed. Defaults to 300 ms. */
    timeout?: number;
    /**
     * If set, a background refresh holds a lock in the shared store for this long (ms), so that the
     * other instances do not refresh the same key at the same time. It is a soft lock (read and
     * write are not atomic): rarely, two instances still refresh together. Set it to the maximum
     * duration of a fetch.
     */
    refreshLockTtl?: number;
    /**
     * If true, each write first reads the shared entry, and leaves it alone when it holds a value
     * fetched later. It costs one more round-trip per write, and the check is soft (read and write
     * are not atomic). Defaults to false.
     */
    checkBeforeWrite?: boolean;
};
/**
 * Thrown by `getOrSet` for a key whose last fetch failed less than `failureCooldown` ago, when no
 * fallback value is available.
 */
declare class LilypadCacheCooldownError extends Error {
    constructor(key: string, cooldown: number);
}
/**
 * Represents a cached value along with its expiration time.
 *
 * @template K The type of the cache key.
 * @template V The type of the value being cached.
 * @property key The key as passed by the caller: the store is keyed by its string form.
 * @property value The actual value stored in the cache. Will be NULL if the associated value does not exist at all, instead of simply not being cached yet.
 * @property expirationTime The UNIX timestamp (in milliseconds) indicating when the cached value
 * expires. `0` marks an invalidated entry, which is never served as a stale value.
 * @property fetchedAt When the value was produced: the age of a value copied from the shared
 * level is measured from here, not from when it entered this level.
 * @property ticket Orders the writes: see {@link LilypadCache.setIfNewer}.
 * @property origin Where the value comes from: the source or a write (`source`), a fallback chosen
 * after a failed fetch (`fallback`), or the shared level (`shared`).
 * @property invalidatedAt When the entry was expired by an invalidation: copies of the shared level
 * produced before it are not adopted.
 */
type LilypadCacheEntry<K, V> = {
    key: K;
    value: LilypadCachedValueType<V>;
    expirationTime: number;
    fetchedAt: number;
    ticket: number;
    origin: LilypadCacheEntryOrigin;
    invalidatedAt?: number;
};
/**
 * An asynchronous read of the source, started with {@link LilypadCache.beginRead}. Its results
 * are stored only if no write that started later has already stored a value for the key.
 */
type LilypadCacheRead<K, V> = {
    /** Orders the read among the writes: see {@link LilypadCache.setIfNewer}. */
    ticket: number;
    /** When the read started: the age of its values is measured from here. */
    startedAt: number;
    /** Stores a value in this instance only. @returns `true` if it was stored. */
    store(key: K, value: LilypadCachedValueType<V>, ttl?: number): boolean;
    /**
     * Stores a value in this instance and in the shared level, and ends the failure cooldown of the
     * key. @returns `true` if it was stored.
     */
    storeFetched(key: K, value: LilypadCachedValueType<V>, ttl?: number): boolean;
};
type LilypadCacheEntryOrigin = 'source' | 'fallback' | 'shared';
/**
 * Represents the result of attempting to retrieve a value from the cache.
 *
 * - If the cache contains the value and it is valid, returns an object with `type: 'hit'` and the cached value.
 * - If the cache contains the value but it has expired, returns an object with `type: 'expired'` and the expired value.
 * - If the cache does not contain the value, returns an object with `type: 'miss'`.
 *
 * @template V The type of the cached value.
 */
type LilypadCacheValueRetrieval<V> = {
    type: 'hit' | 'expired';
    value: LilypadCachedValueType<V>;
    expirationTime: number;
} | {
    type: 'miss';
};
type LilypadCacheSyncFn<K, V> = (signal: AbortSignal) => Promise<[K, LilypadCachedValueType<V>][]>;
type LilypadCacheOptions<K extends LilypadCacheKey, V> = {
    /** Time to live of the entries, in milliseconds. Defaults to 60 seconds. */
    ttl?: number;
    /**
     * Identifies the cache in the shared level, in invalidation events and in logs. Required with
     * `shared`, and unique among the caches that use the same shared store.
     */
    name?: string;
    /** Platform capabilities: background work, shared store, invalidation hook. */
    platform?: LilypadPlatform;
    /** Adds a level shared by every instance (e.g. the Vercel Runtime Cache). */
    shared?: LilypadCacheSharedOptions<V>;
    /**
     * How long after its expiration a value is still returned at once by `getOrSet`, while it is
     * refreshed in the background. Defaults to 0 (disabled).
     */
    staleWhileRevalidate?: number;
    /**
     * After a failed fetch, the key is not fetched again for this long (ms): the stale value or the
     * fallback is used, or `LilypadCacheCooldownError` is thrown. Shared through the shared level.
     * Defaults to 0 (disabled).
     */
    failureCooldown?: number;
    /** Maximum number of entries in memory; the least recently used are removed first. */
    maxEntries?: number;
    /**
     * Removes expired entries during cache accesses, at most once per this interval (ms). Unlike
     * `autoCleanupInterval` it needs no timer, so it also works on instances that are suspended
     * between requests.
     */
    cleanupOnAccessEvery?: number;
    /** Removes expired entries with a timer. On serverless platforms prefer `cleanupOnAccessEvery`. */
    autoCleanupInterval?: number;
    /** Defaults to the smaller of `ttl` and 5 minutes. */
    defaultErrorTtl?: number;
    /**
     * How long a bulk sync stays fresh (ms). Defaults to `ttl`, and never exceeds it: the entries of
     * the sync expire after `ttl`.
     */
    defaultBulkSyncTtl?: number;
    /**
     * Loads every entry of the source, for `bulkSync` and `bulkAsyncGet`. It receives a signal that
     * is aborted when the sync times out.
     */
    bulkSyncFn?: LilypadCacheSyncFn<K, V>;
    logger?: LilypadLibLogger;
    /** Timeout of the fetches of `getOrSet`, in milliseconds. Defaults to 5 seconds. */
    flowControlTimeout?: number;
    /** Timeout of `bulkSync`, in milliseconds. Defaults to 30 seconds. */
    bulkSyncTimeout?: number;
    /** Prefix of the tags of the invalidation events. Defaults to `lilypad`. */
    tagPrefix?: string;
};
/**
 * A generic in-memory cache with time-to-live (TTL) support, error fallback, and protection for specific keys.
 *
 * `LilypadCache` provides a flexible caching mechanism for asynchronous or synchronous data, supporting:
 * - Automatic expiration of entries based on TTL.
 * - Prevention of duplicate concurrent fetches for the same key.
 * - Optional fallback to previous values on fetch errors.
 * - Stale-while-revalidate and a cooldown after failed fetches.
 * - An optional level shared by every instance of the application.
 * - Protection of specific keys from deletion or clearing.
 * - Automatic cleanup of expired entries.
 * - Optional bulk synchronization with an external data source.
 *
 * When a value is returned, as a general rule of thumb:
 * - `undefined` means "not in cache"
 * - `null` means "in cache, value is null" (as in, the value is known to not exist at all)
 * - any other value means "in cache, value is X"
 *
 * Asynchronous writes (`getOrSet`, `bulkSync`, and the refreshes of subclasses) are ordered by the
 * time they started: a result that arrives after a write started later is discarded, so a slow,
 * older read can never overwrite a newer value.
 *
 * @typeParam K - The type of the cache keys.
 * @typeParam V - The type of the cache values.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache<string, number>({ ttl: 60000 });
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
declare class LilypadCache<K extends LilypadCacheKey, V> {
    readonly id: string;
    /** The name given in the options, or the id. */
    readonly name: string;
    protected store: Map<string, LilypadCacheEntry<K, V>>;
    protected defaultTtl: number;
    protected defaultErrorTtl: number;
    protected defaultBulkSyncTtl: number;
    protected defaultStaleWhileRevalidate: number;
    protected failureCooldown: number;
    protected cleanupIntervalId?: ReturnType<typeof setInterval> & {
        unref?: () => void;
    };
    protected protectedKeys: Set<string>;
    protected logger?: LilypadLibLogger;
    protected platform?: LilypadPlatform;
    private shared?;
    private maxEntries?;
    private cleanupOnAccessEvery?;
    private lastCleanup;
    private tagPrefix;
    protected flowControl: LilypadFlowControl<LilypadCachedValueType<V>>;
    protected bulkSyncFlowControl: LilypadFlowControl<boolean>;
    /**
     * Timestamp of the last bulk sync operation.
     * If the cache is backed by a database or external store,
     * It's possible that "every entry in the cache" is not the same as "every key in the store".
     * This timestamp can be used to track when the last bulk sync occurred, which would
     * have synced the cache with the store.
     */
    protected bulkSyncExpirationTime: number;
    protected bulkSyncFn?: LilypadCacheSyncFn<K, V>;
    /** Source of the write tickets: see {@link setIfNewer}. */
    private lastTicket;
    /**
     * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
     * already holds data newer than theirs.
     */
    private ticketFloor;
    /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
    private bulkSyncInvalidationTicket;
    /**
     * Tickets below which the reads of keys without an entry are discarded (normalized keys): set
     * when such a key is expired while a read of it is in flight, since that read may predate the
     * change. Removed once a value is stored, or once no read of the key is in flight.
     */
    private fences;
    /** Values of the shared level produced before this time are not adopted. */
    private sharedNotBefore;
    protected disposed: boolean;
    /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
    private failures;
    /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
    private refreshing;
    constructor(options?: LilypadCacheOptions<K, V>);
    /**
     * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
     *
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
     * @returns The expiration time as a Unix timestamp in milliseconds.
     */
    private createExpirationTime;
    /**
     * Normalizes a key to the string form used by the store and by the protected keys.
     */
    protected normalizeKey(key: K): string;
    /**
     * Takes a write ticket. An asynchronous write takes it when it starts, and passes it to
     * {@link setIfNewer} when its value is ready.
     */
    protected nextTicket(): number;
    /**
     * Starts an asynchronous read of the source: every path that reads the source and stores the
     * result must go through it, so that a slow, older read never overwrites a newer value.
     */
    protected beginRead(): LilypadCacheRead<K, V>;
    /**
     * The ticket a read must exceed to store a value for the key: the one of its entry, or else the
     * floor of the missing keys.
     */
    private currentTicket;
    /**
     * Whether a read of the key is in flight. Subclasses that read the source in other ways add
     * their own reads.
     */
    protected hasReadInFlight(normalizedKey: string): boolean;
    /**
     * @param newValue - False when the entry keeps its value (e.g. it is only expired): then
     * {@link onValueStored} is not called.
     */
    private writeEntry;
    /**
     * Called each time a value is stored in this instance (not when an entry is only expired or
     * removed). Subclasses override it to follow the values; it must not write to the cache.
     */
    protected onValueStored(_entry: LilypadCacheEntry<K, V>): void;
    /**
     * Removes the least recently used entries beyond `maxEntries`, sparing protected keys. An
     * eviction forces the next bulk sync, since `bulkGet` would no longer return the evicted keys.
     */
    private evictOverflow;
    /** Marks an entry as recently used, for `maxEntries`. */
    private touch;
    /** Writes to this instance only. */
    private setLocal;
    /**
     * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
     * With a shared level, the value is also written there (in the background).
     *
     * @param key - The key to associate with the cached value.
     * @param value - The value to store in the cache.
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the cache's default TTL is used.
     */
    set(key: K, value: LilypadCachedValueType<V>, ttl?: number): void;
    /**
     * Stores the result of an asynchronous read, unless a write that started later has already
     * stored a value for the key.
     *
     * @param ticket - The ticket taken with {@link nextTicket} when the read started.
     * @param fetchedAt - When the read started.
     * @returns `true` if the value was stored.
     */
    private setIfNewer;
    /**
     * Stores a value just read from the source: in this instance (if no newer write happened, see
     * {@link setIfNewer}) and in the shared level. It also ends the key's failure cooldown.
     *
     * @returns `true` if the value was stored.
     */
    private storeFetched;
    /**
     * Retrieves a value from the cache associated with the specified key.
     * If the cached value has expired or does not exist, it returns `undefined`.
     * It reads the memory of this instance only: use `getOrSet` to also read the shared level.
     *
     * @param key - The key associated with the cached value.
     * @param options.removeExpired - If true, an expired value is also removed from the cache, as a
     * side effect. Defaults to false, so that the old value stays available as a fallback for
     * `getOrSet` with `returnOldOnError`; expired entries are removed by `purgeExpired` /
     * `autoCleanupInterval`.
     * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
     */
    get(key: K, options?: {
        removeExpired?: boolean;
    }): LilypadCachedValueType<V> | undefined;
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
     * Handles error scenarios during cache retrieval by determining an appropriate value to return.
     * It runs for each caller, so every caller gets the fallback its own options ask for.
     *
     * The method follows this order:
     * 1. If `options.errorFn` is provided and returns a value, that value is used and cached.
     * 2. If `options.returnOldOnError` is true and a previous value exists, the old value is used.
     * 3. If no fallback value is determined, the original error is rethrown.
     *
     * The chosen value (from errorFn or old value) is cached in this instance only, with a TTL
     * specified by `options.errorTtl` or the default error TTL.
     *
     * @param error - The error encountered during cache retrieval.
     * @param options - The cache get options, including error handling strategies.
     * @param key - The cache key associated with the retrieval.
     * @returns The determined fallback value to return.
     * @throws Rethrows the original error if no fallback value is determined.
     */
    private errorReturn;
    private getOrSetFlightId;
    /**
     * @returns `true` if a `getOrSet` fetch for the key is in flight.
     */
    protected isFetchInFlight(key: K): boolean;
    /** Throws if the cache is disposed: its reads would query the source without caching. */
    protected assertNotDisposed(): void;
    private inCooldown;
    private recordFailure;
    /**
     * Gets a value from the cache, or sets it using the provided function if not found.
     *
     * Implements a cache-aside pattern with support for concurrent request deduplication.
     * If the key exists in the cache and skipCache is not enabled, the cached value is returned immediately.
     * If another request for the same key is already pending, its fetch is shared; the error handling
     * options are still applied separately to each caller.
     *
     * @template K - The type of the cache key
     * @template V - The type of the cached value
     * @param key - The cache key
     * @param valueFn - An async function that produces the value to cache if it doesn't exist or is expired.
     * It receives a signal that is aborted when the fetch times out.
     * @param options - Optional configuration for cache behavior and error handling
     * @returns A promise that resolves to the cached value or the value produced by valueFn
     * @throws The error of `valueFn` (or the timeout error) when the options give no fallback value
     * @see {@link getOrSetDetailed} to also know where the value comes from
     */
    getOrSet(key: K, valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V>>;
    /**
     * Like {@link getOrSet}, but also tells where the value comes from and whether the last fetch
     * failed.
     *
     * The lookup order is: memory of this instance, shared level, stale value (returned at once and
     * refreshed in the background, within `staleWhileRevalidate`), fetch.
     *
     * A fallback cached after a failed fetch is returned with `refreshFailed: true` until it
     * expires. With `failureCooldown`, it is also refreshed in the background once the cooldown
     * is over.
     *
     * @throws If the cache is disposed.
     */
    getOrSetDetailed(key: K, valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCacheResult<V>>;
    /**
     * The result of a fresh entry. A fallback is reported as such, and refreshed in the background
     * once the failure cooldown is over: otherwise it would hide the recovery of the source for as
     * long as `errorTtl`.
     */
    private freshHit;
    /** Fetches the value (one fetch per key at a time) and stores it. */
    private fetchAndStore;
    /**
     * Refreshes a stale key after the response (or at once, without `platform.afterResponse`),
     * unless it is already being refreshed, locked by another instance, or in its failure cooldown.
     */
    private refreshInBackground;
    private sharedKey;
    private sharedFailureKey;
    private sharedLockKey;
    private cacheTag;
    /** A shared store operation bounded by the timeout; a failure resolves to `fallback`. */
    private sharedOperation;
    private sharedInBackground;
    /** Reads the entry, the failure time and the refresh lock of a key, in parallel. */
    private readShared;
    private decodeEnvelope;
    /**
     * Copies an entry of the shared level into this instance, if it is newer than the local one,
     * produced after the local one was invalidated, and no local write started after the read of
     * the shared level.
     *
     * @returns `true` if the entry was copied.
     */
    private adoptShared;
    /**
     * Writes an entry to the shared level in the background. With `checkBeforeWrite`, it leaves
     * alone a shared value fetched later (a soft check: read and write are not atomic).
     */
    private writeShared;
    /** Removes a key from the shared level, in the background. */
    protected deleteShared(key: K): void;
    /** @returns The lock owner id, or undefined when no lock is configured. */
    private acquireRefreshLock;
    /** Releases the lock only if it still belongs to this refresh, not to another instance. */
    private releaseRefreshLock;
    /**
     * Sends an invalidation event to `platform.onInvalidate`, in the background.
     *
     * @param options.wholeCache - The whole cache changed (e.g. a table was emptied): the event is
     * sent even without keys, and its tags always include the tag of the cache.
     */
    protected emitInvalidation(source: LilypadInvalidationEvent['source'], keys: K[], options?: {
        wholeCache?: boolean;
    }): void;
    /**
     * Synchronizes the cache in bulk with `bulkSyncFn`.
     *
     * Concurrent calls share one sync. Errors are logged; unless `throwOnError` is set they are not
     * rethrown: the cache keeps its current content, and the next call retries the sync.
     * Bulk syncs fill the memory of this instance only, not the shared level.
     *
     * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
     * @returns A promise that resolves to `true` if the cache is synced (now or by a recent sync),
     * `false` if the sync failed, returned no data, or there is no `bulkSyncFn`.
     */
    bulkSync(options?: {
        throwOnError?: boolean;
    }): Promise<boolean>;
    private _bulkSync;
    /**
     * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running.
     */
    protected invalidateBulkSync(): void;
    /**
     * Retrieves multiple values from the cache for the specified keys.
     * If no keys are provided, retrieves all values currently stored in the cache.
     * If some keys are not found in the cache or they have expired, they are simply omitted from the result.
     *
     * @param options - An object containing an optional array of keys to retrieve.
     * @returns A `Map` containing the key-value pairs found in the cache. Without `keys`, each entry
     * is keyed by the key it was stored with (e.g. a number stays a number).
     */
    bulkGet(options: {
        keys?: K[];
    }): Map<K, LilypadCachedValueType<V>>;
    /**
     * Retrieves multiple values from the cache asynchronously.
     * Optionally synchronizes the cache with `bulkSyncFn` before retrieval.
     *
     * @param options - The options for bulk retrieval.
     * @param options.keys - An array of keys to retrieve from the cache.
     * @param options.doSync - If true (default), runs `bulkSync` before retrieval.
     * @returns A promise that resolves to a map of keys to their corresponding values.
     */
    bulkAsyncGet({ keys, doSync, }?: {
        keys?: K[];
        doSync?: boolean;
    }): Promise<Map<K, LilypadCachedValueType<V>>>;
    /**
     * Sets multiple key-value pairs in the cache at once.
     *
     * Accepts either a `Map<K, V>` or an array of `[K, V]` tuples.
     * Each entry is added to the cache using the `set` method (so also to the shared level).
     *
     * @param entries - The entries to set, as a `Map` or an array of key-value tuples.
     */
    bulkSet(entries: Map<K, V> | [K, V][]): void;
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
     * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
     * stays available as a fallback for `returnOldOnError`. A fetch of the key already in flight is
     * not cached. The key is also removed from the shared level, and `platform.onInvalidate` receives
     * a `manual` event.
     *
     * @param key - The key of the cache entry to invalidate.
     * @param options - Optional settings for invalidation.
     * @param options.invalidateBulkSync - If true (default), forces a bulk sync on the next bulkSync
     * call. With false, `bulkGet({})` leaves the key out until the next bulk sync.
     */
    invalidate(key: K, { invalidateBulkSync }?: {
        invalidateBulkSync?: boolean;
    }): void;
    /**
     * The effect of `invalidate` on the data, without the invalidation event: expires the entry in
     * this instance, removes it from the shared level and optionally forces the next bulk sync.
     */
    protected markInvalid(key: K, { invalidateBulkSync }?: {
        invalidateBulkSync?: boolean;
    }): void;
    /**
     * Marks a cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
     * It is never served as a stale value either. Only this instance is affected.
     * A read of the key already in flight is discarded, since it may predate the change.
     *
     * @param key - The key of the cache entry to expire.
     */
    protected expire(key: K): void;
    private expireNormalized;
    /**
     * Expires every entry, forces the next bulk sync, and discards the results of the reads started
     * before (fetches and bulk syncs): the source may have changed in any way.
     */
    protected expireEverything(): void;
    /**
     * From now on, the values of the shared level produced before `time` are ignored (e.g. the
     * source was emptied at that time, and the shared level may still hold older copies).
     */
    protected rejectSharedBefore(time: number): void;
    /**
     * Deletes the specified key from the cache, and from the shared level.
     * To cache the key as "does not exist" instead, use `set(key, null)`.
     *
     * If the key is present in the set of protected keys, the deletion is skipped.
     *
     * @param key - The key to be deleted from the cache.
     * @param options.force - If true, forces deletion even if the key is protected.
     * @returns `false` if the key is protected and was left untouched.
     */
    delete(key: K, options?: {
        force?: boolean;
    }): boolean;
    private deleteNormalized;
    /**
     * Removes all entries from the memory of this instance (not from the shared level), and forces
     * the next bulk sync. Protected keys are kept, unless `force` is set.
     *
     * @param options.force - If `true`, also removes the protected keys.
     */
    clear(options?: {
        force?: boolean;
    }): void;
    /**
     * Removes all expired entries from the cache, except those still within the
     * `staleWhileRevalidate` window of the cache, and the bookkeeping that no longer serves.
     *
     * @param options - Optional settings for the purge operation.
     * @param options.force - If true, also removes the expired protected keys.
     */
    purgeExpired(options?: {
        force?: boolean;
    }): void;
    /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
    private cleanupOnAccess;
    /**
     * Stops the periodic cleanup interval if it is currently running.
     * Clears the interval using its ID and resets the interval ID to `undefined`.
     * This method is typically used to halt automatic cache cleanup operations.
     */
    private stopCleanupInterval;
    /**
     * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
     * This method should be called when the cache is no longer needed to free up resources.
     * A disposed cache ignores every later write, including the ones of fetches still in flight,
     * and its reads (`getOrSet`) throw. The shared level is left untouched.
     *
     * It is asynchronous so that subclasses can release their resources (e.g. a database listener):
     * always await it.
     */
    dispose(): Promise<void>;
}

export { LilypadCache, LilypadCacheCooldownError, type LilypadCacheEntry, type LilypadCacheEntryOrigin, type LilypadCacheGetOptions, type LilypadCacheKey, type LilypadCacheOptions, type LilypadCacheRead, type LilypadCacheResult, type LilypadCacheSharedOptions, type LilypadCacheStatus, type LilypadCacheSyncFn, type LilypadCacheValueRetrieval, type LilypadCachedValueType, type LilypadSharedCodec };
