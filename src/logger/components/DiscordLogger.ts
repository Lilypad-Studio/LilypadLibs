import LilypadLoggerComponent from '../LilypadLoggerComponent';

/** Maximum length of the content of a Discord message. */
const DISCORD_MAX_CONTENT_LENGTH = 2000;
const DISCORD_REQUEST_TIMEOUT = 5000;
/** Wait used after a 429 response without a valid `retry-after` header. */
const DEFAULT_RETRY_AFTER = 1000;

export type LilypadDiscordLoggerOptions = {
  /**
   * Minimum time between two requests to the webhook, in milliseconds. Messages logged in between
   * are sent together in the next request. Defaults to 1000.
   */
  minRequestInterval?: number;
  /** How many times a request rate limited by Discord (429) is retried. Defaults to 1. */
  rateLimitRetries?: number;
};

type QueuedMessage = {
  content: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
export default class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
  private webhookUrl: string;
  private minRequestInterval: number;
  private rateLimitRetries: number;

  private queue: QueuedMessage[] = [];
  private flushing = false;
  private nextRequestAt = 0;

  constructor(webhookUrl: string, options: LilypadDiscordLoggerOptions = {}) {
    super();
    this.webhookUrl = webhookUrl;
    this.minRequestInterval = options.minRequestInterval ?? 1000;
    this.rateLimitRetries = options.rateLimitRetries ?? 1;
  }

  protected send(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH), resolve, reject });
      void this.flush();
    });
  }

  /**
   * Sends the queued messages, one batch at a time. It never rejects: the outcome of each batch
   * settles the promises of its messages.
   */
  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.nextRequestAt - Date.now();
        if (wait > 0) {
          await sleep(wait);
        }
        await this.sendBatch(this.takeBatch());
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Takes the queued messages that fit in one Discord message, always at least one. */
  private takeBatch(): QueuedMessage[] {
    let length = this.queue[0].content.length;
    let count = 1;
    while (
      count < this.queue.length &&
      length + 1 + this.queue[count].content.length <= DISCORD_MAX_CONTENT_LENGTH
    ) {
      length += 1 + this.queue[count].content.length;
      count++;
    }
    return this.queue.splice(0, count);
  }

  private async sendBatch(batch: QueuedMessage[]): Promise<void> {
    const content = batch.map((message) => message.content).join('\n');
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await this.post(content);
        this.nextRequestAt = Date.now() + this.minRequestInterval;

        if (response.status === 429 && attempt < this.rateLimitRetries) {
          this.nextRequestAt = Date.now() + retryAfterMs(response);
          await sleep(this.nextRequestAt - Date.now());
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Discord webhook request failed with status ${response.status} ${response.statusText}`
          );
        }
        batch.forEach((message) => message.resolve());
        return;
      }
    } catch (error) {
      this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.minRequestInterval);
      batch.forEach((message) => message.reject(error));
    }
  }

  private post(content: string): Promise<Response> {
    return fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT),
    });
  }
}

/** The wait requested by a 429 response: `retry-after` is in seconds. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER;
}
