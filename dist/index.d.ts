import postgres from 'postgres';

declare global {
    var __lilypadSingletonMap: Map<string, unknown> | undefined;
    var __lilypadSingletonSignatureMap: Map<string, string> | undefined;
}
type LilypadSingletonAble = {
    singleton: true;
    singletonIdentifier: string;
} | {
    singleton?: false;
};
/**
 * Describes the options a singleton was created with. When a later call asks for the same
 * singleton with a different `value`, `onMismatch` is called: the existing instance is returned
 * anyway, so the options of that call are ignored.
 */
type LilypadSingletonSignature = {
    value: string;
    onMismatch: () => void;
};
declare function getLilypadSingletonInstance<T>(identifier: string, createInstanceFn: () => T, signature?: LilypadSingletonSignature): T;
/**
 * Removes a singleton instance from the registry, so that the next `create` call with the same
 * identifier builds a fresh instance. Meant to be called when the instance is closed/disposed.
 *
 * @returns `true` if an instance was registered under the identifier.
 */
declare function removeLilypadSingletonInstance(identifier: string): boolean;
declare function getLilypadSingletonInstanceAsync<T>(identifier: string, createInstanceFn: () => Promise<T>, signature?: LilypadSingletonSignature): Promise<T>;

interface LilypadLoggerComponentOptions<T extends string> {
    logger: ReturnType<typeof LilypadLogger.create<T>>;
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
    /**
     * Sends an already formatted message to the specific output channel.
     *
     * @param message - The formatted message.
     * @param type - The log type of the message, for outputs that route messages by severity.
     */
    protected abstract send(message: string, type: T): Promise<void>;
}

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 */
type LilypadLoggerConstructorOptions<T extends string> = {
    components: Record<T, LilypadLoggerComponent<T>[]>;
    name?: string;
    errorLogging?: (error: unknown) => Promise<void>;
} & LilypadSingletonAble;
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
 * const logger = LilypadLogger.create<'info' | 'error' | 'warn'>({
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
     * const logger = LilypadLogger.create<'info' | 'error'>({
     *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
     * });
     *
     * @example
     * // Create or retrieve a singleton logger (later calls ignore their options)
     * const singletonLogger = LilypadLogger.create<'info' | 'error'>({
     *   singleton: true,
     *   singletonIdentifier: 'app-logger',
     *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
     * });
     */
    static create<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;
    private constructor();
    /**
     * Registers new logger components for specified types.
     * @param newComponents - A partial record mapping component types to arrays of logger components to register
     * @returns The current logger instance for method chaining
     */
    register(newComponents: Partial<Record<T, LilypadLoggerComponent<T>[]>>): this;
}
type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;
/** The logger accepted by the other Lilypad modules. */
type LilypadLibLogger = LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
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
 * @deprecated Use {@link LilypadLogger.create} instead.
 */
declare function createLogger<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;

interface FlowControlOptions {
    rate?: number;
    /**
     * Maximum duration of each attempt, in milliseconds. With retries, the total duration can be up to
     * `(retries + 1) * timeout` plus the backoff times.
     */
    timeout?: number;
    retries?: number;
    logger?: LilypadLibLogger;
}
interface ExecuteFnOptions<T> {
    /**
     * Called once the execution has definitively failed (after all retries).
     * Its return value becomes the result of the execution; to propagate the error, throw from it.
     */
    errorFn?: (error: unknown) => T;
    functionIdentifier: string;
    consumerIdentifier: string;
    /**
     * The operation to execute. The received signal is aborted when the operation times out,
     * so the function can stop its work and avoid side effects after the timeout.
     */
    fn: (signal: AbortSignal) => Promise<T>;
    retries?: number;
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
 *   fn: (signal) => fetchData({ signal }),
 *   backOffTime: (attempt) => Math.pow(2, attempt) * 100
 * });
 * ```
 *
 * @remarks
 * - **Rate Limiting**: Enforces a minimum interval between executions per consumer/function pair
 * - **Single-Flight**: Deduplicates concurrent requests for the same function identifier. Callers that
 *   join an in-flight execution share its result, including the outcome of the first caller's `errorFn`.
 * - **Retries**: Automatically retries failed operations with configurable backoff strategies
 * - **Timeout**: Fails an attempt that exceeds the specified timeout duration and aborts its signal.
 *   The timeout applies to each attempt, not to the whole execution.
 *
 * @property rate - Minimum milliseconds between executions for rate limiting
 * @property timeout - Maximum milliseconds to wait for each attempt
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
    executeWithTimeout(executionFn: (signal: AbortSignal) => Promise<T>): Promise<T>;
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
    executeWithRetries(options: {
        executionFn: () => Promise<T>;
        retries?: number;
        errorFn?: (error: unknown) => T;
        backOffTime?: (attempt: number) => number;
    }): Promise<T>;
    /**
     * Enforces a rate limit for a specific consumer and function combination.
     *
     * If a rate limit is set, this method checks whether the specified consumer
     * has invoked the given function within the allowed time interval. If the
     * rate limit is exceeded, an error is thrown. Otherwise, the invocation time
     * is recorded.
     *
     * It must stay synchronous: `executeFn` relies on no await happening between the single-flight
     * lookup and the registration of the new execution.
     *
     * @param consumerIdentifier - A unique identifier for the consumer (e.g., user or service).
     * @param functionIdentifier - A unique identifier for the function being rate-limited.
     * @throws {Error} If the rate limit is exceeded for the given consumer and function.
     */
    rateLimit(consumerIdentifier: string, functionIdentifier: string): void;
    /**
     * Removes the rate limit entries whose interval has already elapsed, as they no longer limit anything.
     */
    private pruneRateMap;
    /**
     * @returns `true` if an execution for the function identifier is currently in flight.
     */
    isInFlight(functionIdentifier: string): boolean;
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
    executeFn(options: ExecuteFnOptions<T>): Promise<T>;
}

/**
 * The keys accepted by the cache. Keys are compared by their string form, so `42` and `'42'`
 * address the same entry.
 */
type LilypadCacheKey = string | number;
type LilypadCacheGetOptions<K extends LilypadCacheKey, V> = {
    /**
     * Optional TTL (time to live) in milliseconds for the cached value.
     * If not provided, the cache's default TTL will be used.
     * Concurrent calls share one fetch: the value is cached with the TTL of the call that started it.
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
     * Optional function called when fetching the value fails, whether or not `returnOldOnError` is set.
     * A value other than `undefined` is returned and cached (with `errorTtl`); `undefined` falls back
     * to `returnOldOnError`, then to rethrowing the error.
     */
    errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | null | undefined;
    /**
     * Optional TTL of the fallback value cached on error (from `errorFn` or `returnOldOnError`).
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
 */
type LilypadCacheGetOptionsErrorFn<K extends LilypadCacheKey, V> = {
    key: K;
    error: unknown;
    options: LilypadCacheGetOptions<K, V>;
};
type LilypadCachedValueType<V> = V | null;
/**
 * Represents a cached value along with its expiration time.
 *
 * @template K The type of the cache key.
 * @template V The type of the value being cached.
 * @property key The key as passed by the caller: the store is keyed by its string form.
 * @property value The actual value stored in the cache. Will be NULL if the associated value does not exist at all, instead of simply not being cached yet.
 * @property expirationTime The UNIX timestamp (in milliseconds) indicating when the cached value expires.
 * @property ticket Orders the writes: see {@link LilypadCache.setIfNewer}.
 */
type LilypadCacheEntry<K, V> = {
    key: K;
    value: LilypadCachedValueType<V>;
    expirationTime: number;
    ticket: number;
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
type LilypadCacheValueRetrieval<V> = {
    type: 'hit' | 'expired';
    value: LilypadCachedValueType<V>;
    expirationTime: number;
} | {
    type: 'miss';
};
type LilypadCacheSyncFn<K, V> = (signal: AbortSignal) => Promise<[K, LilypadCachedValueType<V>][]>;
type LilypadCacheConstructorOptions<K extends LilypadCacheKey, V> = {
    autoCleanupInterval?: number;
    /** Defaults to the smaller of `ttl` and 5 minutes. */
    defaultErrorTtl?: number;
    defaultBulkSyncTtl?: number;
    bulkSyncFn?: LilypadCacheSyncFn<K, V>;
    logger?: LilypadLibLogger;
    /** Timeout of the fetches of `getOrSet`, in milliseconds. Defaults to 5 seconds. */
    flowControlTimeout?: number;
    /** Timeout of `bulkSync`, in milliseconds. Defaults to 30 seconds. */
    bulkSyncTimeout?: number;
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
 * - Optional bulk synchronization with an external data source.
 * - Integration with a database gateway for persistent and updated storage when an invalidation occurs.
 *
 * When a value is returned, as a general rule of thumb:
 * - `undefined` means "not in cache"
 * - `null` means "in cache, value is null" (as in, the value is known to not exist at all)
 * - any other value means "in cache, value is X"
 *
 * Asynchronous writes (`getOrSet`, `bulkSync`, and the refreshes of subclasses) are ordered by the
 * time they started: a result that arrives after a write started later is discarded, so a slow,
 * older read can never overwrite a newer value.
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
declare class LilypadCache<K extends LilypadCacheKey, V> {
    readonly id: string;
    protected store: Map<string, LilypadCacheEntry<K, V>>;
    protected defaultTtl: number;
    protected defaultErrorTtl: number;
    protected defaultBulkSyncTtl: number;
    protected cleanupIntervalId?: ReturnType<typeof setInterval> & {
        unref?: () => void;
    };
    protected protectedKeys: Set<string>;
    protected logger?: LilypadLibLogger;
    protected flowControl: LilypadFlowControl<LilypadCachedValueType<V>>;
    protected bulkSyncFlowControl: LilypadFlowControl<boolean>;
    /**
     * Timestamp of the last bulk sync operation.
     * If the cache is backed by a database or external store,
     * It's possible that "every entry in the cache" is not the same as "every key in the store".
     * This timestamp can be used to track when the last bulk sync occurred, which would
     * have synced the cache with the store.
     */
    protected bulkSyncExpirationTime: number;
    protected bulkSyncFn?: LilypadCacheSyncFn<K, V>;
    /** Source of the write tickets: see {@link setIfNewer}. */
    private lastTicket;
    /**
     * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
     * already holds data newer than theirs.
     */
    private ticketFloor;
    /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
    private bulkSyncInvalidationTicket;
    private disposed;
    constructor(ttl?: number, options?: LilypadCacheConstructorOptions<K, V>);
    /**
     * Calculates the expiration timestamp based on the provided TTL (time-to-live) value.
     *
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the default TTL is used.
     * @returns The expiration time as a Unix timestamp in milliseconds.
     */
    private createExpirationTime;
    /**
     * Normalizes a key to the string form used by the store and by the protected keys.
     */
    protected normalizeKey(key: K): string;
    /**
     * Takes a write ticket. An asynchronous write takes it when it starts, and passes it to
     * {@link setIfNewer} when its value is ready.
     */
    protected nextTicket(): number;
    private write;
    /**
     * Stores a value in the cache associated with the specified key, optionally setting a time-to-live (TTL) for expiration.
     *
     * @param key - The key to associate with the cached value.
     * @param value - The value to store in the cache.
     * @param ttl - Optional. The time-to-live in milliseconds. If not provided, the cache's default TTL is used.
     */
    set(key: K, value: LilypadCachedValueType<V>, ttl?: number): void;
    /**
     * Stores the result of an asynchronous read, unless a write that started later has already
     * stored a value for the key.
     *
     * @param ticket - The ticket taken with {@link nextTicket} when the read started.
     * @returns `true` if the value was stored.
     */
    protected setIfNewer(key: K, value: LilypadCachedValueType<V>, ttl: number | undefined, ticket: number): boolean;
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
    get(key: K, removeOld?: boolean): LilypadCachedValueType<V> | undefined;
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
     * It runs for each caller, so every caller gets the fallback its own options ask for.
     *
     * The method follows this order:
     * 1. If `options.errorFn` is provided and returns a value, that value is used and cached.
     * 2. If `options.returnOldOnError` is true and a previous value exists, the old value is used.
     * 3. If no fallback value is determined, the original error is rethrown.
     *
     * The chosen value (from errorFn or old value) is cached with a TTL specified by `options.errorTtl` or the default error TTL.
     *
     * @param error - The error encountered during cache retrieval.
     * @param options - The cache get options, including error handling strategies.
     * @param key - The cache key associated with the retrieval.
     * @returns The determined fallback value to return.
     * @throws Rethrows the original error if no fallback value is determined.
     */
    private errorReturn;
    private getOrSetFlightId;
    /**
     * @returns `true` if a `getOrSet` fetch for the key is in flight.
     */
    protected isFetchInFlight(key: K): boolean;
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
     */
    getOrSet(key: K, valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V>>;
    /**
     * Synchronizes the cache in bulk by executing the provided sync function.
     *
     * This method uses flow control to manage the execution of the bulk sync operation.
     * If a `syncFn` is provided, it will be used to fetch key-value pairs to synchronize.
     * Errors are logged; unless `throwOnError` is set they are not rethrown: the cache keeps its
     * current content, and the next call retries the sync.
     *
     * @param syncFn - An optional asynchronous function that returns an array of key-value pairs to be synchronized.
     * It receives a signal that is aborted when the sync times out.
     * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
     * @returns A promise that resolves to `true` if the cache is synced (now or by a recent sync),
     * `false` if the sync failed or returned no data.
     */
    bulkSync(syncFn?: LilypadCacheSyncFn<K, V>, options?: {
        throwOnError?: boolean;
    }): Promise<boolean>;
    private _bulkSync;
    /**
     * Forces the next `bulkSync` call to fetch fresh data, even if a sync is currently running.
     */
    protected invalidateBulkSync(): void;
    /**
     * Retrieves multiple values from the cache for the specified keys.
     * If no keys are provided, retrieves all values currently stored in the cache.
     * If some keys are not found in the cache or they have expired, they are simply omitted from the result.
     *
     * @param options - An object containing an optional array of keys to retrieve.
     * @returns A `Map` containing the key-value pairs found in the cache. Without `keys`, each entry
     * is keyed by the key it was stored with (e.g. a number stays a number).
     */
    bulkGet(options: {
        keys?: K[];
    }): Map<K, LilypadCachedValueType<V>>;
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
    bulkAsyncGet({ keys, doSync, syncFn, }?: {
        keys?: K[];
        doSync?: boolean;
        syncFn?: LilypadCacheSyncFn<K, V>;
    }): Promise<Map<K, LilypadCachedValueType<V>>>;
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
     * @param options - Optional settings for invalidation.
     * @param options.invalidateBulkSync - If true (default), forces a bulk sync on the next bulkSync call.
     */
    invalidate(key: K, { invalidateBulkSync }?: {
        invalidateBulkSync?: boolean;
    }): void;
    /**
     * Marks a valid cache entry as expired, keeping its value as a fallback for `returnOldOnError`.
     * Unlike `invalidate`, it is never overridden by subclasses, so it is always synchronous.
     *
     * @param key - The key of the cache entry to expire.
     */
    protected expire(key: K): void;
    private expireNormalized;
    /**
     * Deletes the specified key from the cache.
     *
     * If the key is present in the set of protected keys, the deletion is skipped.
     *
     * @param key - The key to be deleted from the cache.
     * @param options - Optional settings for deletion.
     * @param options.force - If true, forces deletion even if the key is protected.
     * @param options.setNull - If true, sets the value to null instead of deleting the entry.
     * @returns `false` if the key is protected and was left untouched.
     */
    delete(key: K, options?: {
        force?: boolean;
        setNull?: boolean;
    }): boolean;
    private deleteNormalized;
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
    clear(options?: Parameters<typeof this.delete>[1]): void;
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
     * A disposed cache ignores every later write, including the ones of fetches still in flight.
     */
    dispose(): void;
}

type ListenerCallback = (payload: unknown) => void | Promise<void>;
type ListenerCallbackIdentifier = {
    channel: string;
    callbackId: string;
    callback: ListenerCallback;
    /**
     * Called when LISTEN is active again after the listener connection was lost and re-established.
     * Notifications sent while the connection was down are lost: use it to resynchronize.
     */
    onReconnect?: () => void | Promise<void>;
};
type LilypadDbGateOptions = {
    logger?: LilypadLibLogger;
    connectionString: string;
    listenerConnectionString?: string;
    listen?: ListenerCallbackIdentifier[];
    /**
     * Maximum duration of each query of the main client, in milliseconds (Postgres
     * `statement_timeout`): the server cancels longer queries, so that slow queries whose callers
     * have already timed out do not pile up.
     */
    statementTimeout?: number;
};
type LilypadDbGateOptionsWithSingleton = LilypadDbGateOptions & LilypadSingletonAble;
type LilypadDbColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array';
/**
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `LilypadDbSchema<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
    tableName: string;
    primaryKey: PK;
    primaryKeyShouldAutoDetermine?: boolean;
    /**
     * Transforms the data of inserts and updates. Its result replaces the data: omitting a property
     * removes it from the write.
     */
    insertSanitizationFn?: (data: Partial<T>) => Partial<T>;
    selectSanitizationFn?: (row: unknown) => T | null;
    /**
     * The columns of the table.
     * - Without a `selectSanitizationFn`, only these columns are selected.
     * - Only these columns are written by inserts and updates: any other property of the data is ignored.
     *
     * The column metadata (`type`, `nullable`, `default`) is descriptive and is not used by the gate.
     */
    cols: {
        [K in keyof T]: {
            type: LilypadDbColumnType;
        } & ({
            nullable?: false;
        } | {
            nullable: true;
            default: T[K] | null;
        });
    };
};
/** The data of an insert: the primary key can be omitted when the database generates it. */
type LilypadDbInsertData<T, PK extends keyof T = keyof T> = Omit<T, PK> & Partial<Pick<T, PK>>;
/** The data of an update: the primary key identifies the row, the other columns are optional. */
type LilypadDbUpdateData<T, PK extends keyof T = keyof T> = Partial<T> & Pick<T, PK>;
/**
 * Provides a gateway for interacting with a PostgreSQL database, including CRUD operations and channel-based listeners.
 *
 * The `LilypadDbGate` class manages a database connection and allows for:
 * - Fetching all rows from a table with type safety.
 * - Inserting, updating, and deleting rows in a table.
 * - Listening to PostgreSQL channels for notifications and handling them with callbacks.
 * - Managing multiple listeners and cleaning up resources.
 *
 * @example
 * ```typescript
 * const dbGate = await LilypadDbGate.create({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   listen: [
 *     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 *
 * @public
 */
