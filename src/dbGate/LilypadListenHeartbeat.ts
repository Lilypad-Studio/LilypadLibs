/**
 * Tells whether the `LISTEN` connection still delivers notifications.
 *
 * postgres.js re-establishes a lost `LISTEN` connection by itself, but it gives no signal while the
 * connection is down: until it is back, notifications are lost silently. The heartbeat sends a
 * notification to itself every `interval` (through the main pool), and counts the connection as
 * unhealthy when none has come back for {@link UNHEALTHY_AFTER_INTERVALS} intervals.
 *
 * Time is measured on the monotonic clock (`performance.now()`): a step back of the wall clock
 * would otherwise keep a dead connection healthy until the clock catches up.
 */
export class LilypadListenHeartbeat {
  /** Missed beats (as a number of intervals) after which the connection counts as unhealthy. */
  static readonly UNHEALTHY_AFTER_INTERVALS = 2.5;

  private lastBeat?: number | undefined;
  private timer?:
    (ReturnType<typeof setInterval> & { unref?: (() => void) | undefined }) | undefined;

  /**
   * @param interval - Time between two heartbeats, in ms.
   * @param send - Sends one heartbeat notification.
   * @param onError - Receives the errors of `send` (a missed beat is enough of a consequence).
   */
  constructor(
    private readonly interval: number,
    private readonly send: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Starts sending heartbeats; the connection counts as healthy from now. */
  start(now: number = performance.now()): void {
    if (this.timer) {
      return;
    }
    this.lastBeat = now;
    this.timer = setInterval(() => {
      this.send().catch(this.onError);
    }, this.interval);
    // Do not keep the Node.js event loop alive
    this.timer.unref?.();
  }

  /** Records a heartbeat received on the `LISTEN` connection. */
  beat(now: number = performance.now()): void {
    if (this.timer) {
      this.lastBeat = now;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lastBeat = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Whether a heartbeat came back recently. `false` when stopped. */
  healthy(now: number = performance.now()): boolean {
    return (
      this.lastBeat !== undefined &&
      now - this.lastBeat <= this.interval * LilypadListenHeartbeat.UNHEALTHY_AFTER_INTERVALS
    );
  }
}
