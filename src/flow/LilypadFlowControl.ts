import { withLilypadTimeout } from '@/internal/LilypadTimeout';
import { assertNumberOption } from '@/internal/LilypadValidation';

export type LilypadFlowControlOptions = {
  /**
   * Minimum time between two executions of each consumer/function pair, in milliseconds. `0`, like
   * no value, disables the rate limit.
   */
  rate?: number | undefined;
  /**
   * Maximum duration of each attempt, in milliseconds. With retries, the total duration can be up to
   * `(retries + 1) * timeout` plus the backoff times.
   */
  timeout?: number | undefined;
  /** How many times a failed attempt is retried: a non-negative integer. Defaults to 0. */
  retries?: number | undefined;
};

export type LilypadExecuteFnOptions<T> = {
  /** Identifies the execution: concurrent calls with the same identifier share one execution. */
  functionIdentifier: string;
  /**
   * With the `rate` option, the rate limit applies to each consumer/function pair; without a
   * consumer, to the function alone.
   */
  consumerIdentifier?: string | undefined;
  /**
   * The operation to execute. The received signal is aborted when the operation times out,
   * so the function can stop its work and avoid side effects after the timeout.
   */
  fn: (signal: AbortSignal) => Promise<T>;
  retries?: number | undefined;
  backOffTime?: ((attempt: number) => number) | undefined;
  /**
   * Whether a failed attempt is retried: return `false` for the errors that another attempt cannot
   * fix (e.g. a validation error). Defaults to retrying every error.
   */
  shouldRetry?: ((error: unknown, attempt: number) => boolean) | undefined;
  /**
   * Timeout of each attempt of this execution, in milliseconds; overrides the instance's `timeout`.
   * Callers that join an in-flight execution share the timeout of the call that started it: their
   * own `timeout` and `retries` are ignored, but still checked, and rejected when invalid.
   */
  timeout?: number | undefined;
};

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
  /** What is limited: `<consumer>#<function>`, or the function alone. */
  readonly rateKey: string;

  constructor(rateKey: string) {
    super(`Rate limit exceeded for ${rateKey}`);
    this.name = 'LilypadRateLimitError';
    this.rateKey = rateKey;
  }
}

/**
 * Above this number of tracked rate limit keys, expired entries are pruned (at most once per `rate`).
 */
const RATE_MAP_PRUNE_THRESHOLD = 1000;

