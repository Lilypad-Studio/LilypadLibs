import { e as LilypadLoggerComponent, f as LilypadLogRecord } from './LilypadLogger-Bgz_B7cT.js';
export { a as LilypadLibLogger, L as LilypadLogger, g as LilypadLoggerComponentOptions, b as LilypadLoggerConstructorOptions, d as LilypadLoggerType, c as createLogger } from './LilypadLogger-Bgz_B7cT.js';
import './singleton.js';
import './platform.js';

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
    protected send(message: string, type: T): Promise<void>;
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
    protected sendRecord(record: LilypadLogRecord<T>): Promise<void>;
    protected send(message: string, type: T): Promise<void>;
}

type LilypadDiscordLoggerOptions = {
    /**
     * Minimum time between two requests to the webhook, in milliseconds. Messages logged in between
     * are sent together in the next request. Defaults to 1000.
     */
    minRequestInterval?: number;
    /** How many times a request rate limited by Discord (429) is retried. Defaults to 1. */
    rateLimitRetries?: number;
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
 * - A rate limited request (429) is retried after the `retry-after` time given by Discord.
 * - A failed request makes `output` reject for every message of the batch, so the logger reports
 *   it through its `errorLogging` callback.
 */
declare class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
    private webhookUrl;
    private minRequestInterval;
    private rateLimitRetries;
    private queue;
    private flushing;
    private nextRequestAt;
    constructor(webhookUrl: string, options?: LilypadDiscordLoggerOptions);
    protected send(message: string): Promise<void>;
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

export { LilypadConsoleLogger, LilypadDiscordLogger, type LilypadDiscordLoggerOptions, LilypadJsonConsoleLogger, LilypadLogRecord, LilypadLoggerComponent };
