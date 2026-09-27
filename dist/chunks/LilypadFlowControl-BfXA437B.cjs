"use strict";
const require_LilypadValidation = require("./LilypadValidation-BobS4Y-i.cjs");
//#region src/flow/LilypadFlowControl.ts
/** Thrown when an attempt exceeds its timeout. */
var LilypadTimeoutError = class extends Error {
	constructor(timeout) {
		super(`Operation timed out after ${timeout}ms`);
		this.name = "LilypadTimeoutError";
		this.timeout = timeout;
	}
};
/** Thrown when an execution is refused by the rate limit. */
var LilypadRateLimitError = class extends Error {
	constructor(rateKey) {
		super(`Rate limit exceeded for ${rateKey}`);
		this.name = "LilypadRateLimitError";
	}
};
/**
* Above this number of tracked rate limit keys, expired entries are pruned (at most once per `rate`).
*/
const RATE_MAP_PRUNE_THRESHOLD = 1e3;
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
var LilypadFlowControl = class {
	/** @throws If a numeric option is not valid (e.g. `NaN`, or a negative duration). */
	constructor(options) {
		this.singleFlightMap = /* @__PURE__ */ new Map();
		this.rateMap = /* @__PURE__ */ new Map();
		this.lastRatePrune = 0;
		require_LilypadValidation.assertNumberOption("LilypadFlowControl", "rate", options?.rate, "non-negative");
		require_LilypadValidation.assertNumberOption("LilypadFlowControl", "timeout", options?.timeout, "positive-delay");
		require_LilypadValidation.assertNumberOption("LilypadFlowControl", "retries", options?.retries, "non-negative-integer");
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
	async executeWithTimeout(executionFn, timeout = this.timeout) {
		require_LilypadValidation.assertNumberOption("LilypadFlowControl", "timeout", timeout, "positive-delay");
		if (timeout === void 0) return executionFn(new AbortController().signal);
		return require_LilypadValidation.withLilypadTimeout(executionFn, timeout, () => new LilypadTimeoutError(timeout));
	}
	/**
	* Executes a given asynchronous function with retry logic and optional exponential backoff.
	*
	* @template T The return type of the execution function.
	* @param options.executionFn - The asynchronous function to execute.
	* @param options.retries - The maximum number of retry attempts. If not provided, the instance's configured retries will be used.
	* @param options.backOffTime - Optional function to calculate the backoff time (in milliseconds) before each retry attempt. Receives the current attempt number as an argument. Defaults to exponential backoff if not provided.
	* @param options.shouldRetry - Returns `false` for an error that must not be retried: it is thrown at once.
	* @returns A promise that resolves with the result of `executionFn`.
	* @throws The error of the last attempt, once all retries are exhausted.
	*/
	async executeWithRetries(options) {
		let attempts = 0;
		while (true) try {
			return await options.executionFn();
		} catch (error) {
			if (attempts >= (options.retries ?? this.retries ?? 0) || options.shouldRetry?.(error, attempts + 1) === false) throw error;
			attempts++;
			const backoffTimeValue = options.backOffTime ? options.backOffTime(attempts) : Math.pow(2, attempts) * 100;
			require_LilypadValidation.assertNumberOption("LilypadFlowControl", "backOffTime", backoffTimeValue, "non-negative-delay");
			await new Promise((resolve) => setTimeout(resolve, backoffTimeValue));
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
	rateLimit(rateKey) {
		if (this.rate !== void 0) {
			const now = Date.now();
			if (now - (this.rateMap.get(rateKey) ?? 0) < this.rate) throw new LilypadRateLimitError(rateKey);
			this.rateMap.set(rateKey, now);
			if (this.rateMap.size > RATE_MAP_PRUNE_THRESHOLD && now - this.lastRatePrune >= this.rate) {
				this.lastRatePrune = now;
				this.pruneRateMap(now);
			}
		}
	}
	/**
	* Removes the rate limit entries whose interval has already elapsed, as they no longer limit anything.
	*/
	pruneRateMap(now) {
		for (const [rateKey, lastExecution] of this.rateMap) if (now - lastExecution >= this.rate) this.rateMap.delete(rateKey);
	}
	/**
	* @returns `true` if an execution for the key is currently in flight.
	*/
	isInFlight(key) {
		return this.singleFlightMap.has(key);
	}
	/**
	* Runs `fn`, unless an execution for the same key is in flight: then its promise is returned,
	* and `fn` is not called. The execution is registered synchronously, so that a call made right
	* after this one joins it.
	*
	* The caller that joins a flight is responsible for expecting the type of the one that started it.
	*/
	singleFlight(key, fn) {
		const inFlight = this.singleFlightMap.get(key);
		if (inFlight) return inFlight;
		let execution;
		try {
			execution = fn();
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const flight = execution.finally(() => {
			if (this.singleFlightMap.get(key) === flight) this.singleFlightMap.delete(key);
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
	executeFn(options) {
		const { functionIdentifier, consumerIdentifier } = options;
		if (!this.isInFlight(functionIdentifier)) try {
			this.rateLimit(consumerIdentifier === void 0 ? functionIdentifier : `${consumerIdentifier}#${functionIdentifier}`);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.singleFlight(functionIdentifier, () => this.executeWithRetries({
			executionFn: () => this.executeWithTimeout(options.fn, options.timeout),
			retries: options.retries,
			backOffTime: options.backOffTime,
			shouldRetry: options.shouldRetry
		}));
	}
};
//#endregion
Object.defineProperty(exports, "LilypadFlowControl", {
	enumerable: true,
	get: function() {
		return LilypadFlowControl;
	}
});
Object.defineProperty(exports, "LilypadRateLimitError", {
	enumerable: true,
	get: function() {
		return LilypadRateLimitError;
	}
});
Object.defineProperty(exports, "LilypadTimeoutError", {
	enumerable: true,
	get: function() {
		return LilypadTimeoutError;
	}
});

//# sourceMappingURL=LilypadFlowControl-BfXA437B.cjs.map