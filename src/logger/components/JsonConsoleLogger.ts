import LilypadLoggerComponent, {
  safeJson,
  writeToConsole,
  type LilypadLogRecord,
} from '../LilypadLoggerComponent';

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
export default class LilypadJsonConsoleLogger<T extends string> extends LilypadLoggerComponent<T> {
  protected override async sendRecord(record: LilypadLogRecord<T>): Promise<void> {
    const errors = record.parts.filter((part): part is Error => part instanceof Error);
    const line = safeJson({
      ...record.context,
      time: record.timestamp.toISOString(),
      level: record.type,
      ...(record.loggerName !== undefined && { logger: record.loggerName }),
      msg: record.message,
      ...(errors.length > 0 && {
        errors: errors.map((error) => ({
          name: error.name,
          message: error.message,
          stack: error.stack,
        })),
      }),
    });
    await this.send(line, record.type);
  }

  protected send(message: string, type: T): Promise<void> {
    writeToConsole(message, type);
    return Promise.resolve();
  }
}
