"use strict";Object.defineProperty(exports, "__esModule", {value: true});

var _chunk4MPPN5CNjs = require('./chunk-4MPPN5CN.js');

// src/cache/LilypadCache.ts
var LilypadCache = class extends _chunk4MPPN5CNjs.LilypadCacheCore {
  constructor(options = {}) {
    super(options);
  }
  /**
   * Stores a value in the cache, and in the shared level (in the background).
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   * @throws If the cache is disposed.
   */
  set(key, value, ttl) {
    super.set(key, value, ttl);
  }
  /**
   * Stores several values at once, like `set` (so also in the shared level).
   *
   * @throws If the cache is disposed.
   */
  bulkSet(entries) {
    super.bulkSet(entries);
  }
  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
   * the same key share one fetch; the `onError` options still apply separately to each caller.
   *
   * @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value,
   * or if the cache is disposed.
   * @see {@link getOrSetDetailed} to also know where the value comes from
   */
  getOrSet(key, valueFn, options) {
    return super.getOrSet(key, valueFn, options);
  }
  /**
   * Like {@link getOrSet}, but also tells where the value comes from and whether the last fetch
   * failed.
   *
   * The lookup order is: memory of this instance, shared level, stale value (returned at once and
   * refreshed in the background, within `staleWhileRevalidate`), fetch.
   *
   * @throws If the cache is disposed.
   */
  getOrSetDetailed(key, valueFn, options) {
    return super.getOrSetDetailed(key, valueFn, options);
  }
  /**
   * Synchronizes the cache in bulk with `bulkSync.fn`. Concurrent calls share one sync. Errors are
   * logged; unless `throwOnError` is set they are not rethrown.
   *
   * @returns `true` if the cache is synced (now or by a recent sync), `false` if the sync failed,
   * returned no data, or there is no `bulkSync.fn`.
   * @throws If the cache is disposed.
   */
  bulkSync(options) {
    return super.bulkSync(options);
  }
  /**
   * Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out.
   *
   * @throws If the cache is disposed.
   */
  getMany(keys) {
    return super.getMany(keys);
  }
  /**
   * Returns every fresh entry, keyed by the key it was stored with. It is the whole source only
   * while the last `bulkSync` is fresh: use `getAll` to sync first.
   *
   * @throws If the cache is disposed.
   */
  entries() {
    return super.entries();
  }
  /**
   * Like `entries()`, after a `bulkSync` (unless `sync` is false).
   *
   * @throws If the cache is disposed.
   */
  getAll(options) {
    return this.getAllEntries(options);
  }
  /**
   * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running (that
   * sync then does not count as fresh).
   *
   * @throws If the cache is disposed.
   */
  invalidateBulkSync() {
    this.assertNotDisposed();
    this.forceNextBulkSync();
  }
};



exports.LilypadCache = LilypadCache;
//# sourceMappingURL=chunk-T3SYQIKG.js.map