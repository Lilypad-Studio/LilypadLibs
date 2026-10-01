import type {
  LilypadDbNotification,
  LilypadDbCacheListenSync,
  LilypadDbSyncHost,
  LilypadDbSyncStrategy,
} from '@/dbCache/sync/LilypadDbSyncTypes';
import {
  getLilypadNotificationRouter,
  type LilypadNotificationRouter,
  type LilypadNotificationSubscriber,
} from '@/dbCache/sync/LilypadNotificationRouter';
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import { LilypadBackoff } from '@/internal/LilypadBackoff';

/**
 * The most notifications of its table a cache applies one by one per second. Anyone can send a
 * notification, and each one costs a removal from the shared level and an invalidation event (a
 * `TRUNCATE` or a `BULK`, an expiration of every entry): beyond the budget, the notifications of the
 * second are applied as one change of the whole table (see `overflow`).
 */
const NOTIFICATIONS_PER_SECOND = 2000;
const BUDGET_WINDOW = 1000;
/** At most one warning about the notifications beyond the budget per this many ms. */
const OVERFLOW_WARNING_INTERVAL = 60_000;

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
  /** With `applyChanges: false`, the notifications of the writes of this instance are not applied. */
  readonly seesOwnWrites: boolean;
  private readonly router: LilypadNotificationRouter;
  private readonly subscriber: LilypadNotificationSubscriber;
  private readonly applyChanges: boolean;
  private listening?: Promise<void> | undefined;
  private readonly backoff = new LilypadBackoff(() => 1000);
  /** Since when `LISTEN` delivers every change to this instance. */
  private listenTrustedSince?: number | undefined;
  /**
   * The notifications applied in the current second (`performance.now()`), and whether a change
   * of the whole table was: at most one per second is applied at once.
   */
  private budget = { start: -Infinity, count: 0, tableWide: false, warned: false };
  /** The last warning about a second beyond the budget, and the seconds beyond it not logged since. */
  private overflowWarning = { warnedAt: -Infinity, unlogged: 0 };
  /** The change of the whole table due at the end of the second, for the notifications beyond it. */
  private overflowTimer?:
    (ReturnType<typeof setTimeout> & { unref?: (() => void) | undefined }) | undefined;

  constructor(
    private readonly host: LilypadDbSyncHost<K>,
    private readonly options: LilypadDbCacheListenSync
  ) {
    this.applyChanges = options.applyChanges !== false;
    this.seesOwnWrites = this.applyChanges;
    this.router = getLilypadNotificationRouter(host.gate, options.channel);
    this.subscriber = {
      table: host.tableName.split('.').pop()!,
      handle: (payload) => this.handleNotification(payload),
      // Notifications sent while the connection was down are lost: every entry may be stale, the
      // shared copies too (every instance may have lost them), and rows may have been inserted
      onReconnect: () => {
        if (host.isDisposed()) {
          return;
        }
        this.applyTableChange();
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
    if (this.listening || this.options.connect !== 'lazy' || !this.backoff.ready()) {
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
      if (!this.takeBudget(payload.op === 'TRUNCATE' || payload.op === 'BULK')) {
        this.overflow();
      } else if (payload.op === 'TRUNCATE') {
        host.emitInvalidation('notification', host.applyTruncate('eager'), { wholeCache: true });
      } else if (payload.op === 'BULK') {
        this.applyTableChange();
      } else {
        const key = await host.applyChange(payload.op, payload.id!, 'eager', parseXid(payload.xid));
        host.emitInvalidation('notification', [key]);
      }
    }
    await this.options.onNotification?.(payload);
  }

  /**
   * Takes one notification from the budget of this second: `false` once it is spent, or for a
   * change of the whole table when one was already applied in this second.
   */
  private takeBudget(tableWide: boolean): boolean {
    const now = performance.now();
    if (now - this.budget.start >= BUDGET_WINDOW) {
      this.budget = { start: now, count: 0, tableWide: false, warned: false };
    }
    if (this.budget.count >= NOTIFICATIONS_PER_SECOND || (tableWide && this.budget.tableWide)) {
      return false;
    }
    this.budget.count++;
    this.budget.tableWide ||= tableWide;
    return true;
  }

  /**
   * Applies a notification beyond the budget as a change of the whole table: at once if none was
   * applied in this second, otherwise once at its end, for every notification left until then. The
   * cost of a flood of notifications is then bounded, whatever their number: a change of every
   * row, as for a `BULK` notification, without a removal from the shared level per key.
   */
  private overflow() {
    if (this.budget.count >= NOTIFICATIONS_PER_SECOND && !this.budget.warned) {
      this.budget.warned = true;
      this.warnOverflow();
    }
    if (!this.budget.tableWide) {
      this.budget.tableWide = true;
      this.applyTableChange();
      return;
    }
    if (this.overflowTimer) {
      return;
    }
    const remaining = this.budget.start + BUDGET_WINDOW - performance.now();
    this.overflowTimer = setTimeout(
      () => {
        this.overflowTimer = undefined;
        if (this.host.isDisposed()) {
          return;
        }
        // Counts as the change of the whole table of the next second
        this.budget = { start: performance.now(), count: 0, tableWide: true, warned: false };
        this.applyTableChange();
      },
      Math.max(0, remaining)
    );
    this.overflowTimer.unref?.();
  }

  /** Logs a second beyond the budget, at most once a minute: a flood must not flood the logs too. */
  private warnOverflow() {
    const now = performance.now();
    if (now - this.overflowWarning.warnedAt < OVERFLOW_WARNING_INTERVAL) {
      this.overflowWarning.unlogged++;
      return;
    }
    const unlogged = this.overflowWarning.unlogged;
    this.overflowWarning = { warnedAt: now, unlogged: 0 };
    this.host.log(
      'warn',
      `More than ${NOTIFICATIONS_PER_SECOND} notifications in a second on the ${this.options.channel} channel: the others are applied as a change of the whole table${unlogged > 0 ? ` (and in ${unlogged} more second${unlogged === 1 ? '' : 's'} since the last warning)` : ''}.`
    );
  }

  private applyTableChange() {
    this.host.applyBulkChange();
    this.host.emitInvalidation('notification', [], { wholeCache: true });
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
    clearTimeout(this.overflowTimer);
    this.overflowTimer = undefined;
    await this.listening?.catch(() => {});
    await this.router.unsubscribe(this.subscriber);
  }
}
