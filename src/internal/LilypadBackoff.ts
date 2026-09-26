/** The longest wait before a retry, unless the base delay itself is longer. */
const MAX_RETRY_DELAY = 60_000;

/**
 * Tracks the failures of a repeated operation (a `LISTEN`, a read of the changelog, a schema
 * check), so that it is retried after an exponential backoff instead of at every call.
 */
export class LilypadBackoff {
  private failures = 0;
  private retryAt = 0;

  /** @param baseDelay - The wait after the first failure, in ms; it doubles at each failure. */
  constructor(private readonly baseDelay: () => number) {}

  /** Whether the operation may run now: no failure, or the backoff is over. */
  ready(now: number = Date.now()): boolean {
    return now >= this.retryAt;
  }

  /** Records a failure: the next attempt waits `base * 2^(failures - 1)`, up to one minute. */
  fail(now: number = Date.now()): void {
    this.failures++;
    const base = this.baseDelay();
    const delay = Math.max(base, Math.min(base * 2 ** (this.failures - 1), MAX_RETRY_DELAY));
    this.retryAt = now + delay;
  }

  /** Records a success: the next failure starts again from the base delay. */
  succeed(): void {
    this.failures = 0;
    this.retryAt = 0;
  }
}
