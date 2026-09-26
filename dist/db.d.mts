import { L as LilypadLibLogger } from './LilypadLibLogger-DPBngeVh.mjs';
import { LilypadSingletonAble } from './singleton.mjs';
import postgres from 'postgres';
import { h as LilypadCacheKey, r as LilypadCacheCore, i as LilypadCacheOptions, a as LilypadCacheBulkSyncOptions, b as LilypadCacheEntry, g as LilypadCachedValueType, f as LilypadCacheGetOptions, l as LilypadCacheResult } from './LilypadCacheCore-CwC0ToZN.mjs';
import './platform.mjs';
import './flow.mjs';

type ListenerCallback = (payload: unknown) => void | Promise<void>;
type ListenerCallbackIdentifier = {
    channel: string;
    callbackId: string;
    callback: ListenerCallback;
    /**
     * Called when LISTEN is active again after the listener connection was lost and re-established.
     * Notifications sent while the connection was down are lost: use it to resynchronize.
     */
    onReconnect?: () => void | Promise<void>;
};
type LilypadDbGateOptions = {
    logger?: LilypadLibLogger;
    connectionString: string;
    /** The connection used for `LISTEN`, if not `connectionString` (e.g. a direct, unpooled one). */
    listenerConnectionString?: string;
    listen?: ListenerCallbackIdentifier[];
    /**
     * Maximum duration of each query of the main client, in milliseconds (Postgres
     * `statement_timeout`): the server cancels longer queries, so that slow queries whose callers
     * have already timed out do not pile up.
     */
    statementTimeout?: number;
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
declare const lilypadServerlessPool: Readonly<LilypadDbPoolOptions>;
type LilypadDbGateOptionsWithSingleton = LilypadDbGateOptions & LilypadSingletonAble;
type LilypadDbColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array';
/**
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `LilypadDbSchema<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
    tableName: string;
    primaryKey: PK;
    primaryKeyShouldAutoDetermine?: boolean;
    /**
     * Transforms the data of inserts and updates. Its result replaces the data: omitting a property
     * removes it from the write.
     */
    writeSanitizationFn?: (data: Partial<T>) => Partial<T>;
    selectSanitizationFn?: (row: unknown) => T | null;
    /**
     * The columns of the table, one for each property of `T`.
     * - Without a `selectSanitizationFn`, only these columns are selected.
     * - Only these columns are written by inserts and updates: any other property of the data is ignored.
     *
     * The metadata is optional. Only the `type` of the primary key is used: with `number`,
     * `LilypadDbCache` converts to numbers the ids that notifications and the changelog carry as text.
     */
    cols: {
        [K in keyof T]: LilypadDbColumn<T[K]>;
    };
};
/** The metadata of a column. `nullable` and `default` are descriptive: the library ignores them. */
type LilypadDbColumn<V = unknown> = {
    type?: LilypadDbColumnType;
    nullable?: boolean;
    default?: V | null;
};
/** The data of an insert: the primary key can be omitted when the database generates it. */
type LilypadDbInsertData<T, PK extends keyof T = keyof T> = Omit<T, PK> & Partial<Pick<T, PK>>;
/** The data of an update: the primary key identifies the row, the other columns are optional. */
type LilypadDbUpdateData<T, PK extends keyof T = keyof T> = Partial<T> & Pick<T, PK>;
/**
 * The result of an insert or an update: the row as stored by the database (`null` if the
 * `selectSanitizationFn` discards it), and the id of the transaction that wrote it, as recorded
 * by the changelog (`xid`).
 */
type LilypadDbWriteResult<T> = {
    row: T | null;
    xid: bigint;
};
/**
 * The result of a delete: whether a row had this primary key, and the id of the transaction that
 * deleted it.
 */
