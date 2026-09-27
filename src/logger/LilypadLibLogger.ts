/** The levels the Lilypad modules log on. */
export type LilypadLibLogLevel = 'error' | 'warn' | 'info' | 'debug';

/** The structured part of a message of a Lilypad module. */
export type LilypadLogMeta = {
  /** The instance that logs: the `name` of a cache, the `id` of a gate, or the class name. */
  source: string;
  /** The error the message is about, if any. */
  error?: unknown;
  /** Another value the message is about (e.g. a malformed notification), if any. */
  detail?: unknown;
};

/**
 * The logger accepted by the other Lilypad modules: any object with some of these methods, such as
 * a `LilypadLogger` or `console`, which receive the message and then its {@link LilypadLogMeta}.
 * The levels it lacks are skipped. For pino, which takes the fields first, wrap it with
 * {@link lilypadPinoLogger}.
 */
export type LilypadLibLogger = {
  [L in LilypadLibLogLevel]?: (message: string, meta: LilypadLogMeta) => unknown;
};

/**
 * Logs a message on a level of a library logger. It never throws, and ignores the rejection of a
 * returned promise: a failing logger must not break the module that logs, nor terminate the
 * Node.js process with an unhandled rejection.
 *
 * @param source - The instance that logs (see {@link LilypadLogMeta.source}).
 * @param detail - The value the message is about: an `Error` goes to `meta.error`, anything else to
 * `meta.detail`.
 */
export function libLog(
  logger: LilypadLibLogger | undefined,
  level: LilypadLibLogLevel,
  source: string,
  message: string,
  detail?: unknown
): void {
  const method = logger?.[level];
  if (!method) {
    return;
  }
  const meta: LilypadLogMeta =
    detail === undefined
      ? { source }
      : detail instanceof Error
        ? { source, error: detail }
        : { source, detail };
  try {
    const result = method.call(logger, message, meta);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Ignored, see above
  }
}

/** The methods of a pino logger that {@link lilypadPinoLogger} uses. */
export type LilypadPinoLike = {
  [L in LilypadLibLogLevel]?: (fields: object, message: string) => unknown;
};

/**
 * Adapts a pino logger (or any logger that takes the fields first) to {@link LilypadLibLogger}: the
 * meta becomes the fields, with the error under `err`, so that pino serializes its stack.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache({ logger: lilypadPinoLogger(pino()) });
 * ```
 */
export function lilypadPinoLogger(pino: LilypadPinoLike): LilypadLibLogger {
  const logger: LilypadLibLogger = {};
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    const method = pino[level];
    if (method) {
      logger[level] = (message, { source, error, detail }) =>
        method.call(pino, { source, err: error, detail }, message);
    }
  }
  return logger;
}
