import LilypadLoggerComponent, { writeToConsole } from '../LilypadLoggerComponent';

/**
 * A logger component that outputs messages to the console.
 *
 * @template T - A string literal type representing the logger's category or name.
 *
 * @example
 * ```typescript
 * const logger = new LilypadConsoleLogger<'app'>();
 * ```
 *
 * @remarks
 * This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
 * Messages of type `error` are sent to `console.error`, messages of type `warn` to `console.warn`
 * (case-insensitive), and every other message to `console.log`.
 */
export default class LilypadConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
  protected send(message: string, type: T): Promise<void> {
    writeToConsole(message, type);
    return Promise.resolve();
  }
}
