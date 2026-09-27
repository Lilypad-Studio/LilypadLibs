import type {
  LilypadDbNotification,
  LilypadDbCacheListenSync,
  LilypadDbSyncHost,
  LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import {
  getLilypadNotificationRouter,
  type LilypadNotificationRouter,
  type LilypadNotificationSubscriber,
} from '@/cache/dbSync/LilypadNotificationRouter';
import type { LilypadSchemaVerifier } from '@/cache/dbSync/LilypadSchemaVerifier';
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import { LILYPAD_DEFAULT_NOTIFY_CHANNEL } from '@/dbGate/LilypadChangelog';
import { LilypadBackoff } from '@/internal/LilypadBackoff';

export { parseLilypadNotification } from '@/cache/dbSync/LilypadNotificationRouter';

function parseXid(xid: string | undefined): bigint | undefined {
  return xid !== undefined && /^\d+$/.test(xid) ? BigInt(xid) : undefined;
}

/**
 * The `listen` strategy: the cache subscribes to the `cache_events` channel of the gate (through
 * the router shared by the caches of the gate), and applies the notifications of its table.
 *
 * It trusts that it sees every change while `LISTEN` is active and the gate's heartbeat is recent
 * (`isListenHealthy`): a connection that stopped delivering notifications is not trusted, even
 * before postgres.js re-establishes it.
 */
export class LilypadListenSync<K extends LilypadCacheKey> implements LilypadDbSyncStrategy {
  readonly seesOwnWrites = true;
  private readonly router: LilypadNotificationRouter;
  private readonly subscriber: LilypadNotificationSubscriber;
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
    this.router = getLilypadNotificationRouter(host.gate, LILYPAD_DEFAULT_NOTIFY_CHANNEL);
    this.subscriber = {
      table: host.tableName.split('.').pop()!,
      handle: (payload) => this.handleNotification(payload),
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
      log: (level, ...message) => host.log(level, ...message),
    };
  }

  start(): Promise<void> {
    return this.options.connect === 'lazy' ? Promise.resolve() : this.startListening();
  }

  /**
   * Subscribes once, after the schema check (which resolves the schema of the table, to ignore the
   * notifications of other schemas). A failed subscription is retried by the next call, after a
   * backoff for the lazy `LISTEN` of the reads. If the cache was disposed meanwhile, it
   * unsubscribes again.
   */
  private startListening(): Promise<void> {
    if (!this.listening) {
      this.listening = this.verifier
        .verify()
        .then(() => this.router.subscribe(this.subscriber))
        .then(async () => {
          if (this.host.isDisposed()) {
            // dispose() ran while LISTEN was starting: it found no subscription to remove
            await this.router.unsubscribe(this.subscriber);
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

  private async handleNotification(payload: LilypadDbNotification): Promise<void> {
    const { host } = this;
    if (host.isDisposed() || !this.isForSchema(payload)) {
      return;
    }
    host.log('debug', 'Received a notification on the cache_events channel:', payload);
    if (this.applyChanges) {
      if (payload.op === 'TRUNCATE') {
        host.emitInvalidation('notification', host.applyTruncate('eager'), { wholeCache: true });
      } else if (payload.op === 'BULK') {
        host.applyBulkChange();
        host.emitInvalidation('notification', [], { wholeCache: true });
      } else {
        const key = await host.applyChange(payload.op, payload.id!, 'eager', parseXid(payload.xid));
        host.emitInvalidation('notification', [key]);
      }
    }
    await this.options.onNotification?.(payload);
  }

  /**
   * Whether a notification of the table (the router matched its name) is about the schema of this
   * cache: `schema`, when the trigger sends it and the schema of the table is known, must match.
   */
  private isForSchema(payload: LilypadDbNotification): boolean {
    const tableSchema = this.host.tableSchema();
    return (
      payload.schema === undefined || tableSchema === undefined || payload.schema === tableSchema
    );
  }

  /** Waits for a `LISTEN` still starting, then unsubscribes. It never rejects. */
  async dispose(): Promise<void> {
    await this.listening?.catch(() => {});
    await this.router.unsubscribe(this.subscriber);
  }
}
