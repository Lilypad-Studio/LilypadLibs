import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import type { LilypadChangelogCursor } from '@/dbGate/LilypadChangelog';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import type { LilypadChangelogPruning } from '@/dbGate/LilypadSchemaCheck';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';
import type { LilypadInvalidationEvent, LilypadPlatform } from '@/platform/LilypadPlatform';

export type LilypadDbNotification = {
  /**
   * The schema of the table. Notifications without it match the table in any schema (the triggers
   * of version 1 of the changelog, and custom triggers that do not send it).
   */
  schema?: string;
  table: string;
  /**
   * A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`).
   * Absent for `TRUNCATE`.
   */
  id?: string | number;
  op: 'UPDATE' | 'DELETE' | 'INSERT' | 'TRUNCATE';
  /**
   * The id of the transaction that made the change (sent by the triggers of version 3). It lets
   * the instance that made the change skip its own writes.
   */
  xid?: string;
};

/** How the cache checks that the database has the triggers it needs (see {@link LilypadDbCacheSync}). */
export type LilypadDbCacheSchemaVerification = 'warn' | 'throw' | 'off';

/** The options shared by the strategies that see every change of the table. */
export type LilypadDbCacheTrustedSyncOptions = {
  verify?: LilypadDbCacheSchemaVerification;
  /**
   * While the sync is trusted, an entry read from the database (not a copy from the shared
   * level, nor a fallback after an error) that reaches its TTL with no change of its row is
   * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
   * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
   * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
   */
  maxAge?: number;
};

export type LilypadDbCacheListenSync = LilypadDbCacheTrustedSyncOptions & {
  strategy: 'listen';
  /**
   * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
   * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
   */
  connect?: 'eager' | 'lazy';
  /**
   * If false, the cache does not apply the notifications: keeping it up to date is then up to
   * `onNotification`, and entries are never kept past their TTL. Defaults to true.
   */
  applyChanges?: boolean;
  /** Called with every notification of the table, after the cache has applied it. */
  onNotification?: (payload: LilypadDbNotification) => Promise<void> | void;
};

export type LilypadDbCacheChangelogSync = LilypadDbCacheTrustedSyncOptions & {
  strategy: 'changelog';
  /** Minimum time between two reads of the changelog, in ms. Changes are seen within it. */
  pollInterval: number;
  /**
   * `await` (default): a read that is due waits for the changelog, so it never returns data
   * older than `pollInterval`. `background`: the read does not wait, and may return data one
   * interval older.
   */
  poll?: 'await' | 'background';
  /**
   * If the changelog has not been read for this long (ms), the instance no longer trusts it:
   * every entry is expired instead. It must be much shorter than the retention of the
   * changelog (see `pruneLilypadChangelog`): the schema check reports a pruning it finds with a
   * shorter one. Defaults to 1 hour.
   */
  maxGap?: number;
  /**
   * On the first read, or after `maxGap`, the changes of this many ms are applied, so that
   * copies in the shared level older than those changes are removed too. It must cover the
   * lifetime of a shared entry. Defaults to the TTL plus `staleWhileRevalidate`, plus 1 minute.
   */
  lookback?: number;
  /** The changelog table, if not `lilypad_cache_changes`. */
  table?: string;
  /**
   * How the old changelog rows are deleted, for the schema check. `detect` (default): it looks for
   * the `prune` option of the trigger and for a pg_cron job, and warns with the best one for the
   * database if it finds neither. `external`: a job it cannot see deletes them (e.g.
   * `pruneLilypadChangelog` from a scheduled function), so it suggests nothing.
   */
  pruning?: LilypadChangelogPruning;
};

/**
 * How the cache learns about the changes made by other instances and other programs.
 *
 * - `listen`: `LISTEN/NOTIFY` on a dedicated connection. Near real-time, for long-running servers.
 *   Not suited to serverless platforms: the connection must stay open, it does not work through a
 *   pooler in transaction mode, and notifications sent while an instance is suspended are lost.
 *   Notifications are only hints (any role can send them): the cache reads the rows again, it
 *   never trusts the content of a notification.
 * - `changelog`: each instance reads the changelog table (see `lilypadChangelogSql`) at most once
 *   per `pollInterval`, when the cache is used. The caches of a gate read their tables together,
 *   in one query. No long-lived connection: suited to serverless platforms. Changes are seen
 *   within `pollInterval`.
 * - `none`: only the writes of this instance and the TTL keep the cache up to date.
 *
 * `listen` and `changelog` rely on triggers that the library does not install (see
 * `lilypadChangelogSql`). Their `verify` option checks that they exist (`checkLilypadSchema`):
 * - `warn` (default): once, when the cache first uses the database (`LISTEN`, or the first read
 *   of the changelog), without delaying changelog reads; problems are logged as a warning, with the
 *   SQL that fixes them (on `console.warn` without a logger).
 * - `throw`: in `create`, which rejects with a `LilypadSchemaCheckError`. `create` then queries
 *   the database, whatever the strategy.
 * - `off`: no check. With `listen`, notifications of a table of the same name in another schema
 *   are then told apart only if `tableName` is qualified (`schema.table`).
 *
 * While `listen` or `changelog` is trusted (`LISTEN` active and its heartbeat recent, changelog
 * read within `maxGap`), the cache sees every change of the table, so the TTL no longer needs a
 * query: an entry that reaches its TTL without a change of its row is kept until `maxAge`.
 *
 * When `LISTEN` or a read of the changelog fails, the next attempts back off exponentially (up to
 * one minute), instead of retrying at every read.
 */
export type LilypadDbCacheSync =
  | LilypadDbCacheListenSync
  | LilypadDbCacheChangelogSync
  | { strategy: 'none' };

export type LilypadDbRowChange = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * How a change reaches the cache:
 * - `eager`: a notification, which anyone can send: the cache re-reads the rows it holds;
 * - `lazy`: a change read from the changelog, which only the triggers write: the cache applies it
 *   without a query, and the next read fetches the row.
 */
export type LilypadDbChangeMode = 'eager' | 'lazy';

/** What the sync strategies need from the cache. */
export interface LilypadDbSyncHost<K extends LilypadCacheKey> {
  readonly id: string;
  readonly name: string;
  readonly gate: LilypadDbGate;
  readonly tableName: string;
  readonly platform?: LilypadPlatform;
  log(level: LilypadLibLogLevel, ...message: unknown[]): void;
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
  /** Expires every entry: the changes made meanwhile may have been missed. */
  expireEverything(): void;
  emitInvalidation(
    source: LilypadInvalidationEvent['source'],
    keys: K[],
    options?: { wholeCache?: boolean }
  ): void;
  /** Forgets the writes of this instance whose changes a read from `cursor` no longer returns. */
  forgetOwnWritesCoveredBy(cursor: LilypadChangelogCursor): void;
  /** The schema of the table, once known: notifications of other schemas are ignored. */
  tableSchema(): string | undefined;
  /** The default `lookback` of the changelog: the TTL plus the stale window, plus 1 minute. */
  defaultLookback(): number;
}

/** How a cache follows the changes of its table (one implementation per `sync.strategy`). */
export interface LilypadDbSyncStrategy {
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
}

/** The `none` strategy: nothing to follow. */
export const lilypadNoSync: LilypadDbSyncStrategy = {
  start: () => Promise.resolve(),
  beforeRead: () => undefined,
  trustedSince: () => undefined,
  seesOwnWrites: false,
  dispose: () => Promise.resolve(),
};
