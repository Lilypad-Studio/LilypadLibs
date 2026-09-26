import { n as LilypadLibLogger } from "./LilypadLibLogger-DwYjcH1k.mjs";
import { i as LilypadSharedStore, n as LilypadInvalidationEvent, r as LilypadPlatform } from "./LilypadPlatform-BcgvOfll.mjs";
import { n as LilypadFlowControl } from "./LilypadFlowControl-Nfd_SeXl.mjs";
//#region src/cache/LilypadCacheTypes.d.ts
/**
 * The keys accepted by the cache. Keys are compared by their string form, so `42` and `'42'`
 * address the same entry.
 */
type LilypadCacheKey = string | number;
/** A cached value: `null` means "known not to exist", as opposed to "not cached" (`undefined`). */
type LilypadCachedValueType<V> = V | null;
/** The source of a value, for `getOrSet`: it receives a signal aborted when the fetch times out. */
type LilypadCacheValueFn<V> = (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>;
/** What the fallback function of `onError` receives. */
type LilypadCacheErrorContext<K extends LilypadCacheKey, V> = {
  key: K;
  /** The error of the fetch, or a `LilypadCacheCooldownError`. */
  error: unknown;
  /** The last value of the key, expired or invalidated, if the cache still holds one. */
  stale?: {
    value: LilypadCachedValueType<V>;
    fetchedAt: number;
  };
};
/** What `getOrSet` returns when the fetch fails. */
type LilypadCacheErrorOptions<K extends LilypadCacheKey, V> = {
  /**
   * - `'stale'`: the last value of the key, even expired or invalidated;
   * - a function: its result (it can return `context.stale?.value`), or `undefined` to rethrow.
   *
   * The fallback is cached in this instance only, for `ttl`. Without a fallback value, the error
   * is rethrown.
   */
  fallback?: 'stale' | ((context: LilypadCacheErrorContext<K, V>) => LilypadCachedValueType<V> | undefined);
  /** TTL of the cached fallback, in ms. Defaults to the cache's `errorTtl`. */
  ttl?: number;
};
type LilypadCacheGetOptions<K extends LilypadCacheKey, V> = {
  /**
   * TTL in milliseconds of the fetched value; defaults to the cache's TTL. Concurrent calls share
   * one fetch: the value is cached with the TTL of the call that started it.
   */
  ttl?: number;
  /**
   * If true, skips the lookup (memory, shared level, stale value) and fetches with `valueFn`. A
   * fetch of the key already in flight is joined instead of starting another one.
   */
  skipCache?: boolean;
  /**
   * How long after its expiration a value is still returned at once, while it is refreshed in the
   * background. Overrides the cache's `staleWhileRevalidate`.
   */
  staleWhileRevalidate?: number;
  /**
   * Timeout of the fetch, in milliseconds. Overrides the cache's `fetchTimeout`. Concurrent calls
   * share the timeout of the call that started the fetch.
   */
  timeout?: number;
  /** The value returned (and briefly cached) when the fetch fails; applied to each caller. */
  onError?: LilypadCacheErrorOptions<K, V>;
};
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
   * error (`onError`), also while that fallback is cached.
   */
  refreshFailed: boolean;
};
/**
 * Converts values to and from what the shared store can hold (usually JSON). Either function may
 * throw: a value that cannot be encoded is not shared, and one that cannot be decoded is ignored.
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
type LilypadCacheEntryOrigin = 'source' | 'fallback' | 'shared';
/**
 * A cached value along with its bookkeeping.
 *
 * @property key The key as passed by the caller: the store is keyed by its string form.
 * @property value The cached value; `null` if the value is known not to exist.
 * @property expirationTime When the value expires (ms since the epoch). `0` marks an invalidated
 * entry, which is never served as a stale value.
 * @property fetchedAt When the value was produced: the age of a value copied from the shared
 * level is measured from here, not from when it entered this level.
 * @property ticket Orders the writes: see {@link LilypadCacheRead}.
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
 * An asynchronous read of the source, started with `beginRead()`. Its results are stored only if
 * no write that started later has already stored a value for the key.
 */
