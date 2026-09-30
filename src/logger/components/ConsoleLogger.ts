import {
  LilypadLoggerComponent,
  writeToConsole,
  type LilypadLogRecord,
} from '../LilypadLoggerComponent';

/**
 * A logger component that outputs messages to the console.
 *
 * @template T - The channels of the logger it is registered on (e.g. `'error' | 'info'`).
 *
 * @example
 * ```typescript
 * const output = new LilypadConsoleLogger<'error' | 'info'>();
 * const logger = LilypadLogger.create({ components: { error: [output], info: [output] } });
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
