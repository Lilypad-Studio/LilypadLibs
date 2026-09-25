import { a as LilypadLibLogger } from './LilypadLogger-Bgz_B7cT.js';
import './singleton.js';
import './platform.js';

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
    /**
     * Timeout of each attempt of this execution, in milliseconds; overrides the instance's `timeout`.
     * Callers that join an in-flight execution share the timeout of the call that started it.
     */
    timeout?: number;
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
    executeWithTimeout(executionFn: (signal: AbortSignal) => Promise<T>, timeout?: number | undefined): Promise<T>;
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

export { type ExecuteFnOptions, type FlowControlOptions, LilypadFlowControl };
