"use strict";
const require_LilypadCacheCore = require("./LilypadCacheCore-CMu2ChAi.cjs");
//#region src/cache/LilypadCache.ts
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
* newer value.
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
var LilypadCache = class extends require_LilypadCacheCore.LilypadCacheCore {
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
//#endregion
Object.defineProperty(exports, "LilypadCache", {
	enumerable: true,
	get: function() {
		return LilypadCache;
	}
});

//# sourceMappingURL=cache-DMu0s-oy.cjs.map