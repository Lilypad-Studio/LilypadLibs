/** The levels the Lilypad modules log on. */
export type LilypadLibLogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * The logger accepted by the other Lilypad modules: any object with some of these methods, such as
 * a `LilypadLogger`, `console` or pino. The levels it lacks are skipped.
 */
export type LilypadLibLogger = {
  [L in LilypadLibLogLevel]?: (...message: unknown[]) => unknown;
};

/**
 * Logs a message on a level of a library logger. It never throws, and ignores the rejection of a
 * returned promise: a failing logger must not break the module that logs, nor terminate the
 * Node.js process with an unhandled rejection.
 */
export function libLog(
  logger: LilypadLibLogger | undefined,
  level: LilypadLibLogLevel,
  ...message: unknown[]
): void {
  const method = logger?.[level];
  if (!method) {
    return;
  }
  try {
    const result = method.call(logger, ...message);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Ignored, see above
  }
}
