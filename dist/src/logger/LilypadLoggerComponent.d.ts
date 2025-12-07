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
    private getTimestamp;
    private formatMessage;
    output(type: T, message: string, options?: LilypadLoggerComponentOptions<T>): Promise<void>;
    protected abstract send(message: string): Promise<void>;
}
export {};
