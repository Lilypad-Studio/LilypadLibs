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
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import { LilypadBackoff } from '@/internal/LilypadBackoff';

function parseXid(xid: string | undefined): bigint | undefined {
  return xid !== undefined && /^\d+$/.test(xid) ? BigInt(xid) : undefined;
}

/**
 * The `listen` strategy: the cache subscribes to the notification channel of its config (through
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
  private listening?: Promise<void> | undefined;
  private readonly backoff = new LilypadBackoff(() => 1000);
  /** Since when `LISTEN` delivers every change to this instance. */
  private listenTrustedSince?: number | undefined;

  constructor(
    private readonly host: LilypadDbSyncHost<K>,
    private readonly options: LilypadDbCacheListenSync
  ) {
    this.applyChanges = options.applyChanges !== false;
    this.router = getLilypadNotificationRouter(host.gate, options.channel);
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
      log: (level, message, detail) => host.log(level, message, detail),
    };
  }

  start(): Promise<void> {
    return this.options.connect === 'lazy' ? Promise.resolve() : this.startListening();
  }

  /**
   * Subscribes once. A failed subscription is retried by the next call, after a backoff for the
   * lazy `LISTEN` of the reads. If the cache was disposed meanwhile, it unsubscribes again.
   */
  private startListening(): Promise<void> {
    this.listening ??= this.router
      .subscribe(this.subscriber)
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
    return this.listening;
  }

  beforeRead(): Promise<void> | undefined {
    if (this.listening || this.options.connect !== 'lazy' || !this.backoff.ready(Date.now())) {
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
    host.log('debug', `Received a notification on the ${this.options.channel} channel:`, payload);
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
   * cache: `schema`, when the trigger sends it, must match.
   */
  private isForSchema(payload: LilypadDbNotification): boolean {
    return payload.schema === undefined || payload.schema === this.host.tableSchema;
  }

  /** Waits for a `LISTEN` still starting, then unsubscribes. It never rejects. */
  async dispose(): Promise<void> {
    await this.listening?.catch(() => {});
    await this.router.unsubscribe(this.subscriber);
  }
}
