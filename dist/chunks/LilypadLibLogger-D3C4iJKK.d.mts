//#region src/logger/LilypadLibLogger.d.ts
/** The levels the Lilypad modules log on. */
type LilypadLibLogLevel = 'error' | 'warn' | 'info' | 'debug';
/** The structured part of a message of a Lilypad module. */
type LilypadLogMeta = {
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
type LilypadLibLogger = { [L in LilypadLibLogLevel]?: (message: string, meta: LilypadLogMeta) => unknown; };
/** The methods of a pino logger that {@link lilypadPinoLogger} uses. */
type LilypadPinoLike = { [L in LilypadLibLogLevel]?: (fields: object, message: string) => unknown; };
/**
 * Adapts a pino logger (or any logger that takes the fields first) to {@link LilypadLibLogger}: the
 * meta becomes the fields, with the error under `err`, so that pino serializes its stack.
 *
 * @example
 * ```typescript
 * const cache = new LilypadCache({ logger: lilypadPinoLogger(pino()) });
 * ```
 */
declare function lilypadPinoLogger(pino: LilypadPinoLike): LilypadLibLogger;
//#endregion
export { lilypadPinoLogger as a, LilypadPinoLike as i, LilypadLibLogger as n, LilypadLogMeta as r, LilypadLibLogLevel as t };
//# sourceMappingURL=LilypadLibLogger-D3C4iJKK.d.mts.map