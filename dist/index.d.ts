interface LilypadLoggerComponentOptions<T extends string> {
    logger: ReturnType<typeof createLogger<T>>;
    name?: string;
}
/**
 * Abstract base class for logging components in the Lilypad library.
 *
 * Provides a template for implementing custom loggers with standardized message formatting.
 * Subclasses must implement the {@link send} method to define how formatted messages are output.
 *
 * @template T - A string literal type representing the log message types (e.g., 'INFO', 'ERROR', 'WARN')
 *
 * @example
 * ```typescript
 * class ConsoleLogger extends LilypadLoggerComponent<'INFO' | 'ERROR' | 'WARN'> {
 *   protected async send(message: string): Promise<void> {
 *     console.log(message);
 *   }
 * }
 * ```
 */
declare abstract class LilypadLoggerComponent<T extends string> {
    private getTimestamp;
    private formatMessage;
    output(type: T, message: string, options?: LilypadLoggerComponentOptions<T>): Promise<void>;
    protected abstract send(message: string): Promise<void>;
}

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => void} [errorLogging] - Optional callback function to handle logging errors.
 */
interface LilypadLoggerConstructorOptions<T extends string> {
    components: Record<T, LilypadLoggerComponent<T>[]>;
    name?: string;
    errorLogging?: (error: unknown) => Promise<void>;
}
type ChannelMethodFunction = (...message: unknown[]) => Promise<void>;
type ChannelMethods<T extends string> = {
    [K in T]: ChannelMethodFunction;
};
/**
 * A generic logger that dynamically creates logging methods based on component types.
 *
 * @template T - A string literal union type representing the available log types/channels
 *
 * @example
 * ```typescript
 * const logger = new LilypadLogger<'info' | 'error' | 'warn'>({
 *   components: {
 *     info: [consoleComponent],
 *     error: [consoleComponent, fileComponent],
 *     warn: [consoleComponent]
 *   }
 * });
 *
 * logger.info('Information message');
 * logger.error('Error message');
 * logger.warn('Warning message');
 * ```
 *
 * @remarks
 * The logger creates dynamic methods on the instance for each log type defined in the constructor options.
 * Each method accepts a message string and routes it to all registered components of that type.
 * Errors thrown by components are caught and handled via the errorLogging callback if provided.
 */
declare class LilypadLogger<T extends string> {
    private components;
    private _name?;
    get __name(): string | undefined;
    constructor(options: LilypadLoggerConstructorOptions<T>);
    /**
     * Registers new logger components for specified types.
     * @param newComponents - A partial record mapping component types to arrays of logger components to register
     * @returns The current logger instance for method chaining
     */
    register(newComponents: Partial<Record<T, LilypadLoggerComponent<T>[]>>): this;
}
type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;
/**
 * Creates a new Lilypad logger instance with the specified options.
 *
 * @template T - The type of log channels supported by this logger. Defaults to 'log' | 'error' | 'warn'.
 * @param options - Configuration options for the logger instance.
 * @returns A new logger instance that combines LilypadLogger functionality with channel methods.
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   // logger options
 * });
 * ```
 */
declare function createLogger<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;

type LilypadCacheGetOptions<K extends string, V> = {
    /**
     * Optional TTL (time to live) in milliseconds for the cached value.
     * If not provided, the cache's default TTL will be used.
     */
    ttl?: number;
    /**
     * If true, bypasses the cache and always calls `valueFn` to get a fresh value.
     */
    skipCache?: boolean;
    /**
     * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
     * `getOrSet` will return the currently cached value (if any) instead of
     * rethrowing the error. If there is no cached value the error is rethrown.
     */
    returnOldOnError?: boolean;
    /**
     * Optional function that is called when an error occurs and `returnOldOnError` is true.
     */
    errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | undefined;
    /**
     * Optional TTL to use when caching the old value on error. Only used if `returnOldOnError` is true.
     */
    errorTtl?: number;
    /**
     * Optional additional data that can be passed to the errorFn
     */
    data?: unknown;
};
/**
 * Represents the error context passed to an error handler function when a cache get operation fails.
 *
 * @template K - The type of the cache key.
 * @template V - The type of the cache value.
 * @property {K} key - The cache key for which the error occurred.
 * @property {unknown} error - The error that was thrown during the get operation.
 * @property {LilypadCacheGetOptions<K, V>} options - The options used for the cache get operation.
 * @property {LilypadCache<K, V>} cache - The cache instance where the error occurred.
 */
