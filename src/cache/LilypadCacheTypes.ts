import type { LilypadLibLogger } from '@/logger/LilypadLibLogger';
import type { LilypadPlatform, LilypadSharedStore } from '@/platform/LilypadPlatform';

/**
 * The keys accepted by the cache. Keys are compared by their string form, so `42` and `'42'`
 * address the same entry.
 */
export type LilypadCacheKey = string | number;

/** A cached value: `null` means "known not to exist", as opposed to "not cached" (`undefined`). */
export type LilypadCachedValueType<V> = V | null;

/** The source of a value, for `getOrSet`: it receives a signal aborted when the fetch times out. */
export type LilypadCacheValueFn<V> = (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>;

/** What the fallback function of `onError` receives. */
export type LilypadCacheErrorContext<K extends LilypadCacheKey, V> = {
  key: K;
  /** The error of the fetch, or a `LilypadCacheCooldownError`. */
  error: unknown;
  /** The last value of the key, expired or invalidated, if the cache still holds one. */
  stale?: { value: LilypadCachedValueType<V>; fetchedAt: number };
};

/** What `getOrSet` returns when the fetch fails. */
export type LilypadCacheErrorOptions<K extends LilypadCacheKey, V> = {
  /**
   * - `'stale'`: the last value of the key, even expired or invalidated;
   * - a function: its result (it can return `context.stale?.value`), or `undefined` to rethrow.
   *
   * The fallback is cached in this instance only, for `ttl`. Without a fallback value, the error
   * is rethrown.
   */
  fallback?:
    | 'stale'
    | ((context: LilypadCacheErrorContext<K, V>) => LilypadCachedValueType<V> | undefined);
  /** TTL of the cached fallback, in ms. Defaults to the cache's `errorTtl`. */
  ttl?: number;
};

export type LilypadCacheGetOptions<K extends LilypadCacheKey, V> = {
  /**
   * TTL in milliseconds of the fetched value; defaults to the cache's TTL. Concurrent calls share
   * one fetch: the value is cached with the TTL of the call that started it.
   */
  ttl?: number;
  /** If true, bypasses the cache and always calls `valueFn`. */
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
export type LilypadCacheStatus = 'L1-HIT' | 'L2-HIT' | 'STALE' | 'MISS';

export type LilypadCacheResult<V> = {
  value: LilypadCachedValueType<V>;
  status: LilypadCacheStatus;
  /**
   * The last fetch of the key failed: the value is a stale copy, or a fallback chosen after the
   * error (`onError`), also while that fallback is cached.
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

export type LilypadCacheEntryOrigin = 'source' | 'fallback' | 'shared';

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
 * An asynchronous read of the source, started with `beginRead()`. Its results are stored only if
 * no write that started later has already stored a value for the key.
 */
export type LilypadCacheRead<K, V> = {
  /** Orders the read among the writes. */
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

/**
 * What `peek` returns:
 * - `hit`: the value is cached and fresh;
 * - `expired`: the value is cached but expired (or invalidated);
 * - `miss`: the key is not cached.
 */
export type LilypadCachePeek<V> =
  | { type: 'hit' | 'expired'; value: LilypadCachedValueType<V>; expirationTime: number }
  | { type: 'miss' };

export type LilypadCacheSyncFn<K, V> = (
  signal: AbortSignal
) => Promise<[K, LilypadCachedValueType<V>][]>;

export type LilypadCacheBulkSyncOptions<K, V> = {
  /**
   * Loads every entry of the source, for `bulkSync` and `bulkAsyncGet`. It receives a signal that
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
  /** TTL of the fallbacks cached after a failed fetch. Defaults to the smaller of `ttl` and 5 minutes. */
  errorTtl?: number;
  /** Timeout of the fetches of `getOrSet`, in milliseconds. Defaults to 5 seconds. */
  fetchTimeout?: number;
  /** Loading the whole source at once (`bulkSync`, `bulkAsyncGet`). */
  bulkSync?: LilypadCacheBulkSyncOptions<K, V>;
  logger?: LilypadLibLogger;
  /** Prefix of the tags of the invalidation events. Defaults to `lilypad`. */
  tagPrefix?: string;
};