type LilypadDbDeleteResult = {
    deleted: boolean;
    xid?: bigint;
};
/** Thrown by `updateToTable` when no row has the primary key of the data. */
declare class LilypadDbNotFoundError extends Error {
    readonly tableName: string;
    readonly primaryKeyValue: unknown;
    constructor(tableName: string, primaryKeyValue: unknown);
}
/**
 * A gateway to a PostgreSQL database: typed CRUD helpers over a {@link LilypadDbSchema}, and
 * channel listeners (`LISTEN/NOTIFY`) with reconnection handling.
 *
 * @example
 * ```typescript
 * const gate = await LilypadDbGate.create({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   listen: [
 *     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 */
declare class LilypadDbGate {
    readonly id: string;
    readonly sql: postgres.Sql;
    /** Only when `listenerConnectionString` differs: otherwise `sql` listens. */
    private readonly listenerClient?;
    protected logger?: LilypadLibLogger;
    private listeners;
    private releaseSingleton;
    private readonly heartbeat?;
    private readonly heartbeatChannel;
    private heartbeatStop?;
    private constructor();
    /**
     * Creates a gate and registers the listeners of `options.listen`.
     * Without listeners it opens no connection: the pool connects on the first query, so creating a
     * gate at module level does not reach the database (e.g. during a build).
     * With `singleton: true`, a later call with the same identifier returns the existing gate and
     * ignores its own options (a warning is logged if they differ).
     */
    static create(options: LilypadDbGateOptionsWithSingleton): Promise<LilypadDbGate>;
    private static initializeNew;
    /**
     * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
     * otherwise by copying the schema columns.
     */
    private mapRow;
    /**
     * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
     * columns that are not in the schema; otherwise only the schema columns are needed.
     */
    private selectedColumns;
    /**
     * Prepares the data of an insert/update:
     * - applies the schema's `writeSanitizationFn`, whose result replaces the data;
     * - validates the primary key, which an update always needs to find the row;
     * - restricts the written columns to the schema columns, so that extra properties of `data`
     *   (e.g. coming from a request body) are never written to the table;
     * - skips `undefined` values, which postgres.js rejects.
     */
    private prepareWrite;
    /**
     * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
     * of the whole table is never held in memory at once.
     *
     * @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
     * rejects with the reason of the signal.
     */
    selectAllFromTable<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, options?: {
        signal?: AbortSignal;
    }): Promise<T[]>;
    /**
     * Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
     * the parameters of a query). Keys without a row are left out of the result, as are the rows the
     * `selectSanitizationFn` discards.
     */
    selectFromTableByPrimaryKeys<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, primaryKeyValues: T[PK][]): Promise<T[]>;
    selectFromTableByPrimaryKey<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<T | null>;
    /**
     * Inserts a row.
     *
     * @returns The row as stored by the database, including generated columns such as an
     * auto-determined primary key (`null` if the `selectSanitizationFn` discards it), and the id of
     * the transaction that wrote it.
     */
    insertToTable<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, data: LilypadDbInsertData<T, PK>): Promise<LilypadDbWriteResult<T>>;
    /** Splits a row returned by a write into the row and the id of its transaction. */
    private writeResult;
    /**
     * Updates the row identified by the primary key contained in `data`. Only the columns present
     * in `data` are written.
     *
     * @returns The row as stored by the database (`null` if the `selectSanitizationFn` discards it),
     * and the id of the transaction that wrote it.
     * @throws {LilypadDbNotFoundError} If no row with that primary key exists.
     */
    updateToTable<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, data: LilypadDbUpdateData<T, PK>): Promise<LilypadDbWriteResult<T>>;
    /**
     * Deletes the row with this primary key.
     *
     * @returns Whether a row had this primary key, and the id of the transaction that deleted it.
     */
    deleteFromTable<T, PK extends keyof T = keyof T>(schema: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<LilypadDbDeleteResult>;
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
    addListener(identifier: ListenerCallbackIdentifier): Promise<void>;
    /**
     * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
     * It never rejects: a failed UNLISTEN is logged (the connection keeps the channel, whose
     * notifications are then ignored).
     *
     * @returns `true` if the callback was registered.
     */
    removeListener(channel: string, callbackId: string): Promise<boolean>;
    private startHeartbeat;
    private stopHeartbeat;
    /**
     * Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
     * recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as a channel is
     * listened to. `false` while no channel is listened to.
     */
    isListenHealthy(): boolean;
    close(): Promise<void>;
}