declare class LilypadDbGate {
    readonly id: string;
    private listenerConnectionString;
    sql: postgres.Sql;
    private listenerConnection;
    protected logger?: LilypadLibLogger;
    private listeners;
    private singletonIdentifier?;
    private constructor();
    /**
     * Creates a gate and registers the listeners of `options.listen`.
     * With `singleton: true`, a later call with the same identifier returns the existing gate and
     * ignores its own options (a warning is logged if they differ).
     */
    static create(options: LilypadDbGateOptionsWithSingleton): Promise<LilypadDbGate>;
    private static initializeNew;
    /**
     * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
     * otherwise by copying the schema columns.
     */
    private mapRow;
    /**
     * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
     * columns that are not in the schema; otherwise only the schema columns are needed.
     */
    private selectedColumns;
    /**
     * Prepares the data of an insert/update:
     * - applies the schema's `insertSanitizationFn`, whose result replaces the data;
     * - validates the primary key, which an update always needs to find the row;
     * - restricts the written columns to the schema columns, so that extra properties of `data`
     *   (e.g. coming from a request body) are never written to the table;
     * - skips `undefined` values, which postgres.js rejects.
     */
    private prepareWrite;
    /**
     * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
     * of the whole table is never held in memory at once.
     */
    selectAllFromTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>): Promise<T[]>;
    selectFromTableByPrimaryKey<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<T | null>;
    /**
     * Inserts a row.
     *
     * @returns The row as stored by the database, including generated columns such as an
     * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
     */
    insertToTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbInsertData<T, PK>): Promise<T | null>;
    /**
     * Updates the row identified by the primary key contained in `data`. Only the columns present
     * in `data` are written.
     *
     * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
     * @throws If no row with that primary key exists.
     */
    updateToTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbUpdateData<T, PK>): Promise<T | null>;
    deleteFromTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<void>;
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
    private getListenerConnection;
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
    private initializeListener;
    /**
     * Runs a listener callback, catching both synchronous throws and rejected promises,
     * so a failing callback can neither affect the others nor cause an unhandled rejection.
     */
    private runCallbackSafely;
    /**
     * Executes all registered listener callbacks for a given channel, passing the provided payload to each callback.
     *
     * @param channel - The name of the channel whose listener callbacks should be executed.
     * @param payload - The data to pass to each listener callback.
     */
    private executeAllListenerCallbacks;
    private executeReconnectCallbacks;
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
     *   @param params.onReconnect - Optional function called when LISTEN is re-established after a reconnection.
     *
     * @returns A promise that resolves once LISTEN is active on the channel.
     * @throws If LISTEN fails; in that case the callback is not registered.
     */
    addListener(identifier: ListenerCallbackIdentifier): Promise<void>;
    /**
     * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
     *
     * @returns `true` if the callback was registered.
     */
    removeListener(channel: string, callbackId: string): Promise<boolean>;
    close(): Promise<void>;
}

