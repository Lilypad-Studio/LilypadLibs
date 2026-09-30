import { safeJson } from '@/logger/formatLogValue';
/**
 * A log message, as received by the components.
 */
export type LilypadLogRecord<T extends string = string> = {
  /** The channel the message was logged on. */
  type: T;
  /**
   * The parts passed to the channel method, formatted and joined by spaces, with the values of the
   * redacted keys replaced (see the logger's `redact` option).
   */
  message: string;
  /** The parts passed to the channel method, as they were (not redacted). */
  parts: unknown[];
  timestamp: Date;
  loggerName?: string | undefined;
  /**
   * The result of the logger's `context` option when the message was logged: its JSON-safe copy,
   * redacted (see `toLogJson`).
   */
  context?: Record<string, unknown> | undefined;
};

/**
 * Abstract base class of the outputs of a {@link LilypadLogger}: a component implements
 * {@link write}, which receives each record of the channels it is registered on. Use
 * {@link formatRecord} for a line of text.
 *
 * @template T - A string literal type representing the log message types (e.g., 'INFO', 'ERROR', 'WARN')
 *
 * @example
 * ```typescript
 * class StderrLogger extends LilypadLoggerComponent<'info' | 'error'> {
 *   async write(record: LilypadLogRecord<'info' | 'error'>): Promise<void> {
 *     process.stderr.write(this.formatRecord(record) + '\n');
 *   }
 * }
 * ```
 */
export abstract class LilypadLoggerComponent<T extends string> {
  /**
   * Formats a record as `<ISO timestamp> - [name] [TYPE]: <message> <context as JSON>`.
   */
  protected formatRecord(record: LilypadLogRecord<T>): string {
    let formatted = `${record.timestamp.toISOString()} - `;

    if (record.loggerName) {
      formatted += `[${record.loggerName}] `;
    }

    formatted += `[${record.type.toUpperCase()}]: ${record.message}`;
    if (record.context && Object.keys(record.context).length > 0) {
      formatted += ` ${safeJson(record.context)}`;
    }
    return formatted;
  }

  /**
   * Sends a record to the output. A rejection is reported by the logger to its `errorLogging`.
   */
  abstract write(record: LilypadLogRecord<T>): Promise<void>;
}

/**
 * Writes a message on the console: channels named `error` go to `console.error`, `warn` to
 * `console.warn` (case-insensitive), the others to `console.log`.
 */
export function writeToConsole(message: string, type: string): void {
  switch (type.toLowerCase()) {
    case 'error':
      console.error(message);
      break;
    case 'warn':
      console.warn(message);
      break;
    default:
      console.log(message);
  }
}

/** `JSON.stringify` that never throws (circular references, BigInts): see `toLogJson`. */
export { safeJson } from '@/logger/formatLogValue';