type LilypadCacheGetOptionsErrorFn<K extends string, V> = {
    key: K;
    error: unknown;
    options: LilypadCacheGetOptions<K, V>;
    cache: LilypadCache<K, V>;
};
/**
 * Represents a cached value along with its expiration time.
 *
 * @template V The type of the value being cached.
 * @property value The actual value stored in the cache.
 * @property expirationTime The UNIX timestamp (in milliseconds) indicating when the cached value expires.
 */
type LilypadCacheValue<V> = {
    value: V;
    expirationTime: number;
};
/**
 * Represents the result of attempting to retrieve a value from the cache.
 *
 * - If the cache contains the value and it is valid, returns an object with `type: 'hit'` and the cached value.
 * - If the cache contains the value but it has expired, returns an object with `type: 'expired'` and the expired value.
 * - If the cache does not contain the value, returns an object with `type: 'miss'`.
 *
 * @template V The type of the cached value.
 */
type LilypadCacheValueRetrieval<V> = ({
    type: 'hit' | 'expired';
} & LilypadCacheValue<V>) | {
    type: 'miss';
};
/**
 * A generic in-memory cache with time-to-live (TTL) support, error fallback, and protection for specific keys.
 *
 * `LilypadCache` provides a flexible caching mechanism for asynchronous or synchronous data, supporting:
 * - Automatic expiration of entries based on TTL.
 * - Prevention of duplicate concurrent fetches for the same key.
 * - Optional fallback to previous values on fetch errors.
 * - Protection of specific keys from deletion or clearing.
 * - Automatic periodic cleanup of expired entries.
 *
 * @typeParam K - The type of the cache keys.
 * @typeParam V - The type of the cache values.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache<string, number>(60000);
 * cache.set('foo', 42);
 * const value = cache.get('foo'); // 42
 * ```
 *
 * @example
 * ```typescript
 * // Using getOrSet with async fetch and error fallback
 * const cache = new LilypadCache<string, string>();
 * const value = await cache.getOrSet('user:1', async () => fetchUserFromDb(1), {
 *   returnOldOnError: true,
 *   errorFn: ({ error }) => 'defaultUser'
 * });
 * ```
 *
 * @see {@link getOrSet}
 * @see {@link addProtectedKeys}
 * @see {@link purgeExpired}
 * @see {@link dispose}
 */
