import {
  LilypadFlowControl
} from "./chunk-7IQFDANE.mjs";
import {
  runAfterResponse,
  runInBackground,
  sharedStoreOperation,
  toTtlSeconds
} from "./chunk-3L5FE6KG.mjs";

// src/cache/LilypadCacheTypes.ts
var LilypadCacheCooldownError = class extends Error {
  constructor(key, cooldown) {
    super(`Fetching "${key}" failed less than ${cooldown}ms ago: not retrying yet.`);
    this.name = "LilypadCacheCooldownError";
  }
};

// src/internal/LilypadValidation.ts
var DESCRIPTIONS = {
  positive: "a positive finite number",
  "non-negative": "a non-negative finite number",
  "positive-integer": "a positive integer"
};
function satisfies(value, rule) {
  switch (rule) {
    case "positive":
      return Number.isFinite(value) && value > 0;
    case "non-negative":
      return Number.isFinite(value) && value >= 0;
    case "positive-integer":
      return Number.isInteger(value) && value > 0;
  }
}
function assertNumberOption(owner, name, value, rule) {
  if (value !== void 0 && (typeof value !== "number" || !satisfies(value, rule))) {
    throw new Error(`${owner}: ${name} must be ${DESCRIPTIONS[rule]} (got ${String(value)}).`);
  }
}

// src/logger/LilypadLibLogger.ts
function libLog(logger, level, ...message) {
  const method = logger == null ? void 0 : logger[level];
  if (!method) {
    return;
  }
  try {
    const result = method.call(logger, ...message);
    if (typeof (result == null ? void 0 : result.then) === "function") {
      void Promise.resolve(result).catch(() => {
      });
    }
  } catch {
  }
}

