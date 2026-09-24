import LilypadLoggerComponent from '../LilypadLoggerComponent';

/** Maximum length of the content of a Discord message. */
const DISCORD_MAX_CONTENT_LENGTH = 2000;
const DISCORD_REQUEST_TIMEOUT = 5000;

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
 * - A failed request (e.g. rate limited by Discord) makes `output` reject, so the logger reports it
 *   through its `errorLogging` callback.
 */
export default class LilypadDiscordLogger<T extends string> extends LilypadLoggerComponent<T> {
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    super();
    this.webhookUrl = webhookUrl;
  }

  protected async send(message: string): Promise<void> {
    const payload = {
      content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH),
      allowed_mentions: { parse: [] },
    };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      throw new Error(
        `Discord webhook request failed with status ${response.status} ${response.statusText}`
      );
    }
  }
}
