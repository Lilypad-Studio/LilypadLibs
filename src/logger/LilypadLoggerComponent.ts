import type { LilypadLogger } from './LilypadLogger';

/**
 * A log message, as received by the components.
 */
export type LilypadLogRecord<T extends string = string> = {
  /** The channel the message was logged on. */
  type: T;
  /** The parts passed to the channel method, formatted and joined by spaces. */
  message: string;
  /** The parts passed to the channel method, as they were. */
  parts: unknown[];
  timestamp: Date;
  loggerName?: string;
  /** The result of the logger's `context` option when the message was logged. */
  context?: Record<string, unknown>;
};

export interface LilypadLoggerComponentOptions<T extends string> {
  logger: ReturnType<typeof LilypadLogger.create<T>>;
  /**
   * Set by the logger; components called directly build a minimal one. Typed with `string`, so
   * that components typed with different channel unions stay assignable to each other.
   */
  record?: LilypadLogRecord;
}

/**
 * Abstract base class for logging components in the Lilypad library.
 *
 * Provides a template for implementing custom loggers with standardized message formatting.
 * Subclasses implement {@link send}, which receives the formatted text, or override
 * {@link sendRecord} to receive the structured record (e.g. to write JSON).
 *
 * @template T - A string literal type representing the log message types (e.g., 'INFO', 'ERROR', 'WARN')
 *
 * @example
 * ```typescript
 * class ConsoleLogger extends LilypadLoggerComponent<'INFO' | 'ERROR' | 'WARN'> {
 *   protected async send(message: string): Promise<void> {
 *     console.log(message);
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

  async output(
    type: T,
    message: string,
    options?: LilypadLoggerComponentOptions<T>
  ): Promise<void> {
    const record = (options?.record as LilypadLogRecord<T> | undefined) ?? {
      type,
      message,
      parts: [message],
      timestamp: new Date(),
      loggerName: options?.logger?.__name,
    };
    await this.sendRecord(record);
  }

  /**
   * Sends a record to the output. By default it formats the record with {@link formatRecord}
   * and passes it to {@link send}.
   */
  protected async sendRecord(record: LilypadLogRecord<T>): Promise<void> {
    await this.send(this.formatRecord(record), record.type);
  }

  /**
   * Sends an already formatted message to the specific output channel.
   *
   * @param message - The formatted message.
   * @param type - The log type of the message, for outputs that route messages by severity.
   */
  protected abstract send(message: string, type: T): Promise<void>;
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
