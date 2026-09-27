import { n as LilypadDisposedError } from "./LilypadCacheTypes-DuzvYfI8.mjs";
import { t as LilypadCacheEngine } from "./LilypadCacheEngine-BqEnxCi2.mjs";
import { t as assertNumberOption } from "./LilypadValidation-ByfswRPE.mjs";
import { t as LilypadFlowControl } from "./LilypadFlowControl-vVbPn-4y.mjs";
//#region src/cache/LilypadCache.ts
const DEFAULT_BULK_SYNC_TIMEOUT = 3e4;
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
var LilypadCache = class {
	/** @throws If an option is not valid. */
	constructor(options = {}) {
		this.bulkSyncExpirationTime = 0;
		this.bulkSyncInvalidationTicket = 0;
		const { bulkSync, ...engineOptions } = options;
		assertNumberOption("LilypadCache", "bulkSync.ttl", bulkSync?.ttl, "non-negative");
		assertNumberOption("LilypadCache", "bulkSync.timeout", bulkSync?.timeout, "positive-delay");
		this.engine = new LilypadCacheEngine(engineOptions, {
			onValueStored: (entry) => {
				if (entry.expirationTime < this.bulkSyncExpirationTime) this.forceNextBulkSync();
			},
			onEntriesIncomplete: () => this.forceNextBulkSync()
		});
		this.bulkSyncFn = bulkSync?.fn;
		this.bulkSyncTtl = bulkSync?.ttl ?? this.engine.defaultTtl;
		this.bulkSyncFlowControl = new LilypadFlowControl({ timeout: bulkSync?.timeout ?? DEFAULT_BULK_SYNC_TIMEOUT });
	}
	/** A unique id of the instance. */
	get id() {
		return this.engine.id;
	}
	/** The name given in the options, or the id. */
	get name() {
		return this.engine.name;
	}
	/** @throws {LilypadDisposedError} If the cache is disposed. */
	assertNotDisposed() {
		if (this.engine.disposed) throw new LilypadDisposedError(`LilypadCache "${this.name}"`);
	}
	/**
	* Returns the value of the key if it is cached and fresh, otherwise `undefined`. It reads the
	* memory of this instance only: `getOrSet` also reads the shared level.
	*
	* @param options.removeExpired - If true, an expired value is also removed. Defaults to false, so
	* that the old value stays available as a fallback (`onError: { fallback: 'stale' }`).
	*/
	get(key, options) {
		this.assertNotDisposed();
		return this.engine.get(key, options);
	}
	/**
	* Tells whether the key is cached, and whether its value is fresh or expired, without side
	* effects (no cleanup, no change of the order of use).
	*/
	peek(key) {
		this.assertNotDisposed();
		return this.engine.peek(key);
	}
	/**
	* Stores a value in the cache, and in the shared level (in the background).
	*
	* @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
	*/
	set(key, value, ttl) {
		this.assertNotDisposed();
		this.engine.set(key, value, ttl);
	}
	/** Stores several values at once, like `set` (so also in the shared level). */
	bulkSet(entries) {
		this.assertNotDisposed();
		for (const [key, value] of entries) this.engine.set(key, value);
	}
	/**
	* Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
	* the same key share one fetch; the `onError` options still apply separately to each caller.
	*
	* @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
	* @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
	* @see {@link getOrSetDetailed} to also know where the value comes from
	*/
	async getOrSet(key, valueFn, options) {
		return (await this.getOrSetDetailed(key, valueFn, options)).value;
	}
	/**
	* Like {@link getOrSet}, but also tells where the value comes from and whether the last fetch
	* failed.
	*
	* The lookup order is: memory of this instance, shared level, stale value (returned at once and
	* refreshed in the background, within `staleWhileRevalidate`), fetch.
	*/
	getOrSetDetailed(key, valueFn, options) {
		try {
			this.assertNotDisposed();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.engine.getOrSetDetailed(key, valueFn, options);
	}
	/** Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out. */
	getMany(keys) {
		this.assertNotDisposed();
		return this.engine.getMany(keys);
	}
	/**
	* Returns every fresh entry, keyed by the key it was stored with. It is the whole source only
	* while the last `bulkSync` is fresh: use `getAll` to sync first.
	*/
	entries() {
		this.assertNotDisposed();
		return this.engine.entries();
	}
	/** Like `entries()`, after a `bulkSync` (unless `sync` is false). */
	async getAll({ sync = true } = {}) {
		if (sync) await this.bulkSync();
		return this.entries();
	}
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
	async bulkSync(options = {}) {
		this.assertNotDisposed();
		const bulkSyncFn = this.bulkSyncFn;
		if (!bulkSyncFn) {
			if (options.throwOnError) throw new Error(`LilypadCache "${this.name}" has no bulkSync.fn.`);
			return false;
		}
		try {
			return await this.bulkSyncFlowControl.singleFlight("LilypadCache-bulkSync", () => this.bulkSyncFlowControl.executeWithTimeout((signal) => this.runBulkSync(bulkSyncFn, signal)).catch((error) => {
				this.engine.log("error", "Error during bulk sync:", error);
				throw error;
			}));
		} catch (error) {
			if (options.throwOnError) throw error;
			return false;
		}
	}
	async runBulkSync(bulkSyncFn, signal) {
		if (Date.now() < this.bulkSyncExpirationTime) return true;
		const read = this.engine.beginRead();
		const data = await bulkSyncFn(signal);
		if (signal.aborted) return false;
		if (!data) {
			this.engine.log("warn", "Bulk sync function returned no data");
			return false;
		}
		const storedAt = Date.now();
		this.engine.replaceEntries(read, data);
		if (this.bulkSyncInvalidationTicket < read.ticket) this.bulkSyncExpirationTime = storedAt + Math.min(this.bulkSyncTtl, this.engine.defaultTtl);
		return true;
	}
	/**
	* Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running (that
	* sync then does not count as fresh).
	*/
	invalidateBulkSync() {
		this.assertNotDisposed();
		this.forceNextBulkSync();
	}
	forceNextBulkSync() {
		this.bulkSyncExpirationTime = 0;
		this.bulkSyncInvalidationTicket = this.engine.nextTicket();
	}
	/**
	* Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
	*
	* @returns The cache, for chaining.
	*/
	addProtectedKeys(keys) {
		this.assertNotDisposed();
		this.engine.addProtectedKeys(keys);
		return this;
	}
	/** @returns The cache, for chaining. */
	removeProtectedKeys(keys) {
		this.assertNotDisposed();
		this.engine.removeProtectedKeys(keys);
		return this;
	}
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
	invalidate(key, { invalidateBulkSync = true } = {}) {
		this.assertNotDisposed();
		this.engine.invalidate(key);
		if (invalidateBulkSync) this.forceNextBulkSync();
	}
	/**
	* Deletes the key from the cache, and from the shared level. To cache the key as "does not
	* exist" instead, write `null`.
	*
	* @param options.force - If true, also deletes a protected key.
	* @returns `false` if the key is protected and was left untouched.
	*/
	delete(key, options) {
		this.assertNotDisposed();
		return this.engine.delete(key, options);
	}
	/**
	* Removes all entries from the memory of this instance (not from the shared level), and forces
	* the next bulk sync. Protected keys are kept, unless `force` is set.
	*/
	clear(options) {
		this.assertNotDisposed();
		this.engine.clear(options);
	}
	/**
	* Removes all expired entries, except those still within the `staleWhileRevalidate` window of
	* the cache, and the bookkeeping that no longer serves.
	*
	* @param options.force - If true, also removes the expired protected keys.
	*/
	purgeExpired(options) {
		this.assertNotDisposed();
		this.engine.purgeExpired(options);
	}
	/**
	* Disposes of the cache: stops the cleanup timer and removes every entry. A disposed cache
	* ignores every later internal write, including the ones of fetches still in flight, and its
	* methods throw. The shared level is left untouched. Calling it again does nothing.
	*/
	dispose() {
		this.engine.dispose();
		return Promise.resolve();
	}
	/** `await using cache = ...` disposes of the cache at the end of the scope. */
	[Symbol.asyncDispose]() {
		return this.dispose();
	}
};
//#endregion
export { LilypadCache as t };

//# sourceMappingURL=cache-XcCUYurS.mjs.map