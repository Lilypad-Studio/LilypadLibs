import { assertNumberOption } from '@/internal/LilypadValidation';

export interface LilypadFlowControlOptions {
  /** Minimum time between two executions of each consumer/function pair, in milliseconds. */
  rate?: number;
  /**
   * Maximum duration of each attempt, in milliseconds. With retries, the total duration can be up to
   * `(retries + 1) * timeout` plus the backoff times.
   */
  timeout?: number;
  /** How many times a failed attempt is retried. Defaults to 0. */
  retries?: number;
}

export interface LilypadExecuteFnOptions<T> {
  /** Identifies the execution: concurrent calls with the same identifier share one execution. */
  functionIdentifier: string;
  /**
   * With the `rate` option, the rate limit applies to each consumer/function pair; without a
   * consumer, to the function alone.
   */
  consumerIdentifier?: string;
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

/** Thrown when an attempt exceeds its timeout. */
export class LilypadTimeoutError extends Error {
  readonly timeout: number;

  constructor(timeout: number) {
    super(`Operation timed out after ${timeout}ms`);
    this.name = 'LilypadTimeoutError';
    this.timeout = timeout;
  }
}

/** Thrown when an execution is refused by the rate limit. */
export class LilypadRateLimitError extends Error {
  constructor(rateKey: string) {
    super(`Rate limit exceeded for ${rateKey}`);
    this.name = 'LilypadRateLimitError';
  }
}

/**
 * Above this number of tracked rate limit keys, expired entries are pruned.
 */
const RATE_MAP_PRUNE_THRESHOLD = 1000;

/**
 * Flow control for asynchronous operations: timeouts, retries, rate limiting and single-flight
 * deduplication. Each one is a method of its own (`executeWithTimeout`, `executeWithRetries`,
 * `rateLimit`, `singleFlight`), and `executeFn` combines them all.
 *
 * The class is not generic: each execution is typed by its own `fn`.
 *
 * @example
 * ```typescript
 * const flowControl = new LilypadFlowControl({ rate: 1000, timeout: 5000, retries: 3 });
 *
 * const result = await flowControl.executeFn({
 *   functionIdentifier: 'myFunction',
 *   consumerIdentifier: 'user123',
 *   fn: (signal) => fetchData({ signal }),
 *   backOffTime: (attempt) => Math.pow(2, attempt) * 100,
 * });
 * ```
 *
 * @remarks
 * - **Rate Limiting**: Enforces a minimum interval between executions per consumer/function pair.
 *   A refused execution rejects with a `LilypadRateLimitError`.
 * - **Single-Flight**: Deduplicates concurrent requests for the same function identifier. Callers
 *   that join an in-flight execution share its outcome, and each handles an error on its own.
 * - **Retries**: Automatically retries failed operations with configurable backoff strategies
 * - **Timeout**: Fails an attempt that exceeds the specified timeout duration with a
 *   `LilypadTimeoutError`, and aborts its signal. The timeout applies to each attempt, not to the
 *   whole execution.
 */
export class LilypadFlowControl {
  private readonly rate?: number;
  private readonly timeout?: number;
  private readonly retries?: number;

  private singleFlightMap: Map<string, Promise<unknown>> = new Map();
  private rateMap: Map<string, number> = new Map();

  /** @throws If a numeric option is not valid (e.g. `NaN`, or a negative duration). */
  constructor(options?: LilypadFlowControlOptions) {
    assertNumberOption('LilypadFlowControl', 'rate', options?.rate, 'non-negative');
    assertNumberOption('LilypadFlowControl', 'timeout', options?.timeout, 'positive');
    assertNumberOption('LilypadFlowControl', 'retries', options?.retries, 'non-negative-integer');
    this.rate = options?.rate;
    this.timeout = options?.timeout;
    this.retries = options?.retries;
  }

