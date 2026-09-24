"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } async function _asyncNullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return await rhsFn(); } } var _class; var _class2; var _class3; var _class4;// src/flow/LilypadFlowControl.ts
var RATE_MAP_PRUNE_THRESHOLD = 1e3;
var LilypadFlowControl = (_class = class {
  
  
  
  
  __init() {this.singleFlightMap = /* @__PURE__ */ new Map()}
  __init2() {this.rateMap = /* @__PURE__ */ new Map()}
  constructor(options) {;_class.prototype.__init.call(this);_class.prototype.__init2.call(this);
    this.rate = options == null ? void 0 : options.rate;
    this.timeout = options == null ? void 0 : options.timeout;
    this.retries = options == null ? void 0 : options.retries;
    this.logger = options == null ? void 0 : options.logger;
  }
  /**
   * Executes an asynchronous function with a timeout constraint.
   *
   * @template T The type of value returned by the execution function.
   * @param executionFn An asynchronous function to execute. It receives a signal that is aborted on timeout.
   * @returns A promise that resolves with the result of `executionFn` if it completes before the timeout,
   *          or rejects with an error if the timeout is exceeded.
   * @throws {Error} Throws an error with message 'Operation timed out' if the execution exceeds the configured timeout duration.
   *
   * @remarks
   * This method uses `Promise.race()` to implement the timeout mechanism. The timeout is cleared in the finally block
   * to ensure no memory leaks occur regardless of whether the operation succeeds or times out.
   * JavaScript cannot forcibly stop a running promise: `executionFn` should observe the signal to stop its work.
   */
  async executeWithTimeout(executionFn) {
    const controller = new AbortController();
    if (this.timeout === void 0) {
      return executionFn(controller.signal);
    }
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error("Operation timed out");
        controller.abort(error);
        reject(error);
      }, this.timeout);
    });
    try {
      return await Promise.race([executionFn(controller.signal), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  /**
   * Executes a given asynchronous function with retry logic and optional exponential backoff.
   *
   * @template T The return type of the execution function.
   * @param options - The options for executing with retries, including:
   * @param options.executionFn - The asynchronous function to execute.
   * @param options.errorFn - Optional function to handle errors after all retries have been exhausted. If provided, its return value is returned instead of throwing the error; it can throw to propagate it.
   * @param options.retries - The maximum number of retry attempts. If not provided, the instance's configured retries will be used.
   * @param options.backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to exponential backoff if not provided.
   * @returns A promise that resolves with the result of `executionFn`, or with the result of `errorFn` if retries are exhausted.
   * @throws The error thrown by `executionFn` if all retries are exhausted and no `errorFn` is provided.
   */
  async executeWithRetries(options) {
    let attempts = 0;
    while (true) {
      try {
        const result = await options.executionFn();
        return result;
      } catch (error) {
        if (attempts >= (_nullishCoalesce(_nullishCoalesce(options.retries, () => ( this.retries)), () => ( 0)))) {
          if (options.errorFn) {
            return options.errorFn(error);
          }
          throw error;
        }
        attempts++;
        const backoffTimeValue = options.backOffTime ? options.backOffTime(attempts) : Math.pow(2, attempts) * 100;
        await new Promise((resolve) => setTimeout(resolve, backoffTimeValue));
      }
    }
  }
  /**
   * Enforces a rate limit for a specific consumer and function combination.
   *
   * If a rate limit is set, this method checks whether the specified consumer
   * has invoked the given function within the allowed time interval. If the
   * rate limit is exceeded, an error is thrown. Otherwise, the invocation time
   * is recorded.
   *
   * @param consumerIdentifier - A unique identifier for the consumer (e.g., user or service).
   * @param functionIdentifier - A unique identifier for the function being rate-limited.
   * @throws {Error} If the rate limit is exceeded for the given consumer and function.
   * @returns A promise that resolves when the rate limit check passes.
   */
  async rateLimit(consumerIdentifier, functionIdentifier) {
    this.checkRateLimit(consumerIdentifier, functionIdentifier);
  }
  /**
   * Synchronous implementation of {@link rateLimit}. It must stay synchronous: `executeFn` relies on
   * no await happening between the single-flight lookup and the registration of the new execution.
   */
  checkRateLimit(consumerIdentifier, functionIdentifier) {
    if (this.rate !== void 0) {
      const rateKey = consumerIdentifier + "#" + functionIdentifier;
      const now = Date.now();
      const lastExecution = _nullishCoalesce(this.rateMap.get(rateKey), () => ( 0));
      if (now - lastExecution < this.rate) {
        throw new Error(`Rate limit exceeded for ${rateKey}`);
      }
      this.rateMap.set(rateKey, now);
      if (this.rateMap.size > RATE_MAP_PRUNE_THRESHOLD) {
        this.pruneRateMap(now);
      }
    }
  }
  /**
   * Removes the rate limit entries whose interval has already elapsed, as they no longer limit anything.
   */
  pruneRateMap(now) {
    for (const [rateKey, lastExecution] of this.rateMap) {
      if (now - lastExecution >= this.rate) {
        this.rateMap.delete(rateKey);
      }
    }
  }
  /**
   * Executes a provided function with optional rate limiting, single-flight deduplication,
   * retries, and timeout handling. Ensures that only one execution per function identifier
   * is in-flight at a time, and subsequent calls return the same promise until completion.
   * Calls that join an in-flight execution are not rate limited, since they do not start a new one.
   *
   * @template T - The return type of the function to execute.
   * @param options - The execution options, including:
   *   - consumerIdentifier: Unique identifier for the consumer (used for rate limiting).
   *   - functionIdentifier: Unique identifier for the function (used for single-flight).
   *   - fn: The function to execute.
   *   - errorFn: Optional error handler, called once all retries are exhausted.
   *   - backOffTime: Optional backoff time between retries.
   * @returns A promise that resolves with the result of the executed function.
   */
  async executeFn(options) {
    const inFlight = this.singleFlightMap.get(options.functionIdentifier);
    if (inFlight) {
      return inFlight;
    }
    this.checkRateLimit(options.consumerIdentifier, options.functionIdentifier);
    const executionPromise = this.executeWithRetries({
      executionFn: () => this.executeWithTimeout(options.fn),
      retries: _nullishCoalesce(_nullishCoalesce(options.retries, () => ( this.retries)), () => ( 0)),
      errorFn: options.errorFn,
      backOffTime: options.backOffTime
    }).finally(() => {
      this.singleFlightMap.delete(options.functionIdentifier);
    });
    this.singleFlightMap.set(options.functionIdentifier, executionPromise);
    return executionPromise;
  }
}, _class);

// src/cache/LilypadCache.ts
function isStale(retrieval) {
  return Date.now() >= retrieval.expirationTime;
}
var LilypadCache = (_class2 = class {
  __init3() {this.id = `LilypadCache-${Math.random().toString(36).substring(2, 15)}`}
  
  
  // time to live in milliseconds
  
  // default error TTL in milliseconds
  
  
  __init4() {this.protectedKeys = /* @__PURE__ */ new Set()}
  
  
  
  /**
   * Timestamp of the last bulk sync operation.
   * If the cache is backed by a database or external store,
   * It's possible that "every entry in the cache" is not the same as "every key in the store".
   * This timestamp can be used to track when the last bulk sync occurred, which would
   * have synced the cache with the store.
   */
  __init5() {this.bulkSyncExpirationTime = 0}
  
  constructor(ttl = 6e4, options = {}) {;_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);_class2.prototype.__init5.call(this);
    var _a;
    this.store = /* @__PURE__ */ new Map();
    this.defaultTtl = ttl;
    this.defaultBulkSyncTtl = _nullishCoalesce(options.defaultBulkSyncTtl, () => ( ttl));
    this.bulkSyncFn = options.bulkSyncFn;
    this.defaultErrorTtl = _nullishCoalesce(options.defaultErrorTtl, () => ( 5 * 60 * 1e3));
    this.logger = options.logger;
    this.flowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: _nullishCoalesce(options.flowControlTimeout, () => ( 5e3))
    });
    this.bulkSyncFlowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: _nullishCoalesce(options.flowControlTimeout, () => ( 3e4))
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
    void ((_a = this.logger) == null ? void 0 : _a.debug(this.id, `LilypadCache initialized`));
  }
  /**
   * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
   *
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
   * @returns The expiration time as a Unix timestamp in milliseconds.
   */
  createExpirationTime(ttl) {
    return Date.now() + (_nullishCoalesce(ttl, () => ( this.defaultTtl)));
  }
  /**
   * Normalizes a key to the string form used by the store.
   * Keys can be non-strings at runtime (e.g. numeric primary keys cast to `K`), so every access
   * to the store or to the protected keys must go through this method.
   */
  normalizeKey(key) {
    return String(key);
  }
  /**
   * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
   *
   * @param key - The key to associate with the cached value.
   * @param value - The value to store in the cache.
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the cache's default TTL is used.
   */
  set(key, value, ttl) {
    this.store.set(this.normalizeKey(key), {
      value,
      expirationTime: this.createExpirationTime(ttl)
    });
  }
  /**
   * Retrieves a value from the cache associated with the specified key.
   * If the cached value has expired or does not exist, it returns `undefined`.
   *
   * @param key - The key associated with the cached value.
   * @param removeOld - If true, an expired value is also removed from the cache, as a side effect.
   * Defaults to false, so that the old value stays available as a fallback for `getOrSet` with
   * `returnOldOnError`; expired entries are removed by `purgeExpired` / `autoCleanupInterval`.
   * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
   */
  get(key, removeOld = false) {
    const cacheValue = this.store.get(this.normalizeKey(key));
    if (cacheValue && !isStale(cacheValue)) {
      return cacheValue.value;
    } else {
      if (removeOld) {
        this.delete(key);
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
    const cacheValue = this.store.get(this.normalizeKey(key));
    if (cacheValue && !isStale(cacheValue)) {
      return { ...cacheValue, type: "hit" };
    } else {
      if (cacheValue) {
        return { ...cacheValue, type: "expired" };
      }
      return { type: "miss" };
    }
  }
  /**
   * Handles error scenarios during cache retrieval by determining an appropriate value to return.
   *
   * The method follows this order:
   * 1. If `options.errorFn` is provided and returns a value, that value is used and cached.
   * 2. If `options.returnOldOnError` is true and a previous value exists (`fetched.type !== 'miss'`), the old value is used.
   * 3. If no fallback value is determined, the original error is rethrown.
   *
   * The chosen value (from errorFn or old value) is cached with a TTL specified by `options.errorTtl` or the default error TTL.
   *
   * @param error - The error encountered during cache retrieval.
   * @param options - The cache get options, including error handling strategies.
   * @param key - The cache key associated with the retrieval.
   * @param fetched - The result of the cache value retrieval, including type and value.
   * @returns The determined fallback value to return.
   * @throws Rethrows the original error if no fallback value is determined.
   */
  errorReturn(error, options, key, fetched) {
    var _a, _b;
    void ((_a = this.logger) == null ? void 0 : _a.error(this.id, `Error fetching cache key "${String(key)}": `, error));
    let valueToReturn = void 0;
    const errorFnRes = (_b = options.errorFn) == null ? void 0 : _b.call(options, { key, error, options });
    if (errorFnRes !== void 0) {
      valueToReturn = errorFnRes;
    }
    if (fetched.type !== "miss" && options.returnOldOnError && valueToReturn === void 0) {
      valueToReturn = fetched.value;
    }
    if (valueToReturn === void 0) {
      throw error;
    }
    this.set(key, valueToReturn, _nullishCoalesce(options.errorTtl, () => ( this.defaultErrorTtl)));
    return valueToReturn;
  }
  /**
   * Gets a value from the cache, or sets it using the provided function if not found.
   *
   * Implements a cache-aside pattern with support for concurrent request deduplication.
   * If the key exists in the cache and skipCache is not enabled, the cached value is returned immediately.
   * If another request for the same key is already pending, that promise is reused instead of creating a duplicate.
   *
   * @template K - The type of the cache key
   * @template V - The type of the cached value
   * @param key - The cache key
   * @param valueFn - An async function that produces the value to cache if it doesn't exist or is expired
   * @param options - Optional configuration for cache behavior and error handling
   * @returns A promise that resolves to the cached value or the value produced by valueFn
   * @throws Will not throw, but will return a handled error value if valueFn rejects and error handling is configured
   */
  async getOrSet(key, valueFn, options = {}) {
    const fetched = this.getComprehensive(key);
    if (!options.skipCache && fetched.type === "hit") {
      return fetched.value;
    }
    return this.flowControl.executeFn({
      functionIdentifier: `LilypadCache-getOrSet-${String(key)}`,
      consumerIdentifier: "",
      errorFn: (error) => this.errorReturn(error, options, key, fetched),
      fn: async (signal) => {
        const value = await valueFn();
        if (!signal.aborted) {
          this.set(key, value, options.ttl);
        }
        return value;
      }
    });
  }
  /**
   * Synchronizes the cache in bulk by executing the provided sync function.
   *
   * This method uses flow control to manage the execution of the bulk sync operation.
   * If a `syncFn` is provided, it will be used to fetch key-value pairs to synchronize.
   * Errors encountered during the sync process are logged and not rethrown: the cache keeps its
   * current content, and the next call retries the sync.
   *
   * @param syncFn - An optional asynchronous function that returns an array of key-value pairs to be synchronized.
   * @returns A promise that resolves when the bulk sync operation is complete (or has failed).
   */
  async bulkSync(syncFn) {
    await this.bulkSyncFlowControl.executeFn({
      functionIdentifier: `LilypadCache-bulkSync`,
      consumerIdentifier: "",
      errorFn: (error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.error(this.id, "Error during bulk sync: ", error));
      },
      fn: async () => this._bulkSync(syncFn)
    });
  }
  async _bulkSync(syncFn) {
    var _a, _b;
    if (Date.now() < this.bulkSyncExpirationTime) {
      return;
    }
    const data = await _asyncNullishCoalesce(await (syncFn == null ? void 0 : syncFn()), async () => ( await ((_a = this.bulkSyncFn) == null ? void 0 : _a.call(this))));
    if (!data) {
      void ((_b = this.logger) == null ? void 0 : _b.warn(this.id, "Bulk sync function returned no data"));
      return;
    }
    for (const key of this.store.keys()) {
      if (!this.delete(key)) {
        this.expire(key);
      }
    }
    for (const [key, value] of data) {
      this.set(key, value);
    }
    this.bulkSyncExpirationTime = this.createExpirationTime(this.defaultBulkSyncTtl);
  }
  /**
   * Retrieves multiple values from the cache for the specified keys.
   * If no keys are provided, retrieves all values currently stored in the cache.
   * If some keys are not found in the cache or they have expired, they are simply omitted from the result.
   *
   * @param options - An object containing an optional array of keys to retrieve.
   * @returns A `Map` containing the key-value pairs found in the cache.
   */
  bulkGet(options) {
    const result = /* @__PURE__ */ new Map();
    const keysToGet = _nullishCoalesce(options.keys, () => ( Array.from(this.store.keys())));
    for (const key of keysToGet) {
      const value = this.get(key);
      if (value !== void 0) {
        result.set(key, value);
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
   * Each entry is added to the cache using the `set` method.
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
   * If the cache contains a valid entry for the given key, this method marks it as expired
   * by setting its value with a negative expiration time.
   *
   * @param key - The key of the cache entry to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - If true (default), forces a bulk sync on the next bulkSync call.
   */
  invalidate(key, { invalidateBulkSync = true } = {}) {
    this.expire(key);
    if (invalidateBulkSync) {
      this.bulkSyncExpirationTime = 0;
    }
  }
  /**
   * Marks a valid cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
   * Unlike `invalidate`, it is never overridden by subclasses, so it is always synchronous.
   *
   * @param key - The key of the cache entry to expire.
   */
  expire(key) {
    const comprehensive = this.getComprehensive(key);
    if (comprehensive.type === "hit") {
      this.set(key, comprehensive.value, -1);
    }
  }
  /**
   * Deletes the specified key from the cache.
   *
   * If the key is present in the set of protected keys, the deletion is skipped.
   *
   * @param key - The key to be deleted from the cache.
   * @param options - Optional settings for deletion.
   * @param options.force - If true, forces deletion even if the key is protected.
   * @param options.setNull - If true, sets the value to null instead of deleting the entry.
   */
  delete(key, options = {}) {
    const normalizedKey = this.normalizeKey(key);
    if (this.protectedKeys.has(normalizedKey) && !options.force) {
      return false;
    }
    if (options.setNull) {
      this.set(normalizedKey, null);
      return true;
    }
    this.store.delete(normalizedKey);
    return true;
  }
  /**
   * Removes all entries from the cache.
   *
   * Iterates over all keys in the cache store and deletes each entry.
   * The deletion behavior can be customized using the `options` parameter.
   *
   * @param options - Optional settings for the clear operation.
   * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
   * @param options.setNull - If `true`, sets the value to null instead of deleting the entry.
   */
  clear(options = {}) {
    for (const key of this.store.keys()) {
      this.delete(key, options);
    }
  }
  /**
   * Removes all expired entries from the cache.
   *
   * Iterates through the cache store and deletes any entries whose expiration time has passed.
   * Optionally, the deletion can be forced by providing the `force` option.
   *
   * @param options - Optional settings for the purge operation.
   * @param options.force - If true, forces deletion of expired entries regardless of other conditions.
   */
  purgeExpired(options = {}) {
    const now = Date.now();
    for (const [key, cacheValue] of this.store.entries()) {
      if (now >= cacheValue.expirationTime) {
        this.delete(key, options);
      }
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
   */
  dispose() {
    this.logger = void 0;
    this.stopCleanupInterval();
    this.clear({ force: true });
  }
}, _class2);
var LilypadCache_default = LilypadCache;

// src/singleton/LilypadSingleton.ts
var singletonMap = globalThis.__lilypadSingletonMap ??= /* @__PURE__ */ new Map();
function getLilypadSingletonInstance(identifier, createInstanceFn) {
  if (singletonMap.has(identifier)) {
    return singletonMap.get(identifier);
  }
  const instance = createInstanceFn();
  singletonMap.set(identifier, instance);
  return instance;
}
function removeLilypadSingletonInstance(identifier) {
  return singletonMap.delete(identifier);
}
async function getLilypadSingletonInstanceAsync(identifier, createInstanceFn) {
  if (singletonMap.has(identifier)) {
    return singletonMap.get(identifier);
  }
  const instancePromise = createInstanceFn();
  singletonMap.set(identifier, instancePromise);
  try {
    const instance = await instancePromise;
    singletonMap.set(identifier, instance);
    return instance;
  } catch (error) {
    singletonMap.delete(identifier);
    throw error;
  }
}

// src/cache/LilypadDbCache.ts
var LilypadDbCache = class _LilypadDbCache extends LilypadCache_default {
  
  
  
  /**
   * Creates a cache and, unless disabled, registers its default database listener.
   *
   * @throws If the default database listener cannot be registered (e.g. the database is unreachable).
   */
  static async create(ttl = 6e4, options) {
    if (options.singleton) {
      const identifier = options.singletonIdentifier;
      return getLilypadSingletonInstanceAsync(identifier, async () => {
        const cache = await _LilypadDbCache.initializeNew(ttl, options);
        cache.singletonIdentifier = identifier;
        return cache;
      });
    }
    return _LilypadDbCache.initializeNew(ttl, options);
  }
  static async initializeNew(ttl, options) {
    const cache = new _LilypadDbCache(ttl, options);
    if (cache.defaultDbListener) {
      try {
        await cache.dbGate.gate.addListener(cache.defaultDbListener);
      } catch (error) {
        await cache.dispose();
        throw error;
      }
    }
    return cache;
  }
  constructor(ttl, options) {
    var _a;
    super(ttl, options);
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () => (await this.dbGate.gate.selectAllFromTable(this.dbGate.schema)).map((item) => [
      item[options.dbGate.schema.primaryKey],
      item
    ]);
    if (_nullishCoalesce(options.useDefaultDbListener, () => ( true))) {
      this.defaultDbListener = this.getDefaultDbListener(
        options.useDefaultDbListener ? options.defaultListenerOptions : void 0
      );
    }
    void ((_a = this.logger) == null ? void 0 : _a.debug(
      this.id,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}"`
    ));
  }
  /**
   * Retrieves a cached value by key, or fetches it from the database if not found in cache.
   * Concurrent calls for the same key share a single database query.
   *
   * @param key - The cache key to retrieve or fetch.
   * @returns A promise that resolves to the cached value (`null` if the row does not exist),
   * or undefined if an error occurs during fetching.
   * @throws Does not throw; errors are logged internally.
   */
  async getOrFetch(key) {
    try {
      return await this.getOrSet(
        key,
        () => this.dbGate.gate.selectFromTableByPrimaryKey(this.dbGate.schema, key)
      );
    } catch (e2) {
      return void 0;
    }
  }
  /**
   * Invalidates the cache entry for the specified key.
   *
   * Attempts to update the cache for the given key. If the update fails,
   * logs the error and falls back to the base class's invalidate method.
   *
   * @param key - The cache key to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - Whether to invalidate bulk sync when the update fails (default: true).
   * @returns A promise that resolves when the invalidation process is complete.
   */
  async invalidate(key, options = {}) {
    var _a;
    try {
      await this.update(key);
    } catch (error) {
      void ((_a = this.logger) == null ? void 0 : _a.error(
        this.id,
        `Error updating cache key "${String(key)}" after invalidation: `,
        error
      ));
      super.invalidate(key, options);
    }
  }
  /**
   * Updates the cache entry for the specified key by fetching the latest value from the database.
   * A row that does not exist is cached as `null`.
   *
   * @param key - The primary key of the cache entry to update.
   * @returns A promise that resolves to the updated value from the database.
   * @throws Rethrows any error encountered during the database fetch.
   */
  async update(key) {
    const value = await this.dbGate.gate.selectFromTableByPrimaryKey(this.dbGate.schema, key);
    this.set(key, value);
    return value;
  }
  async getAll(keys) {
    const values = await super.bulkAsyncGet({ doSync: true, keys });
    return Array.from(values.values()).filter((item) => item !== null);
  }
  getDefaultDbListener(options) {
    return {
      channel: "cache_events",
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${this.dbGate.schema.tableName}_${this.id}`,
      callback: async (payload) => {
        var _a, _b, _c, _d;
        void ((_a = this.logger) == null ? void 0 : _a.debug(
          this.id,
          this.dbGate.schema.tableName,
          "LilypadDbCache handler has received payload on cache_events channel:",
          payload
        ));
        if (typeof payload !== "string") {
          return;
        }
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(payload);
        } catch (e) {
          void ((_b = this.logger) == null ? void 0 : _b.error(this.id, "Error parsing cache_events payload:", e));
          return;
        }
        if (!parsedPayload.id || !parsedPayload.table) {
          return;
        }
        if (parsedPayload.table === this.dbGate.schema.tableName) {
          void ((_c = this.logger) == null ? void 0 : _c.debug(
            this.id,
            this.dbGate.schema.tableName,
            "LilypadDbCache handler is processing payload:",
            parsedPayload
          ));
          if (!(options == null ? void 0 : options.callback) || options.automaticallyInvalidateDataBeforeCallback) {
            if (parsedPayload.op === "DELETE") {
              this.delete(String(parsedPayload.id), { setNull: true });
            } else {
              await this.invalidate(String(parsedPayload.id), { invalidateBulkSync: false });
            }
          }
          await ((_d = options == null ? void 0 : options.callback) == null ? void 0 : _d.call(options, parsedPayload));
          return;
        }
      }
    };
  }
  /**
   * Disposes of the cache: stops its default database listener, removes it from the singleton
   * registry (if it was created as a singleton) and clears it.
   */
  async dispose() {
    if (this.singletonIdentifier !== void 0) {
      removeLilypadSingletonInstance(this.singletonIdentifier);
      this.singletonIdentifier = void 0;
    }
    const listenerRemoval = this.defaultDbListener ? this.dbGate.gate.removeListener(
      this.defaultDbListener.channel,
      this.defaultDbListener.callbackId
    ) : void 0;
    super.dispose();
    await listenerRemoval;
  }
  getItemPrimaryKeyValue(item) {
    const keyValue = item[this.dbGate.schema.primaryKey];
    if (keyValue === void 0) {
      throw new Error(
        `Primary key "${String(
          this.dbGate.schema.primaryKey
        )}" is missing in the item data for table "${this.dbGate.schema.tableName}".`
      );
    }
    return keyValue;
  }
  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item) {
    const row = await this.dbGate.gate.insertToTable(this.dbGate.schema, item);
    if (row !== null) {
      this.set(this.getItemPrimaryKeyValue(row), row);
    }
    return row;
  }
  /**
   * Updates the item in the database and caches the row returned by the database.
   *
   * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws If no row with the item's primary key exists.
   */
  async sqlUpdate(item) {
    const keyValue = this.getItemPrimaryKeyValue(item);
    const row = await this.dbGate.gate.updateToTable(this.dbGate.schema, item);
    this.set(keyValue, row);
    return row;
  }
  async sqlDelete(key) {
    await this.dbGate.gate.deleteFromTable(this.dbGate.schema, key);
    this.delete(key, { setNull: true });
  }
};

