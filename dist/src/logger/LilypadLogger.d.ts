import LilypadLoggerComponent from 'logger/LilypadLoggerComponent';
/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => void} [errorLogging] - Optional callback function to handle logging errors.
 */
export interface LilypadLoggerConstructorOptions<T extends string> {
    components: Record<T, LilypadLoggerComponent<T>[]>;
    name?: string;
    errorLogging?: (error: unknown) => Promise<void>;
}
type ChannelMethods<T extends string> = {
    [K in T]: (message: unknown) => Promise<void>;
};
/**
 * A generic logger that dynamically creates logging methods based on component types.
 *
 * @template T - A string literal union type representing the available log types/channels
 *
 * @example
 * ```typescript
 * const logger = new LilypadLogger<'info' | 'error' | 'warn'>({
 *   components: {
 *     info: [consoleComponent],
 *     error: [consoleComponent, fileComponent],
 *     warn: [consoleComponent]
 *   }
 * });
 *
 * logger.info('Information message');
 * logger.error('Error message');
 * logger.warn('Warning message');
 * ```
 *
 * @remarks
 * The logger creates dynamic methods on the instance for each log type defined in the constructor options.
 * Each method accepts a message string and routes it to all registered components of that type.
 * Errors thrown by components are caught and handled via the errorLogging callback if provided.
 */
declare class LilypadLogger<T extends string> {
    private components;
    private _name?;
    get __name(): string | undefined;
    constructor(options: LilypadLoggerConstructorOptions<T>);
    /**
     * Registers new logger components for specified types.
     * @param newComponents - A partial record mapping component types to arrays of logger components to register
     * @returns The current logger instance for method chaining
     */
    register(newComponents: Partial<Record<T, LilypadLoggerComponent<T>[]>>): this;
}
export type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;
/**
 * Creates a new Lilypad logger instance with the specified options.
 *
 * @template T - The type of log channels supported by this logger. Defaults to 'log' | 'error' | 'warn'.
 * @param options - Configuration options for the logger instance.
 * @returns A new logger instance that combines LilypadLogger functionality with channel methods.
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   // logger options
 * });
 * ```
 */
export default function createLogger<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;
export {};
