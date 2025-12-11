import { LilypadLoggerType } from '@/logger/LilypadLogger';

export interface FlowControlOptions {
  rate?: number;
  timeout?: number;
  retries?: number;
  logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
}

export interface ExecuteFnOptions<T> {
  errorFn?: (error: unknown) => T | void;
  functionIdentifier: string;
  consumerIdentifier: string;
  fn: () => Promise<T>;
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
export class LilypadFlowControl<T> {
  private rate?: number;
  private timeout?: number;
  private retries?: number;
  private logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;

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
   * @param executionFn An asynchronous function to execute.
   * @returns A promise that resolves with the result of `executionFn` if it completes before the timeout,
   *          or rejects with an error if the timeout is exceeded.
   * @throws {Error} Throws an error with message 'Operation timed out' if the execution exceeds the configured timeout duration.
   *
   * @remarks
   * This method uses `Promise.race()` to implement the timeout mechanism. The timeout is cleared in the finally block
   * to ensure no memory leaks occur regardless of whether the operation succeeds or times out.
   */
  async executeWithTimeout(executionFn: () => Promise<T>): Promise<T> {
    if (this.timeout === undefined) {
      return executionFn();
    }
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Operation timed out')), this.timeout);
    });
    try {
      return await Promise.race([executionFn(), timeoutPromise]);
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
   * @param options.errorFn - Optional function to handle errors after all retries have been exhausted. If provided, its return value will be returned instead of throwing the error.
   * @param options.retries - The maximum number of retry attempts. If not provided, the instance's configured retries will be used.
   * @param options.backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to exponential backoff if not provided.
   * @returns A promise that resolves with the result of `executionFn`, or with the result of `errorFn` if retries are exhausted.
   * @throws The error thrown by `executionFn` if all retries are exhausted and no `errorFn` is provided.
   */
  async executeWithRetries(options: {
    executionFn: () => Promise<T>;
    retries?: number;
    errorFn?: (error: unknown) => T | void;
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
            const result = options.errorFn(error);
            if (result !== undefined) {
              return result;
            }
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
   * @param consumerIdentifier - A unique identifier for the consumer (e.g., user or service).
   * @param functionIdentifier - A unique identifier for the function being rate-limited.
   * @throws {Error} If the rate limit is exceeded for the given consumer and function.
   * @returns A promise that resolves when the rate limit check passes.
   */
  async rateLimit(consumerIdentifier: string, functionIdentifier: string): Promise<void> {
    if (this.rate !== undefined) {
      const rateKey = consumerIdentifier + '#' + functionIdentifier;
      const now = Date.now();
      const lastExecution = this.rateMap.get(rateKey) ?? 0;
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
  async executeFn(options: ExecuteFnOptions<T>): Promise<T> {
    // Rate Limiting
    await this.rateLimit(options.consumerIdentifier, options.functionIdentifier);

    if (this.singleFlightMap.has(options.functionIdentifier)) {
      return this.singleFlightMap.get(options.functionIdentifier)!;
    }

    // Execution Pipeline (Retries and Timeout)
    const pipeline = async () => {
      // Create a function that wraps the main fn with timeout if needed
      const executionFn = () =>
        this.timeout !== undefined ? this.executeWithTimeout(options.fn) : options.fn();

      const effectiveRetries = options.retries ?? this.retries ?? 0;
      if (effectiveRetries > 0) {
        return this.executeWithRetries({
          executionFn: executionFn,
          retries: effectiveRetries,
          errorFn: options.errorFn,
          backOffTime: options.backOffTime,
        });
      }

      try {
        return await executionFn();
      } catch (error) {
        if (options.errorFn) {
          const result = options.errorFn(error);
          if (result !== undefined) {
            return result;
          }
        }
        throw error;
      }
    };

    // Store and Execute
    const executionPromise = pipeline().finally(() => {
      // Clear the single-flight map after the promise resolves or rejects
      this.singleFlightMap.delete(options.functionIdentifier);
    });

    // Store the promise in the single-flight map
    this.singleFlightMap.set(options.functionIdentifier, executionPromise);
    // The type T is returned from the pipeline, so we assert the type here.
    return executionPromise;
  }
}