type LilypadCacheRead<K, V> = {
  /** Orders the read among the writes. */
  ticket: number;
  /** When the read started: the age of its values is measured from here. */
  startedAt: number;
  /** Stores a value in this instance only. @returns `true` if it was stored. */
  store(key: K, value: LilypadCachedValueType<V>, ttl?: number): boolean;
  /**
   * Stores a value in this instance and in the shared level, and ends the failure cooldown of the
   * key. The shared copy is kept through `staleWhileRevalidate` (at least the cache's).
   * @returns `true` if it was stored.
   */
  storeFetched(key: K, value: LilypadCachedValueType<V>, ttl?: number, staleWhileRevalidate?: number): boolean;
};
/**
 * What `peek` returns:
 * - `hit`: the value is cached and fresh;
 * - `expired`: the value is cached but expired (or invalidated);
 * - `miss`: the key is not cached.
 */
type LilypadCachePeek<V> = {
  type: 'hit' | 'expired';
  value: LilypadCachedValueType<V>;
  expirationTime: number;
} | {
  type: 'miss';
};
type LilypadCacheSyncFn<K, V> = (signal: AbortSignal) => Promise<[K, LilypadCachedValueType<V>][]>;
type LilypadCacheBulkSyncOptions<K, V> = {
  /**
   * Loads every entry of the source, for `bulkSync` and `getAll`. It receives a signal that
   * is aborted when the sync times out. Without it, `bulkSync` resolves to `false`.
   */
  fn?: LilypadCacheSyncFn<K, V>;
  /**
   * How long a bulk sync stays fresh (ms). Defaults to `ttl`, and never exceeds it: the entries of
   * the sync expire after `ttl`.
   */
  ttl?: number;
  /** Timeout of a bulk sync, in milliseconds. Defaults to 30 seconds. */
  timeout?: number;
};
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
  /** TTL of the fallbacks cached after a failed fetch. Defaults to the smaller of `ttl` and 5 minutes. */
  errorTtl?: number;
  /** Timeout of the fetches of `getOrSet`, in milliseconds. Defaults to 5 seconds. */
  fetchTimeout?: number;
  /** Loading the whole source at once (`bulkSync`, `getAll`). */
  bulkSync?: LilypadCacheBulkSyncOptions<K, V>;
  logger?: LilypadLibLogger;
  /** Prefix of the tags of the invalidation events. Defaults to `lilypad`. */
  tagPrefix?: string;
};
//#endregion
//#region src/cache/LilypadCacheCore.d.ts
/**
 * The engine of {@link LilypadCache} and `LilypadDbCache`: an in-memory, TTL-based cache with an
 * optional shared level, stale-while-revalidate, a failure cooldown, protected keys, and a bulk
 * sync.
 *
 * Its public methods only read, expire or remove entries. The methods that write values (`set`,
 * `getOrSet`, `bulkSync`...) are protected: `LilypadCache` makes them public, while
 * `LilypadDbCache` keeps them internal, so that its values always come from its table.
 *
 * When a value is returned:
 * - `undefined` means "not in cache";
 * - `null` means "in cache, the value is known not to exist";
 * - any other value means "in cache, the value is X".
 *
 * Asynchronous writes (fetches, bulk syncs, and the refreshes of subclasses) are ordered by the
 * time they started: every entry carries a ticket, and a result that arrives after a write started
 * later is discarded, so a slow, older read can never overwrite a newer value. A key without an
 * entry keeps the ticket of its last entry in a fence while a read of it is in flight.
 *
 * A disposed cache ignores every internal write (fetches still in flight cannot fill it again),
 * and its public methods, except `dispose`, throw.
 */
