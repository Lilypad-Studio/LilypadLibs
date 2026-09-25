import { LilypadFlowControl } from '@/flow/LilypadFlowControl';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  runAfterResponse,
  runInBackground,
  sharedStoreOperation,
  toTtlSeconds,
  type LilypadInvalidationEvent,
  type LilypadPlatform,
  type LilypadSharedStore,
} from '@/platform/LilypadPlatform';

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

export type LilypadCachedValueType<V> = V | null;

/**
 * Where the value returned by `getOrSetDetailed` comes from:
 * - `L1-HIT`: a fresh value in the memory of this instance;
 * - `L2-HIT`: a fresh value from the shared level;
 * - `STALE`: an expired value within `staleWhileRevalidate`, being refreshed in the background;
 * - `MISS`: fetched now (or a fallback, if the fetch failed).
 */
export type LilypadCacheStatus = 'L1-HIT' | 'L2-HIT' | 'STALE' | 'MISS';

export type LilypadCacheResult<V> = {
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
export type LilypadSharedCodec<V> = {
  encode(value: V): unknown;
  /** Returns `null` when the stored value does not have the expected shape: it is then ignored. */
  decode(raw: unknown): V | null;
};

export type LilypadCacheSharedOptions<V> = {
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
export class LilypadCacheCooldownError extends Error {
  constructor(key: string, cooldown: number) {
    super(`Fetching "${key}" failed less than ${cooldown}ms ago: not retrying yet.`);
    this.name = 'LilypadCacheCooldownError';
  }
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
export type LilypadCacheEntry<K, V> = {
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
export type LilypadCacheRead<K, V> = {
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

export type LilypadCacheEntryOrigin = 'source' | 'fallback' | 'shared';

/** What the cache stores in the shared level. */
type LilypadSharedEnvelope = {
  lilypad: 1;
  value: unknown;
  fetchedAt: number;
  expiresAt: number;
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
export type LilypadCacheValueRetrieval<V> =
  | { type: 'hit' | 'expired'; value: LilypadCachedValueType<V>; expirationTime: number }
  | { type: 'miss' };

export type LilypadCacheSyncFn<K, V> = (
  signal: AbortSignal
) => Promise<[K, LilypadCachedValueType<V>][]>;

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
const DEFAULT_SHARED_TIMEOUT = 300;
/**
 * A background refresh scheduled longer ago than this no longer blocks new ones: it may never
 * have started (e.g. the platform dropped the work scheduled after the response).
 */
const STUCK_REFRESH_AFTER = 60_000;

export type LilypadCacheOptions<K extends LilypadCacheKey, V> = {
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

type LilypadResolvedSharedOptions<V> = {
  store: LilypadSharedStore;
  codec?: LilypadSharedCodec<V>;
  timeout: number;
  refreshLockTtl?: number;
  checkBeforeWrite: boolean;
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
class LilypadCache<K extends LilypadCacheKey, V> {
  public readonly id = `LilypadCache-${globalThis.crypto.randomUUID()}`;
  /** The name given in the options, or the id. */
  public readonly name: string;

  protected store: Map<string, LilypadCacheEntry<K, V>>;
  protected defaultTtl: number; // time to live in milliseconds
  protected defaultErrorTtl: number; // default error TTL in milliseconds
  protected defaultBulkSyncTtl: number;
  protected defaultStaleWhileRevalidate: number;
  protected failureCooldown: number;
  protected cleanupIntervalId?: ReturnType<typeof setInterval> & { unref?: () => void };

  protected protectedKeys: Set<string> = new Set();

  protected logger?: LilypadLibLogger;
  protected platform?: LilypadPlatform;
  private shared?: LilypadResolvedSharedOptions<V>;
  private maxEntries?: number;
  private cleanupOnAccessEvery?: number;
  private lastCleanup = Date.now();
  private tagPrefix: string;

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
  /**
   * Tickets below which the reads of keys without an entry are discarded (normalized keys): set
   * when such a key is expired while a read of it is in flight, since that read may predate the
   * change. Removed once a value is stored, or once no read of the key is in flight.
   */
  private fences = new Map<string, number>();
  /** Values of the shared level produced before this time are not adopted. */
  private sharedNotBefore = 0;
  protected disposed = false;

  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  private failures = new Map<string, number>();
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  private refreshing = new Map<string, number>();

  public constructor(options: LilypadCacheOptions<K, V> = {}) {
    const ttl = options.ttl ?? 60000;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error('ttl must be a positive finite number');
    }
    this.store = new Map();
    this.defaultTtl = ttl;
    this.defaultBulkSyncTtl = options.defaultBulkSyncTtl ?? ttl;
    this.bulkSyncFn = options.bulkSyncFn;
    // A transient error must not pin its fallback for longer than a regular value
    this.defaultErrorTtl = options.defaultErrorTtl ?? Math.min(ttl, DEFAULT_ERROR_TTL);
    this.defaultStaleWhileRevalidate = options.staleWhileRevalidate ?? 0;
    this.failureCooldown = options.failureCooldown ?? 0;
    this.logger = options.logger;
    this.platform = options.platform;
    this.name = options.name ?? this.id;
    this.maxEntries = options.maxEntries;
    this.cleanupOnAccessEvery = options.cleanupOnAccessEvery;
    this.tagPrefix = options.tagPrefix ?? 'lilypad';

    if (options.shared) {
      const store = options.shared.store ?? options.platform?.shared;
      if (!store) {
        throw new Error('LilypadCache: `shared` needs a `store`, or a `platform.shared` store.');
      }
      if (options.name === undefined) {
        throw new Error('LilypadCache: `name` is required with `shared`.');
      }
      this.shared = {
        store,
        codec: options.shared.codec,
        timeout: options.shared.timeout ?? DEFAULT_SHARED_TIMEOUT,
        refreshLockTtl: options.shared.refreshLockTtl,
        checkBeforeWrite: options.shared.checkBeforeWrite ?? false,
      };
    }
    if (options.maxEntries !== undefined && !(options.maxEntries > 0)) {
      throw new Error('maxEntries must be a positive number');
    }
    if (options.cleanupOnAccessEvery !== undefined && !(options.cleanupOnAccessEvery >= 0)) {
      throw new Error('cleanupOnAccessEvery must be a non-negative number');
    }

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

    libLog(this.logger, 'debug', this.name, `LilypadCache initialized`);
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

  /**
   * Starts an asynchronous read of the source: every path that reads the source and stores the
   * result must go through it, so that a slow, older read never overwrites a newer value.
   */
  protected beginRead(): LilypadCacheRead<K, V> {
    const ticket = this.nextTicket();
    const startedAt = Date.now();
    return {
      ticket,
      startedAt,
      store: (key, value, ttl) => this.setIfNewer(key, value, ttl, ticket, startedAt),
      storeFetched: (key, value, ttl) => this.storeFetched(key, value, ttl, ticket, startedAt),
    };
  }

  /**
   * The ticket a read must exceed to store a value for the key: the one of its entry, or else the
   * floor of the missing keys.
   */
  private currentTicket(normalizedKey: string): number {
    const entry = this.store.get(normalizedKey);
    if (entry) {
      return entry.ticket;
    }
    return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0);
  }

  /**
   * Whether a read of the key is in flight. Subclasses that read the source in other ways add
   * their own reads.
   */
  protected hasReadInFlight(normalizedKey: string): boolean {
    return this.flowControl.isInFlight(this.getOrSetFlightId(normalizedKey));
  }

  /**
   * @param newValue - False when the entry keeps its value (e.g. it is only expired): then
   * {@link onValueStored} is not called.
   */
  private writeEntry(entry: LilypadCacheEntry<K, V>, newValue: boolean = true) {
    // A disposed cache stays empty, even when in-flight fetches complete
    if (this.disposed) {
      return;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    if (this.maxEntries !== undefined) {
      // Re-inserted at the end: the Map order is the order of use
      this.store.delete(normalizedKey);
    }
    this.store.set(normalizedKey, entry);
    // The ticket of the entry now orders the reads of the key
    this.fences.delete(normalizedKey);
    if (newValue) {
      this.onValueStored(entry);
      // Otherwise bulkGet would leave the key out while the bulk sync still counts as fresh
      if (entry.expirationTime < this.bulkSyncExpirationTime) {
        this.invalidateBulkSync();
      }
    }
    this.evictOverflow();
  }

  /**
   * Called each time a value is stored in this instance (not when an entry is only expired or
   * removed). Subclasses override it to follow the values; it must not write to the cache.
   */
  protected onValueStored(_entry: LilypadCacheEntry<K, V>): void {}

  /**
   * Removes the least recently used entries beyond `maxEntries`, sparing protected keys. An
   * eviction forces the next bulk sync, since `bulkGet` would no longer return the evicted keys.
   */
  private evictOverflow() {
    if (this.maxEntries === undefined || this.store.size <= this.maxEntries) {
      return;
    }
    let evicted = false;
    for (const normalizedKey of this.store.keys()) {
      if (this.store.size <= this.maxEntries) {
        break;
      }
      if (!this.protectedKeys.has(normalizedKey)) {
        this.store.delete(normalizedKey);
        evicted = true;
      }
    }
    if (evicted) {
      this.invalidateBulkSync();
    }
  }

  /** Marks an entry as recently used, for `maxEntries`. */
  private touch(normalizedKey: string, entry: LilypadCacheEntry<K, V>) {
    if (this.maxEntries !== undefined) {
      this.store.delete(normalizedKey);
      this.store.set(normalizedKey, entry);
    }
  }

  /** Writes to this instance only. */
  private setLocal(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl?: number,
    origin: LilypadCacheEntryOrigin = 'source'
  ): LilypadCacheEntry<K, V> {
    const entry = {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt: Date.now(),
      ticket: this.nextTicket(),
      origin,
    };
    this.writeEntry(entry);
    return entry;
  }

  /**
   * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
   * With a shared level, the value is also written there (in the background).
   *
   * @param key - The key to associate with the cached value.
   * @param value - The value to store in the cache.
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the cache's default TTL is used.
   */
  set(key: K, value: LilypadCachedValueType<V>, ttl?: number) {
    this.cleanupOnAccess();
    const entry = this.setLocal(key, value, ttl);
    this.writeShared(entry);
  }

  /**
   * Stores the result of an asynchronous read, unless a write that started later has already
   * stored a value for the key.
   *
   * @param ticket - The ticket taken with {@link nextTicket} when the read started.
   * @param fetchedAt - When the read started.
   * @returns `true` if the value was stored.
   */
  private setIfNewer(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number,
    fetchedAt: number = Date.now()
  ): boolean {
    if (ticket <= this.currentTicket(this.normalizeKey(key))) {
      return false;
    }
    this.writeEntry({
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket,
      origin: 'source',
    });
    return true;
  }

  /**
   * Stores a value just read from the source: in this instance (if no newer write happened, see
   * {@link setIfNewer}) and in the shared level. It also ends the key's failure cooldown.
   *
   * @returns `true` if the value was stored.
   */
  private storeFetched(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number,
    fetchedAt: number
  ): boolean {
    const normalizedKey = this.normalizeKey(key);
    if (this.failures.delete(normalizedKey) && this.shared && this.failureCooldown > 0) {
      this.sharedInBackground(`delete of the failure of "${normalizedKey}"`, (store) =>
        store.delete(this.sharedFailureKey(normalizedKey))
      );
    }
    if (!this.setIfNewer(key, value, ttl, ticket, fetchedAt)) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (entry) {
      this.writeShared(entry);
    }
    return true;
  }

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
  get(key: K, options: { removeExpired?: boolean } = {}): LilypadCachedValueType<V> | undefined {
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && !isStale(entry)) {
      this.touch(normalizedKey, entry);
      return entry.value;
    } else {
      if (options.removeExpired) {
        this.deleteNormalized(normalizedKey);
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
   * The chosen value (from errorFn or old value) is cached in this instance only, with a TTL
   * specified by `options.errorTtl` or the default error TTL.
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
    this.setLocal(key, valueToReturn, options.errorTtl ?? this.defaultErrorTtl, 'fallback');
    return valueToReturn;
  }

  private getOrSetFlightId(normalizedKey: string): string {
    return `LilypadCache-getOrSet-${normalizedKey}`;
  }

  /**
   * @returns `true` if a `getOrSet` fetch for the key is in flight.
   */
  protected isFetchInFlight(key: K): boolean {
    return this.flowControl.isInFlight(this.getOrSetFlightId(this.normalizeKey(key)));
  }

  /** Throws if the cache is disposed: its reads would query the source without caching. */
  protected assertNotDisposed() {
    if (this.disposed) {
      throw new Error(`LilypadCache "${this.name}" is disposed.`);
    }
  }

  private inCooldown(normalizedKey: string): boolean {
    const failedAt = this.failures.get(normalizedKey);
    return (
      this.failureCooldown > 0 &&
      failedAt !== undefined &&
      Date.now() - failedAt < this.failureCooldown
    );
  }

  private recordFailure(normalizedKey: string) {
    const failedAt = Date.now();
    this.failures.set(normalizedKey, failedAt);
    if (this.shared && this.failureCooldown > 0) {
      this.sharedInBackground(`write of the failure of "${normalizedKey}"`, (store) =>
        store.set(this.sharedFailureKey(normalizedKey), failedAt, {
          ttl: toTtlSeconds(this.failureCooldown),
          tags: [this.cacheTag()],
        })
      );
    }
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
   * @see {@link getOrSetDetailed} to also know where the value comes from
   */
  async getOrSet(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V>> {
    return (await this.getOrSetDetailed(key, valueFn, options)).value;
  }

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
  async getOrSetDetailed(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);

    if (!options.skipCache) {
      const local = this.store.get(normalizedKey);
      if (local && !isStale(local)) {
        this.touch(normalizedKey, local);
        return this.freshHit(key, local, 'L1-HIT', valueFn, options);
      }

      let refreshLocked = false;
      if (this.shared) {
        const read = this.beginRead();
        const remote = await this.readShared(normalizedKey);
        refreshLocked = remote.locked;
        if (remote.failedAt !== undefined) {
          this.failures.set(
            normalizedKey,
            Math.max(remote.failedAt, this.failures.get(normalizedKey) ?? 0)
          );
        }
        const adopted = remote.entry && this.adoptShared(key, remote.entry, read.ticket);
        const current = this.store.get(normalizedKey);
        if (current && !isStale(current)) {
          return this.freshHit(key, current, adopted ? 'L2-HIT' : 'L1-HIT', valueFn, options);
        }
      }

      const current = this.store.get(normalizedKey);
      const staleWindow = options.staleWhileRevalidate ?? this.defaultStaleWhileRevalidate;
      if (current && staleWindow > 0 && Date.now() < current.expirationTime + staleWindow) {
        this.refreshInBackground(key, valueFn, options, refreshLocked);
        const failedAt = this.failures.get(normalizedKey);
        return {
          value: current.value,
          status: 'STALE',
          refreshFailed: failedAt !== undefined && failedAt >= current.fetchedAt,
        };
      }
    }

    if (this.inCooldown(normalizedKey) && !this.isFetchInFlight(key)) {
      const error = new LilypadCacheCooldownError(normalizedKey, this.failureCooldown);
      return { value: this.errorReturn(error, options, key), status: 'MISS', refreshFailed: true };
    }
    try {
      const value = await this.fetchAndStore(key, valueFn, options);
      return { value, status: 'MISS', refreshFailed: false };
    } catch (error) {
      return { value: this.errorReturn(error, options, key), status: 'MISS', refreshFailed: true };
    }
  }

  /**
   * The result of a fresh entry. A fallback is reported as such, and refreshed in the background
   * once the failure cooldown is over: otherwise it would hide the recovery of the source for as
   * long as `errorTtl`.
   */
  private freshHit(
    key: K,
    entry: LilypadCacheEntry<K, V>,
    status: 'L1-HIT' | 'L2-HIT',
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V>
  ): LilypadCacheResult<V> {
    const fallback = entry.origin === 'fallback';
    if (fallback && this.failureCooldown > 0) {
      this.refreshInBackground(key, valueFn, options, false);
    }
    return { value: entry.value, status, refreshFailed: fallback };
  }

  /** Fetches the value (one fetch per key at a time) and stores it. */
  private fetchAndStore(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V>
  ): Promise<LilypadCachedValueType<V>> {
    const normalizedKey = this.normalizeKey(key);
    return this.flowControl.executeFn({
      functionIdentifier: this.getOrSetFlightId(normalizedKey),
      consumerIdentifier: '',
      timeout: options.timeout,
      // Runs once per fetch, while the fallback is chosen per caller in errorReturn
      errorFn: (error) => {
        libLog(
          this.logger,
          'error',
          this.name,
          `Error fetching cache key "${normalizedKey}": `,
          error
        );
        this.recordFailure(normalizedKey);
        throw error;
      },
      fn: async (signal) => {
        const read = this.beginRead();
        const value = await valueFn(signal);
        // After a timeout the caller already got an error/fallback: a late result is not cached
        if (!signal.aborted) {
          read.storeFetched(key, value, options.ttl);
        }
        return value;
      },
    });
  }

  /**
   * Refreshes a stale key after the response (or at once, without `platform.afterResponse`),
   * unless it is already being refreshed, locked by another instance, or in its failure cooldown.
   */
  private refreshInBackground(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V>,
    lockedByOtherInstance: boolean
  ) {
    const normalizedKey = this.normalizeKey(key);
    if (
      lockedByOtherInstance ||
      Date.now() - (this.refreshing.get(normalizedKey) ?? -Infinity) < STUCK_REFRESH_AFTER ||
      this.isFetchInFlight(key) ||
      this.inCooldown(normalizedKey)
    ) {
      return;
    }
    const scheduledAt = Date.now();
    this.refreshing.set(normalizedKey, scheduledAt);
    runAfterResponse(
      this.platform,
      async () => {
        const owner = await this.acquireRefreshLock(normalizedKey);
        try {
          await this.fetchAndStore(key, valueFn, options);
        } finally {
          // A newer refresh may have replaced a stuck one meanwhile
          if (this.refreshing.get(normalizedKey) === scheduledAt) {
            this.refreshing.delete(normalizedKey);
          }
          if (owner) {
            await this.releaseRefreshLock(normalizedKey, owner);
          }
        }
      },
      // The fetch error has already been logged by fetchAndStore
      () => {}
    );
  }

  // SHARED LEVEL

  private sharedKey(normalizedKey: string): string {
    return `lilypad:${this.name}:${normalizedKey}`;
  }

  private sharedFailureKey(normalizedKey: string): string {
    return `${this.sharedKey(normalizedKey)}:failedAt`;
  }

  private sharedLockKey(normalizedKey: string): string {
    return `${this.sharedKey(normalizedKey)}:lock`;
  }

  private cacheTag(): string {
    return `${this.tagPrefix}:${this.name}`;
  }

  /** A shared store operation bounded by the timeout; a failure resolves to `fallback`. */
  private sharedOperation<T>(
    description: string,
    operation: (store: LilypadSharedStore) => Promise<T>,
    fallback: T
  ): Promise<T> {
    const shared = this.shared!;
    return sharedStoreOperation(
      () => operation(shared.store),
      fallback,
      shared.timeout,
      (error) => {
        libLog(this.logger, 'warn', this.name, `Shared cache ${description} failed:`, error);
      }
    );
  }

  private sharedInBackground(
    description: string,
    operation: (store: LilypadSharedStore) => Promise<unknown>
  ) {
    runInBackground(
      this.platform,
      this.sharedOperation(description, operation, undefined),
      () => {}
    );
  }

  /** Reads the entry, the failure time and the refresh lock of a key, in parallel. */
  private async readShared(normalizedKey: string): Promise<{
    entry?: LilypadSharedEnvelope & { decoded: LilypadCachedValueType<V> };
    failedAt?: number;
    locked: boolean;
  }> {
    const [raw, failedAt, lock] = await Promise.all([
      this.sharedOperation(
        `read of "${normalizedKey}"`,
        (store) => store.get(this.sharedKey(normalizedKey)),
        null
      ),
      this.failureCooldown > 0
        ? this.sharedOperation(
            `read of the failure of "${normalizedKey}"`,
            (store) => store.get(this.sharedFailureKey(normalizedKey)),
            null
          )
        : null,
      this.shared!.refreshLockTtl !== undefined
        ? this.sharedOperation(
            `read of the lock of "${normalizedKey}"`,
            (store) => store.get(this.sharedLockKey(normalizedKey)),
            null
          )
        : null,
    ]);
    return {
      entry: this.decodeEnvelope(normalizedKey, raw),
      failedAt: typeof failedAt === 'number' ? failedAt : undefined,
      locked: typeof lock === 'string',
    };
  }

  private decodeEnvelope(
    normalizedKey: string,
    raw: unknown
  ): (LilypadSharedEnvelope & { decoded: LilypadCachedValueType<V> }) | undefined {
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const envelope = raw as Partial<LilypadSharedEnvelope>;
    const valid =
      typeof raw === 'object' &&
      envelope.lilypad === 1 &&
      typeof envelope.fetchedAt === 'number' &&
      typeof envelope.expiresAt === 'number' &&
      'value' in envelope;
    if (!valid) {
      libLog(
        this.logger,
        'warn',
        this.name,
        `Ignoring a malformed shared entry for "${normalizedKey}"`
      );
      return undefined;
    }
    if (envelope.value === null) {
      return { ...(envelope as LilypadSharedEnvelope), decoded: null };
    }
    const codec = this.shared!.codec;
    const decoded = codec ? codec.decode(envelope.value) : (envelope.value as V);
    if (decoded === null) {
      libLog(
        this.logger,
        'warn',
        this.name,
        `Ignoring a shared entry rejected by the codec: "${normalizedKey}"`
      );
      return undefined;
    }
    return { ...(envelope as LilypadSharedEnvelope), decoded };
  }

  /**
   * Copies an entry of the shared level into this instance, if it is newer than the local one,
   * produced after the local one was invalidated, and no local write started after the read of
   * the shared level.
   *
   * @returns `true` if the entry was copied.
   */
  private adoptShared(
    key: K,
    remote: LilypadSharedEnvelope & { decoded: LilypadCachedValueType<V> },
    ticket: number
  ): boolean {
    const normalizedKey = this.normalizeKey(key);
    const current = this.store.get(normalizedKey);
    if (current && current.fetchedAt >= remote.fetchedAt) {
      return false;
    }
    // A copy read before the invalidation, whose removal from the shared level failed or was
    // undone by another instance
    if (current?.invalidatedAt !== undefined && remote.fetchedAt < current.invalidatedAt) {
      return false;
    }
    if (remote.fetchedAt < this.sharedNotBefore) {
      return false;
    }
    if (ticket <= this.currentTicket(normalizedKey)) {
      return false;
    }
    this.writeEntry({
      key,
      value: remote.decoded,
      expirationTime: remote.expiresAt,
      fetchedAt: remote.fetchedAt,
      ticket,
      origin: 'shared',
    });
    return true;
  }

  /**
   * Writes an entry to the shared level in the background. With `checkBeforeWrite`, it leaves
   * alone a shared value fetched later (a soft check: read and write are not atomic).
   */
  private writeShared(entry: LilypadCacheEntry<K, V>) {
    if (!this.shared) {
      return;
    }
    const checkBeforeWrite = this.shared.checkBeforeWrite;
    const normalizedKey = this.normalizeKey(entry.key);
    const lifetime = entry.expirationTime + this.defaultStaleWhileRevalidate - Date.now();
    if (lifetime <= 0) {
      return;
    }
    const codec = this.shared.codec;
    const envelope: LilypadSharedEnvelope = {
      lilypad: 1,
      value: entry.value === null || !codec ? entry.value : codec.encode(entry.value),
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expirationTime,
    };
    this.sharedInBackground(`write of "${normalizedKey}"`, async (store) => {
      if (checkBeforeWrite) {
        const current = (await store.get(this.sharedKey(normalizedKey))) as
          | Partial<LilypadSharedEnvelope>
          | null
          | undefined;
        if (typeof current?.fetchedAt === 'number' && current.fetchedAt > envelope.fetchedAt) {
          return;
        }
      }
      await store.set(this.sharedKey(normalizedKey), envelope, {
        ttl: toTtlSeconds(lifetime),
        tags: [this.cacheTag()],
      });
    });
  }

  /** Removes a key from the shared level, in the background. */
  protected deleteShared(key: K) {
    if (!this.shared) {
      return;
    }
    const normalizedKey = this.normalizeKey(key);
    this.sharedInBackground(`delete of "${normalizedKey}"`, (store) =>
      store.delete(this.sharedKey(normalizedKey))
    );
  }

  /** @returns The lock owner id, or undefined when no lock is configured. */
  private async acquireRefreshLock(normalizedKey: string): Promise<string | undefined> {
    const lockTtl = this.shared?.refreshLockTtl;
    if (lockTtl === undefined) {
      return undefined;
    }
    const owner = globalThis.crypto.randomUUID();
    await this.sharedOperation(
      `write of the lock of "${normalizedKey}"`,
      (store) =>
        store.set(this.sharedLockKey(normalizedKey), owner, { ttl: toTtlSeconds(lockTtl) }),
      undefined
    );
    return owner;
  }

  /** Releases the lock only if it still belongs to this refresh, not to another instance. */
  private async releaseRefreshLock(normalizedKey: string, owner: string) {
    const current = await this.sharedOperation(
      `read of the lock of "${normalizedKey}"`,
      (store) => store.get(this.sharedLockKey(normalizedKey)),
      null
    );
    if (current === owner) {
      await this.sharedOperation(
        `delete of the lock of "${normalizedKey}"`,
        (store) => store.delete(this.sharedLockKey(normalizedKey)),
        undefined
      );
    }
  }

  // INVALIDATION EVENTS

  /**
   * Sends an invalidation event to `platform.onInvalidate`, in the background.
   *
   * @param options.wholeCache - The whole cache changed (e.g. a table was emptied): the event is
   * sent even without keys, and its tags always include the tag of the cache.
   */
  protected emitInvalidation(
    source: LilypadInvalidationEvent['source'],
    keys: K[],
    options: { wholeCache?: boolean } = {}
  ) {
    const onInvalidate = this.platform?.onInvalidate;
    if (!onInvalidate || (keys.length === 0 && !options.wholeCache)) {
      return;
    }
    const normalizedKeys = keys.map((key) => this.normalizeKey(key));
    const event: LilypadInvalidationEvent = {
      source,
      cache: this.name,
      keys: normalizedKeys,
      tags: [this.cacheTag(), ...normalizedKeys.map((key) => `${this.cacheTag()}:${key}`)],
    };
    runInBackground(
      this.platform,
      Promise.resolve().then(() => onInvalidate(event)),
      (error) => libLog(this.logger, 'error', this.name, 'Error in onInvalidate:', error)
    );
  }

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
  async bulkSync(options: { throwOnError?: boolean } = {}): Promise<boolean> {
    try {
      return await this.bulkSyncFlowControl.executeFn({
        functionIdentifier: `LilypadCache-bulkSync`,
        consumerIdentifier: '',
        errorFn: (error) => {
          libLog(this.logger, 'error', this.name, 'Error during bulk sync: ', error);
          throw error;
        },
        fn: async (signal) => this._bulkSync(signal),
      });
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      return false;
    }
  }
  private async _bulkSync(signal: AbortSignal): Promise<boolean> {
    if (Date.now() < this.bulkSyncExpirationTime) {
      return true;
    }
    const read = this.beginRead();
    const data = await this.bulkSyncFn?.(signal);
    if (signal.aborted) {
      // Timed out: the caller already got an error, and a newer sync may be running
      return false;
    }
    if (!data) {
      libLog(this.logger, 'warn', this.name, 'Bulk sync function returned no data');
      return false;
    }

    const incoming = new Map<string, [K, LilypadCachedValueType<V>]>();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    if (this.maxEntries !== undefined && incoming.size > this.maxEntries) {
      libLog(
        this.logger,
        'warn',
        this.name,
        `Bulk sync returned ${incoming.size} entries, more than maxEntries (${this.maxEntries}): bulkGet cannot return them all.`
      );
    }
    // Taken before the entries are written, which expire at the earliest `defaultTtl` after it
    const storedAt = Date.now();
    // A copy of the entries: expiring an entry re-inserts it, with maxEntries
    for (const [normalizedKey, entry] of [...this.store]) {
      // Entries written after the sync started are newer than its data; incoming keys are overwritten below
      if (entry.ticket > read.ticket || incoming.has(normalizedKey)) {
        continue;
      }
      if (!this.deleteNormalized(normalizedKey)) {
        this.expireNormalized(normalizedKey); // protected keys are kept, but marked as stale
      }
    }
    for (const [key, value] of incoming.values()) {
      read.store(key, value);
    }
    this.ticketFloor = Math.max(this.ticketFloor, read.ticket);

    // An invalidation that happened while the sync was running may not be reflected in its data
    if (this.bulkSyncInvalidationTicket < read.ticket) {
      // Never beyond the expiration of the entries: `bulkGet` would then return an incomplete
      // (or empty) set while the sync still counts as fresh
      this.bulkSyncExpirationTime = storedAt + Math.min(this.defaultBulkSyncTtl, this.defaultTtl);
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
   * Optionally synchronizes the cache with `bulkSyncFn` before retrieval.
   *
   * @param options - The options for bulk retrieval.
   * @param options.keys - An array of keys to retrieve from the cache.
   * @param options.doSync - If true (default), runs `bulkSync` before retrieval.
   * @returns A promise that resolves to a map of keys to their corresponding values.
   */
  async bulkAsyncGet({
    keys,
    doSync = true,
  }: {
    keys?: K[];
    doSync?: boolean;
  } = {}): Promise<Map<K, LilypadCachedValueType<V>>> {
    if (doSync) {
      await this.bulkSync();
    }
    return this.bulkGet({ keys });
  }

  /**
   * Sets multiple key-value pairs in the cache at once.
   *
   * Accepts either a `Map<K, V>` or an array of `[K, V]` tuples.
   * Each entry is added to the cache using the `set` method (so also to the shared level).
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
  invalidate(key: K, { invalidateBulkSync = true }: { invalidateBulkSync?: boolean } = {}) {
    this.markInvalid(key, { invalidateBulkSync });
    this.emitInvalidation('manual', [key]);
  }

  /**
   * The effect of `invalidate` on the data, without the invalidation event: expires the entry in
   * this instance, removes it from the shared level and optionally forces the next bulk sync.
   */
  protected markInvalid(
    key: K,
    { invalidateBulkSync = true }: { invalidateBulkSync?: boolean } = {}
  ) {
    this.expire(key);
    this.deleteShared(key);
    if (invalidateBulkSync) {
      this.invalidateBulkSync();
    }
  }

  /**
   * Marks a cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
   * It is never served as a stale value either. Only this instance is affected.
   * A read of the key already in flight is discarded, since it may predate the change.
   *
   * @param key - The key of the cache entry to expire.
   */
  protected expire(key: K) {
    this.expireNormalized(this.normalizeKey(key));
  }

  private expireNormalized(normalizedKey: string) {
    const entry = this.store.get(normalizedKey);
    if (!entry) {
      if (this.hasReadInFlight(normalizedKey)) {
        this.fences.set(normalizedKey, this.nextTicket());
      }
      return;
    }
    if (entry.expirationTime > 0) {
      this.writeEntry(
        { ...entry, expirationTime: 0, ticket: this.nextTicket(), invalidatedAt: Date.now() },
        false
      );
    }
  }

  /**
   * Expires every entry, forces the next bulk sync, and discards the results of the reads started
   * before (fetches and bulk syncs): the source may have changed in any way.
   */
  protected expireEverything() {
    for (const normalizedKey of [...this.store.keys()]) {
      this.expireNormalized(normalizedKey);
    }
    this.ticketFloor = Math.max(this.ticketFloor, this.nextTicket());
    this.fences.clear();
    this.invalidateBulkSync();
  }

  /**
   * From now on, the values of the shared level produced before `time` are ignored (e.g. the
   * source was emptied at that time, and the shared level may still hold older copies).
   */
  protected rejectSharedBefore(time: number) {
    this.sharedNotBefore = Math.max(this.sharedNotBefore, time);
  }

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
  delete(key: K, options: { force?: boolean } = {}) {
    const deleted = this.deleteNormalized(this.normalizeKey(key), options);
    if (deleted) {
      this.deleteShared(key);
    }
    return deleted;
  }

  private deleteNormalized(normalizedKey: string, options: { force?: boolean } = {}): boolean {
    if (this.protectedKeys.has(normalizedKey) && !options.force) {
      return false;
    }
    this.store.delete(normalizedKey);
    return true;
  }

  /**
   * Removes all entries from the memory of this instance (not from the shared level), and forces
   * the next bulk sync. Protected keys are kept, unless `force` is set.
   *
   * @param options.force - If `true`, also removes the protected keys.
   */
  clear(options: { force?: boolean } = {}) {
    for (const normalizedKey of [...this.store.keys()]) {
      this.deleteNormalized(normalizedKey, options);
    }
    // Otherwise a bulk sync still fresh would let bulkGet return the emptied cache as complete
    this.invalidateBulkSync();
  }

  /**
   * Removes all expired entries from the cache, except those still within the
   * `staleWhileRevalidate` window of the cache, and the bookkeeping that no longer serves.
   *
   * @param options - Optional settings for the purge operation.
   * @param options.force - If true, also removes the expired protected keys.
   */
  purgeExpired(options: { force?: boolean } = {}) {
    const now = Date.now();
    for (const [normalizedKey, entry] of [...this.store]) {
      if (now >= entry.expirationTime + this.defaultStaleWhileRevalidate) {
        this.deleteNormalized(normalizedKey, options);
      }
    }
    for (const [normalizedKey, failedAt] of this.failures) {
      if (now - failedAt >= this.failureCooldown) {
        this.failures.delete(normalizedKey);
      }
    }
    // Refreshes that never started (e.g. work after the response dropped by the platform)
    for (const [normalizedKey, scheduledAt] of this.refreshing) {
      if (now - scheduledAt >= STUCK_REFRESH_AFTER) {
        this.refreshing.delete(normalizedKey);
      }
    }
    for (const normalizedKey of this.fences.keys()) {
      if (!this.hasReadInFlight(normalizedKey)) {
        this.fences.delete(normalizedKey);
      }
    }
  }

  /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
  private cleanupOnAccess() {
    if (this.cleanupOnAccessEvery === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCleanup >= this.cleanupOnAccessEvery) {
      this.lastCleanup = now;
      this.purgeExpired();
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
   * A disposed cache ignores every later write, including the ones of fetches still in flight,
   * and its reads (`getOrSet`) throw. The shared level is left untouched.
   *
   * It is asynchronous so that subclasses can release their resources (e.g. a database listener):
   * always await it.
   */
  dispose(): Promise<void> {
    this.logger = undefined;
    this.stopCleanupInterval();
    this.clear({ force: true });
    this.fences.clear();
    this.refreshing.clear();
    this.disposed = true;
    return Promise.resolve();
  }
}
export default LilypadCache;