// src/cache/LilypadSharedLevel.ts
var SHARED_FORMAT_VERSION = 2;
function lilypadCacheTags(tagPrefix, name, normalizedKeys) {
  const cacheTag = `${tagPrefix}:${encodeURIComponent(name)}`;
  return [cacheTag, ...normalizedKeys.map((key) => `${cacheTag}:${encodeURIComponent(key)}`)];
}
var LilypadSharedLevel = class {
  constructor(options) {
    this.options = options;
  }
  key(kind, normalizedKey) {
    const { name } = this.options;
    return `lilypad:${SHARED_FORMAT_VERSION}:${encodeURIComponent(name)}:${kind}:${encodeURIComponent(normalizedKey)}`;
  }
  valueKey(normalizedKey) {
    return this.key("v", normalizedKey);
  }
  failureKey(normalizedKey) {
    return this.key("f", normalizedKey);
  }
  lockKey(normalizedKey) {
    return this.key("l", normalizedKey);
  }
  cacheTags() {
    return lilypadCacheTags(this.options.tagPrefix, this.options.name, []);
  }
  /** An operation bounded by the timeout; a failure resolves to `fallback`. */
  operation(description, operation, fallback) {
    const { store, timeout, warn } = this.options;
    return sharedStoreOperation(
      () => operation(store),
      fallback,
      timeout,
      (error) => warn(`Shared cache ${description} failed:`, error)
    );
  }
  inBackground(description, operation) {
    runInBackground(
      this.options.platform,
      this.operation(description, operation, void 0),
      () => {
      }
    );
  }
  /**
   * Reads the entry of a key, and, when asked, the time of its last failed fetch and its refresh
   * lock, in parallel.
   */
  async read(normalizedKey, withFailure) {
    const [raw, failedAt, lock] = await Promise.all([
      this.operation(
        `read of "${normalizedKey}"`,
        (store) => store.get(this.valueKey(normalizedKey)),
        null
      ),
      withFailure ? this.operation(
        `read of the failure of "${normalizedKey}"`,
        (store) => store.get(this.failureKey(normalizedKey)),
        null
      ) : null,
      this.options.refreshLockTtl !== void 0 ? this.operation(
        `read of the lock of "${normalizedKey}"`,
        (store) => store.get(this.lockKey(normalizedKey)),
        null
      ) : null
    ]);
    return {
      entry: this.decode(normalizedKey, raw),
      failedAt: typeof failedAt === "number" ? failedAt : void 0,
      locked: typeof lock === "string"
    };
  }
  decode(normalizedKey, raw) {
    if (raw === null || raw === void 0) {
      return void 0;
    }
    const envelope = raw;
    const valid = typeof raw === "object" && envelope.lilypad === SHARED_FORMAT_VERSION && typeof envelope.fetchedAt === "number" && typeof envelope.expiresAt === "number" && "value" in envelope;
    if (!valid) {
      this.options.warn(`Ignoring a malformed shared entry for "${normalizedKey}"`);
      return void 0;
    }
    const { fetchedAt, expiresAt } = envelope;
    if (envelope.value === null) {
      return { value: null, fetchedAt, expiresAt };
    }
    const codec = this.options.codec;
    const value = codec ? codec.decode(envelope.value) : envelope.value;
    if (value === null) {
      this.options.warn(`Ignoring a shared entry rejected by the codec: "${normalizedKey}"`);
      return void 0;
    }
    return { value, fetchedAt, expiresAt };
  }
  /**
   * Writes an entry in the background, kept for `lifetime` ms. With `checkBeforeWrite`, it leaves
   * alone a shared value fetched later (a soft check: read and write are not atomic).
   */
  write(normalizedKey, entry, lifetime) {
    if (lifetime <= 0) {
      return;
    }
    const { codec, checkBeforeWrite } = this.options;
    const envelope = {
      lilypad: SHARED_FORMAT_VERSION,
      value: entry.value === null || !codec ? entry.value : codec.encode(entry.value),
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expiresAt
    };
    const key = this.valueKey(normalizedKey);
    this.inBackground(`write of "${normalizedKey}"`, async (store) => {
      if (checkBeforeWrite) {
        const current = await store.get(key);
        if (typeof (current == null ? void 0 : current.fetchedAt) === "number" && current.fetchedAt > envelope.fetchedAt) {
          return;
        }
      }
      await store.set(key, envelope, { ttl: toTtlSeconds(lifetime), tags: this.cacheTags() });
    });
  }
  /** Removes the entry of a key, in the background. */
  delete(normalizedKey) {
    this.inBackground(
      `delete of "${normalizedKey}"`,
      (store) => store.delete(this.valueKey(normalizedKey))
    );
  }
  /** Records a failed fetch of a key for `ttl` ms, in the background. */
  writeFailure(normalizedKey, failedAt, ttl) {
    this.inBackground(
      `write of the failure of "${normalizedKey}"`,
      (store) => store.set(this.failureKey(normalizedKey), failedAt, {
        ttl: toTtlSeconds(ttl),
        tags: this.cacheTags()
      })
    );
  }
  /** Forgets the failed fetch of a key, in the background. */
  deleteFailure(normalizedKey) {
    this.inBackground(
      `delete of the failure of "${normalizedKey}"`,
      (store) => store.delete(this.failureKey(normalizedKey))
    );
  }
  /** @returns The lock owner id, or undefined when no lock is configured. */
  async acquireLock(normalizedKey) {
    const lockTtl = this.options.refreshLockTtl;
    if (lockTtl === void 0) {
      return void 0;
    }
    const owner = globalThis.crypto.randomUUID();
    await this.operation(
      `write of the lock of "${normalizedKey}"`,
      (store) => store.set(this.lockKey(normalizedKey), owner, { ttl: toTtlSeconds(lockTtl) }),
      void 0
    );
    return owner;
  }
  /** Releases the lock only if it still belongs to `owner`, not to another instance. */
  async releaseLock(normalizedKey, owner) {
    const current = await this.operation(
      `read of the lock of "${normalizedKey}"`,
      (store) => store.get(this.lockKey(normalizedKey)),
      null
    );
    if (current === owner) {
      await this.operation(
        `delete of the lock of "${normalizedKey}"`,
        (store) => store.delete(this.lockKey(normalizedKey)),
        void 0
      );
    }
  }
};