type LilypadDbCacheDefaultNotificationPayload = {
    table?: string;
    /** A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`). */
    id?: string | number;
    op: 'UPDATE' | 'DELETE' | 'INSERT';
};
type LilypadDbCacheDefaultListenerOptions = {
    /**
     * If true, the cache entry is updated from the database (or set to null, for a DELETE)
     * before `callback` is called.
     *
     * Without a `callback` the entry is always updated. With a `callback` this defaults to false:
     * keeping the cache up to date is then the callback's responsibility.
     */
    automaticallyInvalidateDataBeforeCallback?: boolean;
    callback?: (payload: LilypadDbCacheDefaultNotificationPayload) => Promise<void> | void;
};
type LilypadDbCacheConstructorOptions<K extends LilypadCacheKey, V, PK extends keyof V> = ConstructorParameters<typeof LilypadCache<K, V>>[1] & {
    dbGate: {
        gate: LilypadDbGate;
        schema: LilypadDbSchema<V, PK>;
    };
} & ({
    useDefaultDbListener?: false;
} | {
    useDefaultDbListener: true;
    defaultListenerOptions: LilypadDbCacheDefaultListenerOptions;
});
/**
 * A cache class that synchronizes with a database table using a provided database gateway and schema.
 *
 * `LilypadDbCache` extends `LilypadCache` to provide automatic cache population and invalidation
 * by fetching data from a database. It supports bulk synchronization and per-key updates from the database.
 *
 * @typeParam K - The type of the cache key: the type of the primary key column.
 * @typeParam V - The type of the cached value, constrained to object.
 * @typeParam PK - The primary key column of `V` (see {@link LilypadDbSchema}).
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create<number, User, 'id'>(60_000, {
 *   dbGate: { gate, schema: usersSchema },
 *   logger,
 * });
 * const user = await users.getOrFetch(42); // User | null (no such row) | undefined (query failed)
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `update` and
 *   `invalidate` always re-fetch the key; `getAll` loads the whole table (at most once per bulk sync TTL).
 * - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the result.
 * - The `bulkAsyncGet` method fetches all items from the database and updates the cache.
 * - Unless disabled, the cache listens on the `cache_events` channel for JSON payloads shaped as
 *   {@link LilypadDbCacheDefaultNotificationPayload}. The database trigger sending them is not part of this library.
 *   Only keys the cache holds (or is fetching) are re-fetched; other changes just force the next bulk sync.
 */