// src/dbGate/LilypadDbGate.ts
var _postgres = require('postgres'); var _postgres2 = _interopRequireDefault(_postgres);
var LilypadDbGate = (_class3 = class _LilypadDbGate {
  
  
  
  
  __init6() {this.listeners = /* @__PURE__ */ new Map()}
  
  constructor(options) {;_class3.prototype.__init6.call(this);
    this.logger = options.logger;
    this.listenerConnectionString = options.listenerConnectionString || options.connectionString;
    this.sql = _postgres2.default.call(void 0, options.connectionString, { prepare: false });
  }
  static async create(options) {
    if (options.singleton) {
      const identifier = options.singletonIdentifier;
      return await getLilypadSingletonInstanceAsync(identifier, async () => {
        const instance = await _LilypadDbGate.initializeNew(options);
        instance.singletonIdentifier = identifier;
        return instance;
      });
    }
    return await _LilypadDbGate.initializeNew(options);
  }
  static async initializeNew(options) {
    const instance = new _LilypadDbGate(options);
    try {
      for (const listenOption of options.listen) {
        await instance.addListener(listenOption);
      }
    } catch (error) {
      await instance.close();
      throw error;
    }
    return instance;
  }
  // CRUD OPERATIONS
  /**
   * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
   * otherwise by copying the schema columns.
   */
  mapRow(schema, row) {
    if (schema.selectSanitizationFn) {
      return schema.selectSanitizationFn(row);
    }
    const typedRow = {};
    for (const key in schema.cols) {
      typedRow[key] = row[key];
    }
    return typedRow;
  }
  /**
   * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
   * columns that are not in the schema; otherwise only the schema columns are needed.
   */
  selectedColumns(schema) {
    return schema.selectSanitizationFn ? this.sql`*` : this.sql(Object.keys(schema.cols));
  }
  /**
   * Prepares the data of an insert/update:
   * - applies the schema's `insertSanitizationFn`;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table.
   */
  prepareWrite(schema, data, operation) {
    let writeData = { ...data };
    if (schema.insertSanitizationFn) {
      writeData = { ...writeData, ...schema.insertSanitizationFn(writeData) };
    }
    const primaryKeyValue = writeData[schema.primaryKey];
    const primaryKeyRequired = operation === "update" || !schema.primaryKeyShouldAutoDetermine;
    if (primaryKeyRequired && (primaryKeyValue === void 0 || primaryKeyValue === null)) {
      throw new Error(
        `Primary key "${String(
          schema.primaryKey
        )}" is missing in the ${operation} data for table "${schema.tableName}".`
      );
    }
    if (schema.primaryKeyShouldAutoDetermine) {
      delete writeData[schema.primaryKey];
    }
    const columns = Object.keys(schema.cols).filter((column) => column in writeData);
    if (columns.length === 0) {
      throw new Error(`No columns to ${operation} for table "${schema.tableName}".`);
    }
    return { data: writeData, columns, primaryKeyValue };
  }
  async selectAllFromTable(options) {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
    `;
    const typedResults = [];
    for (const row of results) {
      const typedRow = this.mapRow(options, row);
      if (typedRow !== null) {
        typedResults.push(typedRow);
      }
    }
    return typedResults;
  }
  async selectFromTableByPrimaryKey(options, primaryKeyValue) {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
    if (results.length === 0) {
      return null;
    }
    return this.mapRow(options, results[0]);
  }
  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
   */
  async insertToTable(options, data) {
    const { data: insertData, columns } = this.prepareWrite(options, data, "insert");
    const results = await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData, columns)}
      RETURNING *
    `;
    return this.mapRow(options, results[0]);
  }
  /**
   * Updates the row identified by the primary key contained in `data`.
   *
   * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
   * @throws If no row with that primary key exists.
   */
  async updateToTable(options, data) {
    const {
      data: updateData,
      columns,
      primaryKeyValue
    } = this.prepareWrite(options, data, "update");
    const results = await this.sql`
      UPDATE ${this.sql(options.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
      RETURNING *
    `;
    if (results.count === 0) {
      throw new Error(
        `No row with primary key "${String(primaryKeyValue)}" found in table "${options.tableName}".`
      );
    }
    return this.mapRow(options, results[0]);
  }
  async deleteFromTable(options, primaryKeyValue) {
    await this.sql`
      DELETE FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
  }
  // LISTENER MANAGEMENT
  /**
   * Retrieves the singleton listener database connection.
   *
   * If the listener connection does not already exist, this method initializes it
   * using the provided connection string and specific connection options:
   * - `max`: Limits the pool to a single connection.
   * - `idle_timeout`: Disables idle timeout for the connection.
   * - `max_lifetime`: Disables maximum lifetime for the connection.
   *
   * @returns The singleton listener database connection instance.
   */
  getListenerConnection() {
    if (!this.listenerConnection) {
      this.listenerConnection = _postgres2.default.call(void 0, this.listenerConnectionString, {
        max: 1,
        idle_timeout: 0,
        max_lifetime: null
      });
    }
    return this.listenerConnection;
  }
  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   *
   * @param channel - The name of the channel to listen on.
   * @returns The listener entry of the channel.
   */
  initializeListener(channel) {
    var _a;
    void ((_a = this.logger) == null ? void 0 : _a.debug(`Initializing listener for channel "${channel}".`));
    const listener = {
      callbacks: /* @__PURE__ */ new Map(),
      ready: this.getListenerConnection().listen(channel, (payload) => this.executeAllListenerCallbacks(channel, payload)).then(({ unlisten }) => unlisten).catch((error) => {
        if (this.listeners.get(channel) === listener) {
          this.listeners.delete(channel);
        }
        throw error;
      })
    };
    this.listeners.set(channel, listener);
    return listener;
  }
  /**
   * Executes all registered listener callbacks for a given channel, passing the provided payload to each callback.
   *
   * Both synchronous throws and rejected promises of async callbacks are caught and logged,
   * so a failing callback can neither affect the others nor cause an unhandled rejection.
   *
   * @param channel - The name of the channel whose listener callbacks should be executed.
   * @param payload - The data to pass to each listener callback.
   */
  executeAllListenerCallbacks(channel, payload) {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }
    for (const [callbackId, callback] of listener.callbacks) {
      Promise.resolve().then(() => callback(payload)).catch((error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.error(
          `Error in listener callback "${callbackId}" for channel "${channel}":`,
          error
        ));
      });
    }
  }
  /**
   * Adds a listener callback for a specified channel.
   *
   * If the channel does not already have a listener, it initializes one.
   * The callback is associated with the provided `callbackId`: adding a callback with an existing
   * `callbackId` on the same channel replaces the previous one.
   *
   * @param params - An object containing:
   *   @param params.channel - The name of the channel to listen to.
   *   @param params.callbackId - A unique identifier for the callback.
   *   @param params.callback - The callback function to be invoked for the channel.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener({ channel, callbackId, callback }) {
    var _a, _b;
    void ((_a = this.logger) == null ? void 0 : _a.debug(
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    ));
    const listener = _nullishCoalesce(this.listeners.get(channel), () => ( this.initializeListener(channel)));
    listener.callbacks.set(callbackId, callback);
    await listener.ready;
    void ((_b = this.logger) == null ? void 0 : _b.debug(
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    ));
  }
  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
   *
   * @returns `true` if the callback was registered.
   */
  async removeListener(channel, callbackId) {
    const listener = this.listeners.get(channel);
    if (!listener || !listener.callbacks.delete(callbackId)) {
      return false;
    }
    if (listener.callbacks.size === 0) {
      this.listeners.delete(channel);
      const unlisten = await listener.ready;
      await unlisten();
    }
    return true;
  }
  async close() {
    var _a;
    this.listeners.clear();
    if (this.singletonIdentifier !== void 0) {
      removeLilypadSingletonInstance(this.singletonIdentifier);
      this.singletonIdentifier = void 0;
    }
    await ((_a = this.listenerConnection) == null ? void 0 : _a.end());
    await this.sql.end();
  }
}, _class3);

// src/logger/LilypadLogger.ts
var _util = require('util');
var LilypadLogger = (_class4 = class _LilypadLogger {
  __init7() {this.components = {}}
  // Optional logger name
  
  get __name() {
    return this._name;
  }
  /**
   * Creates a new LilypadLogger instance or retrieves a singleton instance.
   *
   * @template T - The log level type, defaults to 'log' | 'error' | 'warn'
   * @param options - Configuration options for the logger
   * @param options.singleton - Whether to use a singleton instance
   * @param options.singletonIdentifier - Unique identifier for the singleton instance
   * @returns A LilypadLogger instance typed according to the generic parameter T
   *
   * @example
   * // Create a new logger instance
   * const logger = LilypadLogger.create({ singleton: false });
   *
   * @example
   * // Create or retrieve a singleton logger
   * const singletonLogger = LilypadLogger.create({
   *   singleton: true,
   *   singletonIdentifier: 'app-logger'
   * });
   */
  static create(options) {
    if (options.singleton) {
      return getLilypadSingletonInstance(
        options.singletonIdentifier,
        () => new _LilypadLogger(options)
      );
    }
    return new _LilypadLogger(options);
  }
  constructor(options) {;_class4.prototype.__init7.call(this);
    const reservedKeys = /* @__PURE__ */ new Set(["components", "register", "__name", "_name"]);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key) || key in this) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }
    this._name = options.name;
    for (const [type, comps] of Object.entries(options.components)) {
      this.components[type] = [...comps];
    }
    for (const type of Object.keys(this.components)) {
      const logFn = async (...message) => {
        try {
          const stringMessage = message.map(formatMessagePart).join(" ");
          const promises = [];
          for (const component of this.components[type]) {
            promises.push(
              component.output(type, stringMessage, { logger: this })
            );
          }
          await Promise.all(promises);
        } catch (error) {
          if (options.errorLogging) {
            await options.errorLogging(error);
          } else {
            console.error(`Error in logger component for type "${type}":`, error);
          }
        }
      };
      this[type] = logFn;
    }
  }
  /**
   * Registers new logger components for specified types.
   * @param newComponents - A partial record mapping component types to arrays of logger components to register
   * @returns The current logger instance for method chaining
   */
  register(newComponents) {
    for (const type of Object.keys(newComponents)) {
      if (!this.components[type]) {
        throw new Error(
          `Logger type "${type}" was not defined when the logger was created and cannot be registered.`
        );
      }
      this.components[type].push(..._nullishCoalesce(newComponents[type], () => ( [])));
    }
    return this;
  }
}, _class4);
function formatMessagePart(part) {
  return typeof part === "string" ? part : _util.inspect.call(void 0, part, { depth: 4, breakLength: Infinity });
}
function createLogger(options) {
  return LilypadLogger.create(options);
}

// src/logger/LilypadLoggerComponent.ts
var LilypadLoggerComponent = class {
  getTimestamp() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  formatMessage(type, message, options) {
    var _a;
    let formatted = `${this.getTimestamp()} - `;
    if ((_a = options == null ? void 0 : options.logger) == null ? void 0 : _a.__name) {
      formatted += `[${options.logger.__name}] `;
    }
    formatted += `[${type.toUpperCase()}]: ${message}`;
    return formatted;
  }
  async output(type, message, options) {
    const formattedMessage = this.formatMessage(type, message, options);
    await this.send(formattedMessage, type);
  }
};

// src/logger/components/ConsoleLogger.ts
var LilypadConsoleLogger = class extends LilypadLoggerComponent {
  async send(message, type) {
    switch (type.toLowerCase()) {
      case "error":
        console.error(message);
        break;
      case "warn":
        console.warn(message);
        break;
      default:
        console.log(message);
    }
  }
};

// src/logger/components/DiscordLogger.ts
var DISCORD_MAX_CONTENT_LENGTH = 2e3;
var DISCORD_REQUEST_TIMEOUT = 5e3;
var LilypadDiscordLogger = class extends LilypadLoggerComponent {
  
  constructor(webhookUrl) {
    super();
    this.webhookUrl = webhookUrl;
  }
  async send(message) {
    const payload = {
      content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH),
      allowed_mentions: { parse: [] }
    };
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT)
    });
    if (!response.ok) {
      throw new Error(
        `Discord webhook request failed with status ${response.status} ${response.statusText}`
      );
    }
  }
};

// src/serializer/LilypadSerializer.ts
var LilypadSerializer = class {
  constructor(options) {
    this.options = options;
  }
  serialize(input) {
    return input.map((item) => {
      const packedItem = {};
      Object.keys(this.options.serialization).forEach((fromKey) => {
        const isEqual = _nullishCoalesce(this.options.serialization[fromKey].equality, () => ( ((v, d) => v === d)));
        if (isEqual(item[fromKey], this.options.serialization[fromKey].default)) {
          return;
        }
        const value = this.options.serialization[fromKey].serialize(item);
        if (value === void 0) {
          return;
        }
        const toKey = this.options.serialization[fromKey].target;
        packedItem[toKey] = value;
      });
      return packedItem;
    });
  }
  deserialize(input) {
    return input.map((item) => {
      const unpackedItem = {};
      Object.keys(this.options.serialization).forEach((fromKey) => {
        unpackedItem[fromKey] = _nullishCoalesce(this.options.serialization[fromKey].deserialize(item), () => ( cloneDefault(this.options.serialization[fromKey].default)));
      });
      return unpackedItem;
    });
  }
};
function cloneDefault(value) {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}














exports.LilypadCache = LilypadCache_default; exports.LilypadConsoleLogger = LilypadConsoleLogger; exports.LilypadDbCache = LilypadDbCache; exports.LilypadDbGate = LilypadDbGate; exports.LilypadDiscordLogger = LilypadDiscordLogger; exports.LilypadFlowControl = LilypadFlowControl; exports.LilypadLogger = LilypadLogger; exports.LilypadLoggerComponent = LilypadLoggerComponent; exports.LilypadSerializer = LilypadSerializer; exports.createLogger = createLogger; exports.getLilypadSingletonInstance = getLilypadSingletonInstance; exports.getLilypadSingletonInstanceAsync = getLilypadSingletonInstanceAsync; exports.removeLilypadSingletonInstance = removeLilypadSingletonInstance;
//# sourceMappingURL=index.js.map