declare class LilypadCache<K extends string, V> {
    private store;
    private defaultTtl;
    private defaultErrorTtl;
    private defaultBulkSyncTtl;
    private cleanupIntervalId?;
    private protectedKeys;
    private logger?;
    private flowControl;
    private bulkSyncFlowControl;
    /**
     * Timestamp of the last bulk sync operation.
     * If the cache is backed by a database or external store,
     * It's possible that "every entry in the cache" is not the same as "every key in the store".
     * This timestamp can be used to track when the last bulk sync occurred, which would
     * have synced the cache with the store.
     */
    private bulkSyncExpirationTime;
    private bulkSyncFn?;
    constructor(ttl?: number, options?: {
        autoCleanupInterval?: number;
        defaultErrorTtl?: number;
        defaultBulkSyncTtl?: number;
        bulkSyncFn?: () => Promise<[K, V][]>;
        logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
        flowControlTimeout?: number;
    });
    /**
     * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
     *
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
     * @returns The expiration time as a Unix timestamp in milliseconds.
     */
    private createExpirationTime;
    /**
     * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
     *
     * @param key - The key to associate with the cached value.
     * @param value - The value to store in the cache.
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the value will not expire.
     */
    set(key: K, value: V, ttl?: number): void;
    /**
     * Retrieves a value from the cache associated with the specified key.
     * If the cached value has expired or does not exist, it returns `undefined`.
     * If the value is expired, it is also removed from the cache, as a side effect.
     *
     * @param key - The key associated with the cached value.
     * @returns The cached value if it exists and is not expired; otherwise, `undefined`.
     */
    get(key: K, removeOld?: boolean): V | undefined;
    /**
     * Retrieves a comprehensive cache value for the specified key, indicating whether the value is a cache hit, expired, or a miss.
     *
     * @param key - The key to retrieve from the cache.
     * @returns An object representing the cache retrieval result:
     * - If the value exists and is not stale, returns the cache value with `type: 'hit'`.
     * - If the value exists but is stale, returns the cache value with `type: 'expired'`.
     * - If the value does not exist, returns an object with `type: 'miss'`.
     */
    getComprehensive(key: K): LilypadCacheValueRetrieval<V>;
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
    private errorReturn;
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
    getOrSet(key: K, valueFn: () => Promise<V>, options?: LilypadCacheGetOptions<K, V>): Promise<V>;
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
    bulkSync(syncFn?: () => Promise<[K, V][]>): Promise<void>;
    private _bulkSync;
    /**
     * Retrieves multiple values from the cache for the specified keys.
     * If no keys are provided, retrieves all values currently stored in the cache.
     *
     * @param options - An object containing an optional array of keys to retrieve.
     * @returns A `Map` containing the key-value pairs found in the cache.
     */
    bulkGet(options: {
        keys?: K[];
    }): Map<K, V>;
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
    bulkAsyncGet(options: {
        keys?: K[];
        doSync?: boolean;
        syncFn?: () => Promise<[K, V][]>;
    }): Promise<Map<K, V>>;
    /**
     * Sets multiple key-value pairs in the cache at once.
     *
     * Accepts either a `Map<K, V>` or an array of `[K, V]` tuples.
     * Each entry is added to the cache using the `set` method.
     *
     * @param entries - The entries to set, as a `Map` or an array of key-value tuples.
     */
    bulkSet(entries: Map<K, V> | [K, V][]): void;
    /**
     * Adds the specified keys to the set of protected keys.
     * Protected keys are typically excluded from certain cache operations
     * such as eviction or deletion to ensure their persistence.
     *
     * @param keys - An array of keys to mark as protected.
     * @returns The current instance for method chaining.
     */
    addProtectedKeys(keys: K[]): this;
    /**
     * Removes the specified keys from the set of protected keys.
     *
     * @param keys - An array of keys to be removed from the protected keys set.
     * @returns The current instance for method chaining.
     */
    removeProtectedKeys(keys: K[]): this;
    /**
     * Invalidates the cache entry for the specified key.
     *
     * If the cache contains a valid entry for the given key, this method marks it as expired
     * by setting its value with a negative expiration time.
     *
     * @param key - The key of the cache entry to invalidate.
     */
    invalidate(key: K): void;
    /**
     * Deletes the specified key from the cache.
     *
     * If the key is present in the set of protected keys, the deletion is skipped.
     *
     * @param key - The key to be deleted from the cache.
     * @param options - Optional settings for deletion.
     * @param options.force - If true, forces deletion even if the key is protected.
     */
    delete(key: K, options?: {
        force?: boolean;
    }): void;
    /**
     * Removes all entries from the cache.
     *
     * Iterates over all keys in the cache store and deletes each entry.
     * The deletion behavior can be customized using the `options` parameter.
     *
     * @param options - Optional settings for the clear operation.
     * @param options.force - If `true`, forces deletion of entries regardless of other conditions.
     */
    clear(options?: {
        force?: boolean;
    }): void;
    /**
     * Removes all expired entries from the cache.
     *
     * Iterates through the cache store and deletes any entries whose expiration time has passed.
     * Optionally, the deletion can be forced by providing the `force` option.
     *
     * @param options - Optional settings for the purge operation.
     * @param options.force - If true, forces deletion of expired entries regardless of other conditions.
     */
    purgeExpired(options?: {
        force?: boolean;
    }): void;
    /**
     * Stops the periodic cleanup interval if it is currently running.
     * Clears the interval using its ID and resets the interval ID to `undefined`.
     * This method is typically used to halt automatic cache cleanup operations.
     */
    private stopCleanupInterval;
    /**
     * Disposes of the cache by stopping the cleanup interval and clearing all cached items.
     * This method should be called when the cache is no longer needed to free up resources.
     */
    dispose(): void;
}

