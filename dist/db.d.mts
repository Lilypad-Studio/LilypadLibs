import { n as LilypadLibLogger } from "./chunks/LilypadLibLogger-D3C4iJKK.mjs";
import { c as LilypadCacheOptions, g as LilypadDisposedError, h as LilypadCachedValueType, l as LilypadCachePeek, o as LilypadCacheGetOptions, s as LilypadCacheKey, t as LilypadCacheBulkSyncOptions, u as LilypadCacheResult } from "./chunks/LilypadCacheTypes-CLQapyZs.mjs";
import { A as LilypadDbColumnReference, B as LilypadDbReference, C as defineLilypadTable, D as LilypadDbColumn, E as LilypadDbCheck, F as LilypadDbIndex, G as LilypadDbWriteResult, H as LilypadDbSchema, I as LilypadDbIndexMethod, L as LilypadDbInsertData, M as LilypadDbDeleteResult, N as LilypadDbEmptyWriteError, O as LilypadDbColumnDefault, P as LilypadDbForeignKey, R as LilypadDbMissingPrimaryKeyError, S as defineLilypadDb, T as isLilypadDbTableDefinition, U as LilypadDbUniqueKey, V as LilypadDbReferentialAction, W as LilypadDbUpdateData, _ as LilypadDbTableInputBase, a as LilypadDbConfigInput, b as LilypadDbTableSync, c as LilypadDbResolvedForeignKey, d as LilypadDbRow, f as LilypadDbTableChangelogSync, g as LilypadDbTableInput, h as LilypadDbTableDraft, i as LilypadDbConfig, j as LilypadDbColumnType, k as LilypadDbColumnName, l as LilypadDbResolvedIndex, m as LilypadDbTableDefinitionBase, n as LILYPAD_DEFAULT_DB_CONFIG_NAME, o as LilypadDbConfigSettings, p as LilypadDbTableDefinition, r as LilypadChangelogPruning, s as LilypadDbPrimaryKey, t as LILYPAD_DEFAULT_CHANGELOG_TABLE, u as LilypadDbResolvedUniqueKey, v as LilypadDbTableListenSync, w as isLilypadDbConfig, x as LilypadDbTableTrustedSync, y as LilypadDbTableName, z as LilypadDbNotFoundError } from "./chunks/schema-B8RIzo97.mjs";
import { t as LilypadSingletonAble } from "./chunks/LilypadSingleton-CmL74XTL.mjs";
import postgres from "postgres";
//#region src/dbGate/LilypadDbTable.d.ts
/**
 * The typed CRUD helpers of one table, created with `gate.table(db.tables.users)` (or
 * `gate.table('users')` on a gate created with a config): every method uses the definition of the
 * table, and the connections of the gate (it rejects once the gate is closed). Queries name the
 * table with its schema (`public.users`), whatever the `search_path`.
 *
 * - Only the `cols` keys are selected (unless there is a `selectSanitizationFn`, which gets `*`)
 *   and written: extra properties of the data (e.g. from a request body) are never written.
 * - Rows are mapped with the `selectSanitizationFn`, or by copying the `cols` keys.
 * - Writes return the id of their transaction (`xid`), as the changelog records it.
 *
 * @example
 * ```typescript
 * const users = gate.table(db.tables.users);
 * const { row } = await users.insert({ name: 'Ada' });
 * const user = await users.selectByPrimaryKey(row!.id);
 * ```
 */
export declare class LilypadDbTable<T, PK extends keyof T = keyof T> {
  private readonly gate;
  readonly definition: LilypadDbTableDefinition<T, PK>;
  constructor(gate: LilypadDbGate, definition: LilypadDbTableDefinition<T, PK>);
  private get sql();
  /**
   * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
   * otherwise by copying the schema columns.
   */
  private mapRow;
  private mapRows;
  /**
   * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
   * columns that are not in the schema; otherwise only the schema columns are needed.
   */
  private selectedColumns;
  /** The `RETURNING` list of a write: the selected columns and the transaction id. */
  private returning;
  private get tableName();
  private get primaryKeyColumn();
  /**
   * Prepares the data of an insert/update:
   * - applies the schema's `writeSanitizationFn`, whose result replaces the data;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table;
   * - leaves the primary key out of the `SET` of an update: it identifies the row;
   * - skips `undefined` values, which postgres.js rejects.
   */
  private prepareWrite;
  /** Splits a row returned by a write into the row and the id of its transaction. */
  private writeResult;
  /**
   * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
   * of the whole table is never held in memory at once.
   *
   * @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
   * rejects with the reason of the signal.
   */
  selectAll(options?: {
    signal?: AbortSignal;
  }): Promise<T[]>;
  /**
   * Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
   * the parameters of a query). Keys without a row are left out of the result, as are the rows the
   * `selectSanitizationFn` discards.
   */
  selectByPrimaryKeys(primaryKeyValues: T[PK][]): Promise<T[]>;
  /** Selects the row with this primary key, or `null`. */
  selectByPrimaryKey(primaryKeyValue: T[PK]): Promise<T | null>;
  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key (`null` if the `selectSanitizationFn` discards it), and the id of
   * the transaction that wrote it.
   * @throws {LilypadDbMissingPrimaryKeyError} Without the primary key, unless it is generated.
   * @throws {LilypadDbEmptyWriteError} If the data has no column of the schema.
   */
  insert(data: LilypadDbInsertData<T, PK>): Promise<LilypadDbWriteResult<T>>;
  /**
   * Updates the row identified by the primary key contained in `data`. Only the columns present
   * in `data` are written.
   *
   * @returns The row as stored by the database (`null` if the `selectSanitizationFn` discards it),
   * and the id of the transaction that wrote it.
   * @throws {LilypadDbNotFoundError} If no row with that primary key exists.
   * @throws {LilypadDbMissingPrimaryKeyError} Without the primary key.
   * @throws {LilypadDbEmptyWriteError} If the data has no other column of the schema.
   */
  update(data: LilypadDbUpdateData<T, PK>): Promise<LilypadDbWriteResult<T>>;
  /**
   * Deletes the row with this primary key.
   *
   * @returns Whether a row had this primary key, and the id of the transaction that deleted it.
   */
  delete(primaryKeyValue: T[PK]): Promise<LilypadDbDeleteResult>;
}
//#endregion
//#region src/dbGate/LilypadDbGate.d.ts
type ListenerCallback = (payload: unknown) => void | Promise<void>;
/** A callback registered on a channel with `addListener`. */
type LilypadDbListener = {
  channel: string;
  callbackId: string;
  callback: ListenerCallback;
  /**
   * Called when LISTEN is active again after the listener connection was lost and re-established.
   * Notifications sent while the connection was down are lost: use it to resynchronize.
   */
  onReconnect?: () => void | Promise<void>;
};
type LilypadDbGateOptions<C extends LilypadDbConfig | undefined = LilypadDbConfig | undefined> = {
  logger?: LilypadLibLogger;
  connectionString: string;
  /**
   * The config of the database (see `defineLilypadDb`): `gate.table('users')` and
   * `LilypadDbCache.create({ gate, table: 'users' })` then find the table in it. A table of another
   * config can still be given as a definition (`other.tables.events`), or with its own `config`.
   */
  config?: C;
  /** The connection used for `LISTEN`, if not `connectionString` (e.g. a direct, unpooled one). */
  listenerConnectionString?: string;
  listen?: LilypadDbListener[];
  /**
   * Maximum duration of each query of the main client, in milliseconds (Postgres
   * `statement_timeout`): the server cancels longer queries. A caller that times out (e.g. after
   * the `fetchTimeout` of a cache) does not stop its query: without this bound, slow queries would
   * keep the connections of the pool busy, and the queries behind them would wait. Defaults to
   * 30 seconds; `false` leaves the setting of the database.
   */
  statementTimeout?: number | false;
  /** Connection pool of the main client. Every duration is in milliseconds. */
  pool?: LilypadDbPoolOptions;
  /**
   * While channels are listened to, a notification is sent to a private channel every this many
   * ms, to detect a `LISTEN` connection that stopped delivering notifications (see
   * `isListenHealthy`). `false` disables it. Defaults to 15 seconds.
   */
  listenHeartbeat?: number | false;
};
type LilypadDbPoolOptions = {
  /** Maximum number of connections (postgres.js default: 10). */
  max?: number;
  /** Closes connections idle for this long (postgres.js default: never). */
  idleTimeout?: number;
  /** Fails a connection attempt after this long (postgres.js default: 30 s). */
  connectTimeout?: number;
  /** Closes connections older than this (postgres.js default: 30 to 60 minutes). */
  maxLifetime?: number;
};
/**
 * Pool settings for serverless platforms (e.g. Vercel Functions), where many short-lived instances
 * each open their own pool:
 * - few connections per instance, so that many instances do not exhaust the database;
 * - idle connections closed quickly, so that a suspended instance does not keep them open.
 *
 * Use it with a pooled connection string (e.g. PgBouncer in transaction mode). Adjust `max` to the
 * number of queries a single instance runs in parallel.
 */
