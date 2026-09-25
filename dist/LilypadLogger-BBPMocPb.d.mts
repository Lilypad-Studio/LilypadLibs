import { LilypadSingletonAble } from './singleton.mjs';
import { LilypadPlatform } from './platform.mjs';

/**
 * A log message, as received by the components.
 */
type LilypadLogRecord<T extends string = string> = {
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
interface LilypadLoggerComponentOptions<T extends string> {
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
declare abstract class LilypadLoggerComponent<T extends string> {
    /**
     * Formats a record as `<ISO timestamp> - [name] [TYPE]: <message> <context as JSON>`.
     */
    protected formatRecord(record: LilypadLogRecord<T>): string;
    output(type: T, message: string, options?: LilypadLoggerComponentOptions<T>): Promise<void>;
    /**
     * Sends a record to the output. By default it formats the record with {@link formatRecord}
     * and passes it to {@link send}.
     */
    protected sendRecord(record: LilypadLogRecord<T>): Promise<void>;
    /**
     * Sends an already formatted message to the specific output channel.
     *
     * @param message - The formatted message.
     * @param type - The log type of the message, for outputs that route messages by severity.
     */
    protected abstract send(message: string, type: T): Promise<void>;
}

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 */
type LilypadLoggerConstructorOptions<T extends string> = {
    components: Record<T, LilypadLoggerComponent<T>[]>;
    name?: string;
    errorLogging?: (error: unknown) => Promise<void>;
    /**
     * `platform.background` receives every message being sent, so that the instance stays alive
     * until it is sent even after the response (serverless platforms).
     */
    platform?: Pick<LilypadPlatform, 'background'>;
    /**
     * Called synchronously for every message: its fields are added to the record (e.g. a request id
     * read from `AsyncLocalStorage`). If it throws, the message is logged without context.
     */
    context?: () => Record<string, unknown> | undefined;
} & LilypadSingletonAble;
type ChannelMethodFunction = (...message: unknown[]) => Promise<void>;
type ChannelMethods<T extends string> = {
    [K in T]: ChannelMethodFunction;
};
/**
 * A generic logger that dynamically creates logging methods based on component types.
 *
 * @template T - A string literal union type representing the available log types/channels
 *
 * @example
 * ```typescript
 * const logger = LilypadLogger.create<'info' | 'error' | 'warn'>({
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
    /** The messages still being sent, awaited by `flush`. */
    private _pending;
    /**
     * Creates a new LilypadLogger instance or retrieves a singleton instance.
     *
     * @template T - The log level type, defaults to 'log' | 'error' | 'warn'
     * @param options - Configuration options for the logger
     * @param options.singleton - Whether to use a singleton instance
     * @param options.singletonIdentifier - Unique identifier for the singleton instance
     * @returns A LilypadLogger instance typed according to the generic parameter T
     *
     * @example
     * // Create a new logger instance
     * const logger = LilypadLogger.create<'info' | 'error'>({
     *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
     * });
     *
     * @example
     * // Create or retrieve a singleton logger (later calls ignore their options)
     * const singletonLogger = LilypadLogger.create<'info' | 'error'>({
     *   singleton: true,
     *   singletonIdentifier: 'app-logger',
     *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
     * });
     */
    static create<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;
    private constructor();
    /**
     * Registers new logger components for specified types.
     * @param newComponents - A partial record mapping component types to arrays of logger components to register
     * @returns The current logger instance for method chaining
     */
    register(newComponents: Partial<Record<T, LilypadLoggerComponent<T>[]>>): this;
    /**
     * Resolves once every message logged so far has been sent (or has failed and been reported).
     * Useful before the process exits, or at the end of a serverless request without `platform`.
     */
    flush(): Promise<void>;
}
type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;
/** The logger accepted by the other Lilypad modules. */
type LilypadLibLogger = LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
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
 * @deprecated Use {@link LilypadLogger.create} instead.
 */
declare function createLogger<T extends string = 'log' | 'error' | 'warn'>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;

export { LilypadLogger as L, type LilypadLibLogger as a, type LilypadLoggerConstructorOptions as b, createLogger as c, type LilypadLoggerType as d, LilypadLoggerComponent as e, type LilypadLogRecord as f, type LilypadLoggerComponentOptions as g };
