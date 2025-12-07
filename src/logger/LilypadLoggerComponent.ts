import type createLogger from './LilypadLogger';

interface LilypadLoggerComponentOptions<T extends string> {
  logger: ReturnType<typeof createLogger<T>>;
  name?: string;
}

/**
 * Abstract base class for logging components in the Lilypad library.
 *
 * Provides a template for implementing custom loggers with standardized message formatting.
 * Subclasses must implement the {@link send} method to define how formatted messages are output.
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
  private getTimestamp(): string {
    return new Date().toISOString();
  }
  private formatMessage(
    type: T,
    message: string,
    options?: LilypadLoggerComponentOptions<T>
  ): string {
    let formatted = `${this.getTimestamp()} - `;

    if (options?.logger?.__name) {
      formatted += `[${options.logger.__name}] `;
    } else if (options?.name) {
      formatted += `[${options.name}] `;
    }

    formatted += `[${type.toUpperCase()}]: ${message}`;
    return formatted;
  }

  async output(
    type: T,
    message: string,
    options?: LilypadLoggerComponentOptions<T>
  ): Promise<void> {
    const formattedMessage = this.formatMessage(type, message, options);
    await this.send(formattedMessage);
  }

  // Sends an already formatted message to the specific output channel
  protected abstract send(message: string): Promise<void>;
}
