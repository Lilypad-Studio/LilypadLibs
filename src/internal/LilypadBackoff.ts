/** The longest wait before a retry, unless the base delay itself is longer. */
const MAX_RETRY_DELAY = 60_000;

/** Beyond it the delay is capped anyway; it keeps `base * 2^n` finite (never `0 * Infinity`). */
const MAX_EXPONENT = 30;

/**
 * Tracks the failures of a repeated operation (a `LISTEN`, a read of the changelog, a schema
 * check), so that it is retried after an exponential backoff instead of at every call.
 *
 * Measured with the monotonic clock (`performance.now()`): a step back of the wall clock (an NTP
 * correction, a resumed VM) must not postpone the next attempt.
 */
export class LilypadBackoff {
  private failures = 0;
  private retryAt = -Infinity;

  /** @param baseDelay - The wait after the first failure, in ms; it doubles at each failure. */
  constructor(private readonly baseDelay: () => number) {}

  /** Whether the operation may run now: no failure, or the backoff is over. */
  ready(): boolean {
    return performance.now() >= this.retryAt;
  }

  /** Records a failure: the next attempt waits `base * 2^(failures - 1)`, up to one minute. */
  fail(): void {
    this.failures++;
    const base = this.baseDelay();
    const exponential = base * 2 ** Math.min(this.failures - 1, MAX_EXPONENT);
    this.retryAt = performance.now() + Math.max(base, Math.min(exponential, MAX_RETRY_DELAY));
  }

  /** Records a success: the next failure starts again from the base delay. */
  succeed(): void {
    this.failures = 0;
    this.retryAt = -Infinity;
  }
}