/** The longest default wait before a retry (without `backOffTime`). */
const MAX_DEFAULT_BACKOFF = 30_000;

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
  private readonly rate?: number | undefined;
  private readonly timeout?: number | undefined;
  private readonly retries?: number | undefined;

  private singleFlightMap = new Map<string, Promise<unknown>>();
  /** When each key last ran, on the monotonic clock (`performance.now()`). */
  private rateMap = new Map<string, number>();
  /** When the rate limit entries were last pruned. */
  private lastRatePrune = -Infinity;

  /** @throws If a numeric option is not valid (e.g. `NaN`, or a negative duration). */
  constructor(options?: LilypadFlowControlOptions) {
    assertNumberOption('LilypadFlowControl', 'rate', options?.rate, 'non-negative');
    assertNumberOption('LilypadFlowControl', 'timeout', options?.timeout, 'positive-delay');
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
   * @throws If the timeout is not a valid delay (e.g. `NaN`, or more than 2^31 - 1 ms).
   *
   * @remarks
   * The timer is always cleared, whether the operation succeeds, fails or times out.
   * JavaScript cannot forcibly stop a running promise: `executionFn` should observe the signal to stop its work.
   */
  async executeWithTimeout<R>(
    executionFn: (signal: AbortSignal) => Promise<R>,
    timeout: number | undefined = this.timeout
  ): Promise<R> {
    // Checked here too: a timer given NaN, or more than 2^31 - 1 ms, fires at once
    assertNumberOption('LilypadFlowControl', 'timeout', timeout, 'positive-delay');
    if (timeout === undefined) {
      return executionFn(new AbortController().signal);
    }
    return withLilypadTimeout(executionFn, timeout, () => new LilypadTimeoutError(timeout));
  }

  /**
   * Executes a given asynchronous function with retry logic and optional exponential backoff.
   *
   * @template T The return type of the execution function.
   * @param options.executionFn - The asynchronous function to execute.
   * @param options.retries - The maximum number of retry attempts, a non-negative integer. If not provided, the instance's configured retries will be used.
   * @param options.backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to an exponential backoff (200 ms, 400 ms, ...) of at most 30 s.
   * @param options.shouldRetry - Returns `false` for an error that must not be retried: it is thrown at once.
   * @returns A promise that resolves with the result of `executionFn`.
   * @throws The error of the last attempt, once all retries are exhausted.
   * @throws If `retries` is not a non-negative integer (before the first attempt), or if
   * `backOffTime` returns a delay a timer cannot hold (with the error of the attempt as `cause`).
   */
  async executeWithRetries<T>(options: {
    executionFn: () => Promise<T>;
    retries?: number | undefined;
    backOffTime?: ((attempt: number) => number) | undefined;
    shouldRetry?: ((error: unknown, attempt: number) => boolean) | undefined;
  }): Promise<T> {
    // Checked per call too: `attempts >= NaN` is always false, so NaN would retry without end
    const retries = options.retries ?? this.retries ?? 0;
    assertNumberOption('LilypadFlowControl', 'retries', retries, 'non-negative-integer');
    let attempts = 0;
    while (true) {
      try {
        return await options.executionFn();
      } catch (error) {
        if (attempts >= retries || options.shouldRetry?.(error, attempts + 1) === false) {
          throw error;
        }
        attempts++;
        const backoffTimeValue = options.backOffTime
          ? options.backOffTime(attempts)
          : Math.min(2 ** attempts * 100, MAX_DEFAULT_BACKOFF);
        try {
          // A delay that a timer cannot hold (NaN, beyond 2^31 - 1 ms) would retry at once
          assertNumberOption(
            'LilypadFlowControl',
            'backOffTime',
            backoffTimeValue,
            'non-negative-delay'
          );
        } catch (invalid) {
          // Keeps the failure of the attempt, which the invalid delay would otherwise hide
          throw new RangeError((invalid as Error).message, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, backoffTimeValue));
      }
    }
  }

  /**
   * Enforces the rate limit (the `rate` option) for a key: records the call, or throws if the
   * previous call of the key is more recent than `rate`. Without `rate` (or with `0`), it does
   * nothing. Intervals are measured on the monotonic clock, so a step back of the wall clock does
   * not lock the keys out.
   *
   * It must stay synchronous: `executeFn` relies on no await happening between the single-flight
   * lookup and the registration of the new execution.
   *
   * @param rateKey - What is limited, e.g. a consumer and a function.
   * @throws {LilypadRateLimitError} If the rate limit is exceeded for the key.
   */
  rateLimit(rateKey: string): void {
    const rate = this.rate;
    if (!rate) {
      return;
    }
    // `performance.now()` starts near 0: a missing entry must not count as a call at time 0
    const now = performance.now();
    const lastExecution = this.rateMap.get(rateKey);
    if (lastExecution !== undefined && now - lastExecution < rate) {
      throw new LilypadRateLimitError(rateKey);
    }
    this.rateMap.set(rateKey, now);
    // At most once per `rate`: when every key is still limited, pruning at each call would scan
    // the whole map for nothing
    if (this.rateMap.size > RATE_MAP_PRUNE_THRESHOLD && now - this.lastRatePrune >= rate) {
      this.lastRatePrune = now;
      this.pruneRateMap(now, rate);
    }
  }

  /**
   * Removes the rate limit entries whose interval has already elapsed, as they no longer limit anything.
   */
  private pruneRateMap(now: number, rate: number) {
    for (const [rateKey, lastExecution] of this.rateMap) {
      if (now - lastExecution >= rate) {
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
   * @throws If `timeout` or `retries` is not valid: before the rate limit and the first attempt.
   * @throws {LilypadTimeoutError} If the last attempt timed out.
   * @throws The error of the last attempt, once the retries are exhausted.
   */
  executeFn<T>(options: LilypadExecuteFnOptions<T>): Promise<T> {
    const { functionIdentifier, consumerIdentifier } = options;
    try {
      // Checked before anything else: an invalid timeout would otherwise fail every attempt (and
      // be retried), and an invalid option would still use the rate limit of the key
      assertNumberOption('LilypadFlowControl', 'timeout', options.timeout, 'positive-delay');
      assertNumberOption('LilypadFlowControl', 'retries', options.retries, 'non-negative-integer');
      if (!this.isInFlight(functionIdentifier)) {
        // Synchronous, see rateLimit
        this.rateLimit(
          consumerIdentifier === undefined
            ? functionIdentifier
            : `${consumerIdentifier}#${functionIdentifier}`
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.singleFlight(functionIdentifier, () =>
      this.executeWithRetries<T>({
        executionFn: () => this.executeWithTimeout(options.fn, options.timeout),
        retries: options.retries,
        backOffTime: options.backOffTime,
        shouldRetry: options.shouldRetry,
      })
    );
  }
}
