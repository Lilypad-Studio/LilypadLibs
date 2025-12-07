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
  private formatMessage(type: T, message: string): string {
    return `${this.getTimestamp()} - [${type}]: ${message}`;
  }

  async output(type: T, message: string): Promise<void> {
    const formattedMessage = this.formatMessage(type, message);
    await this.send(formattedMessage);
  }

  // Sends an already formatted message to the specific output channel
  protected abstract send(message: string): Promise<void>;
}
