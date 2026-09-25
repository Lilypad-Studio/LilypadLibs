import {
  LilypadFlowControl
} from "./chunk-Z7QMURG2.mjs";
import {
  runAfterResponse,
  runInBackground,
  sharedStoreOperation,
  toTtlSeconds
} from "./chunk-3L5FE6KG.mjs";

// src/cache/LilypadCache.ts
var LilypadCacheCooldownError = class extends Error {
  constructor(key, cooldown) {
    super(`Fetching "${key}" failed less than ${cooldown}ms ago: not retrying yet.`);
    this.name = "LilypadCacheCooldownError";
  }
};
function isStale(entry) {
  return Date.now() >= entry.expirationTime;
}
var DEFAULT_ERROR_TTL = 5 * 60 * 1e3;
var DEFAULT_SHARED_TIMEOUT = 300;
var STUCK_REFRESH_AFTER = 6e4;
var LilypadCache = class {
  id = `LilypadCache-${globalThis.crypto.randomUUID()}`;
  /** The name given in the options, or the id. */
  name;
  store;
  defaultTtl;
  // time to live in milliseconds
  defaultErrorTtl;
  // default error TTL in milliseconds
  defaultBulkSyncTtl;
  defaultStaleWhileRevalidate;
  failureCooldown;
  cleanupIntervalId;
  protectedKeys = /* @__PURE__ */ new Set();
  logger;
  platform;
  shared;
  maxEntries;
  cleanupOnAccessEvery;
  lastCleanup = Date.now();
  tagPrefix;
  flowControl;
  bulkSyncFlowControl;
  /**
   * Timestamp of the last bulk sync operation.
   * If the cache is backed by a database or external store,
   * It's possible that "every entry in the cache" is not the same as "every key in the store".
   * This timestamp can be used to track when the last bulk sync occurred, which would
   * have synced the cache with the store.
   */
  bulkSyncExpirationTime = 0;
  bulkSyncFn;
  /** Source of the write tickets: see {@link setIfNewer}. */
  lastTicket = 0;
  /**
   * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
   * already holds data newer than theirs.
   */
  ticketFloor = 0;
  /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
  bulkSyncInvalidationTicket = 0;
  disposed = false;
  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  failures = /* @__PURE__ */ new Map();
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  refreshing = /* @__PURE__ */ new Map();
  constructor(ttl = 6e4, options = {}) {
    var _a, _b;
    this.store = /* @__PURE__ */ new Map();
    this.defaultTtl = ttl;
    this.defaultBulkSyncTtl = options.defaultBulkSyncTtl ?? ttl;
    this.bulkSyncFn = options.bulkSyncFn;
    this.defaultErrorTtl = options.defaultErrorTtl ?? Math.min(ttl, DEFAULT_ERROR_TTL);
    this.defaultStaleWhileRevalidate = options.staleWhileRevalidate ?? 0;
    this.failureCooldown = options.failureCooldown ?? 0;
    this.logger = options.logger;
    this.platform = options.platform;
    this.name = options.name ?? this.id;
    this.maxEntries = options.maxEntries;
    this.cleanupOnAccessEvery = options.cleanupOnAccessEvery;
    this.tagPrefix = options.tagPrefix ?? "lilypad";
    if (options.shared) {
      const store = options.shared.store ?? ((_a = options.platform) == null ? void 0 : _a.shared);
      if (!store) {
        throw new Error("LilypadCache: `shared` needs a `store`, or a `platform.shared` store.");
      }
      if (options.name === void 0) {
        throw new Error("LilypadCache: `name` is required with `shared`.");
      }
      this.shared = {
        store,
        codec: options.shared.codec,
        timeout: options.shared.timeout ?? DEFAULT_SHARED_TIMEOUT,
        refreshLockTtl: options.shared.refreshLockTtl
      };
    }
    if (options.maxEntries !== void 0 && !(options.maxEntries > 0)) {
      throw new Error("maxEntries must be a positive number");
    }
    this.flowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: options.flowControlTimeout ?? 5e3
    });
    this.bulkSyncFlowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: options.bulkSyncTimeout ?? 3e4
    });
    if (options.autoCleanupInterval) {
      if (!Number.isFinite(options.autoCleanupInterval) || options.autoCleanupInterval <= 0) {
        throw new Error("autoCleanupInterval must be a positive finite number");
      }
      this.cleanupIntervalId = setInterval(() => this.purgeExpired(), options.autoCleanupInterval);
      if (this.cleanupIntervalId && typeof this.cleanupIntervalId.unref === "function") {
        this.cleanupIntervalId.unref();
      }
    }
    void ((_b = this.logger) == null ? void 0 : _b.debug(this.id, `LilypadCache initialized`));
  }
  /**
   * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
   *
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
   * @returns The expiration time as a Unix timestamp in milliseconds.
   */
  createExpirationTime(ttl) {
    return Date.now() + (ttl ?? this.defaultTtl);
  }
  /**
   * Normalizes a key to the string form used by the store and by the protected keys.
   */
  normalizeKey(key) {
    return String(key);
  }
  /**
   * Takes a write ticket. An asynchronous write takes it when it starts, and passes it to
   * {@link setIfNewer} when its value is ready.
   */
  nextTicket() {
    return ++this.lastTicket;
  }
  writeEntry(entry) {
    if (this.disposed) {
      return;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    if (this.maxEntries !== void 0) {
      this.store.delete(normalizedKey);
    }
    this.store.set(normalizedKey, entry);
    this.evictOverflow();
  }
  /** Removes the least recently used entries beyond `maxEntries`, sparing protected keys. */
  evictOverflow() {
    if (this.maxEntries === void 0 || this.store.size <= this.maxEntries) {
      return;
    }
    for (const normalizedKey of this.store.keys()) {
      if (this.store.size <= this.maxEntries) {
        return;
      }
      if (!this.protectedKeys.has(normalizedKey)) {
        this.store.delete(normalizedKey);
      }
    }
  }
  /** Marks an entry as recently used, for `maxEntries`. */
  touch(normalizedKey, entry) {
    if (this.maxEntries !== void 0) {
      this.store.delete(normalizedKey);
      this.store.set(normalizedKey, entry);
    }
  }
  /** Writes to this instance only. */
  setLocal(key, value, ttl) {
    const entry = {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt: Date.now(),
      ticket: this.nextTicket()
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
  set(key, value, ttl) {
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
  setIfNewer(key, value, ttl, ticket, fetchedAt = Date.now()) {
    const entry = this.store.get(this.normalizeKey(key));
    if (ticket <= ((entry == null ? void 0 : entry.ticket) ?? this.ticketFloor)) {
      return false;
    }
    this.writeEntry({
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket
    });
    return true;
  }
  /**
   * Stores a value just read from the source: in this instance (if no newer write happened, see
   * {@link setIfNewer}) and in the shared level. It also ends the key's failure cooldown.
   *
   * @returns `true` if the value was stored.
   */
  storeFetched(key, value, ttl, ticket, fetchedAt) {
    const normalizedKey = this.normalizeKey(key);
    if (this.failures.delete(normalizedKey) && this.shared && this.failureCooldown > 0) {
      this.sharedInBackground(
        `delete of the failure of "${normalizedKey}"`,
        (store) => store.delete(this.sharedFailureKey(normalizedKey))
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
   * @param removeOld - If true, an expired value is also removed from the cache, as a side effect.
   * Defaults to false, so that the old value stays available as a fallback for `getOrSet` with
   * `returnOldOnError`; expired entries are removed by `purgeExpired` / `autoCleanupInterval`.
   * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
   */
  get(key, removeOld = false) {
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && !isStale(entry)) {
      this.touch(normalizedKey, entry);
      return entry.value;
    } else {
      if (removeOld) {
        this.deleteNormalized(normalizedKey);
      }
      return void 0;
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
  getComprehensive(key) {
    const entry = this.store.get(this.normalizeKey(key));
    if (!entry) {
      return { type: "miss" };
    }
    return {
      type: isStale(entry) ? "expired" : "hit",
      value: entry.value,
      expirationTime: entry.expirationTime
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
  errorReturn(error, options, key) {
    var _a;
    let valueToReturn = (_a = options.errorFn) == null ? void 0 : _a.call(options, {
      key,
      error,
      options
    });
    const current = this.getComprehensive(key);
    if (valueToReturn === void 0 && options.returnOldOnError && current.type !== "miss") {
      valueToReturn = current.value;
    }
    if (valueToReturn === void 0) {
      throw error;
    }
    this.setLocal(key, valueToReturn, options.errorTtl ?? this.defaultErrorTtl);
    return valueToReturn;
  }
  getOrSetFlightId(key) {
    return `LilypadCache-getOrSet-${this.normalizeKey(key)}`;
  }
  /**
   * @returns `true` if a `getOrSet` fetch for the key is in flight.
   */
  isFetchInFlight(key) {
    return this.flowControl.isInFlight(this.getOrSetFlightId(key));
  }
  inCooldown(normalizedKey) {
    const failedAt = this.failures.get(normalizedKey);
    return this.failureCooldown > 0 && failedAt !== void 0 && Date.now() - failedAt < this.failureCooldown;
  }
  recordFailure(normalizedKey) {
    const failedAt = Date.now();
    this.failures.set(normalizedKey, failedAt);
    if (this.shared && this.failureCooldown > 0) {
      this.sharedInBackground(
        `write of the failure of "${normalizedKey}"`,
        (store) => store.set(this.sharedFailureKey(normalizedKey), failedAt, {
          ttl: toTtlSeconds(this.failureCooldown),
          tags: [this.cacheTag()]
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
  async getOrSet(key, valueFn, options = {}) {
    return (await this.getOrSetDetailed(key, valueFn, options)).value;
  }
  /**
   * Like {@link getOrSet}, but also tells where the value comes from and whether the last fetch
   * failed.
   *
   * The lookup order is: memory of this instance, shared level, stale value (returned at once and
   * refreshed in the background, within `staleWhileRevalidate`), fetch.
   */
  async getOrSetDetailed(key, valueFn, options = {}) {
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    if (!options.skipCache) {
      const local = this.store.get(normalizedKey);
      if (local && !isStale(local)) {
        this.touch(normalizedKey, local);
        return { value: local.value, status: "L1-HIT", refreshFailed: false };
      }
      let refreshLocked = false;
      if (this.shared) {
        const ticket = this.nextTicket();
        const remote = await this.readShared(normalizedKey);
        refreshLocked = remote.locked;
        if (remote.failedAt !== void 0) {
          this.failures.set(
            normalizedKey,
            Math.max(remote.failedAt, this.failures.get(normalizedKey) ?? 0)
          );
        }
        const adopted = remote.entry && this.adoptShared(key, remote.entry, ticket);
        const current2 = this.store.get(normalizedKey);
        if (current2 && !isStale(current2)) {
          return {
            value: current2.value,
            status: adopted ? "L2-HIT" : "L1-HIT",
            refreshFailed: false
          };
        }
      }
      const current = this.store.get(normalizedKey);
      const staleWindow = options.staleWhileRevalidate ?? this.defaultStaleWhileRevalidate;
      if (current && staleWindow > 0 && Date.now() < current.expirationTime + staleWindow) {
        this.refreshInBackground(key, valueFn, options, refreshLocked);
        const failedAt = this.failures.get(normalizedKey);
        return {
          value: current.value,
          status: "STALE",
          refreshFailed: failedAt !== void 0 && failedAt >= current.fetchedAt
        };
      }
    }
    if (this.inCooldown(normalizedKey) && !this.isFetchInFlight(key)) {
      const error = new LilypadCacheCooldownError(normalizedKey, this.failureCooldown);
      return { value: this.errorReturn(error, options, key), status: "MISS", refreshFailed: true };
    }
    try {
      const value = await this.fetchAndStore(key, valueFn, options);
      return { value, status: "MISS", refreshFailed: false };
    } catch (error) {
      return { value: this.errorReturn(error, options, key), status: "MISS", refreshFailed: true };
    }
  }
  /** Fetches the value (one fetch per key at a time) and stores it. */
  fetchAndStore(key, valueFn, options) {
    return this.flowControl.executeFn({
      functionIdentifier: this.getOrSetFlightId(key),
      consumerIdentifier: "",
      timeout: options.timeout,
      // Runs once per fetch, while the fallback is chosen per caller in errorReturn
      errorFn: (error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.error(this.id, `Error fetching cache key "${String(key)}": `, error));
        this.recordFailure(this.normalizeKey(key));
        throw error;
      },
      fn: async (signal) => {
        const ticket = this.nextTicket();
        const fetchedAt = Date.now();
        const value = await valueFn(signal);
        if (!signal.aborted) {
          this.storeFetched(key, value, options.ttl, ticket, fetchedAt);
        }
        return value;
      }
    });
  }
  /**
   * Refreshes a stale key after the response (or at once, without `platform.afterResponse`),
   * unless it is already being refreshed, locked by another instance, or in its failure cooldown.
   */
  refreshInBackground(key, valueFn, options, lockedByOtherInstance) {
    const normalizedKey = this.normalizeKey(key);
    if (lockedByOtherInstance || Date.now() - (this.refreshing.get(normalizedKey) ?? -Infinity) < STUCK_REFRESH_AFTER || this.isFetchInFlight(key) || this.inCooldown(normalizedKey)) {
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
          if (this.refreshing.get(normalizedKey) === scheduledAt) {
            this.refreshing.delete(normalizedKey);
          }
          if (owner) {
            await this.releaseRefreshLock(normalizedKey, owner);
          }
        }
      },
      // The fetch error has already been logged by fetchAndStore
      () => {
      }
    );
  }
  // SHARED LEVEL
  sharedKey(normalizedKey) {
    return `lilypad:${this.name}:${normalizedKey}`;
  }
  sharedFailureKey(normalizedKey) {
    return `${this.sharedKey(normalizedKey)}:failedAt`;
  }
  sharedLockKey(normalizedKey) {
    return `${this.sharedKey(normalizedKey)}:lock`;
  }
  cacheTag() {
    return `${this.tagPrefix}:${this.name}`;
  }
  /** A shared store operation bounded by the timeout; a failure resolves to `fallback`. */
  sharedOperation(description, operation, fallback) {
    const shared = this.shared;
    return sharedStoreOperation(
      () => operation(shared.store),
      fallback,
      shared.timeout,
      (error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.warn(this.id, `Shared cache ${description} failed:`, error));
      }
    );
  }
  sharedInBackground(description, operation) {
    runInBackground(
      this.platform,
      this.sharedOperation(description, operation, void 0),
      () => {
      }
    );
  }
  /** Reads the entry, the failure time and the refresh lock of a key, in parallel. */
  async readShared(normalizedKey) {
    const [raw, failedAt, lock] = await Promise.all([
      this.sharedOperation(
        `read of "${normalizedKey}"`,
        (store) => store.get(this.sharedKey(normalizedKey)),
        null
      ),
      this.failureCooldown > 0 ? this.sharedOperation(
        `read of the failure of "${normalizedKey}"`,
        (store) => store.get(this.sharedFailureKey(normalizedKey)),
        null
      ) : null,
      this.shared.refreshLockTtl !== void 0 ? this.sharedOperation(
        `read of the lock of "${normalizedKey}"`,
        (store) => store.get(this.sharedLockKey(normalizedKey)),
        null
      ) : null
    ]);
    return {
      entry: this.decodeEnvelope(normalizedKey, raw),
      failedAt: typeof failedAt === "number" ? failedAt : void 0,
      locked: typeof lock === "string"
    };
  }
  decodeEnvelope(normalizedKey, raw) {
    var _a, _b;
    if (raw === null || raw === void 0) {
      return void 0;
    }
    const envelope = raw;
    const valid = typeof raw === "object" && envelope.lilypad === 1 && typeof envelope.fetchedAt === "number" && typeof envelope.expiresAt === "number" && "value" in envelope;
    if (!valid) {
      void ((_a = this.logger) == null ? void 0 : _a.warn(this.id, `Ignoring a malformed shared entry for "${normalizedKey}"`));
      return void 0;
    }
    if (envelope.value === null) {
      return { ...envelope, decoded: null };
    }
    const codec = this.shared.codec;
    const decoded = codec ? codec.decode(envelope.value) : envelope.value;
    if (decoded === null) {
      void ((_b = this.logger) == null ? void 0 : _b.warn(
        this.id,
        `Ignoring a shared entry rejected by the codec: "${normalizedKey}"`
      ));
      return void 0;
    }
    return { ...envelope, decoded };
  }
  /**
   * Copies an entry of the shared level into this instance, if it is newer than the local one
   * and no local write started after the read of the shared level.
   *
   * @returns `true` if the entry was copied.
   */
  adoptShared(key, remote, ticket) {
    const current = this.store.get(this.normalizeKey(key));
    if (current && current.fetchedAt >= remote.fetchedAt) {
      return false;
    }
    if (ticket <= ((current == null ? void 0 : current.ticket) ?? this.ticketFloor)) {
      return false;
    }
    this.writeEntry({
      key,
      value: remote.decoded,
      expirationTime: remote.expiresAt,
      fetchedAt: remote.fetchedAt,
      ticket
    });
    return true;
  }
  /**
   * Writes an entry to the shared level in the background, unless the shared level already holds a
   * value fetched later (a soft check: read and write are not atomic).
   */
  writeShared(entry) {
    if (!this.shared) {
      return;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    const lifetime = entry.expirationTime + this.defaultStaleWhileRevalidate - Date.now();
    if (lifetime <= 0) {
      return;
    }
    const codec = this.shared.codec;
    const envelope = {
      lilypad: 1,
      value: entry.value === null || !codec ? entry.value : codec.encode(entry.value),
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expirationTime
    };
    this.sharedInBackground(`write of "${normalizedKey}"`, async (store) => {
      const current = await store.get(this.sharedKey(normalizedKey));
      if (typeof (current == null ? void 0 : current.fetchedAt) === "number" && current.fetchedAt > envelope.fetchedAt) {
        return;
      }
      await store.set(this.sharedKey(normalizedKey), envelope, {
        ttl: toTtlSeconds(lifetime),
        tags: [this.cacheTag()]
      });
    });
  }
  /** Removes a key from the shared level, in the background. */
  deleteShared(key) {
    if (!this.shared) {
      return;
    }
    const normalizedKey = this.normalizeKey(key);
    this.sharedInBackground(
      `delete of "${normalizedKey}"`,
      (store) => store.delete(this.sharedKey(normalizedKey))
    );
  }
  /** @returns The lock owner id, or undefined when no lock is configured. */
  async acquireRefreshLock(normalizedKey) {
    var _a;
    const lockTtl = (_a = this.shared) == null ? void 0 : _a.refreshLockTtl;
    if (lockTtl === void 0) {
      return void 0;
    }
    const owner = globalThis.crypto.randomUUID();
    await this.sharedOperation(
      `write of the lock of "${normalizedKey}"`,
      (store) => store.set(this.sharedLockKey(normalizedKey), owner, { ttl: toTtlSeconds(lockTtl) }),
      void 0
    );
    return owner;
  }
  /** Releases the lock only if it still belongs to this refresh, not to another instance. */
  async releaseRefreshLock(normalizedKey, owner) {
    const current = await this.sharedOperation(
      `read of the lock of "${normalizedKey}"`,
      (store) => store.get(this.sharedLockKey(normalizedKey)),
      null
    );
    if (current === owner) {
      await this.sharedOperation(
        `delete of the lock of "${normalizedKey}"`,
        (store) => store.delete(this.sharedLockKey(normalizedKey)),
        void 0
      );
    }
  }
  // INVALIDATION EVENTS
  /**
   * Sends an invalidation event to `platform.onInvalidate`, in the background.
   */
  emitInvalidation(source, keys) {
    var _a;
    const onInvalidate = (_a = this.platform) == null ? void 0 : _a.onInvalidate;
    if (!onInvalidate || keys.length === 0) {
      return;
    }
    const normalizedKeys = keys.map((key) => this.normalizeKey(key));
    const event = {
      source,
      cache: this.name,
      keys: normalizedKeys,
      tags: [this.cacheTag(), ...normalizedKeys.map((key) => `${this.cacheTag()}:${key}`)]
    };
    runInBackground(
      this.platform,
      Promise.resolve().then(() => onInvalidate(event)),
      (error) => {
        var _a2;
        return void ((_a2 = this.logger) == null ? void 0 : _a2.error(this.id, "Error in onInvalidate:", error));
      }
    );
  }
  /**
   * Synchronizes the cache in bulk by executing the provided sync function.
   *
   * This method uses flow control to manage the execution of the bulk sync operation.
   * If a `syncFn` is provided, it will be used to fetch key-value pairs to synchronize.
   * Errors are logged; unless `throwOnError` is set they are not rethrown: the cache keeps its
   * current content, and the next call retries the sync.
   * Bulk syncs fill the memory of this instance only, not the shared level.
   *
   * @param syncFn - An optional asynchronous function that returns an array of key-value pairs to be synchronized.
   * It receives a signal that is aborted when the sync times out.
   * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
   * @returns A promise that resolves to `true` if the cache is synced (now or by a recent sync),
   * `false` if the sync failed or returned no data.
   */
  async bulkSync(syncFn, options = {}) {
    try {
      return await this.bulkSyncFlowControl.executeFn({
        functionIdentifier: `LilypadCache-bulkSync`,
        consumerIdentifier: "",
        errorFn: (error) => {
          var _a;
          void ((_a = this.logger) == null ? void 0 : _a.error(this.id, "Error during bulk sync: ", error));
          throw error;
        },
        fn: async (signal) => this._bulkSync(syncFn, signal)
      });
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      return false;
    }
  }
  async _bulkSync(syncFn, signal) {
    var _a, _b;
    if (Date.now() < this.bulkSyncExpirationTime) {
      return true;
    }
    const ticket = this.nextTicket();
    const fetchedAt = Date.now();
    const data = await (syncFn == null ? void 0 : syncFn(signal)) ?? await ((_a = this.bulkSyncFn) == null ? void 0 : _a.call(this, signal));
    if (signal.aborted) {
      return false;
    }
    if (!data) {
      void ((_b = this.logger) == null ? void 0 : _b.warn(this.id, "Bulk sync function returned no data"));
      return false;
    }
    const incoming = /* @__PURE__ */ new Map();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    for (const [normalizedKey, entry] of this.store) {
      if (entry.ticket > ticket || incoming.has(normalizedKey)) {
        continue;
      }
      if (!this.deleteNormalized(normalizedKey)) {
        this.expireNormalized(normalizedKey);
      }
    }
    for (const [key, value] of incoming.values()) {
      this.setIfNewer(key, value, void 0, ticket, fetchedAt);
    }
    this.ticketFloor = Math.max(this.ticketFloor, ticket);
    if (this.bulkSyncInvalidationTicket < ticket) {
      this.bulkSyncExpirationTime = this.createExpirationTime(this.defaultBulkSyncTtl);
    }
    return true;
  }
  /**
   * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running.
   */
  invalidateBulkSync() {
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
  bulkGet(options) {
    const result = /* @__PURE__ */ new Map();
    if (options.keys) {
      for (const key of options.keys) {
        const value = this.get(key);
        if (value !== void 0) {
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
    syncFn
  } = {}) {
    if (doSync) {
      await this.bulkSync(syncFn);
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
  bulkSet(entries) {
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
  addProtectedKeys(keys) {
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
  removeProtectedKeys(keys) {
    for (const key of keys) {
      this.protectedKeys.delete(this.normalizeKey(key));
    }
    return this;
  }
  /**
   * Invalidates the cache entry for the specified key.
   *
   * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
   * stays available as a fallback for `returnOldOnError`. It is also removed from the shared level,
   * and `platform.onInvalidate` receives a `manual` event.
   *
   * @param key - The key of the cache entry to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - If true (default), forces a bulk sync on the next bulkSync call.
   */
  invalidate(key, { invalidateBulkSync = true } = {}) {
    this.markInvalid(key, { invalidateBulkSync });
    this.emitInvalidation("manual", [key]);
  }
  /**
   * The effect of `invalidate` on the data, without the invalidation event: expires the entry in
   * this instance, removes it from the shared level and optionally forces the next bulk sync.
   */
  markInvalid(key, { invalidateBulkSync = true } = {}) {
    this.expire(key);
    this.deleteShared(key);
    if (invalidateBulkSync) {
      this.invalidateBulkSync();
    }
  }
  /**
   * Marks a cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
   * It is never served as a stale value either. Only this instance is affected.
   * Unlike `invalidate`, it is never overridden by subclasses, so it is always synchronous.
   *
   * @param key - The key of the cache entry to expire.
   */
  expire(key) {
    this.expireNormalized(this.normalizeKey(key));
  }
  expireNormalized(normalizedKey) {
    const entry = this.store.get(normalizedKey);
    if (entry && entry.expirationTime > 0) {
      this.writeEntry({ ...entry, expirationTime: 0, ticket: this.nextTicket() });
    }
  }
  /**
   * Deletes the specified key from the cache, and from the shared level.
   *
   * If the key is present in the set of protected keys, the deletion is skipped.
   *
   * @param key - The key to be deleted from the cache.
   * @param options - Optional settings for deletion.
   * @param options.force - If true, forces deletion even if the key is protected.
   * @param options.setNull - If true, sets the value to null instead of deleting the entry.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key, options = {}) {
    const deleted = this.deleteNormalized(this.normalizeKey(key), options);
    if (deleted) {
      this.deleteShared(key);
    }
    return deleted;
  }
  deleteNormalized(normalizedKey, options = {}) {
    if (this.protectedKeys.has(normalizedKey) && !options.force) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (options.setNull) {
      this.setLocal(entry ? entry.key : normalizedKey, null);
      return true;
    }
    this.store.delete(normalizedKey);
    return true;
  }
  /**
   * Removes all entries from the memory of this instance (not from the shared level).
   *
   * Iterates over all keys in the cache store and deletes each entry.
   * The deletion behavior can be customized using the `options` parameter.
   *
   * @param options - Optional settings for the clear operation.
   * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
   * @param options.setNull - If `true`, sets the value to null instead of deleting the entry.
   */
  clear(options = {}) {
    for (const normalizedKey of this.store.keys()) {
      this.deleteNormalized(normalizedKey, options);
    }
  }
  /**
   * Removes all expired entries from the cache, except those still within the
   * `staleWhileRevalidate` window of the cache.
   *
   * Iterates through the cache store and deletes any entries whose expiration time has passed.
   * Optionally, the deletion can be forced by providing the `force` option.
   *
   * @param options - Optional settings for the purge operation.
   * @param options.force - If true, forces deletion of expired entries regardless of other conditions.
   */
  purgeExpired(options = {}) {
    const now = Date.now();
    for (const [normalizedKey, entry] of this.store.entries()) {
      if (now >= entry.expirationTime + this.defaultStaleWhileRevalidate) {
        this.deleteNormalized(normalizedKey, options);
      }
    }
    for (const [normalizedKey, failedAt] of this.failures) {
      if (now - failedAt >= this.failureCooldown) {
        this.failures.delete(normalizedKey);
      }
    }
  }
  /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
  cleanupOnAccess() {
    if (this.cleanupOnAccessEvery === void 0) {
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
  stopCleanupInterval() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = void 0;
    }
  }
  /**
   * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
   * This method should be called when the cache is no longer needed to free up resources.
   * A disposed cache ignores every later write, including the ones of fetches still in flight.
   * The shared level is left untouched.
   */
  dispose() {
    this.logger = void 0;
    this.stopCleanupInterval();
    this.clear({ force: true });
    this.disposed = true;
  }
};
var LilypadCache_default = LilypadCache;

export {
  LilypadCacheCooldownError,
  LilypadCache_default
};
//# sourceMappingURL=chunk-XP7HCU7I.mjs.map