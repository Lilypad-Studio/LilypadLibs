"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } async function _asyncNullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return await rhsFn(); } } var _class; var _class2; var _class3;// src/flow/LilypadFlowControl.ts
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
   * @param executionFn An asynchronous function to execute.
   * @returns A promise that resolves with the result of `executionFn` if it completes before the timeout,
   *          or rejects with an error if the timeout is exceeded.
   * @throws {Error} Throws an error with message 'Operation timed out' if the execution exceeds the configured timeout duration.
   *
   * @remarks
   * This method uses `Promise.race()` to implement the timeout mechanism. The timeout is cleared in the finally block
   * to ensure no memory leaks occur regardless of whether the operation succeeds or times out.
   */
  async executeWithTimeout(executionFn) {
    if (this.timeout === void 0) {
      return executionFn();
    }
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Operation timed out")), this.timeout);
    });
    try {
      return await Promise.race([executionFn(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  /**
   * Executes a given asynchronous function with retry logic and optional exponential backoff.
   *
   * @template T The return type of the execution function.
   * @param executionFn - The asynchronous function to execute.
   * @param errorFn - Optional function to handle errors after all retries have been exhausted. If provided, its return value will be returned instead of throwing the error.
   * @param backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to exponential backoff if not provided.
   * @returns A promise that resolves with the result of `executionFn`, or with the result of `errorFn` if retries are exhausted.
   * @throws The error thrown by `executionFn` if all retries are exhausted and no `errorFn` is provided.
   */
  async executeWithRetries(executionFn, errorFn, backOffTime) {
    let attempts = 0;
    while (true) {
      try {
        const result = await executionFn();
        return result;
      } catch (error) {
        if (attempts >= (_nullishCoalesce(this.retries, () => ( 0)))) {
          if (errorFn) {
            const result = errorFn(error);
            if (result !== void 0) {
              return result;
            }
          }
          throw error;
        }
        attempts++;
        const backoffTimeValue = backOffTime ? backOffTime(attempts) : Math.pow(2, attempts) * 100;
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
    if (this.rate !== void 0) {
      const rateKey = consumerIdentifier + "#" + functionIdentifier;
      const now = Date.now();
      const lastExecution = _nullishCoalesce(this.rateMap.get(rateKey), () => ( 0));
      if (now - lastExecution < this.rate) {
        throw new Error(`Rate limit exceeded for ${rateKey}`);
      }
      this.rateMap.set(rateKey, now);
    }
    return;
  }
  /**
   * Executes a provided function with optional rate limiting, single-flight deduplication,
   * retries, and timeout handling. Ensures that only one execution per function identifier
   * is in-flight at a time, and subsequent calls return the same promise until completion.
   *
   * @template T - The return type of the function to execute.
   * @param options - The execution options, including:
   *   - consumerIdentifier: Unique identifier for the consumer (used for rate limiting).
   *   - functionIdentifier: Unique identifier for the function (used for single-flight).
   *   - fn: The function to execute.
   *   - errorFn: Optional error handler for retries.
   *   - backOffTime: Optional backoff time between retries.
   * @returns A promise that resolves with the result of the executed function.
   */
  async executeFn(options) {
    await this.rateLimit(options.consumerIdentifier, options.functionIdentifier);
    if (this.singleFlightMap.has(options.functionIdentifier)) {
      return this.singleFlightMap.get(options.functionIdentifier);
    }
    const pipeline = async () => {
      const executionFn = () => this.timeout !== void 0 ? this.executeWithTimeout(options.fn) : options.fn();
      if (this.retries && this.retries > 0) {
        return this.executeWithRetries(executionFn, options.errorFn, options.backOffTime);
      }
      try {
        return await executionFn();
      } catch (error) {
        if (options.errorFn) {
          const result = options.errorFn(error);
          if (result !== void 0) {
            return result;
          }
        }
        throw error;
      }
    };
    const executionPromise = pipeline().finally(() => {
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
  
  
  // time to live in milliseconds
  
  // default error TTL in milliseconds
  
  
  __init3() {this.protectedKeys = /* @__PURE__ */ new Set()}
  
  
  
  /**
   * Timestamp of the last bulk sync operation.
   * If the cache is backed by a database or external store,
   * It's possible that "every entry in the cache" is not the same as "every key in the store".
   * This timestamp can be used to track when the last bulk sync occurred, which would
   * have synced the cache with the store.
   */
  __init4() {this.bulkSyncExpirationTime = 0}
  
  constructor(ttl = 6e4, options = {}) {;_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);
    this.store = /* @__PURE__ */ new Map();
    this.defaultTtl = ttl;
    this.defaultBulkSyncTtl = _nullishCoalesce(options.defaultBulkSyncTtl, () => ( ttl));
    this.bulkSyncFn = options.bulkSyncFn;
    this.defaultErrorTtl = options.defaultErrorTtl ? options.defaultErrorTtl : 5 * 60 * 1e3;
    this.logger = options.logger;
    this.flowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: options.flowControlTimeout || 5e3
    });
    this.bulkSyncFlowControl = new LilypadFlowControl({
      logger: this.logger,
      timeout: options.flowControlTimeout || 3e4
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
   * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
   *
   * @param key - The key to associate with the cached value.
   * @param value - The value to store in the cache.
   * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the value will not expire.
   */
  set(key, value, ttl) {
    this.store.set(key, { value, expirationTime: this.createExpirationTime(ttl) });
  }
  /**
   * Retrieves a value from the cache associated with the specified key.
   * If the cached value has expired or does not exist, it returns `undefined`.
   * If the value is expired, it is also removed from the cache, as a side effect.
   *
   * @param key - The key associated with the cached value.
   * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
   */
  get(key, removeOld = true) {
    const cacheValue = this.store.get(key);
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
    const cacheValue = this.store.get(key);
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
    (_a = this.logger) == null ? void 0 : _a.error(`Error fetching cache key "${String(key)}": `, error);
    let valueToReturn = void 0;
    const errorFnRes = (_b = options.errorFn) == null ? void 0 : _b.call(options, { key, error, options, cache: this });
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
      fn: async () => {
        const value = await valueFn();
        this.set(key, value, options.ttl);
        return value;
      }
    });
  }
  /**
   * Synchronizes the cache in bulk by executing the provided sync function.
   *
   * This method uses flow control to manage the execution of the bulk sync operation.
   * If a `syncFn` is provided, it will be used to fetch key-value pairs to synchronize.
   * Any errors encountered during the sync process are logged.
   *
   * @param syncFn - An optional asynchronous function that returns an array of key-value pairs to be synchronized.
   * @returns A promise that resolves when the bulk sync operation is complete.
   */
  async bulkSync(syncFn) {
    await this.bulkSyncFlowControl.executeFn({
      functionIdentifier: `LilypadCache-bulkSync`,
      consumerIdentifier: "",
      errorFn: (error) => {
        var _a;
        (_a = this.logger) == null ? void 0 : _a.error("Error during bulk sync: ", error);
      },
      fn: async () => this._bulkSync(syncFn)
    });
  }
  async _bulkSync(syncFn) {
    var _a;
    if (Date.now() < this.bulkSyncExpirationTime) {
      return;
    }
    const data = await _asyncNullishCoalesce(await (syncFn == null ? void 0 : syncFn()), async () => ( await ((_a = this.bulkSyncFn) == null ? void 0 : _a.call(this))));
    const expirationTime = this.createExpirationTime();
    for (const [key, value] of _nullishCoalesce(data, () => ( []))) {
      this.store.set(key, { value, expirationTime });
    }
    this.bulkSyncExpirationTime = this.createExpirationTime(this.defaultBulkSyncTtl);
  }
  /**
   * Retrieves multiple values from the cache for the specified keys.
   * If no keys are provided, retrieves all values currently stored in the cache.
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
  async bulkAsyncGet(options) {
    if (options.doSync) {
      await this.bulkSync(options.syncFn);
    }
    return this.bulkGet({ keys: options.keys });
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
      this.protectedKeys.add(key);
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
      this.protectedKeys.delete(key);
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
   */
  invalidate(key) {
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
   */
  delete(key, options = {}) {
    if (this.protectedKeys.has(key) && !options.force) {
      return;
    }
    this.store.delete(key);
  }
  /**
   * Removes all entries from the cache.
   *
   * Iterates over all keys in the cache store and deletes each entry.
   * The deletion behavior can be customized using the `options` parameter.
   *
   * @param options - Optional settings for the clear operation.
   * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
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

// src/logger/LilypadLogger.ts
var LilypadLogger = (_class3 = class {
  __init5() {this.components = {}}
  // Optional logger name
  
  get __name() {
    return this._name;
  }
  constructor(options) {;_class3.prototype.__init5.call(this);
    const reservedKeys = /* @__PURE__ */ new Set(["components", "register", "__name"]);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key)) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }
    this._name = options.name;
    for (const [type, comps] of Object.entries(options.components)) {
      this.components[type] = [...comps];
    }
    for (const type of Object.keys(this.components)) {
      const logFn = async (...message) => {
        let stringMessage = "";
        for (let i = 0; i < message.length; i++) {
          if (i > 0) {
            stringMessage += " ";
          }
          const msgPart = message[i];
          if (typeof msgPart === "string") {
            stringMessage += msgPart;
          } else {
            stringMessage += JSON.stringify(msgPart);
          }
        }
        try {
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
      this.components[type].push(..._nullishCoalesce(newComponents[type], () => ( [])));
    }
    return this;
  }
}, _class3);
function createLogger(options) {
  return new LilypadLogger(options);
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
    } else if (options == null ? void 0 : options.name) {
      formatted += `[${options.name}] `;
    }
    formatted += `[${type.toUpperCase()}]: ${message}`;
    return formatted;
  }
  async output(type, message, options) {
    const formattedMessage = this.formatMessage(type, message, options);
    await this.send(formattedMessage);
  }
};

// src/logger/components/ConsoleLogger.ts
var LilypadConsoleLogger = class extends LilypadLoggerComponent {
  async send(message) {
    console.log(message);
  }
};

// src/logger/components/DiscordLogger.ts
var LilypadDiscordLogger = class extends LilypadLoggerComponent {
  
  constructor(webhookUrl) {
    super();
    this.webhookUrl = webhookUrl;
  }
  async send(message) {
    const payload = {
      content: message
    };
    await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
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
      Object.keys(this.options.keyMapping).forEach((fromKey) => {
        if (!this.options.serialization[fromKey]) {
          return;
        }
        const isEqual = _nullishCoalesce(this.options.serialization[fromKey].equality, () => ( ((v, d) => v === d)));
        if (isEqual(item[fromKey], this.options.serialization[fromKey].default)) {
          return;
        }
        const value = this.options.serialization[fromKey].serialize(item);
        if (value === void 0) {
          return;
        }
        const toKey = this.options.keyMapping[fromKey];
        packedItem[toKey] = value;
      });
      return packedItem;
    });
  }
  deserialize(input) {
    return input.map((item) => {
      const unpackedItem = {};
      Object.keys(this.options.keyMapping).forEach((fromKey) => {
        unpackedItem[fromKey] = _nullishCoalesce(this.options.serialization[fromKey].deserialize(item), () => ( this.options.serialization[fromKey].default));
      });
      return unpackedItem;
    });
  }
};







exports.LilypadCache = LilypadCache_default; exports.LilypadConsoleLogger = LilypadConsoleLogger; exports.LilypadDiscordLogger = LilypadDiscordLogger; exports.LilypadFlowControl = LilypadFlowControl; exports.LilypadSerializer = LilypadSerializer; exports.createLogger = createLogger;
//# sourceMappingURL=index.js.map