// src/cache/LilypadCacheCore.ts
function isStale(entry) {
  return Date.now() >= entry.expirationTime;
}
var DEFAULT_TTL = 6e4;
var DEFAULT_ERROR_TTL = 5 * 60 * 1e3;
var DEFAULT_FETCH_TIMEOUT = 5e3;
var DEFAULT_BULK_SYNC_TIMEOUT = 3e4;
var DEFAULT_SHARED_TIMEOUT = 300;
var STUCK_REFRESH_AFTER = 6e4;
var LilypadCacheCore = class {
  id = `LilypadCache-${globalThis.crypto.randomUUID()}`;
  /** The name given in the options, or the id. */
  name;
  store = /* @__PURE__ */ new Map();
  defaultTtl;
  errorTtl;
  bulkSyncTtl;
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
   * When the last bulk sync stops counting as fresh. `bulkGet({})` returns every entry of the
   * source only while it is fresh.
   */
  bulkSyncExpirationTime = 0;
  bulkSyncFn;
  /** Source of the write tickets. */
  lastTicket = 0;
  /**
   * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
   * already holds data newer than theirs.
   */
  ticketFloor = 0;
  /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
  bulkSyncInvalidationTicket = 0;
  /**
   * Tickets below which the reads of keys without an entry are discarded (normalized keys): set
   * when such a key is expired, or its entry removed, while a read of it is in flight, since that
   * read may predate the change. Removed once a value is stored, or once no read is in flight.
   */
  fences = /* @__PURE__ */ new Map();
  /** Values of the shared level produced before this time are not adopted. */
  sharedNotBefore = 0;
  disposed = false;
  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  failures = /* @__PURE__ */ new Map();
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  refreshing = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const owner = "LilypadCache";
    assertNumberOption(owner, "ttl", options.ttl, "positive");
    assertNumberOption(owner, "staleWhileRevalidate", options.staleWhileRevalidate, "non-negative");
    assertNumberOption(owner, "failureCooldown", options.failureCooldown, "non-negative");
    assertNumberOption(owner, "maxEntries", options.maxEntries, "positive-integer");
    assertNumberOption(owner, "cleanupOnAccessEvery", options.cleanupOnAccessEvery, "non-negative");
    assertNumberOption(owner, "autoCleanupInterval", options.autoCleanupInterval, "positive");
    assertNumberOption(owner, "errorTtl", options.errorTtl, "non-negative");
    assertNumberOption(owner, "fetchTimeout", options.fetchTimeout, "positive");
    assertNumberOption(owner, "bulkSync.ttl", (_a = options.bulkSync) == null ? void 0 : _a.ttl, "non-negative");
    assertNumberOption(owner, "bulkSync.timeout", (_b = options.bulkSync) == null ? void 0 : _b.timeout, "positive");
    assertNumberOption(owner, "shared.timeout", (_c = options.shared) == null ? void 0 : _c.timeout, "positive");
    assertNumberOption(owner, "shared.refreshLockTtl", (_d = options.shared) == null ? void 0 : _d.refreshLockTtl, "positive");
    const ttl = options.ttl ?? DEFAULT_TTL;
    this.defaultTtl = ttl;
    this.bulkSyncTtl = ((_e = options.bulkSync) == null ? void 0 : _e.ttl) ?? ttl;
    this.bulkSyncFn = (_f = options.bulkSync) == null ? void 0 : _f.fn;
    this.errorTtl = options.errorTtl ?? Math.min(ttl, DEFAULT_ERROR_TTL);
    this.defaultStaleWhileRevalidate = options.staleWhileRevalidate ?? 0;
    this.failureCooldown = options.failureCooldown ?? 0;
    this.logger = options.logger;
    this.platform = options.platform;
    this.name = options.name ?? this.id;
    this.maxEntries = options.maxEntries;
    this.cleanupOnAccessEvery = options.cleanupOnAccessEvery;
    this.tagPrefix = options.tagPrefix ?? "lilypad";
    if (options.shared) {
      const store = options.shared.store ?? ((_g = options.platform) == null ? void 0 : _g.shared);
      if (!store) {
        throw new Error("LilypadCache: `shared` needs a `store`, or a `platform.shared` store.");
      }
      if (options.name === void 0) {
        throw new Error("LilypadCache: `name` is required with `shared`.");
      }
      this.shared = new LilypadSharedLevel({
        store,
        codec: options.shared.codec,
        timeout: options.shared.timeout ?? DEFAULT_SHARED_TIMEOUT,
        refreshLockTtl: options.shared.refreshLockTtl,
        checkBeforeWrite: options.shared.checkBeforeWrite ?? false,
        name: this.name,
        tagPrefix: this.tagPrefix,
        platform: this.platform,
        warn: (...message) => libLog(this.logger, "warn", this.name, ...message)
      });
    }
    this.flowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: options.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT
    });
    this.bulkSyncFlowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: ((_h = options.bulkSync) == null ? void 0 : _h.timeout) ?? DEFAULT_BULK_SYNC_TIMEOUT
    });
    if (options.autoCleanupInterval) {
      this.cleanupIntervalId = setInterval(() => this.purgeEntries(), options.autoCleanupInterval);
      (_j = (_i = this.cleanupIntervalId).unref) == null ? void 0 : _j.call(_i);
    }
    libLog(this.logger, "debug", this.name, `LilypadCache initialized`);
  }
  createExpirationTime(ttl) {
    return Date.now() + (ttl ?? this.defaultTtl);
  }
  /** Normalizes a key to the string form used by the store and by the protected keys. */
  normalizeKey(key) {
    return String(key);
  }
  /** Takes a write ticket. */
  nextTicket() {
    return ++this.lastTicket;
  }
  /**
   * Starts an asynchronous read of the source: every path that reads the source and stores the
   * result must go through it, so that a slow, older read never overwrites a newer value.
   */
  beginRead() {
    const ticket = this.nextTicket();
    const startedAt = Date.now();
    return {
      ticket,
      startedAt,
      store: (key, value, ttl) => this.setIfNewer(key, value, ttl, ticket, startedAt),
      storeFetched: (key, value, ttl) => this.storeFetched(key, value, ttl, ticket, startedAt)
    };
  }
  /**
   * The ticket a read must exceed to store a value for the key: the one of its entry, or else the
   * floor of the missing keys and the fence of the key.
   */
  currentTicket(normalizedKey) {
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
  hasReadInFlight(normalizedKey) {
    return this.flowControl.isInFlight(this.getOrSetFlightId(normalizedKey));
  }
  /**
   * @param newValue - False when the entry keeps its value (e.g. it is only expired): then
   * {@link onValueStored} is not called.
   * @returns `false` if the cache is disposed, and the entry was not stored.
   */
  writeEntry(entry, newValue = true) {
    if (this.disposed) {
      return false;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    if (this.maxEntries !== void 0) {
      this.store.delete(normalizedKey);
    }
    this.store.set(normalizedKey, entry);
    this.fences.delete(normalizedKey);
    if (newValue) {
      this.onValueStored(entry);
      if (entry.expirationTime < this.bulkSyncExpirationTime) {
        this.forceNextBulkSync();
      }
    }
    this.evictOverflow();
    return true;
  }
  /**
   * Called each time a value is stored in this instance (not when an entry is only expired or
   * removed). Subclasses override it to follow the values; it must not write to the cache.
   */
  onValueStored(_entry) {
  }
  /**
   * Removes an entry from the store. A read of the key in flight may have started before the entry
   * was last written or expired: the ticket of the entry stays as the fence of the key, so that
   * such a read cannot store its older value once the entry is gone.
   */
  dropEntry(normalizedKey, entry) {
    if (this.hasReadInFlight(normalizedKey)) {
      this.fences.set(normalizedKey, Math.max(entry.ticket, this.fences.get(normalizedKey) ?? 0));
    }
    this.store.delete(normalizedKey);
  }
  /**
   * Removes the least recently used entries beyond `maxEntries`, sparing protected keys. An
   * eviction forces the next bulk sync, since `bulkGet` would no longer return the evicted keys.
   */
  evictOverflow() {
    if (this.maxEntries === void 0 || this.store.size <= this.maxEntries) {
      return;
    }
    let evicted = false;
    for (const [normalizedKey, entry] of this.store) {
      if (this.store.size <= this.maxEntries) {
        break;
      }
      if (!this.protectedKeys.has(normalizedKey)) {
        this.dropEntry(normalizedKey, entry);
        evicted = true;
      }
    }
    if (evicted) {
      this.forceNextBulkSync();
    }
  }
  /** Marks an entry as recently used, for `maxEntries`. */
  touch(normalizedKey, entry) {
    if (this.maxEntries !== void 0) {
      this.store.delete(normalizedKey);
      this.store.set(normalizedKey, entry);
    }
  }
  /**
   * Writes to this instance only.
   *
   * @returns The stored entry, or `undefined` if the cache is disposed.
   */
  writeLocal(key, value, ttl, origin = "source", fetchedAt = Date.now()) {
    const entry = {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket: this.nextTicket(),
      origin
    };
    return this.writeEntry(entry) ? entry : void 0;
  }
  /**
   * Stores a value here and in the shared level, taking a new ticket (reads started before it
   * cannot overwrite it). Ignored once the cache is disposed.
   */
  setValue(key, value, ttl) {
    const entry = this.writeLocal(key, value, ttl);
    if (entry) {
      this.writeShared(entry);
    }
  }
  /**
   * Stores a value in the cache, and in the shared level (in the background).
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   * @throws If the cache is disposed.
   */
  set(key, value, ttl) {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    this.setValue(key, value, ttl);
  }
  /**
   * Stores the result of an asynchronous read, unless a write that started later has already
   * stored a value for the key.
   *
   * @returns `true` if the value was stored.
   */
  setIfNewer(key, value, ttl, ticket, fetchedAt) {
    if (ticket <= this.currentTicket(this.normalizeKey(key))) {
      return false;
    }
    return this.writeEntry({
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket,
      origin: "source"
    });
  }
  /**
   * Stores a value just read from the source: in this instance (if no newer write happened) and
   * in the shared level. It also ends the key's failure cooldown.
   *
   * @returns `true` if the value was stored.
   */
  storeFetched(key, value, ttl, ticket, fetchedAt) {
    var _a;
    const normalizedKey = this.normalizeKey(key);
    if (this.failures.delete(normalizedKey) && this.failureCooldown > 0) {
      (_a = this.shared) == null ? void 0 : _a.deleteFailure(normalizedKey);
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
   * Returns the value of the key if it is cached and fresh, otherwise `undefined`. It reads the
   * memory of this instance only: `getOrSet` also reads the shared level.
   *
   * @param options.removeExpired - If true, an expired value is also removed. Defaults to false, so
   * that the old value stays available as a fallback (`onError: { fallback: 'stale' }`).
   * @throws If the cache is disposed.
   */
  get(key, options = {}) {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && !isStale(entry)) {
      this.touch(normalizedKey, entry);
      return entry.value;
    }
    if (options.removeExpired) {
      this.removeEntry(normalizedKey);
    }
    return void 0;
  }
  /**
   * Tells whether the key is cached, and whether its value is fresh or expired, without side
   * effects (no cleanup, no change of the order of use).
   *
   * @throws If the cache is disposed.
   */
  peek(key) {
    this.assertNotDisposed();
    return this.peekEntry(key);
  }
  peekEntry(key) {
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
   * The fallback of a failed fetch, chosen for each caller with its own `onError` options, and
   * cached in this instance only for `onError.ttl` (or the cache's `errorTtl`). The stale value
   * returned as it is keeps its age: it is not a newer value.
   *
   * @throws The original error if no fallback value is determined.
   */
  errorReturn(error, options, key) {
    var _a, _b;
    const current = this.store.get(this.normalizeKey(key));
    const stale = current && { value: current.value, fetchedAt: current.fetchedAt };
    const fallback = (_a = options.onError) == null ? void 0 : _a.fallback;
    const value = fallback === "stale" ? stale == null ? void 0 : stale.value : fallback == null ? void 0 : fallback({ key, error, stale: stale || void 0 });
    if (value === void 0) {
      throw error;
    }
    const fetchedAt = stale && value === stale.value ? stale.fetchedAt : Date.now();
    this.writeLocal(key, value, ((_b = options.onError) == null ? void 0 : _b.ttl) ?? this.errorTtl, "fallback", fetchedAt);
    return value;
  }
  getOrSetFlightId(normalizedKey) {
    return `LilypadCache-getOrSet-${normalizedKey}`;
  }
  /** @returns `true` if a `getOrSet` fetch for the key is in flight. */
  isFetchInFlight(key) {
    return this.flowControl.isInFlight(this.getOrSetFlightId(this.normalizeKey(key)));
  }
  /** Throws if the cache is disposed. */
  assertNotDisposed() {
    if (this.disposed) {
      throw new Error(`LilypadCache "${this.name}" is disposed.`);
    }
  }
  inCooldown(normalizedKey) {
    const failedAt = this.failures.get(normalizedKey);
    return this.failureCooldown > 0 && failedAt !== void 0 && Date.now() - failedAt < this.failureCooldown;
  }
  recordFailure(normalizedKey) {
    var _a;
    const failedAt = Date.now();
    this.failures.set(normalizedKey, failedAt);
    if (this.failureCooldown > 0) {
      (_a = this.shared) == null ? void 0 : _a.writeFailure(normalizedKey, failedAt, this.failureCooldown);
    }
  }
  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
   * the same key share one fetch; the `onError` options still apply separately to each caller.
   *
   * @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
   */
  async getOrSet(key, valueFn, options = {}) {
    return (await this.getOrSetDetailed(key, valueFn, options)).value;
  }
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
  async getOrSetDetailed(key, valueFn, options = {}) {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    if (!options.skipCache) {
      const local = this.store.get(normalizedKey);
      if (local && !isStale(local)) {
        this.touch(normalizedKey, local);
        return this.freshHit(key, local, "L1-HIT", valueFn, options);
      }
      let refreshLocked = false;
      if (this.shared) {
        const read = this.beginRead();
        const remote = await this.shared.read(normalizedKey, this.failureCooldown > 0);
        refreshLocked = remote.locked;
        if (remote.failedAt !== void 0) {
          this.failures.set(
            normalizedKey,
            Math.max(remote.failedAt, this.failures.get(normalizedKey) ?? 0)
          );
        }
        const adopted = remote.entry && this.adoptShared(key, remote.entry, read.ticket);
        const current2 = this.store.get(normalizedKey);
        if (current2 && !isStale(current2)) {
          return this.freshHit(key, current2, adopted ? "L2-HIT" : "L1-HIT", valueFn, options);
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
  /**
   * The result of a fresh entry. A fallback is reported as such, and refreshed in the background
   * once the failure cooldown is over: otherwise it would hide the recovery of the source for as
   * long as its TTL.
   */
  freshHit(key, entry, status, valueFn, options) {
    const fallback = entry.origin === "fallback";
    if (fallback && this.failureCooldown > 0) {
      this.refreshInBackground(key, valueFn, options, false);
    }
    return { value: entry.value, status, refreshFailed: fallback };
  }
  /** Fetches the value (one fetch per key at a time) and stores it. */
  fetchAndStore(key, valueFn, options) {
    const normalizedKey = this.normalizeKey(key);
    return this.flowControl.executeFn({
      functionIdentifier: this.getOrSetFlightId(normalizedKey),
      consumerIdentifier: "",
      timeout: options.timeout,
      // Runs once per fetch, while the fallback is chosen per caller in errorReturn
      errorFn: (error) => {
        libLog(
          this.logger,
          "error",
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
        if (!signal.aborted) {
          read.storeFetched(key, value, options.ttl);
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
        var _a, _b;
        const owner = await ((_a = this.shared) == null ? void 0 : _a.acquireLock(normalizedKey));
        try {
          await this.fetchAndStore(key, valueFn, options);
        } finally {
          if (this.refreshing.get(normalizedKey) === scheduledAt) {
            this.refreshing.delete(normalizedKey);
          }
          if (owner) {
            await ((_b = this.shared) == null ? void 0 : _b.releaseLock(normalizedKey, owner));
          }
        }
      },
      // The fetch error has already been logged by fetchAndStore
      () => {
      }
    );
  }
  // SHARED LEVEL
  /**
   * Copies an entry of the shared level into this instance, if it is newer than the local one,
   * produced after the local one was invalidated, and no local write started after the read of
   * the shared level.
   *
   * @returns `true` if the entry was copied.
   */
  adoptShared(key, remote, ticket) {
    const normalizedKey = this.normalizeKey(key);
    const current = this.store.get(normalizedKey);
    if (current && current.fetchedAt >= remote.fetchedAt) {
      return false;
    }
    if ((current == null ? void 0 : current.invalidatedAt) !== void 0 && remote.fetchedAt < current.invalidatedAt) {
      return false;
    }
    if (remote.fetchedAt < this.sharedNotBefore) {
      return false;
    }
    if (ticket <= this.currentTicket(normalizedKey)) {
      return false;
    }
    return this.writeEntry({
      key,
      value: remote.value,
      expirationTime: remote.expiresAt,
      fetchedAt: remote.fetchedAt,
      ticket,
      origin: "shared"
    });
  }
  /** Writes an entry to the shared level in the background, kept through the stale window. */
  writeShared(entry) {
    var _a;
    (_a = this.shared) == null ? void 0 : _a.write(
      this.normalizeKey(entry.key),
      { value: entry.value, fetchedAt: entry.fetchedAt, expiresAt: entry.expirationTime },
      entry.expirationTime + this.defaultStaleWhileRevalidate - Date.now()
    );
  }
  /** Removes a key from the shared level, in the background. */
  deleteShared(key) {
    var _a;
    (_a = this.shared) == null ? void 0 : _a.delete(this.normalizeKey(key));
  }
  // INVALIDATION EVENTS
  /**
   * Sends an invalidation event to `platform.onInvalidate`, in the background.
   *
   * @param options.wholeCache - The whole cache changed (e.g. a table was emptied): the event is
   * sent even without keys, and its tags always include the tag of the cache.
   */
  emitInvalidation(source, keys, options = {}) {
    var _a;
    const onInvalidate = (_a = this.platform) == null ? void 0 : _a.onInvalidate;
    if (!onInvalidate || keys.length === 0 && !options.wholeCache) {
      return;
    }
    const normalizedKeys = keys.map((key) => this.normalizeKey(key));
    const event = {
      source,
      cache: this.name,
      keys: normalizedKeys,
      tags: lilypadCacheTags(this.tagPrefix, this.name, normalizedKeys)
    };
    runInBackground(
      this.platform,
      Promise.resolve().then(() => onInvalidate(event)),
      (error) => libLog(this.logger, "error", this.name, "Error in onInvalidate:", error)
    );
  }
  // BULK SYNC
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
  async bulkSync(options = {}) {
    this.assertNotDisposed();
    const bulkSyncFn = this.bulkSyncFn;
    if (!bulkSyncFn) {
      if (options.throwOnError) {
        throw new Error(`LilypadCache "${this.name}" has no bulkSync.fn.`);
      }
      return false;
    }
    try {
      return await this.bulkSyncFlowControl.executeFn({
        functionIdentifier: `LilypadCache-bulkSync`,
        consumerIdentifier: "",
        errorFn: (error) => {
          libLog(this.logger, "error", this.name, "Error during bulk sync: ", error);
          throw error;
        },
        fn: async (signal) => this.runBulkSync(bulkSyncFn, signal)
      });
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      return false;
    }
  }
  async runBulkSync(bulkSyncFn, signal) {
    if (Date.now() < this.bulkSyncExpirationTime) {
      return true;
    }
    const read = this.beginRead();
    const data = await bulkSyncFn(signal);
    if (signal.aborted) {
      return false;
    }
    if (!data) {
      libLog(this.logger, "warn", this.name, "Bulk sync function returned no data");
      return false;
    }
    const incoming = /* @__PURE__ */ new Map();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    if (this.maxEntries !== void 0 && incoming.size > this.maxEntries) {
      libLog(
        this.logger,
        "warn",
        this.name,
        `Bulk sync returned ${incoming.size} entries, more than maxEntries (${this.maxEntries}): bulkGet cannot return them all.`
      );
    }
    const storedAt = Date.now();
    for (const [normalizedKey, entry] of [...this.store]) {
      if (entry.ticket > read.ticket || incoming.has(normalizedKey)) {
        continue;
      }
      if (!this.removeEntry(normalizedKey)) {
        this.expireNormalized(normalizedKey);
      }
    }
    for (const [key, value] of incoming.values()) {
      read.store(key, value);
    }
    this.ticketFloor = Math.max(this.ticketFloor, read.ticket);
    if (this.bulkSyncInvalidationTicket < read.ticket) {
      this.bulkSyncExpirationTime = storedAt + Math.min(this.bulkSyncTtl, this.defaultTtl);
    }
    return true;
  }
  /** Forces the next bulk sync to fetch fresh data, even if a sync is currently running. */
  forceNextBulkSync() {
    this.bulkSyncExpirationTime = 0;
    this.bulkSyncInvalidationTicket = this.nextTicket();
  }
  /**
   * Returns the fresh values of `keys`, or, without keys, every fresh entry (keyed by the key it was
   * stored with, e.g. a number stays a number). Missing and expired keys are left out.
   *
   * @throws If the cache is disposed.
   */
  bulkGet(options = {}) {
    this.assertNotDisposed();
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
   * Like `bulkGet`, after a `bulkSync` (unless `doSync` is false).
   *
   * @throws If the cache is disposed.
   */
  async bulkAsyncGet({
    keys,
    doSync = true
  } = {}) {
    if (doSync) {
      await this.bulkSync();
    }
    return this.bulkGet({ keys });
  }
  /**
   * Stores several values at once, like `set` (so also in the shared level).
   *
   * @throws If the cache is disposed.
   */
  bulkSet(entries) {
    for (const [key, value] of entries) {
      this.set(key, value);
    }
  }
  // PROTECTED KEYS
  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  addProtectedKeys(keys) {
    this.assertNotDisposed();
    for (const key of keys) {
      this.protectedKeys.add(this.normalizeKey(key));
    }
    return this;
  }
  /**
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  removeProtectedKeys(keys) {
    this.assertNotDisposed();
    for (const key of keys) {
      this.protectedKeys.delete(this.normalizeKey(key));
    }
    return this;
  }
  // INVALIDATION AND REMOVAL
  /**
   * Invalidates the entry of the key.
   *
   * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
   * stays available as a fallback (`onError: { fallback: 'stale' }`). A fetch of the key already
   * in flight is not cached. The key is also removed from the shared level, and
   * `platform.onInvalidate` receives a `manual` event.
   *
   * @param options.invalidateBulkSync - If true (default), forces the next bulk sync. With false,
   * `bulkGet({})` leaves the key out until the next bulk sync.
   * @throws If the cache is disposed.
   */
  invalidate(key, { invalidateBulkSync = true } = {}) {
    this.assertNotDisposed();
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
      this.forceNextBulkSync();
    }
  }
  /**
   * Marks an entry as expired, keeping its value as a fallback. It is never served as a stale
   * value either. Only this instance is affected. A read of the key already in flight is
   * discarded, since it may predate the change.
   */
  expire(key) {
    this.expireNormalized(this.normalizeKey(key));
  }
  expireNormalized(normalizedKey) {
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
  expireEverything() {
    for (const normalizedKey of [...this.store.keys()]) {
      this.expireNormalized(normalizedKey);
    }
    this.ticketFloor = Math.max(this.ticketFloor, this.nextTicket());
    this.fences.clear();
    this.forceNextBulkSync();
  }
  /**
   * From now on, the values of the shared level produced before `time` are ignored (e.g. the
   * source was emptied at that time, and the shared level may still hold older copies).
   */
  rejectSharedBefore(time) {
    this.sharedNotBefore = Math.max(this.sharedNotBefore, time);
  }
  /**
   * Deletes the key from the cache, and from the shared level. To cache the key as "does not
   * exist" instead, write `null`.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   * @throws If the cache is disposed.
   */
  delete(key, options = {}) {
    this.assertNotDisposed();
    const deleted = this.removeEntry(this.normalizeKey(key), options.force);
    if (deleted) {
      this.deleteShared(key);
    }
    return deleted;
  }
  /** @returns `false` if the key is protected (and `force` is not set). */
  removeEntry(normalizedKey, force = false) {
    if (this.protectedKeys.has(normalizedKey) && !force) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (entry) {
      this.dropEntry(normalizedKey, entry);
    }
    return true;
  }
  /**
   * Removes all entries from the memory of this instance (not from the shared level), and forces
   * the next bulk sync. Protected keys are kept, unless `force` is set.
   *
   * @throws If the cache is disposed.
   */
  clear(options = {}) {
    this.assertNotDisposed();
    this.clearEntries(options.force);
  }
  clearEntries(force) {
    for (const normalizedKey of [...this.store.keys()]) {
      this.removeEntry(normalizedKey, force);
    }
    this.forceNextBulkSync();
  }
  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window of
   * the cache, and the bookkeeping that no longer serves.
   *
   * @param options.force - If true, also removes the expired protected keys.
   * @throws If the cache is disposed.
   */
  purgeExpired(options = {}) {
    this.assertNotDisposed();
    this.purgeEntries(options.force);
  }
  purgeEntries(force) {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    for (const [normalizedKey, entry] of [...this.store]) {
      if (now >= entry.expirationTime + this.defaultStaleWhileRevalidate) {
        this.removeEntry(normalizedKey, force);
      }
    }
    for (const [normalizedKey, failedAt] of this.failures) {
      if (now - failedAt >= this.failureCooldown) {
        this.failures.delete(normalizedKey);
      }
    }
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
  cleanupOnAccess() {
    if (this.cleanupOnAccessEvery === void 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCleanup >= this.cleanupOnAccessEvery) {
      this.lastCleanup = now;
      this.purgeEntries();
    }
  }
  /**
   * Disposes of the cache: stops the cleanup timer and removes every entry. A disposed cache
   * ignores every later internal write, including the ones of fetches still in flight, and its
   * public methods throw. The shared level is left untouched. Calling it again does nothing.
   *
   * It is asynchronous so that subclasses can release their resources (e.g. a database listener):
   * always await it.
   */
  dispose() {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = void 0;
    }
    this.clearEntries(true);
    this.logger = void 0;
    this.fences.clear();
    this.refreshing.clear();
    this.failures.clear();
    this.disposed = true;
    return Promise.resolve();
  }
};

export {
  LilypadCacheCooldownError,
  assertNumberOption,
  libLog,
  LilypadCacheCore
};
//# sourceMappingURL=chunk-NBFS4HMY.mjs.map