import type {
  LilypadDbCacheDefaultNotificationPayload,
  LilypadDbCacheListenSync,
  LilypadDbSyncHost,
  LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import type { LilypadSchemaVerifier } from '@/cache/dbSync/LilypadSchemaVerifier';
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import { LILYPAD_DEFAULT_NOTIFY_CHANNEL } from '@/dbGate/LilypadChangelog';
import type { ListenerCallbackIdentifier } from '@/dbGate/LilypadDbGate';
import { LilypadBackoff } from '@/internal/LilypadBackoff';

const OPERATIONS = new Set(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']);

/**
 * Parses a notification of the `cache_events` channel.
 *
 * @returns The payload, or `undefined` if it does not have the expected shape.
 */
export function parseLilypadNotification(
  payload: unknown
): LilypadDbCacheDefaultNotificationPayload | undefined {
  if (typeof payload !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { table, op, id, schema, xid } = parsed as Record<string, unknown>;
  if (typeof table !== 'string' || table === '' || typeof op !== 'string' || !OPERATIONS.has(op)) {
    return undefined;
  }
  if (op !== 'TRUNCATE' && !((typeof id === 'string' && id !== '') || typeof id === 'number')) {
    return undefined;
  }
  if (
    (schema !== undefined && typeof schema !== 'string') ||
    (xid !== undefined && typeof xid !== 'string')
  ) {
    return undefined;
  }
  return parsed as LilypadDbCacheDefaultNotificationPayload;
}

function parseXid(xid: string | undefined): bigint | undefined {
  return xid !== undefined && /^\d+$/.test(xid) ? BigInt(xid) : undefined;
}

/**
 * The `listen` strategy: the cache registers a callback on the `cache_events` channel of the gate,
 * and applies the notifications of its table.
 *
 * It trusts that it sees every change while `LISTEN` is active and the gate's heartbeat is recent
 * (`isListenHealthy`): a connection that stopped delivering notifications is not trusted, even
 * before postgres.js re-establishes it.
 */
export class LilypadListenSync<K extends LilypadCacheKey> implements LilypadDbSyncStrategy {
  readonly seesOwnWrites = true;
  private readonly listener: ListenerCallbackIdentifier;
  private readonly applyChanges: boolean;
  private listening?: Promise<void>;
  private readonly backoff = new LilypadBackoff(() => 1000);
  /** Since when `LISTEN` delivers every change to this instance. */
  private listenTrustedSince?: number;

  constructor(
    private readonly host: LilypadDbSyncHost<K>,
    private readonly options: LilypadDbCacheListenSync,
    private readonly verifier: LilypadSchemaVerifier
  ) {
    this.applyChanges = options.applyChanges !== false;
    this.listener = {
      channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${host.tableName}_${host.id}`,
      // Notifications sent while the connection was down are lost: every entry may be stale
      onReconnect: () => {
        if (host.isDisposed()) {
          return;
        }
        host.expireEverything();
        if (this.applyChanges) {
          this.listenTrustedSince = Date.now();
        }
      },
      callback: (payload: unknown) => this.handleNotification(payload),
    };
  }

  start(): Promise<void> {
    return this.options.connect === 'lazy' ? Promise.resolve() : this.startListening();
  }

  /**
   * Registers the listener once, after the schema check (which resolves the schema of the table,
   * to ignore the notifications of other schemas). A failed registration is retried by the next
   * call, after a backoff for the lazy `LISTEN` of the reads. If the cache was disposed meanwhile,
   * the listener is removed again.
   */
  private startListening(): Promise<void> {
    if (!this.listening) {
      const { gate } = this.host;
      this.listening = this.verifier
        .verify()
        .then(() => gate.addListener(this.listener))
        .then(async () => {
          if (this.host.isDisposed()) {
            // dispose() ran while LISTEN was starting: it found no listener to remove
            await gate.removeListener(this.listener.channel, this.listener.callbackId);
            return;
          }
          this.backoff.succeed();
          if (this.applyChanges) {
            this.listenTrustedSince = Date.now();
          }
        })
        .catch((error: unknown) => {
          this.listening = undefined;
          this.backoff.fail();
          throw error;
        });
    }
    return this.listening;
  }

  beforeRead(): Promise<void> | undefined {
    const now = Date.now();
    if (this.listening) {
      // Starting LISTEN ran the check: this only retries one that could not run
      this.verifier.checkInBackground(now);
      return undefined;
    }
    if (this.options.connect !== 'lazy' || !this.backoff.ready(now)) {
      return undefined;
    }
    return this.startListening().catch((error: unknown) => {
      this.host.log('error', 'Error starting LISTEN for the cache:', error);
    });
  }

  trustedSince(): number | undefined {
    return this.host.gate.isListenHealthy() ? this.listenTrustedSince : undefined;
  }

  private async handleNotification(raw: unknown): Promise<void> {
    const { host } = this;
    if (host.isDisposed()) {
      return;
    }
    host.log('debug', 'Received a notification on the cache_events channel:', raw);
    const payload = parseLilypadNotification(raw);
    if (!payload) {
      host.log('warn', 'Ignoring a malformed cache_events notification:', raw);
      return;
    }
    if (!this.isForTable(payload)) {
      return;
    }
    if (this.applyChanges) {
      if (payload.op === 'TRUNCATE') {
        host.emitInvalidation('notification', host.applyTruncate('eager'), { wholeCache: true });
      } else {
        const key = await host.applyChange(payload.op, payload.id!, 'eager', parseXid(payload.xid));
        host.emitInvalidation('notification', [key]);
      }
    }
    await this.options.onNotification?.(payload);
  }

  /**
   * Whether a notification is about the table of this cache. `table` is the name without its
   * schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
   */
  private isForTable(payload: LilypadDbCacheDefaultNotificationPayload): boolean {
    if (payload.table !== this.host.tableName.split('.').pop()) {
      return false;
    }
    const tableSchema = this.host.tableSchema();
    return (
      payload.schema === undefined || tableSchema === undefined || payload.schema === tableSchema
    );
  }

  /** Waits for a `LISTEN` still starting, then removes the listener. It never rejects. */
  async dispose(): Promise<void> {
    await this.listening?.catch(() => {});
    await this.host.gate.removeListener(this.listener.channel, this.listener.callbackId);
  }
}
