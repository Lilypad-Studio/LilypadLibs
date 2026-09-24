import { randomUUID } from 'node:crypto';
import { LilypadFlowControl } from '@/flow/LilypadFlowControl';
import type { LilypadLibLogger } from '@/logger/LilypadLogger';

/**
 * The keys accepted by the cache. Keys are compared by their string form, so `42` and `'42'`
 * address the same entry.
 */
export type LilypadCacheKey = string | number;

export type LilypadCacheGetOptions<K extends LilypadCacheKey, V> = {
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

export type LilypadCachedValueType<V> = V | null;

/**
 * Represents a cached value along with its expiration time.
 *
 * @template K The type of the cache key.
 * @template V The type of the value being cached.
 * @property key The key as passed by the caller: the store is keyed by its string form.
 * @property value The actual value stored in the cache. Will be NULL if the associated value does not exist at all, instead of simply not being cached yet.
 * @property expirationTime The UNIX timestamp (in milliseconds) indicating when the cached value expires.
 * @property ticket Orders the writes: see {@link LilypadCache.setIfNewer}.
 */
type LilypadCacheEntry<K, V> = {
  key: K;
  value: LilypadCachedValueType<V>;
  expirationTime: number;
  ticket: number;
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
type LilypadCacheValueRetrieval<V> =
  | { type: 'hit' | 'expired'; value: LilypadCachedValueType<V>; expirationTime: number }
  | { type: 'miss' };

type LilypadCacheSyncFn<K, V> = (signal: AbortSignal) => Promise<[K, LilypadCachedValueType<V>][]>;

/**
 * Determines whether a cached value is stale based on its expiration time.
 *
 * @param entry - The cached value object containing the expiration time.
 * @returns `true` if the current time is greater than or equal to the expiration time, indicating the value is stale; otherwise, `false`.
 */
function isStale(entry: { expirationTime: number }): boolean {
  return Date.now() >= entry.expirationTime;
}

const DEFAULT_ERROR_TTL = 5 * 60 * 1000; // 5 minutes

type LilypadCacheConstructorOptions<K extends LilypadCacheKey, V> = {
  autoCleanupInterval?: number;
  /** Defaults to the smaller of `ttl` and 5 minutes. */
  defaultErrorTtl?: number;
  defaultBulkSyncTtl?: number;
  bulkSyncFn?: LilypadCacheSyncFn<K, V>;
  logger?: LilypadLibLogger;
  /** Timeout of the fetches of `getOrSet`, in milliseconds. Defaults to 5 seconds. */
  flowControlTimeout?: number;
  /** Timeout of `bulkSync`, in milliseconds. Defaults to 30 seconds. */
  bulkSyncTimeout?: number;
};

/**
 * A generic in-memory cache with time-to-live (TTL) support, error fallback, and protection for specific keys.
 *
 * `LilypadCache` provides a flexible caching mechanism for asynchronous or synchronous data, supporting:
 * - Automatic expiration of entries based on TTL.
 * - Prevention of duplicate concurrent fetches for the same key.
 * - Optional fallback to previous values on fetch errors.
 * - Protection of specific keys from deletion or clearing.
 * - Automatic periodic cleanup of expired entries.
 * - Optional bulk synchronization with an external data source.
 * - Integration with a database gateway for persistent and updated storage when an invalidation occurs.
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
class LilypadCache<K extends LilypadCacheKey, V> {
  public readonly id = `LilypadCache-${randomUUID()}`;

  protected store: Map<string, LilypadCacheEntry<K, V>>;
  protected defaultTtl: number; // time to live in milliseconds
  protected defaultErrorTtl: number; // default error TTL in milliseconds
  protected defaultBulkSyncTtl: number;
  protected cleanupIntervalId?: ReturnType<typeof setInterval> & { unref?: () => void };

  protected protectedKeys: Set<string> = new Set();

  protected logger?: LilypadLibLogger;

  protected flowControl: LilypadFlowControl<LilypadCachedValueType<V>>;
  protected bulkSyncFlowControl: LilypadFlowControl<boolean>;

  /**
   * Timestamp of the last bulk sync operation.
   * If the cache is backed by a database or external store,
   * It's possible that "every entry in the cache" is not the same as "every key in the store".
   * This timestamp can be used to track when the last bulk sync occurred, which would
   * have synced the cache with the store.
   */
  protected bulkSyncExpirationTime: number = 0;
  protected bulkSyncFn?: LilypadCacheSyncFn<K, V>;

  /** Source of the write tickets: see {@link setIfNewer}. */
  private lastTicket = 0;
  /**
   * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
   * already holds data newer than theirs.
   */
  private ticketFloor = 0;
  /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
  private bulkSyncInvalidationTicket = 0;
  private disposed = false;

  public constructor(ttl: number = 60000, options: LilypadCacheConstructorOptions<K, V> = {}) {
    this.store = new Map();
    this.defaultTtl = ttl;
    this.defaultBulkSyncTtl = options.defaultBulkSyncTtl ?? ttl;
    this.bulkSyncFn = options.bulkSyncFn;
    // A transient error must not pin its fallback for longer than a regular value
    this.defaultErrorTtl = options.defaultErrorTtl ?? Math.min(ttl, DEFAULT_ERROR_TTL);
    this.logger = options.logger;

    this.flowControl = new LilypadFlowControl<LilypadCachedValueType<V>>({
      logger: this.logger,
      timeout: options.flowControlTimeout ?? 5000,
    });

    this.bulkSyncFlowControl = new LilypadFlowControl<boolean>({
      logger: this.logger,
      timeout: options.bulkSyncTimeout ?? 30000,
    });

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

    void this.logger?.debug(this.id, `LilypadCache initialized`);
  }

  /**
   * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
   *
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
   * @returns The expiration time as a Unix timestamp in milliseconds.
   */
  private createExpirationTime(ttl?: number): number {
    return Date.now() + (ttl ?? this.defaultTtl);
  }

  /**
   * Normalizes a key to the string form used by the store and by the protected keys.
   */
  protected normalizeKey(key: K): string {
    return String(key);
  }

  /**
   * Takes a write ticket. An asynchronous write takes it when it starts, and passes it to
   * {@link setIfNewer} when its value is ready.
   */
  protected nextTicket(): number {
    return ++this.lastTicket;
  }

  private write(key: K, value: LilypadCachedValueType<V>, ttl: number | undefined, ticket: number) {
    // A disposed cache stays empty, even when in-flight fetches complete
    if (this.disposed) {
      return;
    }
    this.store.set(this.normalizeKey(key), {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      ticket,
    });
  }

  /**
   * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
   *
   * @param key - The key to associate with the cached value.
   * @param value - The value to store in the cache.
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the cache's default TTL is used.
   */
  set(key: K, value: LilypadCachedValueType<V>, ttl?: number) {
    this.write(key, value, ttl, this.nextTicket());
  }

  /**
   * Stores the result of an asynchronous read, unless a write that started later has already
   * stored a value for the key.
   *
   * @param ticket - The ticket taken with {@link nextTicket} when the read started.
   * @returns `true` if the value was stored.
   */
  protected setIfNewer(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number
  ): boolean {
    const entry = this.store.get(this.normalizeKey(key));
    if (ticket <= (entry?.ticket ?? this.ticketFloor)) {
      return false;
    }
    this.write(key, value, ttl, ticket);
    return true;
  }

  /**
   * Retrieves a value from the cache associated with the specified key.
   * If the cached value has expired or does not exist, it returns `undefined`.
   *
   * @param key - The key associated with the cached value.
   * @param removeOld - If true, an expired value is also removed from the cache, as a side effect.
   * Defaults to false, so that the old value stays available as a fallback for `getOrSet` with
   * `returnOldOnError`; expired entries are removed by `purgeExpired` / `autoCleanupInterval`.
   * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
   */
  get(key: K, removeOld: boolean = false): LilypadCachedValueType<V> | undefined {
    const entry = this.store.get(this.normalizeKey(key));
    if (entry && !isStale(entry)) {
      return entry.value;
    } else {
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
  getComprehensive(key: K): LilypadCacheValueRetrieval<V> {
    const entry = this.store.get(this.normalizeKey(key));
    if (!entry) {
      return { type: 'miss' };
    }
    return {
      type: isStale(entry) ? 'expired' : 'hit',
      value: entry.value,
      expirationTime: entry.expirationTime,
    };
  }

  /**
   * Handles error scenarios during cache retrieval by determining an appropriate value to return.
   * It runs for each caller, so every caller gets the fallback its own options ask for.
   *
   * The method follows this order:
   * 1. If `options.errorFn` is provided and returns a value, that value is used and cached.
   * 2. If `options.returnOldOnError` is true and a previous value exists, the old value is used.
   * 3. If no fallback value is determined, the original error is rethrown.
   *
   * The chosen value (from errorFn or old value) is cached with a TTL specified by `options.errorTtl` or the default error TTL.
   *
   * @param error - The error encountered during cache retrieval.
   * @param options - The cache get options, including error handling strategies.
   * @param key - The cache key associated with the retrieval.
   * @returns The determined fallback value to return.
   * @throws Rethrows the original error if no fallback value is determined.
   */
  private errorReturn(
    error: unknown,
    options: LilypadCacheGetOptions<K, V>,
    key: K
  ): LilypadCachedValueType<V> {
    let valueToReturn: LilypadCachedValueType<V> | undefined = options.errorFn?.({
      key,
      error,
      options,
    });

    // The current entry, not the one seen before the fetch: it may have been updated meanwhile
    const current = this.getComprehensive(key);
    if (valueToReturn === undefined && options.returnOldOnError && current.type !== 'miss') {
      valueToReturn = current.value;
    }

    if (valueToReturn === undefined) {
      throw error; // rethrow if no fallback value determined
    }
    this.set(key, valueToReturn, options.errorTtl ?? this.defaultErrorTtl);
    return valueToReturn;
  }

  private getOrSetFlightId(key: K): string {
    return `LilypadCache-getOrSet-${this.normalizeKey(key)}`;
  }

  /**
   * @returns `true` if a `getOrSet` fetch for the key is in flight.
   */
  protected isFetchInFlight(key: K): boolean {
    return this.flowControl.isInFlight(this.getOrSetFlightId(key));
  }

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
   */
  async getOrSet(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V>> {
    if (!options.skipCache) {
      const cached = this.getComprehensive(key);
      if (cached.type === 'hit') {
        return cached.value;
      }
    }

    try {
      return await this.flowControl.executeFn({
        functionIdentifier: this.getOrSetFlightId(key),
        consumerIdentifier: '',
        // Runs once per fetch, while the fallback is chosen per caller in errorReturn
        errorFn: (error) => {
          void this.logger?.error(this.id, `Error fetching cache key "${String(key)}": `, error);
          throw error;
        },
        fn: async (signal) => {
          const ticket = this.nextTicket();
          const value = await valueFn(signal);
          // After a timeout the caller already got an error/fallback: a late result is not cached
          if (!signal.aborted) {
            this.setIfNewer(key, value, options.ttl, ticket);
          }
          return value;
        },
      });
    } catch (error) {
      return this.errorReturn(error, options, key);
    }
  }

  /**
   * Synchronizes the cache in bulk by executing the provided sync function.
   *
   * This method uses flow control to manage the execution of the bulk sync operation.
   * If a `syncFn` is provided, it will be used to fetch key-value pairs to synchronize.
   * Errors are logged; unless `throwOnError` is set they are not rethrown: the cache keeps its
   * current content, and the next call retries the sync.
   *
   * @param syncFn - An optional asynchronous function that returns an array of key-value pairs to be synchronized.
   * It receives a signal that is aborted when the sync times out.
   * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
   * @returns A promise that resolves to `true` if the cache is synced (now or by a recent sync),
   * `false` if the sync failed or returned no data.
   */
  async bulkSync(
    syncFn?: LilypadCacheSyncFn<K, V>,
    options: { throwOnError?: boolean } = {}
  ): Promise<boolean> {
    try {
      return await this.bulkSyncFlowControl.executeFn({
        functionIdentifier: `LilypadCache-bulkSync`,
        consumerIdentifier: '',
        errorFn: (error) => {
          void this.logger?.error(this.id, 'Error during bulk sync: ', error);
          throw error;
        },
        fn: async (signal) => this._bulkSync(syncFn, signal),
      });
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      return false;
    }
  }
  private async _bulkSync(
    syncFn: LilypadCacheSyncFn<K, V> | undefined,
    signal: AbortSignal
  ): Promise<boolean> {
    if (Date.now() < this.bulkSyncExpirationTime) {
      return true;
    }
    const ticket = this.nextTicket();
    const data = (await syncFn?.(signal)) ?? (await this.bulkSyncFn?.(signal));
    if (signal.aborted) {
      // Timed out: the caller already got an error, and a newer sync may be running
      return false;
    }
    if (!data) {
      void this.logger?.warn(this.id, 'Bulk sync function returned no data');
      return false;
    }

    const incoming = new Map<string, [K, LilypadCachedValueType<V>]>();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    for (const [normalizedKey, entry] of this.store) {
      // Entries written after the sync started are newer than its data; incoming keys are overwritten below
      if (entry.ticket > ticket || incoming.has(normalizedKey)) {
        continue;
      }
      if (!this.deleteNormalized(normalizedKey)) {
        this.expireNormalized(normalizedKey); // protected keys are kept, but marked as stale
      }
    }
    for (const [key, value] of incoming.values()) {
      this.setIfNewer(key, value, undefined, ticket);
    }
    this.ticketFloor = Math.max(this.ticketFloor, ticket);

    // An invalidation that happened while the sync was running may not be reflected in its data
    if (this.bulkSyncInvalidationTicket < ticket) {
      this.bulkSyncExpirationTime = this.createExpirationTime(this.defaultBulkSyncTtl);
    }
    return true;
  }

  /**
   * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running.
   */
  protected invalidateBulkSync() {
    this.bulkSyncExpirationTime = 0;
    this.bulkSyncInvalidationTicket = this.nextTicket();
  }

  /**
   * Retrieves multiple values from the cache for the specified keys.
   * If no keys are provided, retrieves all values currently stored in the cache.
   * If some keys are not found in the cache or they have expired, they are simply omitted from the result.
   *
   * @param options - An object containing an optional array of keys to retrieve.
   * @returns A `Map` containing the key-value pairs found in the cache. Without `keys`, each entry
   * is keyed by the key it was stored with (e.g. a number stays a number).
   */
  bulkGet(options: { keys?: K[] }): Map<K, LilypadCachedValueType<V>> {
    const result = new Map<K, LilypadCachedValueType<V>>();
    if (options.keys) {
      for (const key of options.keys) {
        const value = this.get(key);
        if (value !== undefined) {
          result.set(key, value);
        }
      }
      return result;
    }
    for (const entry of this.store.values()) {
      if (!isStale(entry)) {
        result.set(entry.key, entry.value);
      }
    }
    return result;
  }

  /**
   * Retrieves multiple values from the cache asynchronously.
   * Optionally synchronizes the cache before retrieval using a provided sync function.
   *
   * @param options - The options for bulk retrieval.
   * @param options.keys - An array of keys to retrieve from the cache.
   * @param options.doSync - If true, synchronizes the cache using `syncFn` before retrieval.
   * @param options.syncFn - An asynchronous function that returns an array of key-value pairs to sync the cache.
   * @returns A promise that resolves to a map of keys to their corresponding values.
   */
  async bulkAsyncGet({
    keys,
    doSync = true,
    syncFn,
  }: {
    keys?: K[];
    doSync?: boolean;
    syncFn?: LilypadCacheSyncFn<K, V>;
  } = {}): Promise<Map<K, LilypadCachedValueType<V>>> {
    if (doSync) {
      await this.bulkSync(syncFn);
    }
    return this.bulkGet({ keys });
  }

  /**
   * Sets multiple key-value pairs in the cache at once.
   *
   * Accepts either a `Map<K, V>` or an array of `[K, V]` tuples.
   * Each entry is added to the cache using the `set` method.
   *
   * @param entries - The entries to set, as a `Map` or an array of key-value tuples.
   */
  bulkSet(entries: Map<K, V> | [K, V][]): void {
    const entriesToSet = entries instanceof Map ? Array.from(entries.entries()) : entries;
    for (const [key, value] of entriesToSet) {
      this.set(key, value);
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
  addProtectedKeys(keys: K[]) {
    for (const key of keys) {
      this.protectedKeys.add(this.normalizeKey(key));
    }
    return this;
  }
  /**
   * Removes the specified keys from the set of protected keys.
   *
   * @param keys - An array of keys to be removed from the protected keys set.
   * @returns The current instance for method chaining.
   */
  removeProtectedKeys(keys: K[]) {
    for (const key of keys) {
      this.protectedKeys.delete(this.normalizeKey(key));
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
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - If true (default), forces a bulk sync on the next bulkSync call.
   */
  invalidate(key: K, { invalidateBulkSync = true }: { invalidateBulkSync?: boolean } = {}) {
    this.expire(key);
    if (invalidateBulkSync) {
      this.invalidateBulkSync();
    }
  }

  /**
   * Marks a valid cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
   * Unlike `invalidate`, it is never overridden by subclasses, so it is always synchronous.
   *
   * @param key - The key of the cache entry to expire.
   */
  protected expire(key: K) {
    this.expireNormalized(this.normalizeKey(key));
  }

  private expireNormalized(normalizedKey: string) {
    const entry = this.store.get(normalizedKey);
    if (entry && !isStale(entry)) {
      this.set(entry.key, entry.value, -1); // sets to expired
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
   * @param options.setNull - If true, sets the value to null instead of deleting the entry.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key: K, options: { force?: boolean; setNull?: boolean } = {}) {
    return this.deleteNormalized(this.normalizeKey(key), options);
  }

  private deleteNormalized(
    normalizedKey: string,
    options: { force?: boolean; setNull?: boolean } = {}
  ): boolean {
    if (this.protectedKeys.has(normalizedKey) && !options.force) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (options.setNull) {
      if (entry) {
        this.set(entry.key, null);
      } else {
        // No entry holds the original key: the normalized one is its string form
        this.set(normalizedKey as K, null);
      }
      return true;
    }
    this.store.delete(normalizedKey);
    return true;
  }

  /**
   * Removes all entries from the cache.
   *
   * Iterates over all keys in the cache store and deletes each entry.
   * The deletion behavior can be customized using the `options` parameter.
   *
   * @param options - Optional settings for the clear operation.
   * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
   * @param options.setNull - If `true`, sets the value to null instead of deleting the entry.
   */
  clear(options: Parameters<typeof this.delete>[1] = {}) {
    for (const normalizedKey of this.store.keys()) {
      this.deleteNormalized(normalizedKey, options);
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
  purgeExpired(options: { force?: boolean } = {}) {
    for (const [normalizedKey, entry] of this.store.entries()) {
      if (isStale(entry)) {
        this.deleteNormalized(normalizedKey, options);
      }
    }
  }

  /**
   * Stops the periodic cleanup interval if it is currently running.
   * Clears the interval using its ID and resets the interval ID to `undefined`.
   * This method is typically used to halt automatic cache cleanup operations.
   */
  private stopCleanupInterval() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
  }

  /**
   * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
   * This method should be called when the cache is no longer needed to free up resources.
   * A disposed cache ignores every later write, including the ones of fetches still in flight.
   */
  dispose() {
    this.logger = undefined;
    this.stopCleanupInterval();
    this.clear({ force: true });
    this.disposed = true;
  }
}
export default LilypadCache;
