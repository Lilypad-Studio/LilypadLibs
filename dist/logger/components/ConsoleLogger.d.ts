import LilypadLoggerComponent from '../LilypadLoggerComponent';
/**
 * A logger component that outputs messages to the console.
 *
 * @template T - A string literal type representing the logger's category or name.
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger<'app'>();
 * ```
 *
 * @remarks
 * This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
 * Messages are sent to the standard output using `console.log()`.
 */
export default class ConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
    protected send(message: string): Promise<void>;
}
