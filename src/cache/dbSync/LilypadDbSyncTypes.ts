import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import type {
  LilypadDbTableChangelogSync,
  LilypadDbTableListenSync,
} from '@/dbConfig/LilypadDbConfig';
import type { LilypadChangelogCursor } from '@/dbGate/LilypadChangelog';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';
import type { LilypadInvalidationEvent, LilypadPlatform } from '@/platform/LilypadPlatform';

export type LilypadDbNotification = {
  /**
   * The schema of the table. Notifications without it match the table in any schema (the triggers
   * of version 1 of the changelog, and custom triggers that do not send it).
   */
  schema?: string | undefined;
  table: string;
  /**
   * A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`).
   * Absent for `TRUNCATE` and `BULK`.
   */
  id?: string | number | undefined;
  /**
   * `BULK`: one statement changed more rows than the `notifyBulkThreshold` of the trigger, which
   * sends this one notification instead of one per row. The cache expires the whole table.
   */
  op: 'UPDATE' | 'DELETE' | 'INSERT' | 'TRUNCATE' | 'BULK';
  /**
   * The id of the transaction that made the change (sent by the triggers of version 3). It lets
   * the instance that made the change skip its own writes.
   */
  xid?: string | undefined;
};

/**
 * The options of the sync of a table that `LilypadDbCache.create` may change for one cache (the
 * strategy, `maxGap` and `lookback` stay those of the config, which `lilypad-doctor` checks the
 * database against). Each applies to the strategies that have it, and is ignored by the others.
 */
export type LilypadDbCacheSyncOverrides = {
  /** See `maxAge` in the sync of the table. */
  maxAge?: number | undefined;
  /** `listen`: see {@link LilypadDbTableListenSync}. */
  connect?: 'eager' | 'lazy' | undefined;
  /** `listen`: see {@link LilypadDbTableListenSync}. */
  applyChanges?: boolean | undefined;
  /** `listen`: called with every notification of the table, after the cache has applied it. */
  onNotification?: ((payload: LilypadDbNotification) => Promise<void> | void) | undefined;
  /** `changelog`: see {@link LilypadDbTableChangelogSync}. */
  pollInterval?: number | undefined;
  /** `changelog`: see {@link LilypadDbTableChangelogSync}. */
  poll?: 'await' | 'background' | undefined;
};

/** The options of the `listen` strategy of a cache: its table's, with the overrides of the cache. */
export type LilypadDbCacheListenSync = LilypadDbTableListenSync & {
  /** The channel the triggers notify (the `notifyChannel` of the config). */
  channel: string;
  onNotification?: ((payload: LilypadDbNotification) => Promise<void> | void) | undefined;
};

/** The options of the `changelog` strategy of a cache: its table's, with the overrides of the cache. */
export type LilypadDbCacheChangelogSync = LilypadDbTableChangelogSync & {
  /** The changelog table (the `changelog.table` of the config). */
  table: string;
};

export type LilypadDbRowChange = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * How a change reaches the cache:
 * - `eager`: a notification, which anyone can send: the cache re-reads the rows it holds;
 * - `lazy`: a change read from the changelog, which only the triggers write: the cache applies it
 *   without a query, and the next read fetches the row.
 */
export type LilypadDbChangeMode = 'eager' | 'lazy';

/** What the sync strategies need from the cache. */
export type LilypadDbSyncHost<K extends LilypadCacheKey> = {
  readonly id: string;
  readonly name: string;
  readonly gate: LilypadDbGate;
  /** The table, qualified (`schema.table`). */
  readonly tableName: string;
  readonly platform?: LilypadPlatform | undefined;
  log(level: LilypadLibLogLevel, message: string, detail?: unknown): void;
  isDisposed(): boolean;
  /** Applies a change of a row made elsewhere. @returns The key of the row. */
  applyChange(
    op: LilypadDbRowChange,
    id: string | number,
    mode: LilypadDbChangeMode,
    xid?: bigint
  ): Promise<K>;
  /** Applies a `TRUNCATE` of the table. @returns The keys that were cached. */
  applyTruncate(mode: LilypadDbChangeMode): K[];
  /**
   * Applies a change of too many rows to follow them one by one: every entry is expired (no query,
   * no removal from the shared level, whose older copies are ignored), and the next `getAll` loads
   * the table again.
   */
  applyBulkChange(): void;
  /** Expires every entry: the changes made meanwhile may have been missed. */
  expireEverything(): void;
  emitInvalidation(
    source: LilypadInvalidationEvent['source'],
    keys: K[],
    options?: { wholeCache?: boolean | undefined }
  ): void;
  /** Forgets the writes of this instance whose changes a read from `cursor` no longer returns. */
  forgetOwnWritesCoveredBy(cursor: LilypadChangelogCursor): void;
  /** The schema of the table: notifications of other schemas are ignored. */
  readonly tableSchema: string;
  /** The default `lookback` of the changelog: the TTL plus the stale window, plus 1 minute. */
  defaultLookback(): number;
};

/** How a cache follows the changes of its table (one implementation per `sync.strategy`). */
export type LilypadDbSyncStrategy = {
  /** Called by `create`: starts what must be active before the cache is returned. */
  start(): Promise<void>;
  /**
   * Brings the cache up to date before a read. It never rejects.
   *
   * @returns A promise to await, or `undefined` when there is nothing to wait for, so that reads
   * stay synchronous up to the fetch.
   */
  beforeRead(): Promise<void> | undefined;
  /**
   * Since when this instance sees every change of the table, or `undefined` if it may miss some.
   */
  trustedSince(): number | undefined;
  /** Whether the changes of the writes of this instance come back through the sync. */
  readonly seesOwnWrites: boolean;
  dispose(): Promise<void>;
};

/** The `none` strategy: nothing to follow. */
export const lilypadNoSync: LilypadDbSyncStrategy = {
  start: () => Promise.resolve(),
  beforeRead: () => undefined,
  trustedSince: () => undefined,
  seesOwnWrites: false,
  dispose: () => Promise.resolve(),
};
