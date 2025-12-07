"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2;// src/cache/LilypadCache.ts
function isStale(retrieval) {
  return Date.now() >= retrieval.expirationTime;
}
var LilypadCache = (_class = class {
  
  
  // time to live in milliseconds
  
  // default error TTL in milliseconds
  
  __init() {this.pendingPromises = /* @__PURE__ */ new Map()}
  __init2() {this.protectedKeys = /* @__PURE__ */ new Set()}
  
  constructor(ttl = 6e4, options = {}) {;_class.prototype.__init.call(this);_class.prototype.__init2.call(this);
    this.store = /* @__PURE__ */ new Map();
    this.defaultTtl = ttl;
    this.defaultErrorTtl = options.defaultErrorTtl ? options.defaultErrorTtl : 5 * 60 * 1e3;
    this.logger = options.logger;
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
    const pending = this.pendingPromises.get(key);
    if (pending) {
      return pending.catch((error) => this.errorReturn(error, options, key, fetched));
    }
    const promise = valueFn();
    this.pendingPromises.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value, options.ttl);
      return value;
    } catch (error) {
      return this.errorReturn(error, options, key, fetched);
    } finally {
      this.pendingPromises.delete(key);
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
}, _class);
var LilypadCache_default = LilypadCache;

// src/logger/LilypadLogger.ts
var LilypadLogger = (_class2 = class {
  __init3() {this.components = {}}
  // Optional logger name
  
  get __name() {
    return this._name;
  }
  constructor(options) {;_class2.prototype.__init3.call(this);
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
}, _class2);
function createLogger(options) {
  return new LilypadLogger(options);
}

// src/logger/components/FileLogger.ts
var _fs = require('fs'); var _fs2 = _interopRequireDefault(_fs);

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

// src/logger/components/FileLogger.ts
var LilypadFileLogger = class extends LilypadLoggerComponent {
  
  constructor(filePath) {
    super();
    this.filePath = filePath;
  }
  send(message) {
    return new Promise((resolve, reject) => {
      _fs2.default.appendFile(this.filePath, message + "\n", "utf8", (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
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






exports.LilypadCache = LilypadCache_default; exports.LilypadConsoleLogger = LilypadConsoleLogger; exports.LilypadDiscordLogger = LilypadDiscordLogger; exports.LilypadFileLogger = LilypadFileLogger; exports.createLogger = createLogger;
//# sourceMappingURL=index.js.map