declare class LilypadDbCache<K extends LilypadCacheKey & V[PK], V extends object, PK extends keyof V = keyof V> extends LilypadCache<K, V> {
    private readonly dbGate;
    private readonly defaultDbListener?;
    private singletonIdentifier?;
    /**
     * Creates a cache and, unless disabled, registers its default database listener.
     * With `singleton: true`, a later call with the same identifier returns the existing cache and
     * ignores its own options (a warning is logged if the table or the TTL differ).
     *
     * @throws If the default database listener cannot be registered (e.g. the database is unreachable).
     */
    static create<K extends LilypadCacheKey & V[PK], V extends object, PK extends keyof V = keyof V>(ttl: number | undefined, options: LilypadDbCacheConstructorOptions<K, V, PK> & LilypadSingletonAble): Promise<LilypadDbCache<K, V, PK>>;
    private static initializeNew;
    private constructor();
    /**
     * Retrieves a cached value by key, or fetches it from the database if not found in cache.
     * Concurrent calls for the same key share a single database query.
     *
     * @param key - The cache key to retrieve or fetch.
     * @returns A promise that resolves to the cached value (`null` if the row does not exist),
     * or undefined if an error occurs during fetching.
     * @throws Does not throw; errors are logged internally.
     */
    getOrFetch(key: K): Promise<LilypadCachedValueType<V> | undefined>;
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
    invalidate(key: K, options?: {
        invalidateBulkSync?: boolean;
    }): Promise<void>;
    /**
     * Updates the cache entry for the specified key by fetching the latest value from the database.
     * A row that does not exist is cached as `null`.
     * If a write that started later completes first, the fetched value is returned but not cached.
     *
     * @param key - The primary key of the cache entry to update.
     * @returns A promise that resolves to the updated value from the database.
     * @throws Rethrows any error encountered during the database fetch.
     */
    update(key: K): Promise<LilypadCachedValueType<V>>;
    /**
     * Returns every row of the table, loading it if the bulk sync has expired.
     *
     * @throws If the table cannot be loaded.
     */
    getAll(keys?: K[]): Promise<V[]>;
    /**
     * The key of the cached entry for a notified id, so that the entry keeps its original key type
     * (a notification may carry a numeric key as a string, or the other way around).
     */
    private resolveNotifiedKey;
    /**
     * Caches the key as "does not exist". Unlike `delete(key, { setNull: true })`, it also applies
     * to protected keys: they are protected from removal, not from reflecting a deleted row.
     */
    private markDeleted;
    protected getDefaultDbListener(options?: LilypadDbCacheDefaultListenerOptions): ListenerCallbackIdentifier;
    private applyNotification;
    /**
     * Marks every entry as expired (keeping the values as fallback) and forces the next bulk sync.
     */
    private expireAll;
    /**
     * Disposes of the cache: stops its default database listener, removes it from the singleton
     * registry (if it was created as a singleton) and clears it.
     */
    dispose(): Promise<void>;
    private getItemPrimaryKeyValue;
    /**
     * Inserts the item in the database and caches the row returned by the database.
     * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
     * holds the one generated by the database.
     *
     * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
     */
    sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null>;
    /**
     * Updates the item in the database and caches the row returned by the database.
     * Only the columns present in `item` are written.
     *
     * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
     * @throws If no row with the item's primary key exists.
     */
    sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null>;
    sqlDelete(key: K): Promise<void>;
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
 * Messages of type `error` are sent to `console.error`, messages of type `warn` to `console.warn`
 * (case-insensitive), and every other message to `console.log`.
 */
declare class LilypadConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
    protected send(message: string, type: T): Promise<void>;
}