  /**
   * Executes an asynchronous function with a timeout constraint.
   *
   * @template R The type of value returned by the execution function.
   * @param executionFn An asynchronous function to execute. It receives a signal that is aborted on timeout.
   * @param timeout The timeout, in milliseconds. Defaults to the instance's `timeout`.
   * @returns A promise that resolves with the result of `executionFn` if it completes before the timeout,
   *          or rejects with an error if the timeout is exceeded.
   * @throws {LilypadTimeoutError} If the execution exceeds the timeout.
   *
   * @remarks
   * This method uses `Promise.race()` to implement the timeout mechanism. The timeout is cleared in the finally block
   * to ensure no memory leaks occur regardless of whether the operation succeeds or times out.
   * JavaScript cannot forcibly stop a running promise: `executionFn` should observe the signal to stop its work.
   */
  async executeWithTimeout<R>(
    executionFn: (signal: AbortSignal) => Promise<R>,
    timeout: number | undefined = this.timeout
  ): Promise<R> {
    const controller = new AbortController();
    if (timeout === undefined) {
      return executionFn(controller.signal);
    }
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new LilypadTimeoutError(timeout);
        controller.abort(error);
        reject(error);
      }, timeout);
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
   * @param options.executionFn - The asynchronous function to execute.
   * @param options.retries - The maximum number of retry attempts. If not provided, the instance's configured retries will be used.
   * @param options.backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to exponential backoff if not provided.
   * @returns A promise that resolves with the result of `executionFn`.
   * @throws The error of the last attempt, once all retries are exhausted.
   */
  async executeWithRetries<T>(options: {
    executionFn: () => Promise<T>;
    retries?: number;
    backOffTime?: (attempt: number) => number;
  }): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        const result = await options.executionFn();
        return result;
      } catch (error) {
        if (attempts >= (options.retries ?? this.retries ?? 0)) {
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
   * Enforces the rate limit (the `rate` option) for a key: records the call, or throws if the
   * previous call of the key is more recent than `rate`. Without `rate`, it does nothing.
   *
   * It must stay synchronous: `executeFn` relies on no await happening between the single-flight
   * lookup and the registration of the new execution.
   *
   * @param rateKey - What is limited, e.g. a consumer and a function.
   * @throws {LilypadRateLimitError} If the rate limit is exceeded for the key.
   */
  rateLimit(rateKey: string): void {
    if (this.rate !== undefined) {
      const now = Date.now();
      const lastExecution = this.rateMap.get(rateKey) ?? 0;
      if (now - lastExecution < this.rate) {
        throw new LilypadRateLimitError(rateKey);
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
   * @returns `true` if an execution for the key is currently in flight.
   */
  isInFlight(key: string): boolean {
    return this.singleFlightMap.has(key);
  }

  /**
   * Runs `fn`, unless an execution for the same key is in flight: then its promise is returned,
   * and `fn` is not called. The execution is registered synchronously, so that a call made right
   * after this one joins it.
   *
   * The caller that joins a flight is responsible for expecting the type of the one that started it.
   */
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const inFlight = this.singleFlightMap.get(key) as Promise<T> | undefined;
    if (inFlight) {
      return inFlight;
    }
    let execution: Promise<T>;
    try {
      execution = fn();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const flight: Promise<T> = execution.finally(() => {
      if (this.singleFlightMap.get(key) === flight) {
        this.singleFlightMap.delete(key);
      }
    });
    this.singleFlightMap.set(key, flight);
    return flight;
  }

  /**
   * Executes a function with single-flight deduplication, rate limiting, retries and timeouts.
   * Only one execution per function identifier is in flight at a time: later calls join it. Calls
   * that join an in-flight execution are not rate limited, since they do not start a new one.
   *
   * @template T - The return type of the function to execute.
   * @returns A promise that resolves with the result of the executed function.
   * @throws {LilypadRateLimitError} If the execution is refused by the rate limit.
   * @throws {LilypadTimeoutError} If the last attempt timed out.
   * @throws The error of the last attempt, once the retries are exhausted.
   */
  executeFn<T>(options: LilypadExecuteFnOptions<T>): Promise<T> {
    const { functionIdentifier, consumerIdentifier } = options;
    if (!this.isInFlight(functionIdentifier)) {
      try {
        // Synchronous, see rateLimit
        this.rateLimit(
          consumerIdentifier === undefined
            ? functionIdentifier
            : `${consumerIdentifier}#${functionIdentifier}`
        );
      } catch (error) {
        return Promise.reject(error as Error);
      }
    }
    return this.singleFlight(functionIdentifier, () =>
      this.executeWithRetries<T>({
        executionFn: () => this.executeWithTimeout(options.fn, options.timeout),
        retries: options.retries,
        backOffTime: options.backOffTime,
      })
    );
  }
}
