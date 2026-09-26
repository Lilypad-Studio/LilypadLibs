import { LilypadSingletonAble } from './singleton.js';
import { LilypadPlatform } from './platform.js';
import { a as LilypadLibLogLevel } from './LilypadLibLogger-DPBngeVh.js';
export { L as LilypadLibLogger } from './LilypadLibLogger-DPBngeVh.js';

/**
 * A log message, as received by the components.
 */
type LilypadLogRecord<T extends string = string> = {
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
declare abstract class LilypadLoggerComponent<T extends string> {
    /**
     * Formats a record as `<ISO timestamp> - [name] [TYPE]: <message> <context as JSON>`.
     */
    protected formatRecord(record: LilypadLogRecord<T>): string;
    /**
     * Sends a record to the output. A rejection is reported by the logger to its `errorLogging`.
     */
    abstract write(record: LilypadLogRecord<T>): Promise<void>;
}

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => void | Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 */
type LilypadLoggerConstructorOptions<T extends string> = {
    components: Record<T, LilypadLoggerComponent<T>[]>;
    name?: string;
    errorLogging?: (error: unknown) => void | Promise<void>;
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
    /**
     * The keys whose values are replaced with `[Redacted]` in the messages and in the context, at
     * any depth (compared ignoring case, `-` and `_`). Defaults to
     * {@link LILYPAD_DEFAULT_REDACTED_KEYS} (authorization headers, cookies, passwords, tokens...);
     * extend it with `[...LILYPAD_DEFAULT_REDACTED_KEYS, 'ssn']`, or pass `false` to redact nothing.
     * The `parts` of a record are never redacted.
     */
    redact?: readonly string[] | false;
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
    /** The name given in the options, added to each record. */
    readonly name?: string;
    /** The messages still being sent, awaited by `flush`. */
    private _pending;
    /**
     * Creates a new LilypadLogger instance or retrieves a singleton instance.
     *
     * @template T - The log level type, defaults to the levels the other Lilypad modules log on
     * ('error' | 'warn' | 'info' | 'debug'), so that the logger can be passed to them
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
    static create<T extends string = LilypadLibLogLevel>(options: LilypadLoggerConstructorOptions<T>): LilypadLoggerType<T>;
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

/**
 * The keys whose values the logger replaces with `[Redacted]` by default, wherever they appear in
 * a logged value or in the context (e.g. the headers of the request of an HTTP client error).
 * Keys are compared ignoring case, `-` and `_`: `apiKey`, `api_key` and `API-KEY` all match.
 */
declare const LILYPAD_DEFAULT_REDACTED_KEYS: readonly string[];

/**
 * A logger component that outputs messages to the console.
 *
 * @template T - A string literal type representing the logger's category or name.
 *
 * @example
 * ```typescript
 * const logger = new LilypadConsoleLogger<'app'>();
 * ```
 *
 * @remarks
 * This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
 * Messages of type `error` are sent to `console.error`, messages of type `warn` to `console.warn`
 * (case-insensitive), and every other message to `console.log`.
 */
declare class LilypadConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
    write(record: LilypadLogRecord<T>): Promise<void>;
}

/**
 * A logger component that writes one JSON object per message on the console, for log platforms
 * that filter on fields (Vercel logs, log drains, ...).
 *
 * Each line holds `time`, `level` (the channel), `logger` (the logger name), `msg` (the formatted
 * message), the fields of the logger's `context`, and `errors` when Error objects were logged.
 * Channels named `error` go to `console.error`, `warn` to `console.warn` (case-insensitive), the
 * others to `console.log`.
 *
 * @example
 * ```typescript
 * const json = new LilypadJsonConsoleLogger<'error' | 'info'>();
 * const logger = LilypadLogger.create({ components: { error: [json], info: [json] } });
 * logger.info('Invoice created', { id: 'inv_1' });
 * // {"time":"2026-09-24T10:00:00.000Z","level":"info","msg":"Invoice created { id: 'inv_1' }"}
 * ```
 */
declare class LilypadJsonConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
    write(record: LilypadLogRecord<T>): Promise<void>;
}

type LilypadDiscordLoggerOptions = {
    /**
     * Minimum time between two requests to the webhook, in milliseconds. Messages logged in between
     * are sent together in the next request. Defaults to 1000.
     */
    minRequestInterval?: number;
    /**
     * How many times a request rate limited by Discord (429) is retried, after the `retry-after`
     * time (when it is at most 30 seconds). Defaults to 1.
     */
    rateLimitRetries?: number;
    /**
     * Maximum number of messages waiting to be sent. Beyond it the oldest are dropped (their
     * `write` resolves), and the next request says how many were dropped. Defaults to 100.
     */
    maxQueueSize?: number;
};
/**
 * A Discord webhook logger component that sends log messages to a Discord channel.
 *
 * @template T - A string type representing the log level or category.
 * @extends {LilypadLoggerComponent<T>}
 *
 * @example
 * ```typescript
 * const discordLogger = new LilypadDiscordLogger<'info' | 'error' | 'warn'>('https://discordapp.com/api/webhooks/...');
 * const logger = LilypadLogger.create({ components: { error: [discordLogger] } });
 * await logger.error('An important log message');
 * ```
 *
 * @remarks
 * This class uses Discord's webhook API to send messages. Ensure the webhook URL is kept secure
 * and not exposed in version control or client-side code.
 * - Log messages are sent to a third-party service: anything they contain (including data logged
 *   together with errors) becomes visible to the members of the Discord channel.
 * - Mentions are disabled, so a message containing `@everyone` or a user/role mention notifies no one.
 * - Messages longer than 2000 characters are truncated.
 * - Requests are throttled (see {@link LilypadDiscordLoggerOptions}): messages logged while a request
 *   is pending or too recent are batched into one Discord message, up to 2000 characters.
 * - A rate limited request (429) is retried after the `retry-after` time given by Discord, when
 *   it is at most 30 seconds.
 * - A failed request makes `write` reject for one message of the batch (with the number of
 *   messages lost), so the logger reports it once through its `errorLogging` callback.
 * - At most `maxQueueSize` messages wait to be sent: during a flood of messages the oldest are
 *   dropped, so that memory and the pending `write` promises stay bounded.
 */
declare class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
    private webhookUrl;
    private minRequestInterval;
    private rateLimitRetries;
    private maxQueueSize;
    private queue;
    /** Messages dropped since the last batch, announced in the next one. */
    private dropped;
    private flushing;
    private nextRequestAt;
    constructor(webhookUrl: string, options?: LilypadDiscordLoggerOptions);
    write(record: LilypadLogRecord<T>): Promise<void>;
    private enqueue;
    /**
     * Sends the queued messages, one batch at a time. It never rejects: the outcome of each batch
     * settles the promises of its messages.
     */
    private flush;
    /** Takes the queued messages that fit in one Discord message, always at least one. */
    private takeBatch;
    private sendBatch;
    private post;
}

export { LILYPAD_DEFAULT_REDACTED_KEYS, LilypadConsoleLogger, LilypadDiscordLogger, type LilypadDiscordLoggerOptions, LilypadJsonConsoleLogger, LilypadLibLogLevel, type LilypadLogRecord, LilypadLogger, LilypadLoggerComponent, type LilypadLoggerConstructorOptions, type LilypadLoggerType };