/**
 * A file-based logger component that extends LilypadLoggerComponent.
 *
 * This logger writes log messages to a specified file on disk. Each message is appended
 * on a new line in UTF-8 encoding.
 *
 * The directory for the log file must exist prior to logging; this class does not create directories.
 *
 * @template T - A string type that represents the log level or category.
 */
declare class LilypadFileLogger<T extends string> extends LilypadLoggerComponent<T> {
    private filePath;
    constructor(filePath: string);
    protected send(message: string): Promise<void>;
}

/**
 * A logger component that outputs messages to the console.
 *
 * @template T - A string literal type representing the logger's category or name.
 *
 * @example
 * ```typescript
 * const logger = new LilypadConsoleLogger<'app'>();
 * ```
 *
 * @remarks
 * This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
 * Messages are sent to the standard output using `console.log()`.
 */
declare class LilypadConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
    protected send(message: string): Promise<void>;
}

/**
 * A Discord webhook logger component that sends log messages to a Discord channel.
 *
 * @template T - A string type representing the log level or category.
 * @extends {LilypadLoggerComponent<T>}
 *
 * @example
 * ```typescript
 * const logger = new LilypadDiscordLogger<'info' | 'error' | 'warn'>('https://discordapp.com/api/webhooks/...');
 * await logger.send('An important log message');
 * ```
 *
 * @remarks
 * This class uses Discord's webhook API to send messages. Ensure the webhook URL is kept secure
 * and not exposed in version control or client-side code.
 */
declare class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
    private webhookUrl;
    constructor(webhookUrl: string);
    protected send(message: string): Promise<void>;
}

interface FlowControlOptions {
    rate?: number;
    timeout?: number;
    retries?: number;
    logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
}
interface ExecuteFnOptions<T> {
    errorFn?: (error: unknown) => T | void;
    functionIdentifier: string;
    consumerIdentifier: string;
    fn: () => Promise<T>;
    backOffTime?: (attempt: number) => number;
}
/**
 * A flow control utility class that manages execution of asynchronous operations with support for
 * rate limiting, retries, timeouts, and single-flight request deduplication.
 *
 * @template T - The type of value resolved by the executed operations.
 *
 * @example
 * ```typescript
 * const flowControl = new LilypadFlowControl<string>({
 *   rate: 1000,
 *   timeout: 5000,
 *   retries: 3,
 *   logger: myLogger
 * });
 *
 * const result = await flowControl.executeFn({
 *   functionIdentifier: 'myFunction',
 *   consumerIdentifier: 'user123',
 *   fn: () => fetchData(),
 *   backOffTime: (attempt) => Math.pow(2, attempt) * 100
 * });
 * ```
 *
 * @remarks
 * - **Rate Limiting**: Enforces a minimum interval between executions per consumer/function pair
 * - **Single-Flight**: Deduplicates concurrent requests for the same function identifier
 * - **Retries**: Automatically retries failed operations with configurable backoff strategies
 * - **Timeout**: Fails operations that exceed the specified timeout duration
 *
 * @property rate - Minimum milliseconds between executions for rate limiting
 * @property timeout - Maximum milliseconds to wait for operation completion
 * @property retries - Maximum number of retry attempts for failed operations
 * @property logger - Optional logger instance for error, warning, info, and debug messages
 */
declare class LilypadFlowControl<T> {
    private rate?;
    private timeout?;
    private retries?;
    private logger?;
    private singleFlightMap;
    private rateMap;
    constructor(options?: FlowControlOptions);
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
    executeWithTimeout(executionFn: () => Promise<T>): Promise<T>;
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
    executeWithRetries(executionFn: () => Promise<T>, errorFn?: (error: unknown) => T | void, backOffTime?: (attempt: number) => number): Promise<T>;
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
    rateLimit(consumerIdentifier: string, functionIdentifier: string): Promise<void>;
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
    executeFn(options: ExecuteFnOptions<T>): Promise<T>;
}

export { type ExecuteFnOptions, type FlowControlOptions, LilypadCache, type LilypadCacheGetOptions, LilypadConsoleLogger, LilypadDiscordLogger, LilypadFileLogger, LilypadFlowControl, type LilypadLoggerConstructorOptions, createLogger };