/**
 * The changelog records every change of the cached tables in a table, so that each instance can
 * read the changes made since its last check with one query. It needs no long-lived connection
 * (unlike `LISTEN/NOTIFY`), so it suits serverless platforms, and it also catches the changes made
 * by other programs. It needs PostgreSQL 13 or later (`xid8`).
 */
declare const LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
type LilypadChangelogSqlOptions = {
    /** Name of the changelog table. Defaults to `lilypad_cache_changes`. */
    table?: string;
    /**
     * Channel on which the trigger also sends a `NOTIFY` for the `listen` strategy, or `false` to
     * send none. Defaults to `cache_events`.
     */
    notifyChannel?: string | false;
};
/**
 * The SQL that creates the changelog table and its trigger function. Run it once, in a migration.
 * It is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`).
 *
 * Then attach the trigger to every cached table with {@link lilypadChangelogTriggerSql}.
 */
declare function lilypadChangelogSql(options?: LilypadChangelogSqlOptions): string;
/**
 * The SQL that attaches the changelog triggers to a cached table: one for the changes of its rows,
 * and one for `TRUNCATE`, which fires no row trigger. Run it once per table, in a migration, after
 * {@link lilypadChangelogSql}.
 *
 * @param options.table - The cached table (as in its `LilypadDbSchema`).
 * @param options.primaryKey - Its primary key column.
 * @param options.changelogTable - The changelog table, if not the default one.
 */
