import {
  LilypadLoggerComponent,
  writeToConsole,
  type LilypadLogRecord,
} from '../LilypadLoggerComponent';

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
export class LilypadConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
  write(record: LilypadLogRecord<T>): Promise<void> {
    writeToConsole(this.formatRecord(record), record.type);
    return Promise.resolve();
  }
}
