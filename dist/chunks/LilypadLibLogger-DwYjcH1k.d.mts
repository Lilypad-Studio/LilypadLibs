//#region src/logger/LilypadLibLogger.d.ts
/** The levels the Lilypad modules log on. */
type LilypadLibLogLevel = 'error' | 'warn' | 'info' | 'debug';
/**
 * The logger accepted by the other Lilypad modules: any object with some of these methods, such as
 * a `LilypadLogger`, `console` or pino. The levels it lacks are skipped.
 */
type LilypadLibLogger = { [L in LilypadLibLogLevel]?: (...message: unknown[]) => unknown; };
//#endregion
export { LilypadLibLogger as n, LilypadLibLogLevel as t };
//# sourceMappingURL=LilypadLibLogger-DwYjcH1k.d.mts.map