declare abstract class LilypadCacheCore<K extends LilypadCacheKey, V> {
  readonly id: string;
  /** The name given in the options, or the id. */
  readonly name: string;
  protected store: Map<string, LilypadCacheEntry<K, V>>;
  protected readonly defaultTtl: number;
  protected readonly errorTtl: number;
  protected readonly bulkSyncTtl: number;
  protected readonly defaultStaleWhileRevalidate: number;
  protected readonly failureCooldown: number;
  private cleanupIntervalId?;
  protected protectedKeys: Set<string>;
  /**
   * With `maxEntries`, the stored keys that can be evicted (not protected), least recently used
   * first. The protected keys stay out of it, so that an eviction never scans them.
   */
  private evictionOrder;
  protected logger?: LilypadLibLogger;
  protected platform?: LilypadPlatform;
  private shared?;
  private readonly maxEntries?;
  private readonly cleanupOnAccessEvery?;
  private lastCleanup;
  private readonly tagPrefix;
  protected readonly flowControl: LilypadFlowControl;
  protected readonly bulkSyncFlowControl: LilypadFlowControl;
  /**
   * When the last bulk sync stops counting as fresh. `entries()` returns every entry of the source
   * only while it is fresh.
   */
  protected bulkSyncExpirationTime: number;
  protected bulkSyncFn?: LilypadCacheSyncFn<K, V>;
  /** Source of the write tickets. */
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
   * when such a key is expired, or its entry removed, while a read of it is in flight, since that
   * read may predate the change. Removed once a value is stored, or once no read is in flight.
   */
  private fences;
  /** Values of the shared level produced before this time are not adopted. */
  private sharedNotBefore;
  protected disposed: boolean;
  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  private failures;
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  private refreshing;
  protected constructor(options?: LilypadCacheOptions<K, V>);
  private createExpirationTime;
  /** Normalizes a key to the string form used by the store and by the protected keys. */
  protected normalizeKey(key: K): string;
  /** Takes a write ticket. */
  protected nextTicket(): number;
  /**
   * Starts an asynchronous read of the source: every path that reads the source and stores the
   * result must go through it, so that a slow, older read never overwrites a newer value.
   */
  protected beginRead(): LilypadCacheRead<K, V>;
  /**
   * The ticket a read must exceed to store a value for the key: the one of its entry, or else the
   * floor of the missing keys and the fence of the key.
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
   * @returns `false` if the cache is disposed, and the entry was not stored.
   */
  private writeEntry;
  /**
   * Called each time a value is stored in this instance (not when an entry is only expired or
   * removed). Subclasses override it to follow the values; it must not write to the cache.
   */
  protected onValueStored(_entry: LilypadCacheEntry<K, V>): void;
  /**
   * Removes an entry from the store. A read of the key in flight may have started before the entry
   * was last written or expired: the ticket of the entry stays as the fence of the key, so that
   * such a read cannot store its older value once the entry is gone.
   */
  private dropEntry;
  /**
   * Removes the least recently used entries beyond `maxEntries`, sparing protected keys. An
   * eviction forces the next bulk sync, since `entries()` would no longer return the evicted keys.
   */
  private evictOverflow;
  /** Marks a stored key as the most recently used one, for `maxEntries`. */
  private markUsed;
  /**
   * Writes to this instance only.
   *
   * @returns The stored entry, or `undefined` if the cache is disposed.
   */
  private writeLocal;
  /**
   * Stores a value here and in the shared level, taking a new ticket (reads started before it
   * cannot overwrite it). Ignored once the cache is disposed.
   */
  protected setValue(key: K, value: LilypadCachedValueType<V>, ttl?: number): void;
  /**
   * Stores a value in the cache, and in the shared level (in the background).
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   * @throws If the cache is disposed.
   */
  protected set(key: K, value: LilypadCachedValueType<V>, ttl?: number): void;
  /**
   * Stores the result of an asynchronous read, unless a write that started later has already
   * stored a value for the key.
   *
   * @returns `true` if the value was stored.
   */
  private setIfNewer;
  /**
   * Stores a value just read from the source: in this instance (if no newer write happened) and
   * in the shared level. It also ends the key's failure cooldown.
   *
   * @returns `true` if the value was stored.
   */
  private storeFetched;
  /**
   * Returns the value of the key if it is cached and fresh, otherwise `undefined`. It reads the
   * memory of this instance only: `getOrSet` also reads the shared level.
   *
   * @param options.removeExpired - If true, an expired value is also removed. Defaults to false, so
   * that the old value stays available as a fallback (`onError: { fallback: 'stale' }`).
   * @throws If the cache is disposed.
   */
  get(key: K, options?: {
    removeExpired?: boolean;
  }): LilypadCachedValueType<V> | undefined;
  /**
   * Tells whether the key is cached, and whether its value is fresh or expired, without side
   * effects (no cleanup, no change of the order of use).
   *
   * @throws If the cache is disposed.
   */
  peek(key: K): LilypadCachePeek<V>;
  private peekEntry;
  /**
   * The fallback of a failed fetch, chosen for each caller with its own `onError` options, and
   * cached in this instance only for `onError.ttl` (or the cache's `errorTtl`). The stale value
   * returned as it is keeps its age: it is not a newer value.
   *
   * @throws The original error if no fallback value is determined.
   */
  private errorReturn;
  private getOrSetFlightId;
  /** @returns `true` if a `getOrSet` fetch for the key is in flight. */
  protected isFetchInFlight(key: K): boolean;
  /** Throws if the cache is disposed. */
  protected assertNotDisposed(): void;
  private inCooldown;
  private recordFailure;
  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
   * the same key share one fetch; the `onError` options still apply separately to each caller.
   *
   * @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
   */
  protected getOrSet(key: K, valueFn: LilypadCacheValueFn<V>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V>>;
  /**
   * Like `getOrSet`, but also tells where the value comes from and whether the last fetch failed.
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
  protected getOrSetDetailed(key: K, valueFn: LilypadCacheValueFn<V>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCacheResult<V>>;
  /**
   * The result of a fresh entry. A fallback is reported as such, and refreshed in the background
   * once the failure cooldown is over: otherwise it would hide the recovery of the source for as
   * long as its TTL.
   */
  private freshHit;
  /** Fetches the value (one fetch per key at a time) and stores it. */
  private fetchAndStore;
  /**
   * Refreshes a stale key after the response (or at once, without `platform.afterResponse`),
   * unless it is already being refreshed, locked by another instance, or in its failure cooldown.
   */
  private refreshInBackground;
  /**
   * Copies an entry of the shared level into this instance, if it is newer than the local one,
   * produced after the local one was invalidated, and no local write started after the read of
   * the shared level.
   *
   * @returns `true` if the entry was copied.
   */
  private adoptShared;
  /**
   * Writes an entry to the shared level in the background, kept through the stale window: the
   * cache's, or a longer one asked by the read that fetched it.
   */
  private writeShared;
  /** Removes a key from the shared level, in the background. */
  protected deleteShared(key: K): void;
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
   * Synchronizes the cache in bulk with `bulkSync.fn`.
   *
   * Concurrent calls share one sync. Errors are logged; unless `throwOnError` is set they are not
   * rethrown: the cache keeps its current content, and the next call retries the sync.
   * Bulk syncs fill the memory of this instance only, not the shared level.
   *
   * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
   * @returns `true` if the cache is synced (now or by a recent sync), `false` if the sync failed,
   * returned no data, or there is no `bulkSync.fn`.
   * @throws If the cache is disposed.
   */
  protected bulkSync(options?: {
    throwOnError?: boolean;
  }): Promise<boolean>;
  private runBulkSync;
  /**
   * Replaces the content of the cache with a complete load of the source, started with `read`:
   * the loaded entries are stored (unless written since), the others are removed (protected keys
   * are only expired), and the reads of missing keys started before the load are discarded. The
   * entries written after the load started are kept: they are newer than its data.
   */
  protected replaceEntries(read: LilypadCacheRead<K, V>, data: Iterable<readonly [K, LilypadCachedValueType<V>]>): void;
  /** Forces the next bulk sync to fetch fresh data, even if a sync is currently running. */
  protected forceNextBulkSync(): void;
  /**
   * Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out.
   *
   * @throws If the cache is disposed.
   */
  protected getMany(keys: Iterable<K>): Map<K, LilypadCachedValueType<V>>;
  /**
   * Returns every fresh entry, keyed by the key it was stored with (e.g. a number stays a number).
   * Expired entries are left out.
   *
   * @throws If the cache is disposed.
   */
  protected entries(): Map<K, LilypadCachedValueType<V>>;
  /**
   * Like `entries()`, after a `bulkSync` (unless `sync` is false).
   *
   * @throws If the cache is disposed.
   */
  protected getAllEntries({ sync }?: {
    sync?: boolean;
  }): Promise<Map<K, LilypadCachedValueType<V>>>;
  /**
   * Stores several values at once, like `set` (so also in the shared level).
   *
   * @throws If the cache is disposed.
   */
  protected bulkSet(entries: Iterable<readonly [K, LilypadCachedValueType<V>]>): void;
  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  addProtectedKeys(keys: K[]): this;
  /**
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  removeProtectedKeys(keys: K[]): this;
  /**
   * Invalidates the entry of the key.
   *
   * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
   * stays available as a fallback (`onError: { fallback: 'stale' }`). A fetch of the key already
   * in flight is not cached. The key is also removed from the shared level, and
   * `platform.onInvalidate` receives a `manual` event.
   *
   * @param options.invalidateBulkSync - If true (default), forces the next bulk sync. With false,
   * `entries()` leaves the key out until the next bulk sync.
   * @throws If the cache is disposed.
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
   * Marks an entry as expired, keeping its value as a fallback. It is never served as a stale
   * value either. Only this instance is affected. A read of the key already in flight is
   * discarded, since it may predate the change.
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
   * Deletes the key from the cache, and from the shared level. To cache the key as "does not
   * exist" instead, write `null`.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   * @throws If the cache is disposed.
   */
  delete(key: K, options?: {
    force?: boolean;
  }): boolean;
  /** @returns `false` if the key is protected (and `force` is not set). */
  private removeEntry;
  /**
   * Removes all entries from the memory of this instance (not from the shared level), and forces
   * the next bulk sync. Protected keys are kept, unless `force` is set.
   *
   * @throws If the cache is disposed.
   */
  clear(options?: {
    force?: boolean;
  }): void;
  private clearEntries;
  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window of
   * the cache, and the bookkeeping that no longer serves.
   *
   * @param options.force - If true, also removes the expired protected keys.
   * @throws If the cache is disposed.
   */
  purgeExpired(options?: {
    force?: boolean;
  }): void;
  private purgeEntries;
  /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
  private cleanupOnAccess;
  /**
   * Disposes of the cache: stops the cleanup timer and removes every entry. A disposed cache
   * ignores every later internal write, including the ones of fetches still in flight, and its
   * public methods throw. The shared level is left untouched. Calling it again does nothing.
   *
   * It is asynchronous so that subclasses can release their resources (e.g. a database listener):
   * always await it.
   */
  dispose(): Promise<void>;
}
//#endregion
export { LilypadCachedValueType as _, LilypadCacheEntryOrigin as a, LilypadCacheGetOptions as c, LilypadCachePeek as d, LilypadCacheResult as f, LilypadCacheValueFn as g, LilypadCacheSyncFn as h, LilypadCacheEntry as i, LilypadCacheKey as l, LilypadCacheStatus as m, LilypadCacheBulkSyncOptions as n, LilypadCacheErrorContext as o, LilypadCacheSharedOptions as p, LilypadCacheCooldownError as r, LilypadCacheErrorOptions as s, LilypadCacheCore as t, LilypadCacheOptions as u, LilypadSharedCodec as v };
//# sourceMappingURL=LilypadCacheCore-CEgPzhea.d.mts.map