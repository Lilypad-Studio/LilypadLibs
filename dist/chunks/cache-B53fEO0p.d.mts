import { c as LilypadCacheOptions, h as LilypadCachedValueType, l as LilypadCachePeek, m as LilypadCacheValueFn, o as LilypadCacheGetOptions, s as LilypadCacheKey, u as LilypadCacheResult } from "./LilypadCacheTypes-CLQapyZs.mjs";
//#region src/cache/LilypadCache.d.ts
/**
 * A generic in-memory cache with time-to-live (TTL) support, error fallback, and protection for
 * specific keys. It supports:
 * - automatic expiration of entries based on TTL;
 * - one fetch per key at a time, shared by concurrent callers;
 * - a fallback value when a fetch fails (`onError`);
 * - stale-while-revalidate and a cooldown after failed fetches;
 * - an optional level shared by every instance of the application;
 * - protection of specific keys from deletion or clearing;
 * - cleanup of expired entries;
 * - bulk synchronization with an external data source.
 *
 * When a value is returned:
 * - `undefined` means "not in cache";
 * - `null` means "in cache, the value is known not to exist";
 * - any other value means "in cache, the value is X".
 *
 * Asynchronous writes (`getOrSet`, `bulkSync`) are ordered by the time they started: a result that
 * arrives after a write started later is discarded, so a slow, older read can never overwrite a
 * newer value. A read never joins a fetch that started before the last change of its key.
 *
 * Every method throws a {@link LilypadDisposedError} once the cache is disposed, except `dispose`.
 *
 * @typeParam K - The type of the cache keys.
 * @typeParam V - The type of the cache values.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache<string, number>({ ttl: 60_000 });
 * cache.set('foo', 42);
 * cache.get('foo'); // 42
 * ```
 *
 * @example
 * ```typescript
 * // Fetch on a miss; on error, fall back to the last known value
 * const user = await cache.getOrSet('user:1', () => fetchUser(1), {
 *   onError: { fallback: 'stale' },
 * });
 * ```
 */
declare class LilypadCache<K extends LilypadCacheKey, V> {
  private readonly engine;
  private readonly bulkSyncFn?;
  private readonly bulkSyncTtl;
  private readonly bulkSyncFlowControl;
  /**
   * When the last bulk sync stops counting as fresh. `entries()` returns every entry of the source
   * only while it is fresh.
   */
  private bulkSyncExpirationTime;
  /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
  private bulkSyncInvalidationTicket;
  /** @throws If an option is not valid. */
  constructor(options?: LilypadCacheOptions<K, V>);
  /** A unique id of the instance. */
  get id(): string;
  /** The name given in the options, or the id. */
  get name(): string;
  /** @throws {LilypadDisposedError} If the cache is disposed. */
  private assertNotDisposed;
  /**
   * Returns the value of the key if it is cached and fresh, otherwise `undefined`. It reads the
   * memory of this instance only: `getOrSet` also reads the shared level.
   *
   * @param options.removeExpired - If true, an expired value is also removed. Defaults to false, so
   * that the old value stays available as a fallback (`onError: { fallback: 'stale' }`).
   */
  get(key: K, options?: {
    removeExpired?: boolean;
  }): LilypadCachedValueType<V> | undefined;
  /**
   * Tells whether the key is cached, and whether its value is fresh or expired, without side
   * effects (no cleanup, no change of the order of use).
   */
  peek(key: K): LilypadCachePeek<V>;
  /**
   * Stores a value in the cache, and in the shared level (in the background).
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   */
  set(key: K, value: LilypadCachedValueType<V>, ttl?: number): void;
  /** Stores several values at once, like `set` (so also in the shared level). */
  bulkSet(entries: Iterable<readonly [K, LilypadCachedValueType<V>]>): void;
  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
   * the same key share one fetch; the `onError` options still apply separately to each caller.
   *
   * @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
   * @see {@link getOrSetDetailed} to also know where the value comes from
   */
  getOrSet(key: K, valueFn: LilypadCacheValueFn<V>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V>>;
  /**
   * Like {@link getOrSet}, but also tells where the value comes from and whether the last fetch
   * failed.
   *
   * The lookup order is: memory of this instance, shared level, stale value (returned at once and
   * refreshed in the background, within `staleWhileRevalidate`), fetch.
   */
  getOrSetDetailed(key: K, valueFn: LilypadCacheValueFn<V>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCacheResult<V>>;
  /** Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out. */
  getMany(keys: Iterable<K>): Map<K, LilypadCachedValueType<V>>;
  /**
   * Returns every fresh entry, keyed by the key it was stored with. It is the whole source only
   * while the last `bulkSync` is fresh: use `getAll` to sync first.
   */
  entries(): Map<K, LilypadCachedValueType<V>>;
  /** Like `entries()`, after a `bulkSync` (unless `sync` is false). */
  getAll({ sync }?: {
    sync?: boolean;
  }): Promise<Map<K, LilypadCachedValueType<V>>>;
  /**
   * Synchronizes the cache in bulk with `bulkSync.fn`.
   *
   * Concurrent calls share one sync. Errors are logged; unless `throwOnError` is set they are not
   * rethrown: the cache keeps its current content, and the next call retries the sync.
   * Bulk syncs fill the memory of this instance only, not the shared level.
   *
   * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
   * @returns `true` if the cache is synced (now or by a recent sync), `false` if the sync failed,
   * returned no data, or there is no `bulkSync.fn`.
   */
  bulkSync(options?: {
    throwOnError?: boolean;
  }): Promise<boolean>;
  private runBulkSync;
  /**
   * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running (that
   * sync then does not count as fresh).
   */
  invalidateBulkSync(): void;
  private forceNextBulkSync;
  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   */
  addProtectedKeys(keys: K[]): this;
  /** @returns The cache, for chaining. */
  removeProtectedKeys(keys: K[]): this;
  /**
   * Invalidates the entry of the key.
   *
   * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
   * stays available as a fallback (`onError: { fallback: 'stale' }`). A fetch of the key already
   * in flight is not cached, and later reads do not join it. The key is also removed from the
   * shared level, and `platform.onInvalidate` receives a `manual` event.
   *
   * @param options.invalidateBulkSync - If true (default), forces the next bulk sync. With false,
   * `entries()` leaves the key out until the next bulk sync.
   */
  invalidate(key: K, { invalidateBulkSync }?: {
    invalidateBulkSync?: boolean;
  }): void;
  /**
   * Deletes the key from the cache, and from the shared level. To cache the key as "does not
   * exist" instead, write `null`.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key: K, options?: {
    force?: boolean;
  }): boolean;
  /**
   * Removes all entries from the memory of this instance (not from the shared level), and forces
   * the next bulk sync. Protected keys are kept, unless `force` is set.
   */
  clear(options?: {
    force?: boolean;
  }): void;
  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window of
   * the cache, and the bookkeeping that no longer serves.
   *
   * @param options.force - If true, also removes the expired protected keys.
   */
  purgeExpired(options?: {
    force?: boolean;
  }): void;
  /**
   * Disposes of the cache: stops the cleanup timer and removes every entry. A disposed cache
   * ignores every later internal write, including the ones of fetches still in flight, and its
   * methods throw. The shared level is left untouched. Calling it again does nothing.
   */
  dispose(): Promise<void>;
  /** `await using cache = ...` disposes of the cache at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void>;
}
//#endregion
export { LilypadCache as t };
//# sourceMappingURL=cache-B53fEO0p.d.mts.map