type LilypadDiscordLoggerOptions = {
    /**
     * Minimum time between two requests to the webhook, in milliseconds. Messages logged in between
     * are sent together in the next request. Defaults to 1000.
     */
    minRequestInterval?: number;
    /** How many times a request rate limited by Discord (429) is retried. Defaults to 1. */
    rateLimitRetries?: number;
};
/**
 * A Discord webhook logger component that sends log messages to a Discord channel.
 *
 * @template T - A string type representing the log level or category.
 * @extends {LilypadLoggerComponent<T>}
 *
 * @example
 * ```typescript
 * const discordLogger = new LilypadDiscordLogger<'info' | 'error' | 'warn'>('https://discordapp.com/api/webhooks/...');
 * const logger = LilypadLogger.create({ components: { error: [discordLogger] } });
 * await logger.error('An important log message');
 * ```
 *
 * @remarks
 * This class uses Discord's webhook API to send messages. Ensure the webhook URL is kept secure
 * and not exposed in version control or client-side code.
 * - Log messages are sent to a third-party service: anything they contain (including data logged
 *   together with errors) becomes visible to the members of the Discord channel.
 * - Mentions are disabled, so a message containing `@everyone` or a user/role mention notifies no one.
 * - Messages longer than 2000 characters are truncated.
 * - Requests are throttled (see {@link LilypadDiscordLoggerOptions}): messages logged while a request
 *   is pending or too recent are batched into one Discord message, up to 2000 characters.
 * - A rate limited request (429) is retried after the `retry-after` time given by Discord.
 * - A failed request makes `output` reject for every message of the batch, so the logger reports
 *   it through its `errorLogging` callback.
 */
