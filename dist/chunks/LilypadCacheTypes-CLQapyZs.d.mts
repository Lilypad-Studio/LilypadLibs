import { n as LilypadLibLogger } from "./LilypadLibLogger-D3C4iJKK.mjs";
import { i as LilypadSharedStore, r as LilypadPlatform } from "./LilypadPlatform-BcgvOfll.mjs";
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
/** Thrown by the public methods of a cache (or a gate) once it is disposed (or closed). */
declare class LilypadDisposedError extends Error {
  /** @param subject - What is disposed, e.g. `LilypadCache "users"`. */
  constructor(subject: string, state?: 'disposed' | 'closed');
}
type LilypadCacheEntryOrigin = 'source' | 'fallback' | 'shared';
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
export { LilypadSharedCodec as _, LilypadCacheErrorOptions as a, LilypadCacheOptions as c, LilypadCacheSharedOptions as d, LilypadCacheStatus as f, LilypadDisposedError as g, LilypadCachedValueType as h, LilypadCacheErrorContext as i, LilypadCachePeek as l, LilypadCacheValueFn as m, LilypadCacheCooldownError as n, LilypadCacheGetOptions as o, LilypadCacheSyncFn as p, LilypadCacheEntryOrigin as r, LilypadCacheKey as s, LilypadCacheBulkSyncOptions as t, LilypadCacheResult as u };
//# sourceMappingURL=LilypadCacheTypes-CLQapyZs.d.mts.map