export declare const lilypadServerlessPool: Readonly<LilypadDbPoolOptions>;
type LilypadDbGateOptionsWithSingleton<C extends LilypadDbConfig | undefined> = LilypadDbGateOptions<C> & LilypadSingletonAble;
/**
 * A gateway to a PostgreSQL database: typed CRUD helpers over the tables of a config (through
 * {@link LilypadDbGate.table}), and channel listeners (`LISTEN/NOTIFY`) with reconnection handling.
 *
 * @typeParam C - The config the gate was created with, whose tables can be named.
 *
 * @example
 * ```typescript
 * const gate = await LilypadDbGate.create({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   config: db, // the default export of lilypad.config.ts
 *   listen: [
 *     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 */
export declare class LilypadDbGate<C extends LilypadDbConfig | undefined = LilypadDbConfig | undefined> {
  readonly id: string;
  readonly sql: postgres.Sql;
  /** The config given to `create`, if any. */
  readonly config: C;
  /** Only when `listenerConnectionString` differs: otherwise `sql` listens. */
  private readonly listenerClient?;
  protected logger?: LilypadLibLogger;
  private listeners;
  private releaseSingleton;
  private readonly heartbeat?;
  private readonly heartbeatChannel;
  private heartbeatStop?;
  /** A heartbeat that could not start is retried after a backoff (see `isListenHealthy`). */
  private readonly heartbeatBackoff;
  private closing?;
  private constructor();
  /**
   * Creates a gate and registers the listeners of `options.listen`.
   * Without listeners it opens no connection: the pool connects on the first query, so creating a
   * gate at module level does not reach the database (e.g. during a build).
   * With `singleton: '<identifier>'`, a later call with the same identifier returns the existing gate and
   * ignores its own options (a warning is logged if they differ).
   */
  static create<C extends LilypadDbConfig | undefined = undefined>(options: LilypadDbGateOptionsWithSingleton<C>): Promise<LilypadDbGate<C>>;
  private static initializeNew;
  /**
   * The typed CRUD helpers of a table: a table of a config (`db.tables.users`), or the key of a
   * table of the config of the gate (`'users'`). The handle is cheap: create one per table and
   * keep it, or call `table` again.
   *
   * @throws If the table is given by name and the config of the gate has no such table.
   */
  table<T, PK extends keyof T = keyof T>(definition: LilypadDbTableDefinition<T, PK>): LilypadDbTable<T, PK>;
  table<N extends LilypadDbTableName<C>>(name: N): LilypadDbTable<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>;
  /** The client that listens: postgres.js keeps one dedicated connection per client for LISTEN. */
  private listenClient;
  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   */
  private initializeListener;
  /**
   * Runs a listener callback, catching both synchronous throws and rejected promises,
   * so a failing callback can neither affect the others nor cause an unhandled rejection.
   */
  private runCallbackSafely;
  /** Runs every callback of a channel with the payload of a notification. */
  private executeAllListenerCallbacks;
  private executeReconnectCallbacks;
  /**
   * Adds a listener callback for a channel. Adding a callback with an existing `callbackId` on the
   * same channel replaces the previous one.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  addListener(identifier: LilypadDbListener): Promise<void>;
  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
   * It never rejects: a failed UNLISTEN is logged (the connection keeps the channel, whose
   * notifications are then ignored).
   *
   * @returns `true` if the callback was registered.
   */
  removeListener(channel: string, callbackId: string): Promise<boolean>;
  /** Starts the heartbeat, unless it is running or starting. It never rejects. */
  private startHeartbeat;
  private stopHeartbeat;
  /**
   * Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
   * recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as a channel is
   * listened to. `false` while no channel is listened to.
   */
  isListenHealthy(): boolean;
  /** Whether `close` was called: the gate then rejects every query and listener. */
  get closed(): boolean;
  /** @throws {LilypadDisposedError} If the gate is closed. */
  assertOpen(): void;
  /**
   * Closes the connections, after the queries still running (for at most `timeout` ms; the ones
   * still running then are cancelled). Later queries and listeners are rejected. Calling it again
   * returns the same promise.
   *
   * @param options.timeout - How long to wait for the running queries, in ms. Defaults to 5 s.
   * @throws If the timeout is not valid: the gate then stays open.
   */
  close(options?: {
    timeout?: number;
  }): Promise<void>;
  /** `await using gate = ...` closes the gate at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void>;
  private closeConnections;
}
//#endregion
//#region src/dbGate/LilypadChangelog.d.ts
/** Above this number of rows changed by one statement, the trigger sends one `BULK` notification. */
export declare const LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD = 1000;
/**
 * The shortest retention that {@link pruneLilypadChangelog} accepts without `force`: the default
 * `maxGap` of the caches. A shorter one deletes rows that the caches may still have to read.
 */
export declare const LILYPAD_MIN_CHANGELOG_RETENTION: number;
type LilypadChangelogSqlOptions = {
  /** Name of the changelog table. Defaults to `lilypad_cache_changes`. */
  table?: string;
  /**
   * Channel on which the trigger also sends a `NOTIFY` for the `listen` strategy, or `false` to
   * send none. Defaults to `cache_events`.
   */
  notifyChannel?: string | false;
  /**
   * With a `notifyChannel`, a statement that changes more rows than this sends one `BULK`
   * notification instead of one per row: the caches then expire every entry of the table instead
   * of re-reading each row, and the `NOTIFY` queue is not flooded. Defaults to 1000.
   */
  notifyBulkThreshold?: number;
  /**
   * Makes the trigger delete the old changelog rows itself, so that no scheduled job is needed:
   * on about one statement in `every`, it deletes up to `batchSize` rows older than `olderThan`,
   * in the writing transaction. `false` (the default) leaves the pruning to
   * {@link pruneLilypadChangelog} or {@link lilypadChangelogPruneScheduleSql}.
   */
  prune?: LilypadChangelogPruneOptions | false;
};
type LilypadChangelogPruneOptions = {
  /**
   * The retention, in milliseconds: the rows older than this are deleted. It must be much longer
   * than the `maxGap` and the `lookback` of the caches, and than the longest transaction (e.g. 24 h).
   */
  olderThan: number;
  /**
   * The trigger prunes on about one call in `every` (one call per statement). Defaults to 20.
   * `batchSize / every` is the average number of rows pruned per statement: it must stay above the
   * average number of rows a statement records, or the table keeps growing.
   */
  every?: number;
  /** The most rows one prune deletes. Defaults to 1000. */
  batchSize?: number;
};
/**
 * The SQL that creates the changelog table and its trigger function. Run it once, in a migration.
 * It is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`).
 *
 * Then attach the trigger to every cached table with {@link lilypadChangelogTriggerSql}.
 */
export declare function lilypadChangelogSql(options?: LilypadChangelogSqlOptions): string;
type LilypadChangelogPruneScheduleOptions = {
  /**
   * The retention, in milliseconds: the rows older than this are deleted. It must be much longer
   * than the `maxGap` and the `lookback` of the caches, and than the longest transaction (e.g. 24 h).
   */
  olderThan: number;
  /** When the job runs, in cron syntax (pg_cron uses UTC). Defaults to `0 3 * * *`: daily at 3:00. */
  schedule?: string;
  /** Name of the changelog table, if not the default one. */
  changelogTable?: string;
  /** Name of the job. Defaults to `<changelog table>_prune`. Scheduling it again replaces it. */
  jobName?: string;
  /**
   * The database of the changelog table, when pg_cron is installed in another one (see
   * `cron.database_name`): the SQL then runs in the pg_cron database, and the job resolves
   * `changelogTable` with the search_path of its role, so qualify it with its schema. Without it,
   * the SQL runs in the database of the changelog, which must be the pg_cron one.
   */
  database?: string;
};
/**
 * The SQL that schedules a pg_cron job deleting the changelog rows older than `olderThan`: the
 * database then prunes its changelog itself. Run it once, in a migration, with pg_cron installed
 * (`CREATE EXTENSION pg_cron`). Running it again updates the job.
 */
export declare function lilypadChangelogPruneScheduleSql(options: LilypadChangelogPruneScheduleOptions): string;
/**
 * The SQL that attaches the changelog triggers to a cached table: one statement trigger for each of
 * INSERT, UPDATE and DELETE, which records all the rows of a statement in one query (through its
 * transition tables), and one for `TRUNCATE`. It drops the row trigger of the versions 3 and
 * earlier, which the trigger function no longer serves. Run it once per table, in a migration (in one transaction, so that no write goes
 * unrecorded), after {@link lilypadChangelogSql}.
 *
 * Transition tables are not supported on the partitions of a partitioned table, nor on tables with
 * inheritance children: attach the triggers to the partitioned table itself.
 *
 * @param options.table - The cached table (`table` or `schema.table`).
 * @param options.primaryKey - Its primary key column.
 * @param options.changelogTable - The changelog table, if not the default one.
 */
export declare function lilypadChangelogTriggerSql(options: {
  table: string;
  primaryKey: string;
  changelogTable?: string;
}): string;
/**
 * A change recorded by the changelog: a change of one row, or a `TRUNCATE` of the table (which
 * removed every row, and has no `rowId`).
 */
type LilypadChange = {
  /** The id of the changelog row. */
  id: string;
  /** The transaction that made the change. */
  xid: bigint;
} & ({
  rowId: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
} | {
  rowId: null;
  op: 'TRUNCATE';
});
/**
 * Where the next read of the changelog starts: the transactions that a read could not see yet.
 * They are the ones still running when it read (`xip`) and the ones that had not started
 * (`xid >= xmax`): every other transaction had already committed or aborted, so its changes were
 * visible to that read.
 */
type LilypadChangelogCursor = {
  /** The first transaction id not yet assigned when the read took its snapshot. */
  xmax: bigint;
  /** The transactions running when the read took its snapshot. */
  xip: bigint[];
};
/** What to read of a table: the changes since a cursor, or those of the last `lookback` ms. */
type LilypadChangesRequest = {
  tableName: string;
  since: {
    cursor: LilypadChangelogCursor;
  } | {
    lookback: number;
  };
};
/**
 * Reads the changes of a table since `cursor`, and the cursor for the next read.
 *
 * The cursor holds the transactions the read could not see yet (see
 * {@link LilypadChangelogCursor}): the next read returns exactly the changes of those
 * transactions that are visible to it, whatever the order of the commits. Each change is thus
 * returned once, and a long-running transaction does not make every read return again all the
 * changes made since it started.
 *
 * Without a cursor (first read, or a cursor no longer trusted), `since.lookback` returns the
 * changes recorded in the last `lookback` milliseconds instead.
 *
 * `tableName` is resolved as the gate's queries resolve it (with the `search_path` when it is not
 * qualified), so a table of the same name in another schema is not mixed up with it.
 */
export declare function readLilypadChanges(gate: LilypadDbGate, options: LilypadChangesRequest & {
  changelogTable?: string;
}): Promise<{
  changes: LilypadChange[];
  cursor: LilypadChangelogCursor;
}>;
/**
 * Deletes the changelog rows older than `olderThan` milliseconds, in batches of `batchSize` rows
 * (one statement each, so that no statement locks or rewrites the whole table). Call it
 * periodically (e.g. from a scheduled job): `olderThan` must be much larger than the `maxGap` and
 * the `lookback` of the caches, and than the longest transaction.
 *
 * @param options.olderThan - The retention, in **milliseconds**. Below one hour it throws, unless
 * `force` is set: a shorter retention deletes rows that the caches may still have to read, and
 * they would miss these changes without knowing it.
 * @param options.batchSize - The most rows one statement deletes. Defaults to 10000.
 * @returns The number of deleted rows.
 */
export declare function pruneLilypadChangelog(gate: LilypadDbGate, options: {
  olderThan: number;
  changelogTable?: string;
  batchSize?: number;
  force?: boolean;
}): Promise<number>;
//#endregion
//#region src/cache/dbSync/LilypadDbSyncTypes.d.ts
type LilypadDbNotification = {
  /**
   * The schema of the table. Notifications without it match the table in any schema (the triggers
   * of version 1 of the changelog, and custom triggers that do not send it).
   */
  schema?: string;
  table: string;
  /**
   * A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`).
   * Absent for `TRUNCATE` and `BULK`.
   */
  id?: string | number;
  /**
   * `BULK`: one statement changed more rows than the `notifyBulkThreshold` of the trigger, which
   * sends this one notification instead of one per row. The cache expires the whole table.
   */
  op: 'UPDATE' | 'DELETE' | 'INSERT' | 'TRUNCATE' | 'BULK';
  /**
   * The id of the transaction that made the change (sent by the triggers of version 3). It lets
   * the instance that made the change skip its own writes.
   */
  xid?: string;
};
/**
 * The options of the sync of a table that `LilypadDbCache.create` may change for one cache (the
 * strategy, `maxGap` and `lookback` stay those of the config, which `lilypad-doctor` checks the
 * database against). Each applies to the strategies that have it, and is ignored by the others.
 */
type LilypadDbCacheSyncOverrides = {
  /** See `maxAge` in the sync of the table. */
  maxAge?: number;
  /** `listen`: see {@link LilypadDbTableListenSync}. */
  connect?: 'eager' | 'lazy';
  /** `listen`: see {@link LilypadDbTableListenSync}. */
  applyChanges?: boolean;
  /** `listen`: called with every notification of the table, after the cache has applied it. */
  onNotification?: (payload: LilypadDbNotification) => Promise<void> | void;
  /** `changelog`: see {@link LilypadDbTableChangelogSync}. */
  pollInterval?: number;
  /** `changelog`: see {@link LilypadDbTableChangelogSync}. */
  poll?: 'await' | 'background';
};
//#endregion
//#region src/cache/LilypadDbCache.d.ts
/** The key type of a table: the type of its primary key column. */
type LilypadDbKey<V, PK extends keyof V> = V[PK] & LilypadCacheKey;
/** The options of a cache, apart from its table and its gate. */
type LilypadDbCacheBaseOptions<V extends object, PK extends keyof V = keyof V> = Omit<LilypadCacheOptions<LilypadDbKey<V, PK>, V>, 'bulkSync'> & {
  /**
   * Changes the options of the sync of the table for this cache (e.g. `connect: 'lazy'`, an
   * `onNotification` callback). The strategy is the one of the table in its config.
   */
  sync?: LilypadDbCacheSyncOverrides;
  /**
   * Loading the whole table (`getAll`): `timeout` bounds each load and each query by primary keys
   * (defaults to 30 seconds); with the `none` strategy, a load stays valid for `ttl` (defaults to
   * the TTL).
   */
  bulkSync?: Omit<LilypadCacheBulkSyncOptions<LilypadDbKey<V, PK>, V>, 'fn'>;
};
/** The options of a cache of a table given as a definition (`db.tables.users`). */
type LilypadDbCacheOptions<V extends object, PK extends keyof V = keyof V> = LilypadDbCacheBaseOptions<V, PK> & {
  gate: LilypadDbGate;
  /** The table, from a config: `db.tables.users`, whatever the config of the gate. */
  table: LilypadDbTableDefinition<V, PK>;
};
/** The options of a cache of a table given by its key in `config`. */
type LilypadDbCacheNamedOptions<C extends LilypadDbConfig, N extends LilypadDbTableName<C>> = LilypadDbCacheBaseOptions<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>> & {
  gate: LilypadDbGate;
  config: C;
  table: N;
};
/** The options of a cache of a table given by its key in the config of the gate. */
type LilypadDbCacheGateNamedOptions<C extends LilypadDbConfig, N extends LilypadDbTableName<C>> = LilypadDbCacheBaseOptions<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>> & {
  gate: LilypadDbGate<C>;
  config?: undefined;
  table: N;
};
/**
 * A cache of the rows of one table, kept up to date with the changes made elsewhere.
 *
 * Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
 * table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
 * `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
 * from the table could be kept past its TTL as if it did.
 *
 * Every method throws a {@link LilypadDisposedError} once the cache is disposed, except `dispose`.
 *
 * @typeParam V - The row type.
 * @typeParam PK - The primary key column; the keys of the cache are its values.
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create({ ttl: 60_000, gate, table: db.tables.users, logger });
 * const user = await users.getOrFetch(42); // User, or null when there is no such row
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `refresh` always
 *   re-fetches the key; `getAll` loads the whole table once, then fetches only the rows it does
 *   not hold up to date.
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
 *   notes that the row exists, and `getAll` fetches it.
 * - The name of the cache (shared level keys, invalidation events, logs) defaults to the table name.
 */
export declare class LilypadDbCache<V extends object, PK extends keyof V = keyof V> {
  private readonly engine;
  private readonly table;
  private readonly definition;
  private readonly sync;
  private readonly maxAge;
  /** Bounds the loads of the table and the queries by primary keys (`bulkSync.timeout`). */
  private readonly loadFlowControl;
  /** With the `none` strategy, how long a load of the table stays valid (`bulkSync.ttl`). */
  private readonly loadTtl;
  private releaseSingleton;
  /** The keys of the rows of the table, for `getAll`. */
  private members;
  /** The load of the whole table in flight, shared by concurrent callers. */
  private tableLoad?;
  /** The queries of `fetchRows` in flight, by normalized key. */
  private rowFetches;
  /** The keys to re-read after a notification, gathered into one query (see `refreshInBatch`). */
  private eagerBatch?;
  /** The keys of the batches of `refreshInBatch` pending or running, with their number. */
  private eagerReads;
  /** The keys re-read after notifications in the current second, for the eager budget. */
  private eagerWindow;
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  private refreshes;
  /** The writes of this instance, recognized when their changes come back through the sync. */
  private ownWrites;
  /**
   * Whether the primary key holds numbers: declared by `cols[primaryKey].type`, or learned from the
   * rows read. The ids of notifications and of the changelog are then converted to numbers.
   */
  private numericPrimaryKey;
  private disposing?;
  /**
   * Creates a cache of a table of a config and, with the `listen` strategy (unless
   * `connect: 'lazy'`), registers its database listener. The table is a definition
   * (`db.tables.users`, from any config), or its key (`'users'`) in `config`, or else in the config
   * of the gate. The row type and the primary key are inferred from it.
   * With `singleton: '<identifier>'`, a later call with the same identifier returns the existing
   * cache and ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * Nothing is compared with the database: `lilypad-doctor` checks it against the config.
   *
   * @throws If the table is not found, or if the database listener cannot be registered (e.g. the
   * database is unreachable).
   */
  static create<V extends object, PK extends keyof V = keyof V>(options: LilypadDbCacheOptions<V, PK> & LilypadSingletonAble): Promise<LilypadDbCache<V, PK>>;
  static create<C extends LilypadDbConfig, N extends LilypadDbTableName<C>>(options: LilypadDbCacheNamedOptions<C, N> & LilypadSingletonAble): Promise<LilypadDbCache<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>>;
  static create<C extends LilypadDbConfig, N extends LilypadDbTableName<C>>(options: LilypadDbCacheGateNamedOptions<C, N> & LilypadSingletonAble): Promise<LilypadDbCache<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>>;
  private constructor();
  /** A unique id of the instance. */
  get id(): string;
  /** The name given in the options, or the table name. */
  get name(): string;
  /** @throws {LilypadDisposedError} If the cache is disposed. */
  private assertNotDisposed;
  /** What the sync strategy may use of this cache. */
  private syncHost;
  /** The default `lookback` of the changelog: the lifetime of a shared copy, plus 1 minute. */
  private defaultLookback;
  /** Follows the values stored in the cache: the rows of the table, and the type of their keys. */
  private followValue;
  /**
   * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
   * value was read from the database (or written by this instance) after the sync became trusted,
   * and any change of its row since would have expired it. It is kept until `maxAge`.
   */
  private renew;
  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - A change of a key held (or being read) by this instance: `eager` re-fetches it at once
   *   (with the other keys notified meanwhile, in one query, within the eager budget); `lazy`
   *   expires it with no query, which also discards a read in flight (it may predate the change):
   *   the next read fetches it. A `lazy` DELETE caches the key as `null` at once.
   * - A change of any other key: no query, and no entry. The shared level entry is removed.
   * INSERT and UPDATE note the key as a row of the table, which `getAll` returns. An `eager`
   * DELETE of a key not held leaves it there: `getAll` reads it again, and learns whether it is
   * gone. A notification is thus never trusted without a query (any role can send one).
   *
   * @param xid - The transaction that made the change, when known.
   * @returns The key of the changed row.
   */
  private applyChange;
  /**
   * Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
   * discarded, and the copies of the shared level produced before are ignored. From the changelog
   * (`lazy`) the table is known to be empty; from a notification (`eager`), which anyone can send,
   * the next `getAll` loads the table again instead.
   *
   * @returns The keys that were cached.
   */
  private applyTruncate;
  /**
   * Expires every entry, discards the reads started before, ignores the older copies of the shared
   * level, and forgets the rows of the table. It also applies a change of too many rows to follow
   * them one by one (a `BULK` notification, or a read of the changelog with too many keys).
   *
   * @param empty - The table is known to be empty (a `TRUNCATE` read from the changelog); otherwise
   * the next `getAll` loads it again.
   */
  private forgetTable;
  /** Takes one key of the eager budget: `false` once the budget of this second is spent. */
  private takeEagerRefresh;
  /**
   * Loads every row of the table and replaces the content of the cache with them.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private loadRows;
  /**
   * Loads the whole table, bounded by `bulkSync.timeout`. Concurrent calls share one load.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private loadTable;
  /**
   * The keys whose entry is missing or expired (after renewing the entries still up to date). A
   * missing entry whose row was just loaded is not stale: `maxEntries` evicted it.
   */
  private staleKeys;
  /**
   * Fetches rows by primary key and caches them in this instance only (`null` for the keys without
   * a row). A key already being fetched by a query that started after its last change shares that
   * query.
   *
   * @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
   * @throws If a query fails.
   */
  private fetchRows;
  /**
   * Reads rows by primary key, bounded by `bulkSync.timeout`, and caches them (`null` for the keys
   * without a row).
   *
   * @param read - Started before the query: its ticket orders the rows among the writes.
   * @param shared - Whether the rows also go to the shared level (and end the failure cooldown of
   * their keys), as a fetch of `getOrFetch` does.
   */
  private queryRows;
  /**
   * The rows of these keys, keyed as given, leaving out the keys without a row: the fresh entry,
   * else the value read by `sources` (in order), else the expired entry.
   */
  private rowsOf;
  /**
   * Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
   * memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
   */
  get(key: LilypadDbKey<V, PK>, options?: {
    removeExpired?: boolean;
  }): LilypadCachedValueType<V> | undefined;
  /**
   * Tells whether the key is cached, and whether its row is up to date or expired, with no query.
   * Like `get`, it first renews an entry the sync keeps up to date.
   */
  peek(key: LilypadDbKey<V, PK>): LilypadCachePeek<V>;
  /**
   * Returns the row of the key, from the cache or else from the database. Concurrent calls for the
   * same key share a single query.
   *
   * @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
   * @returns The row, or `null` if it does not exist.
   * @throws If the query fails and `onError` gives no fallback value.
   */
  getOrFetch(key: LilypadDbKey<V, PK>, options?: LilypadCacheGetOptions<LilypadDbKey<V, PK>, V>): Promise<LilypadCachedValueType<V>>;
  /**
   * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
   * failed.
   */
  getOrFetchDetailed(key: LilypadDbKey<V, PK>, options?: LilypadCacheGetOptions<LilypadDbKey<V, PK>, V>): Promise<LilypadCacheResult<V>>;
  /**
   * Fetches the row of the key from the database and caches it (`null` if it does not exist),
   * here and in the shared level. Concurrent calls share the query; a call made while a query is
   * running waits for one more query, which sees every change made before the call.
   * If a write that started later completes first, the fetched value is returned but not cached.
   *
   * @returns The row read from the database.
   * @throws If the query fails or exceeds `fetchTimeout`.
   */
  refresh(key: LilypadDbKey<V, PK>): Promise<LilypadCachedValueType<V>>;
  private fetchRow;
  /**
   * Re-reads a key after a notification, together with the other keys notified meanwhile: a change
   * of many rows notifies each of them, and one query per row would flood the pool. The batch is
   * sent once the notifications received together have been handled (a microtask later). The keys
   * of a failed query are expired instead.
   *
   * The query of a batch starts after the notifications of its keys: it sees their changes, even
   * when an older read of the key is still running.
   */
  private refreshInBatch;
  private runEagerBatch;
  /**
   * Returns every row of the table, or the rows of `keys`, keyed by primary key (the keys without a
   * row are left out).
   *
   * The whole table is loaded once (again after the sync lost changes, or, with the `none`
   * strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
   * queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
   * are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level. With
   * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
   * again at each call.
   *
   * @throws If the rows cannot be loaded.
   */
  getAll(keys?: LilypadDbKey<V, PK>[]): Promise<Map<LilypadDbKey<V, PK>, V>>;
  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the primary key holds numbers (declared as a
   * `number` column, or seen in the rows read).
   */
  private resolveNotifiedKey;
  /**
   * Invalidates the entry of the key: it is no longer returned, not even as a stale value (but it
   * stays a fallback for `onError: { fallback: 'stale' }`), a fetch already in flight is not
   * cached, the key is removed from the shared level, and `platform.onInvalidate` receives a
   * `manual` event.
   */
  invalidate(key: LilypadDbKey<V, PK>): void;
  /**
   * Deletes the key from the cache (not from the table), and from the shared level.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key: LilypadDbKey<V, PK>, options?: {
    force?: boolean;
  }): boolean;
  /**
   * Removes all entries from the memory of this instance (not from the shared level). Protected
   * keys are kept, unless `force` is set.
   */
  clear(options?: {
    force?: boolean;
  }): void;
  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window.
   *
   * @param options.force - If true, also removes the expired protected keys.
   */
  purgeExpired(options?: {
    force?: boolean;
  }): void;
  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   */
  addProtectedKeys(keys: LilypadDbKey<V, PK>[]): this;
  /** @returns The cache, for chaining. */
  removeProtectedKeys(keys: LilypadDbKey<V, PK>[]): this;
  /**
   * Disposes of the cache: stops its database listener and its changelog reads, removes it from
   * the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
   * starting is awaited, so that its listener is removed too. Every call returns the same promise.
   */
  dispose(): Promise<void>;
  private disposeResources;
  /** `await using cache = ...` disposes of the cache at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void>;
  private getItemPrimaryKeyValue;
  /**
   * Caches the row returned by a write of this instance, and remembers the write, so that its
   * change is not applied again when it comes back through the sync.
   * If the entry changed while the write was running (a change applied meanwhile, or a fetch that
   * may have read the row before the write), it is expired instead: the next read fetches the row.
   *
   * @param startTicket - A ticket taken before the write.
   * @param xid - The transaction of the write, if it changed a row.
   */
  private storeWritten;
  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `generatedPrimaryKey`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it. A row
   * that the `selectSanitizationFn` returns without its primary key is returned, but not cached.
   */
  sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null>;
  /**
   * Updates the item in the database and caches the row returned by the database.
   * Only the columns present in `item` are written.
   *
   * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
   */
  sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null>;
  /**
   * Deletes the row in the database, and caches the key as `null` (also for a protected key).
   *
   * @returns `true` if a row had this key, `false` if there was none (the key is cached as `null`
   * either way).
   */
  sqlDelete(key: LilypadDbKey<V, PK>): Promise<boolean>;
}
//#endregion
//#region src/dbConfig/loadLilypadDbConfig.d.ts
/**
 * The file names of a config: `lilypad.config.<ext>` for the default one, `lilypad.<name>.config.<ext>`
 * for the others.
 */
export declare function lilypadDbConfigFileNames(name: string): string[];
/**
 * Loads a config file: its default export (or its `config` export) must be a config made with
 * `defineLilypadDb`. A config found by name must have that name.
 *
 * A TypeScript config is loaded by Node.js itself (type stripping: Node.js 22.18 or later, or
 * `--experimental-strip-types`): it may use only erasable syntax, and its relative imports need
 * their extension (`./tables/users.ts`). Otherwise, write it as `.mjs`.
 *
 * @param options.config - The name of the config (`default` when absent), or the path of its file.
 * @param options.cwd - Where the config files are looked for. Defaults to the working directory.
 * @throws If the file does not exist, cannot be loaded, or exports no config.
 */
export declare function loadLilypadDbConfig(options?: {
  config?: string;
  cwd?: string;
}): Promise<{
  path: string;
  config: LilypadDbConfig;
}>;
//#endregion
//#region src/dbGate/LilypadSchemaShape.d.ts
/**
 * The shape of a table, compared with the database by the schema check: its columns, keys,
 * indexes and checks. A table definition of a config (`db.tables.users`) is one.
 */
type LilypadSchemaTableShape = {
  cols: Readonly<Record<string, LilypadDbColumn>>;
  generatedPrimaryKey?: boolean;
  unique: readonly LilypadDbResolvedUniqueKey[];
  foreignKeys: readonly LilypadDbResolvedForeignKey[];
  indexes: readonly LilypadDbResolvedIndex[];
  checks: readonly LilypadDbCheck[];
  /** Also reports what the database has and the shape lacks (as warnings). */
  strict: boolean;
};
/**
 * A PostgreSQL type as `format_type` writes it: lower case, aliases resolved (`int4` is
 * `integer`, `varchar(64)` is `character varying(64)`, `timestamptz(3)` is
 * `timestamp(3) with time zone`), array suffixes kept.
 */
export declare function normalizeLilypadPgType(type: string): string;
//#endregion
//#region src/dbGate/LilypadSchemaCheck.d.ts
/** A table to check, and what it needs. */
type LilypadSchemaCheckTable = {
  /** `table`, or `schema.table` (as the tables of a config are named). */
  table: string;
  primaryKey: string;
  /**
   * Whether the table needs the changelog triggers (the `changelog` strategy). Defaults to true
   * when the options check the changelog.
   */
  changelog?: boolean;
  /**
   * The channel on which the table needs notifying triggers (the `listen` strategy), or `false`.
   * Defaults to the `notifyChannel` of the options.
   */
  notifyChannel?: string | false;
  /**
   * The columns, keys, indexes and checks the table must have (a table definition of a config is
   * one). Without it, only the table and its triggers are checked.
   */
  shape?: LilypadSchemaTableShape;
};
type LilypadSchemaCheckOptions = {
  tables: LilypadSchemaCheckTable[];
  /**
   * Checks the changelog table, its trigger function, that the tables that need it have the
   * changelog trigger (the `changelog` strategy), and how the changelog is pruned. `false` skips
   * these checks. Defaults to `{}`: the default changelog table.
   */
  changelog?: {
    table?: string;
    /** How the old rows are deleted (see {@link LilypadChangelogPruning}). Defaults to `detect`. */
    pruning?: LilypadChangelogPruning;
    /**
     * The shortest retention the caches accept, in ms: the largest `maxGap` and `lookback` of
     * the caches that read this changelog. A pruning found with a retention that is not longer
     * is an error. Defaults to 1 hour (the default `maxGap`).
     */
    minRetention?: number;
    /**
     * Whether to check how the changelog is pruned (reads `cron.job` and the age of the oldest
     * row). Defaults to true.
     */
    checkPruning?: boolean;
  } | false;
  /**
   * With `changelog: false`, the changelog table whose trigger function the SQL that fixes the
   * notifying triggers installs (it notifies too). Defaults to `lilypad_cache_changes`.
   */
  changelogTable?: string;
  /**
   * Checks that the tables have a trigger that sends notifications on this channel (the `listen`
   * strategy), unless a table sets its own `notifyChannel`. The trigger may be the changelog trigger
   * or one of your own: its function must call `pg_notify` with the channel name as a literal.
   * Defaults to `false`: not checked.
   *
   * The SQL that fixes a missing or outdated changelog notifies on this channel, or, with `false`,
   * on the channel the installed trigger function notifies on (none if it sends none).
   */
  notifyChannel?: string | false;
};
type LilypadSchemaProblemCode =
/** PostgreSQL is older than 13: the changelog needs `xid8`. */
'unsupported-version' |
/** The cached table does not exist (as seen with the `search_path` of the gate). */
'missing-table' |
/** The changelog table or its trigger function does not exist. */
'missing-changelog' |
/**
 * The changelog table or its trigger function was installed by an older version of the library:
 * an error if the caches cannot read it correctly, a warning if it only lacks an improvement.
 */
'outdated-changelog' |
/**
 * The enabled changelog triggers of the table do not record each of INSERT, UPDATE and DELETE:
 * row triggers, or statement triggers with their transition tables.
 */
'missing-changelog-trigger' |
/** The changelog trigger of the table records another column than the primary key. */
'wrong-trigger-primary-key' |
/**
 * `TRUNCATE` of the table is not recorded (or not notified, with `notifyChannel`): it fires no
 * row trigger, so the caches would keep the removed rows.
 */
'missing-truncate-trigger' |
/**
 * No enabled trigger of the table sends notifications on the channel, or not for each of INSERT,
 * UPDATE and DELETE.
 */
'missing-notify-trigger' |
/**
 * A warning: nothing is known to delete the old changelog rows. Neither the `prune` option of
 * the trigger nor a pg_cron job was found, no row was ever deleted from the changelog, and
 * `pruning` is not `external`. The fix is the best pruning for the database, or the one
 * `pruning` asks for (`trigger` or `cron`).
 */
'no-changelog-pruning' |
/**
 * A warning: the oldest changelog row is older than the retention (or 24 hours, if unknown)
 * plus 7 days, so the pruning does not run, or does not keep up.
 */
'unpruned-changelog' |
/**
 * The pruning found deletes rows that are not older than `minRetention`: a cache could miss
 * changes without knowing it.
 */
'short-changelog-retention' |
/** A column of the description does not exist. */
'missing-column' |
/**
 * The type of a column is not its `pgType` (an error), or does not fit its `type` (a warning:
 * e.g. a `numeric` column declared as `number`, which postgres.js returns as a string).
 */
'column-type-mismatch' |
/** A column accepts `NULL` although declared not nullable, or the reverse. */
'column-nullability-mismatch' |
/** A column declared with a default (or the generated primary key) has none. */
'missing-column-default' |
/**
 * The primary key of the description is not the primary key of the table: an error if it is not
 * unique, a warning if a unique index and `NOT NULL` make it a key anyway.
 */
'wrong-primary-key' |
/** No unique constraint or index covers exactly the columns of a unique key. */
'missing-unique-key' |
/** A foreign key of the description does not exist (same columns, same referenced table). */
'missing-foreign-key' |
/** A foreign key exists with other `ON DELETE` / `ON UPDATE` actions. */
'foreign-key-mismatch' |
/** An index does not exist: an error for a unique index, a warning otherwise. */
'missing-index' |
/** A check of the description does not exist (found by its name). */
'missing-check' |
/**
 * A warning: a `NOT NULL` column without a default is not in the description, so the inserts
 * of the library fail.
 */
'undeclared-required-column' |
/** A warning of `strict`: a column of the table is not in the description. */
'undeclared-column' |
/** A warning of `strict`: a unique key, foreign key or check is not in the description. */
'undeclared-constraint' |
/** A warning of `strict`: an index is not in the description. */
'undeclared-index';
/**
 * `error`: the database is not what the config describes (the caches may serve stale data, the
 * queries may fail), and `lilypad-doctor` exits with 1. `warning`: it works, but something needs
 * attention.
 */
type LilypadSchemaProblemSeverity = 'error' | 'warning';
type LilypadSchemaProblem = {
  code: LilypadSchemaProblemCode;
  severity: LilypadSchemaProblemSeverity;
  /** The cached table concerned, for the per-table problems. */
  table?: string;
  message: string;
  /** SQL that fixes the problem, to run in a migration. */
  fix?: string;
};
type LilypadSchemaCheckResult = {
  /** Whether there is no error (there may be warnings). */
  ok: boolean;
  problems: LilypadSchemaProblem[];
  /** The schema each table resolves to (`null` if the table does not exist). */
  tables: {
    table: string;
    schema: string | null;
  }[];
};
/**
 * Thrown by `assertOk()` of a `lilypad-doctor` report when the database is not set up (the check
 * found errors). Its `problems` include the warnings.
 */
export declare class LilypadSchemaCheckError extends Error {
  readonly problems: LilypadSchemaProblem[];
  constructor(subject: string, problems: LilypadSchemaProblem[]);
}
/**
 * Checks that the database has what `LilypadDbCache` needs to learn about changes: the changelog
 * table, its trigger function and a trigger on each cached table, or a trigger that sends
 * notifications. It only reads the catalogs: it changes nothing.
 *
 * @returns The problems found, each with a message and, when the library can generate it, the SQL
 * that fixes it (`ok` is true when there is none).
 * @throws If the catalogs cannot be read (e.g. the database is unreachable).
 */
export declare function checkLilypadSchema(gate: LilypadDbGate, options: LilypadSchemaCheckOptions): Promise<LilypadSchemaCheckResult>;
//#endregion
//#region src/dbGate/LilypadDoctor.d.ts
type LilypadDoctorOptions = {
  /** The connection string of the database to check. */
  connectionString: string;
  /** The config the database must match (see `defineLilypadDb`, `loadLilypadDbConfig`). */
  config: LilypadDbConfig;
};
type LilypadDoctorReport = LilypadSchemaCheckResult & {
  /** The name of the config checked. */
  config: string;
  /** The report, readable, with the SQL that fixes the problems. */
  text: string;
  /** @throws {LilypadSchemaCheckError} If the check found errors. */
  assertOk: () => void;
};
/**
 * What the schema check must verify for a config: each table with its shape (columns, keys,
 * indexes, checks), the changelog triggers of the `changelog` tables, the notifying triggers of the
 * `listen` tables, and the changelog and its pruning when a table reads it. The retention the
 * pruning must keep is the largest of `changelog.minRetention` and the `maxGap` and `lookback` of
 * the `changelog` tables.
 */
export declare function lilypadSchemaCheckOptions(config: LilypadDbConfig): LilypadSchemaCheckOptions;
/**
 * Checks the database against a config: every table (its columns, keys, indexes and checks), the
 * triggers each sync strategy needs, the changelog and how it is pruned. It connects with its own
 * gate (one connection), reads the catalogs only, and closes it. `npx lilypad-doctor` runs it from
 * the command line, e.g. in a deployment step.
 *
 * @throws If the database cannot be reached.
 */
export declare function runLilypadDoctor(options: LilypadDoctorOptions): Promise<LilypadDoctorReport>;
//#endregion
export { LILYPAD_DEFAULT_CHANGELOG_TABLE, LILYPAD_DEFAULT_DB_CONFIG_NAME, type LilypadChange, type LilypadChangelogCursor, type LilypadChangelogPruneOptions, type LilypadChangelogPruneScheduleOptions, type LilypadChangelogPruning, type LilypadChangelogSqlOptions, type LilypadChangesRequest, type LilypadDbCacheBaseOptions, type LilypadDbCacheGateNamedOptions, type LilypadDbCacheNamedOptions, type LilypadDbCacheOptions, type LilypadDbCacheSyncOverrides, type LilypadDbCheck, type LilypadDbColumn, type LilypadDbColumnDefault, type LilypadDbColumnName, type LilypadDbColumnReference, type LilypadDbColumnType, type LilypadDbConfig, type LilypadDbConfigInput, type LilypadDbConfigSettings, type LilypadDbDeleteResult, LilypadDbEmptyWriteError, type LilypadDbForeignKey, type LilypadDbGateOptions, type LilypadDbIndex, type LilypadDbIndexMethod, type LilypadDbInsertData, type LilypadDbKey, type LilypadDbListener, LilypadDbMissingPrimaryKeyError, LilypadDbNotFoundError, type LilypadDbNotification, type LilypadDbPoolOptions, type LilypadDbPrimaryKey, type LilypadDbReference, type LilypadDbReferentialAction, type LilypadDbResolvedForeignKey, type LilypadDbResolvedIndex, type LilypadDbResolvedUniqueKey, type LilypadDbRow, type LilypadDbSchema, type LilypadDbTableChangelogSync, type LilypadDbTableDefinition, type LilypadDbTableDefinitionBase, type LilypadDbTableDraft, type LilypadDbTableInput, type LilypadDbTableInputBase, type LilypadDbTableListenSync, type LilypadDbTableName, type LilypadDbTableSync, type LilypadDbTableTrustedSync, type LilypadDbUniqueKey, type LilypadDbUpdateData, type LilypadDbWriteResult, LilypadDisposedError, type LilypadDoctorOptions, type LilypadDoctorReport, type LilypadSchemaCheckOptions, type LilypadSchemaCheckResult, type LilypadSchemaCheckTable, type LilypadSchemaProblem, type LilypadSchemaProblemCode, type LilypadSchemaProblemSeverity, type LilypadSchemaTableShape, defineLilypadDb, defineLilypadTable, isLilypadDbConfig, isLilypadDbTableDefinition };
//# sourceMappingURL=db.d.mts.map