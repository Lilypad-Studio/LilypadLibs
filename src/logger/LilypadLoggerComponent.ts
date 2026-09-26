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
  loggerName?: string;
  /** The result of the logger's `context` option when the message was logged, redacted. */
  context?: Record<string, unknown>;
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
 *     process.stderr.write(this.formatRecord(record) + '
');
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

/**
 * `JSON.stringify` that never throws (circular references, BigInts). Only a reference to one of
 * its own ancestors prints as `[Circular]`: an object referenced twice side by side is printed twice.
 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafe(value, new Set()));
  } catch {
    return '"[Unserializable]"';
  }
}

function toJsonSafe(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return '[Circular]';
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return toJsonSafe((json as () => unknown).call(value), ancestors);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonSafe(item, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonSafe(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