declare class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
    private webhookUrl;
    private minRequestInterval;
    private rateLimitRetries;
    private queue;
    private flushing;
    private nextRequestAt;
    constructor(webhookUrl: string, options?: LilypadDiscordLoggerOptions);
    protected send(message: string): Promise<void>;
    /**
     * Sends the queued messages, one batch at a time. It never rejects: the outcome of each batch
     * settles the promises of its messages.
     */
    private flush;
    /** Takes the queued messages that fit in one Discord message, always at least one. */
    private takeBatch;
    private sendBatch;
    private post;
}

type InvertRecord<R extends Record<PropertyKey, PropertyKey>> = {
    [K in keyof R as R[K]]: K;
};
/** True if every key of B is the target of at least one key of the mapping. */
type IsSurjective<B extends object, M extends Record<PropertyKey, PropertyKey>> = keyof B extends M[keyof M] ? true : false;
/** True if no two keys of the mapping have the same target. */
type IsInjective<M extends Record<PropertyKey, PropertyKey>> = {
    [K in keyof M]: M[K] extends keyof InvertRecord<M> ? [InvertRecord<M>[M[K]]] extends [K] ? true : false : false;
}[keyof M] extends true ? true : false;
/**
 * True if the mapping M pairs every key of A with exactly one key of B, and vice versa.
 * Every key of A being mapped is already guaranteed by the `Record<keyof A, keyof B>` constraint.
 */
