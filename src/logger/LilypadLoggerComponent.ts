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
export default abstract class LilypadLoggerComponent<T extends string> {
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

/** `JSON.stringify` that never throws (circular references, BigInts). */
export function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') {
        return `${item}n`;
      }
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack };
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) {
          return '[Circular]';
        }
        seen.add(item);
      }
      return item;
    });
  } catch {
    return '"[Unserializable]"';
  }
}
