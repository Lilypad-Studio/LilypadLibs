import type { LilypadLibLogger } from '@/logger/LilypadLogger';

export interface FlowControlOptions {
  rate?: number;
  /**
   * Maximum duration of each attempt, in milliseconds. With retries, the total duration can be up to
   * `(retries + 1) * timeout` plus the backoff times.
   */
  timeout?: number;
  retries?: number;
  logger?: LilypadLibLogger;
}

export interface ExecuteFnOptions<T> {
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
 * Above this number of tracked consumer/function pairs, expired rate limit entries are pruned.
 */
const RATE_MAP_PRUNE_THRESHOLD = 1000;

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
export class LilypadFlowControl<T> {
  private rate?: number;
  private timeout?: number;
  private retries?: number;
  private logger?: LilypadLibLogger;

  private singleFlightMap: Map<string, Promise<T>> = new Map();
  private rateMap: Map<string, number> = new Map();

  constructor(options?: FlowControlOptions) {
    this.rate = options?.rate;
    this.timeout = options?.timeout;
    this.retries = options?.retries;
    this.logger = options?.logger;
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
  async executeWithTimeout(executionFn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    if (this.timeout === undefined) {
      return executionFn(controller.signal);
    }
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error('Operation timed out');
        controller.abort(error);
        reject(error);
      }, this.timeout);
    });
    try {
      return await Promise.race([executionFn(controller.signal), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
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
  async executeWithRetries(options: {
    executionFn: () => Promise<T>;
    retries?: number;
    errorFn?: (error: unknown) => T;
    backOffTime?: (attempt: number) => number;
  }): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        const result = await options.executionFn();
        return result;
      } catch (error) {
        if (attempts >= (options.retries ?? this.retries ?? 0)) {
          if (options.errorFn) {
            return options.errorFn(error);
          }
          throw error;
        }
        attempts++;
        const backoffTimeValue = options.backOffTime
          ? options.backOffTime(attempts)
          : Math.pow(2, attempts) * 100; // Exponential backoff
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
   * It must stay synchronous: `executeFn` relies on no await happening between the single-flight
   * lookup and the registration of the new execution.
   *
   * @param consumerIdentifier - A unique identifier for the consumer (e.g., user or service).
   * @param functionIdentifier - A unique identifier for the function being rate-limited.
   * @throws {Error} If the rate limit is exceeded for the given consumer and function.
   */
  rateLimit(consumerIdentifier: string, functionIdentifier: string): void {
    if (this.rate !== undefined) {
      const rateKey = consumerIdentifier + '#' + functionIdentifier;
      const now = Date.now();
      const lastExecution = this.rateMap.get(rateKey) ?? 0;
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
  private pruneRateMap(now: number) {
    for (const [rateKey, lastExecution] of this.rateMap) {
      if (now - lastExecution >= this.rate!) {
        this.rateMap.delete(rateKey);
      }
    }
  }

  /**
   * @returns `true` if an execution for the function identifier is currently in flight.
   */
  isInFlight(functionIdentifier: string): boolean {
    return this.singleFlightMap.has(functionIdentifier);
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
  async executeFn(options: ExecuteFnOptions<T>): Promise<T> {
    const inFlight = this.singleFlightMap.get(options.functionIdentifier);
    if (inFlight) {
      return inFlight;
    }

    // Rate Limiting (synchronous, see rateLimit)
    this.rateLimit(options.consumerIdentifier, options.functionIdentifier);

    // Execution Pipeline (Retries and Timeout)
    const executionPromise = this.executeWithRetries({
      executionFn: () => this.executeWithTimeout(options.fn),
      retries: options.retries ?? this.retries ?? 0,
      errorFn: options.errorFn,
      backOffTime: options.backOffTime,
    }).finally(() => {
      // Clear the single-flight map after the promise resolves or rejects
      this.singleFlightMap.delete(options.functionIdentifier);
    });

    this.singleFlightMap.set(options.functionIdentifier, executionPromise);
    return executionPromise;
  }
}