type IsBijective<A extends object, B extends object, M extends Record<keyof A, keyof B>> = IsSurjective<B, M> extends true ? IsInjective<M> : false;
interface LilypadSerializerConstructorOptions<FROM extends object, TO extends object, KeyMap extends Record<keyof FROM, keyof TO>> {
    serialization: {
        [K in keyof FROM]: {
            target: IsBijective<FROM, TO, KeyMap> extends true ? KeyMap[K] : never;
            serialize: (item: FROM) => TO[KeyMap[K]];
            deserialize: (item: TO) => FROM[K];
            default: FROM[K];
            equality?: (value: FROM[K], defaultValue: FROM[K]) => boolean;
        };
    };
}
/**
 * A generic serializer/deserializer for mapping objects between two shapes (`FROM` and `TO`)
 * using customizable key mappings, serialization, and deserialization functions.
 *
 * @typeParam FROM - The source object type to serialize from.
 * @typeParam TO - The target object type to serialize to.
 * @typeParam KeyMap - A mapping from keys in `FROM` to keys in `TO`.
 *
 * @remarks
 * - Each key of the source is mapped to its `target` key in the target object; the mapping must be
 *   bijective, otherwise `target` is typed as `never`.
 * - Custom serialization and deserialization functions can be provided for each key.
 * - Default values and equality checks can be specified to skip serialization of default values.
 * - When a function in the serialization map returns `undefined`, that key is omitted from the serialized output.
 * - When deserialization returns `null` or `undefined`, the key gets a copy of its default value
 *   (object defaults are cloned, so deserialized items never share them).
 *
 * @example
 * ```typescript
 * interface Source { a: number; b: string; }
 * interface Target { x: number; y: string; }
 * const serializer = new LilypadSerializer<Source, Target, { a: 'x'; b: 'y' }>({
 *   serialization: {
 *     a: { target: 'x', serialize: (item) => item.a, deserialize: (item) => item.x, default: 0 },
 *     b: { target: 'y', serialize: (item) => item.b, deserialize: (item) => item.y, default: '' },
 *   },
 * });
 * const packed = serializer.serialize([{ a: 1, b: 'foo' }]);
 * const unpacked = serializer.deserialize(packed);
 * ```
 */
