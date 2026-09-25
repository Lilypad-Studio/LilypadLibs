"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class;// src/flow/LilypadFlowControl.ts
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
  async executeWithTimeout(executionFn, timeout = this.timeout) {
    const controller = new AbortController();
    if (timeout === void 0) {
      return executionFn(controller.signal);
    }
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error("Operation timed out");
        controller.abort(error);
        reject(error);
      }, timeout);
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
   * It must stay synchronous: `executeFn` relies on no await happening between the single-flight
   * lookup and the registration of the new execution.
   *
   * @param consumerIdentifier - A unique identifier for the consumer (e.g., user or service).
   * @param functionIdentifier - A unique identifier for the function being rate-limited.
   * @throws {Error} If the rate limit is exceeded for the given consumer and function.
   */
  rateLimit(consumerIdentifier, functionIdentifier) {
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
   * @returns `true` if an execution for the function identifier is currently in flight.
   */
  isInFlight(functionIdentifier) {
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
  async executeFn(options) {
    const inFlight = this.singleFlightMap.get(options.functionIdentifier);
    if (inFlight) {
      return inFlight;
    }
    this.rateLimit(options.consumerIdentifier, options.functionIdentifier);
    const executionPromise = this.executeWithRetries({
      executionFn: () => this.executeWithTimeout(options.fn, _nullishCoalesce(options.timeout, () => ( this.timeout))),
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



exports.LilypadFlowControl = LilypadFlowControl;
//# sourceMappingURL=chunk-FOAUQ67X.js.map