declare function lilypadChangelogTriggerSql(options: {
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
 * Whether the changes of the transaction `xid` were visible to the read that produced `cursor`:
 * a later read from this cursor does not return them.
 */
declare function lilypadCursorCovers(cursor: LilypadChangelogCursor, xid: bigint): boolean;
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
 * qualified), so a table of the same name in another schema is not mixed up with it. Rows recorded
 * by a version 1 trigger, which had no schema, match any schema.
 */
declare function readLilypadChanges(gate: LilypadDbGate, options: LilypadChangesRequest & {
    changelogTable?: string;
}): Promise<{
    changes: LilypadChange[];
    cursor: LilypadChangelogCursor;
}>;
/**
 * Like {@link readLilypadChanges}, for several tables in one query: `changes[i]` holds the changes
 * of `requests[i]`. Every request shares the cursor for the next read.
 */
declare function readLilypadChangesBatch(gate: LilypadDbGate, options: {
    requests: LilypadChangesRequest[];
    changelogTable?: string;
}): Promise<{
    changes: LilypadChange[][];
    cursor: LilypadChangelogCursor;
}>;
/**
 * Deletes the changelog rows older than `olderThan` milliseconds. Call it periodically (e.g. from
 * a scheduled job): `olderThan` must be much larger than the `maxGap` and the `lookback` of the
 * caches.
 *
 * @returns The number of deleted rows.
 */
declare function pruneLilypadChangelog(gate: LilypadDbGate, options: {
    olderThan: number;
    changelogTable?: string;
}): Promise<number>;

type LilypadDbCacheDefaultNotificationPayload = {
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
type LilypadDbCacheSchemaVerification = 'warn' | 'throw' | 'off';
/** The options shared by the strategies that see every change of the table. */
type LilypadDbCacheTrustedSyncOptions = {
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
type LilypadDbCacheListenSync = LilypadDbCacheTrustedSyncOptions & {
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
    onNotification?: (payload: LilypadDbCacheDefaultNotificationPayload) => Promise<void> | void;
};
type LilypadDbCacheChangelogSync = LilypadDbCacheTrustedSyncOptions & {
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
     * changelog (see `pruneLilypadChangelog`). Defaults to 1 hour.
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
type LilypadDbCacheSync = LilypadDbCacheListenSync | LilypadDbCacheChangelogSync | {
    strategy: 'none';
};

/** The key type of a table: the type of its primary key column. */
type LilypadDbKey<V, PK extends keyof V> = V[PK] & LilypadCacheKey;
type LilypadDbCacheOptions<V extends object, PK extends keyof V = keyof V> = Omit<LilypadCacheOptions<LilypadDbKey<V, PK>, V>, 'bulkSync'> & {
    gate: LilypadDbGate;
    schema: LilypadDbSchema<V, PK>;
    /** Defaults to `{ strategy: 'listen' }`. */
    sync?: LilypadDbCacheSync;
    /**
     * Loading the whole table (`getAll`): `timeout` bounds each load and each query by primary keys
     * (defaults to 30 seconds); with the `none` strategy, a load stays valid for `ttl` (defaults to
     * the TTL).
     */
    bulkSync?: Omit<LilypadCacheBulkSyncOptions<LilypadDbKey<V, PK>, V>, 'fn'>;
};
/**
 * A cache of the rows of one table, kept up to date with the changes made elsewhere.
 *
 * Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
 * table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
 * `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
 * from the table could be kept past its TTL as if it did.
 *
 * @typeParam V - The row type.
 * @typeParam PK - The primary key column; the keys of the cache are its values.
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create({ ttl: 60_000, gate, schema: usersSchema, logger });
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
declare class LilypadDbCache<V extends object, PK extends keyof V = keyof V, K extends LilypadDbKey<V, PK> = LilypadDbKey<V, PK>> extends LilypadCacheCore<K, V> {
    private readonly gate;
    private readonly schema;
    private readonly sync;
    private readonly maxAge;
    private readonly verifier;
    private releaseSingleton;
    /**
     * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
     * schema check. Notifications from another schema are ignored; while it is unknown, notifications
     * of the table in any schema are applied.
     */
    private tableSchema?;
    /**
     * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
     * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
     * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
     */
    private members;
    /** When the last load of the table started, if one completed (and nothing voided it since). */
    private membersLoadedAt?;
    /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
    private membersFloor;
    /** Receive the rows of the next load of the table (see `loadTable`). */
    private tableLoadWaiters;
    /** The queries of `fetchRows` in flight, by normalized key. */
    private rowFetches;
    /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
    private refreshes;
    /**
     * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
     * entry the last one stored. While the entry holds it, the changes of these writes are already
     * reflected in it.
     */
    private ownWrites;
    /**
     * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
     * database listener. The row type and the primary key are inferred from `schema`.
     * With `singleton: true`, a later call with the same identifier returns the existing cache and
     * ignores its own options (a warning is logged if the table or the TTL differ).
     *
     * @throws If the database listener cannot be registered (e.g. the database is unreachable), or,
     * with `verify: 'throw'`, if the database is not set up.
     */
    static create<V extends object, PK extends keyof V = keyof V>(options: LilypadDbCacheOptions<V, PK> & LilypadSingletonAble): Promise<LilypadDbCache<V, PK>>;
    private constructor();
    /** What the sync strategy may use of this cache. */
    private syncHost;
    /** Loads every row of the table, for the bulk sync of the base class. */
    private loadRows;
    /**
     * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
     * value was read from the database (or written by this instance) after the sync became trusted,
     * and any change of its row since would have expired it. It is kept until `maxAge`.
     */
    private renew;
    /**
     * Applies a change of a row made elsewhere.
     * - A change made by a write of this instance whose result the entry still holds: nothing to do.
     * - A change of a key held (or being read) by this instance: `eager` re-fetches it at once;
     *   `lazy` expires it with no query, which also discards a read in flight (it may predate the
     *   change): the next read fetches it. A `lazy` DELETE caches the key as `null` at once.
     * - A change of any other key: no query. The shared level entry is removed.
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
     * Whether a change is the one of a write of this instance, and the entry still holds the result
     * of the last write of this instance (nothing else replaced it since): that result is at least
     * as recent as the change. The write is forgotten either way.
     */
    private isOwnWrite;
    private recordOwnWrite;
    /** Forgets the own writes whose changes a read from this cursor no longer returns. */
    private forgetOwnWritesCoveredBy;
    /** Follows the values stored in the cache: a row is a row of the table, `null` is not. */
    protected onValueStored(entry: LilypadCacheEntry<K, V>): void;
    /** Notes a row that exists in the table, without fetching it. */
    private addMember;
    /**
     * Replaces the rows of the table with the result of a load, keeping what changed after the load
     * started: rows added since, rows deleted since.
     */
    private replaceMembers;
    /**
     * Whether the rows of the table are known: loaded since the sync became trusted, or, without a
     * trusted sync, less than `bulkSync.ttl` ago.
     */
    private isTableLoaded;
    /**
     * Loads the whole table, even if the bulk sync of the base class still counts as fresh.
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
     * a row). A key already being fetched shares that query.
     *
     * @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
     * @throws If a query fails.
     */
    private fetchRows;
    /** One read of `fetchRows`, bounded by `bulkSync.timeout`. */
    private queryRows;
    /**
     * The rows of these keys, leaving out the keys without a row: the fresh entry, else the value
     * read by `sources` (in order), else the expired entry.
     */
    private rowsOf;
    private memberKeys;
    /**
     * Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
     * memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
     *
     * @throws If the cache is disposed.
     */
    get(key: K, options?: {
        removeExpired?: boolean;
    }): LilypadCachedValueType<V> | undefined;
    /**
     * Returns the row of the key, from the cache or else from the database. Concurrent calls for the
     * same key share a single query.
     *
     * @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
     * @returns The row, or `null` if it does not exist.
     * @throws If the query fails and `onError` gives no fallback value, or if the cache is disposed.
     */
    getOrFetch(key: K, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V>>;
    /**
     * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
     * failed.
     */
    getOrFetchDetailed(key: K, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCacheResult<V>>;
    /**
     * Fetches the row of the key from the database and caches it (`null` if it does not exist),
     * here and in the shared level. Concurrent calls share the query; a call made while a query is
     * running waits for one more query, which sees every change made before the call.
     * If a write that started later completes first, the fetched value is returned but not cached.
     *
     * @returns The row read from the database.
     * @throws If the query fails or exceeds `fetchTimeout`, or if the cache is disposed.
     */
    refresh(key: K): Promise<LilypadCachedValueType<V>>;
    private refreshRow;
    private fetchRow;
    /** Re-fetches a key; if the query fails, expires it instead. */
    private refreshKey;
    protected hasReadInFlight(normalizedKey: string): boolean;
    /**
     * Returns every row of the table, or the rows of `keys`.
     *
     * The whole table is loaded once (again after the sync lost changes, or, with the `none`
     * strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
     * queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
     * are more than a quarter of the table, the whole table is loaded instead.
     * Rows are cached in the memory of this instance only, not in the shared level. With
     * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
     * again at each call.
     *
     * @throws If the rows cannot be loaded, or the cache is disposed.
     */
    getAll(keys?: K[]): Promise<V[]>;
    /**
     * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
     * its original type (a notification may carry a numeric key as a string, or the other way
     * around), or else the id converted to a number when the schema declares the primary key as a
     * `number` column.
     */
    private resolveNotifiedKey;
    /**
     * Caches the key as "does not exist", here and in the shared level. It also applies to protected
     * keys: they are protected from removal, not from reflecting a deleted row.
     */
    private markDeleted;
    /**
     * Disposes of the cache: stops its database listener and its changelog reads, removes it from
     * the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
     * starting is awaited, so that its listener is removed too.
     */
    dispose(): Promise<void>;
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
     * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
     * holds the one generated by the database.
     *
     * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
     * @throws If the cache is disposed.
     */
    sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null>;
    /**
     * Updates the item in the database and caches the row returned by the database.
     * Only the columns present in `item` are written.
     *
     * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
     * @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
     * @throws If the cache is disposed.
     */
    sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null>;
    /**
     * Deletes the row in the database, and caches the key as `null` (also for a protected key).
     *
     * @throws If the cache is disposed.
     */
    sqlDelete(key: K): Promise<void>;
}

type LilypadSchemaCheckOptions = {
    /** The cached tables, as in their `LilypadDbSchema` (`tableName`, `primaryKey`). */
    tables: {
        table: string;
        primaryKey: string;
    }[];
    /**
     * Checks the changelog table, its trigger function, and that each table has the changelog
     * trigger (the `changelog` strategy). `false` skips these checks. Defaults to `{}`: the default
     * changelog table.
     */
    changelog?: {
        table?: string;
    } | false;
    /**
     * Checks that each table has a trigger that sends notifications on this channel (the `listen`
     * strategy). The trigger may be the changelog trigger or one of your own: its function must call
     * `pg_notify` with the channel name as a literal. Defaults to `false`: not checked.
     */
    notifyChannel?: string | false;
};
type LilypadSchemaProblemCode = 
/** PostgreSQL is older than 13: the changelog needs `xid8`. */
'unsupported-version'
/** The cached table does not exist (as seen with the `search_path` of the gate). */
 | 'missing-table'
/** The changelog table or its trigger function does not exist. */
 | 'missing-changelog'
/** The changelog table or its trigger function was installed by an older version of the library. */
 | 'outdated-changelog'
/** The table has no enabled changelog trigger firing on each INSERT, UPDATE and DELETE row. */
 | 'missing-changelog-trigger'
/** The changelog trigger of the table records another column than the primary key. */
 | 'wrong-trigger-primary-key'
/**
 * `TRUNCATE` of the table is not recorded (or not notified, with `notifyChannel`): it fires no
 * row trigger, so the caches would keep the removed rows.
 */
 | 'missing-truncate-trigger'
/**
 * No enabled trigger of the table sends notifications on the channel, or not for each of INSERT,
 * UPDATE and DELETE.
 */
 | 'missing-notify-trigger';
type LilypadSchemaProblem = {
    code: LilypadSchemaProblemCode;
    /** The cached table concerned, for the per-table problems. */
    table?: string;
    message: string;
    /** SQL that fixes the problem, to run in a migration. */
    fix?: string;
};
type LilypadSchemaCheckResult = {
    ok: boolean;
    problems: LilypadSchemaProblem[];
    /** The schema each table resolves to (`null` if the table does not exist). */
    tables: {
        table: string;
        schema: string | null;
    }[];
};
/** Thrown by `LilypadDbCache.create` with `verify: 'throw'` when the database is not set up. */
declare class LilypadSchemaCheckError extends Error {
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
declare function checkLilypadSchema(gate: LilypadDbGate, options: LilypadSchemaCheckOptions): Promise<LilypadSchemaCheckResult>;

export { LILYPAD_DEFAULT_CHANGELOG_TABLE, type LilypadChange, type LilypadChangelogCursor, type LilypadChangelogSqlOptions, type LilypadChangesRequest, LilypadDbCache, type LilypadDbCacheChangelogSync, type LilypadDbCacheDefaultNotificationPayload, type LilypadDbCacheListenSync, type LilypadDbCacheOptions, type LilypadDbCacheSchemaVerification, type LilypadDbCacheSync, type LilypadDbCacheTrustedSyncOptions, type LilypadDbColumn, type LilypadDbColumnType, type LilypadDbDeleteResult, LilypadDbGate, type LilypadDbGateOptions, type LilypadDbInsertData, type LilypadDbKey, LilypadDbNotFoundError, type LilypadDbPoolOptions, type LilypadDbSchema, type LilypadDbUpdateData, type LilypadDbWriteResult, LilypadSchemaCheckError, type LilypadSchemaCheckOptions, type LilypadSchemaCheckResult, type LilypadSchemaProblem, type LilypadSchemaProblemCode, type ListenerCallbackIdentifier, checkLilypadSchema, lilypadChangelogSql, lilypadChangelogTriggerSql, lilypadCursorCovers, lilypadServerlessPool, pruneLilypadChangelog, readLilypadChanges, readLilypadChangesBatch };