declare class LilypadSerializer<FROM extends object, TO extends object, KeyMap extends Record<keyof FROM, keyof TO>> {
    private options;
    private readonly fromKeys;
    constructor(options: LilypadSerializerConstructorOptions<FROM, TO, KeyMap>);
    serialize(input: FROM[]): TO[];
    deserialize(input: TO[]): FROM[];
}

export { type ExecuteFnOptions, type FlowControlOptions, LilypadCache, type LilypadCacheGetOptions, type LilypadCacheKey, type LilypadCachedValueType, LilypadConsoleLogger, LilypadDbCache, type LilypadDbCacheDefaultListenerOptions, type LilypadDbCacheDefaultNotificationPayload, type LilypadDbColumnType, LilypadDbGate, type LilypadDbGateOptions, type LilypadDbInsertData, type LilypadDbSchema, type LilypadDbUpdateData, LilypadDiscordLogger, type LilypadDiscordLoggerOptions, LilypadFlowControl, type LilypadLibLogger, LilypadLogger, LilypadLoggerComponent, type LilypadLoggerConstructorOptions, type LilypadLoggerType, LilypadSerializer, type LilypadSerializerConstructorOptions, type LilypadSingletonAble, type ListenerCallbackIdentifier, createLogger, getLilypadSingletonInstance, getLilypadSingletonInstanceAsync, removeLilypadSingletonInstance };
