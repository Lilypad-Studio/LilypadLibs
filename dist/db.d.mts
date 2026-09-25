import { a as LilypadLibLogger } from './LilypadLogger-BBPMocPb.mjs';
import { LilypadSingletonAble } from './singleton.mjs';
import postgres from 'postgres';
import { d as LilypadCacheKey, L as LilypadCache, e as LilypadCacheOptions, j as LilypadCacheEntry, c as LilypadCachedValueType, b as LilypadCacheGetOptions, f as LilypadCacheResult } from './cache-o_gcJjOY.mjs';
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
    insertSanitizationFn?: (data: Partial<T>) => Partial<T>;
    selectSanitizationFn?: (row: unknown) => T | null;
    /**
     * The columns of the table.
     * - Without a `selectSanitizationFn`, only these columns are selected.
     * - Only these columns are written by inserts and updates: any other property of the data is ignored.
     *
     * The column metadata (`type`, `nullable`, `default`) is descriptive and is not used by the gate.
     */
    cols: {
        [K in keyof T]: {
            type: LilypadDbColumnType;
        } & ({
            nullable?: false;
        } | {
            nullable: true;
            default: T[K] | null;
        });
    };
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
 * Provides a gateway for interacting with a PostgreSQL database, including CRUD operations and channel-based listeners.
 *
 * The `LilypadDbGate` class manages a database connection and allows for:
 * - Fetching all rows from a table with type safety.
 * - Inserting, updating, and deleting rows in a table.
 * - Listening to PostgreSQL channels for notifications and handling them with callbacks.
 * - Managing multiple listeners and cleaning up resources.
 *
 * @example
 * ```typescript
 * const dbGate = await LilypadDbGate.create({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   listen: [
 *     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 *
 * @public
 */
declare class LilypadDbGate {
    readonly id: string;
    private listenerConnectionString;
    sql: postgres.Sql;
    private listenerConnection;
    protected logger?: LilypadLibLogger;
    private listeners;
    private singletonIdentifier?;
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
     * - applies the schema's `insertSanitizationFn`, whose result replaces the data;
     * - validates the primary key, which an update always needs to find the row;
     * - restricts the written columns to the schema columns, so that extra properties of `data`
     *   (e.g. coming from a request body) are never written to the table;
     * - skips `undefined` values, which postgres.js rejects.
     */
    private prepareWrite;
    /**
     * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
     * of the whole table is never held in memory at once.
     */
    selectAllFromTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>): Promise<T[]>;
    /**
     * Selects the rows with these primary keys, in one query. Keys without a row are left out of
     * the result, as are the rows the `selectSanitizationFn` discards.
     */
    selectFromTableByPrimaryKeys<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValues: T[PK][]): Promise<T[]>;
    selectFromTableByPrimaryKey<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<T | null>;
    /**
     * Inserts a row.
     *
     * @returns The row as stored by the database, including generated columns such as an
     * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
     */
    insertToTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbInsertData<T, PK>): Promise<T | null>;
    /** Like {@link insertToTable}, but also returns the id of the transaction that wrote the row. */
    insertToTableDetailed<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbInsertData<T, PK>): Promise<LilypadDbWriteResult<T>>;
    /** Splits a row returned by a write into the row and the id of its transaction. */
    private writeResult;
    /**
     * Updates the row identified by the primary key contained in `data`. Only the columns present
     * in `data` are written.
     *
     * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
     * @throws If no row with that primary key exists.
     */
    updateToTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbUpdateData<T, PK>): Promise<T | null>;
    /** Like {@link updateToTable}, but also returns the id of the transaction that wrote the row. */
    updateToTableDetailed<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, data: LilypadDbUpdateData<T, PK>): Promise<LilypadDbWriteResult<T>>;
    deleteFromTable<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<void>;
    /**
     * Like {@link deleteFromTable}, but also returns the id of the transaction that deleted the row
     * (`undefined` when no row had this primary key).
     */
    deleteFromTableDetailed<T, PK extends keyof T = keyof T>(options: LilypadDbSchema<T, PK>, primaryKeyValue: T[PK]): Promise<{
        xid?: bigint;
    }>;
    /**
     * Retrieves the singleton listener database connection.
     *
     * If the listener connection does not already exist, this method initializes it
     * using the provided connection string and specific connection options:
     * - `max`: Limits the pool to a single connection.
     * - `idle_timeout`: Disables idle timeout for the connection.
     * - `max_lifetime`: Disables maximum lifetime for the connection.
     *
     * @returns The singleton listener database connection instance.
     */
    private getListenerConnection;
    /**
     * Starts listening on the specified channel.
     *
     * The listener entry is registered immediately, before LISTEN is active, so that concurrent
     * `addListener` calls for the same channel share it and await the same `ready` promise.
     * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
     *
     * @param channel - The name of the channel to listen on.
     * @returns The listener entry of the channel.
     */
    private initializeListener;
    /**
     * Runs a listener callback, catching both synchronous throws and rejected promises,
     * so a failing callback can neither affect the others nor cause an unhandled rejection.
     */
    private runCallbackSafely;
    /**
     * Executes all registered listener callbacks for a given channel, passing the provided payload to each callback.
     *
     * @param channel - The name of the channel whose listener callbacks should be executed.
     * @param payload - The data to pass to each listener callback.
     */
    private executeAllListenerCallbacks;
    private executeReconnectCallbacks;
    /**
     * Adds a listener callback for a specified channel.
     *
     * If the channel does not already have a listener, it initializes one.
     * The callback is associated with the provided `callbackId`: adding a callback with an existing
     * `callbackId` on the same channel replaces the previous one.
     *
     * @param params - An object containing:
     *   @param params.channel - The name of the channel to listen to.
     *   @param params.callbackId - A unique identifier for the callback.
     *   @param params.callback - The callback function to be invoked for the channel.
     *   @param params.onReconnect - Optional function called when LISTEN is re-established after a reconnection.
     *
     * @returns A promise that resolves once LISTEN is active on the channel.
     * @throws If LISTEN fails; in that case the callback is not registered.
     */
    addListener(identifier: ListenerCallbackIdentifier): Promise<void>;
    /**
     * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
     *
     * @returns `true` if the callback was registered.
     */
    removeListener(channel: string, callbackId: string): Promise<boolean>;
    close(): Promise<void>;
}

type LilypadDbCacheDefaultNotificationPayload = {
    /**
     * The schema of the table. Notifications without it match the table in any schema (the triggers
     * of version 1 of the changelog, and custom triggers that do not send it).
     */
    schema?: string;
    table?: string;
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
type LilypadDbCacheDefaultListenerOptions = {
    /**
     * If true, the cache entry is updated from the database (or set to null, for a DELETE)
     * before `callback` is called.
     *
     * Without a `callback` the entry is always updated. With a `callback` this defaults to false:
     * keeping the cache up to date is then the callback's responsibility.
     */
    automaticallyInvalidateDataBeforeCallback?: boolean;
    callback?: (payload: LilypadDbCacheDefaultNotificationPayload) => Promise<void> | void;
};
/**
 * How the cache learns about the changes made by other instances and other programs.
 *
 * - `listen`: `LISTEN/NOTIFY` on a dedicated connection. Near real-time, for long-running servers.
 *   Not suited to serverless platforms: the connection must stay open, it does not work through a
 *   pooler in transaction mode, and notifications sent while an instance is suspended are lost.
 * - `changelog`: each instance reads the changelog table (see `lilypadChangelogSql`) at most once
 *   per `pollInterval`, when the cache is used. No long-lived connection: suited to serverless
 *   platforms. Changes are seen within `pollInterval`.
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
 * While `listen` or `changelog` is trusted (`LISTEN` active, changelog read within `maxGap`), the
 * cache sees every change of the table, so the TTL no longer needs a query: an entry that reaches
 * its TTL without a change of its row is kept until `maxAge`.
 */
type LilypadDbCacheSync = {
    strategy: 'listen';
    verify?: LilypadDbCacheSchemaVerification;
    /**
     * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
     * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
     */
    connect?: 'eager' | 'lazy';
    listenerOptions?: LilypadDbCacheDefaultListenerOptions;
    /**
     * While the sync is trusted, an entry read from the database (not a copy from the shared
     * level, nor a fallback after an error) that reaches its TTL with no change of its row is
     * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
     * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
     * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
     */
    maxAge?: number;
} | {
    strategy: 'changelog';
    verify?: LilypadDbCacheSchemaVerification;
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
    /**
     * While the sync is trusted, an entry read from the database (not a copy from the shared
     * level, nor a fallback after an error) that reaches its TTL with no change of its row is
     * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
     * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
     * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
     */
    maxAge?: number;
} | {
    strategy: 'none';
};
/** How the cache checks that the database has the triggers it needs (see {@link LilypadDbCacheSync}). */
type LilypadDbCacheSchemaVerification = 'warn' | 'throw' | 'off';
type LilypadDbCacheConstructorOptions<K extends LilypadCacheKey, V, PK extends keyof V> = LilypadCacheOptions<K, V> & {
    dbGate: {
        gate: LilypadDbGate;
        schema: LilypadDbSchema<V, PK>;
    };
    /** Defaults to `{ strategy: 'listen' }`, or to what `useDefaultDbListener` asks for. */
    sync?: LilypadDbCacheSync;
} & ({
    /** @deprecated Use `sync: { strategy: 'none' }`. */
    useDefaultDbListener?: false;
} | {
    /** @deprecated Use `sync: { strategy: 'listen', listenerOptions }`. */
    useDefaultDbListener: true;
    /** @deprecated Use `sync: { strategy: 'listen', listenerOptions }`. */
    defaultListenerOptions: LilypadDbCacheDefaultListenerOptions;
});
/**
 * A cache class that synchronizes with a database table using a provided database gateway and schema.
 *
 * `LilypadDbCache` extends `LilypadCache` to provide automatic cache population and invalidation
 * by fetching data from a database. It supports bulk synchronization and per-key updates from the database.
 *
 * @typeParam K - The type of the cache key: the type of the primary key column.
 * @typeParam V - The type of the cached value, constrained to object.
 * @typeParam PK - The primary key column of `V` (see {@link LilypadDbSchema}).
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create<number, User, 'id'>(60_000, {
 *   dbGate: { gate, schema: usersSchema },
 *   logger,
 * });
 * const user = await users.getOrFetch(42); // User | null (no such row) | undefined (query failed)
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `update` and
 *   `invalidate` always re-fetch the key; `getAll` loads the whole table once, then fetches only
 *   the rows it does not hold up to date.
 * - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the result.
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
 *   notes that the row exists, and `getAll` fetches it.
 * - The name of the cache (shared level keys, invalidation events) defaults to the table name.
 */
declare class LilypadDbCache<K extends LilypadCacheKey & V[PK], V extends object, PK extends keyof V = keyof V> extends LilypadCache<K, V> {
    private readonly dbGate;
    private readonly sync;
    private readonly defaultDbListener?;
    /** Whether the default listener updates the cache (not only a callback of the application). */
    private readonly listenAppliesChanges;
    private listening?;
    private singletonIdentifier?;
    /**
     * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
     * schema check. Notifications from another schema are ignored; while it is unknown, notifications
     * of the table in any schema are applied.
     */
    private tableSchema?;
    private schemaCheck?;
    /**
     * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
     * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
     * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
     */
    private members;
    /** When the last load of the table started, if one completed. */
    private membersLoadedAt?;
    /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
    private membersFloor;
    /** Since when `LISTEN` delivers every change to this instance. */
    private listenTrustedSince?;
    /** Since when the chain of changelog reads is unbroken. */
    private changelogTrustedSince?;
    /**
     * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
     * entry the last one stored. While the entry holds it, the changes of these writes are already
     * reflected in it.
     */
    private ownWrites;
    private changelogCursor?;
    /** Changes already applied, by id, with their transaction id, until the cursor passes them. */
    private appliedChanges;
    private lastChangelogRead;
    private changelogRead?;
    /**
     * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
     * database listener.
     * With `singleton: true`, a later call with the same identifier returns the existing cache and
     * ignores its own options (a warning is logged if the table or the TTL differ).
     *
     * @throws If the database listener cannot be registered (e.g. the database is unreachable).
     */
    static create<K extends LilypadCacheKey & V[PK], V extends object, PK extends keyof V = keyof V>(ttl: number | undefined, options: LilypadDbCacheConstructorOptions<K, V, PK> & LilypadSingletonAble): Promise<LilypadDbCache<K, V, PK>>;
    private static initializeNew;
    private constructor();
    private static syncFromLegacyOptions;
    private schemaVerification;
    /**
     * Checks once that the database has the triggers the sync strategy needs, and resolves the schema
     * of the table. With `verify: 'warn'` it never rejects: problems and failures are logged.
     *
     * @throws A `LilypadSchemaCheckError` with `verify: 'throw'`, or the error of the check.
     */
    private verifySchema;
    private runSchemaCheck;
    /**
     * Registers the listener once, after the schema check (which resolves the schema of the table,
     * to ignore the notifications of other schemas); a failed registration is retried by the next call.
     */
    private startListening;
    /**
     * Since when this instance sees every change of the table, or `undefined` if it may miss some:
     * no sync, `LISTEN` not active (or its callback does not update the cache), or changelog not
     * read for longer than `maxGap`.
     */
    private syncTrustedSince;
    private maxAge;
    /**
     * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
     * value was read from the database (or written by this instance) after the sync became trusted,
     * and any change of its row since would have expired it. It is kept until `maxAge`.
     */
    private renew;
    /**
     * Brings the cache up to date with the changes made elsewhere before a read: starts a lazy
     * `LISTEN`, or reads the changelog when it is due. It never throws: a failure is logged, and
     * the read goes on with the cache as it is.
     *
     * @returns A promise to await, or `undefined` when there is nothing to wait for: the read then
     * goes on synchronously, as without synchronization.
     */
    protected syncBeforeRead(): Promise<void> | undefined;
    /** Reads the changelog once at a time; errors are logged. */
    private readChangelog;
    private applyChangelog;
    /**
     * Applies a change of a row made elsewhere.
     * - A change made by a write of this instance whose result the entry still holds: nothing to do.
     * - DELETE: the key is cached as `null`.
     * - INSERT/UPDATE of a key held (or being fetched) by this instance: `eager` re-fetches it at
     *   once; `lazy` expires it, so the next read fetches it. A fetch in flight is always re-fetched,
     *   since it may have read the row before the change.
     * - INSERT/UPDATE of any other key: no query. The shared level entry is removed, and the key is
     *   noted as a row of the table, which the next `getAll` fetches.
     *
     * @param xid - The transaction that made the change, when known.
     * @returns The key of the changed row.
     */
    private applyChange;
    /**
     * Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
     * discarded, the copies of the shared level produced before are ignored, and the table is known
     * to be empty (until the changes that follow).
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
     * trusted sync, less than `defaultBulkSyncTtl` ago.
     */
    private isTableLoaded;
    /** Loads the whole table, even if the bulk sync of the base class still counts as fresh. */
    private loadTable;
    /** The keys whose entry is missing or expired (after renewing the entries still up to date). */
    private staleKeys;
    /**
     * Fetches rows by primary key, in batches, and caches them in this instance only (`null` for
     * the keys without a row). Concurrent calls for the same keys share the queries.
     *
     * @throws If a query fails.
     */
    private fetchRows;
    /** The cached rows of these keys, leaving out the keys without a row. */
    private rowsOf;
    get(key: K, removeOld?: boolean): LilypadCachedValueType<V> | undefined;
    getOrSetDetailed(key: K, valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCacheResult<V>>;
    /**
     * Retrieves a cached value by key, or fetches it from the database if not found in cache.
     * Concurrent calls for the same key share a single database query.
     *
     * @param key - The cache key to retrieve or fetch.
     * @param options - The `getOrSet` options (e.g. `staleWhileRevalidate`, `timeout`).
     * @returns A promise that resolves to the cached value (`null` if the row does not exist),
     * or undefined if an error occurs during fetching.
     * @throws Does not throw; errors are logged internally.
     */
    getOrFetch(key: K, options?: LilypadCacheGetOptions<K, V>): Promise<LilypadCachedValueType<V> | undefined>;
    /**
     * Invalidates the cache entry for the specified key.
     *
     * Attempts to update the cache for the given key. If the update fails,
     * logs the error and expires the entry, as the base class's invalidate method does.
     * `platform.onInvalidate` receives a `manual` event.
     *
     * @param key - The cache key to invalidate.
     * @param options - Optional settings for invalidation.
     * @param options.invalidateBulkSync - Whether to invalidate the bulk sync of the base class
     * (`bulkSync`, `bulkAsyncGet`) when the update fails (default: true). `getAll` fetches the key
     * again either way.
     * @returns A promise that resolves when the invalidation process is complete.
     */
    invalidate(key: K, options?: {
        invalidateBulkSync?: boolean;
    }): Promise<void>;
    /** Re-fetches a key; if the query fails, expires it instead. */
    private refreshKey;
    /**
     * Updates the cache entry for the specified key by fetching the latest value from the database.
     * A row that does not exist is cached as `null`.
     * If a write that started later completes first, the fetched value is returned but not cached.
     *
     * @param key - The primary key of the cache entry to update.
     * @returns A promise that resolves to the updated value from the database.
     * @throws Rethrows any error encountered during the database fetch.
     */
    update(key: K): Promise<LilypadCachedValueType<V>>;
    /**
     * Returns every row of the table, or the rows of `keys`.
     *
     * The whole table is loaded once (again after the sync lost changes, or, with the `none`
     * strategy, after `defaultBulkSyncTtl`). Then only the rows the cache does not hold up to date
     * are queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When
     * they are more than a quarter of the table, the whole table is loaded instead.
     * Rows are cached in the memory of this instance only, not in the shared level.
     *
     * @throws If the rows cannot be loaded.
     */
    getAll(keys?: K[]): Promise<V[]>;
    private memberKeys;
    /**
     * The key of the cached entry for a notified id, so that the entry keeps its original key type
     * (a notification may carry a numeric key as a string, or the other way around).
     */
    private resolveNotifiedKey;
    /**
     * Caches the key as "does not exist", here and in the shared level. Unlike
     * `delete(key, { setNull: true })`, it also applies to protected keys: they are protected from
     * removal, not from reflecting a deleted row.
     */
    private markDeleted;
    protected getDefaultDbListener(options?: LilypadDbCacheDefaultListenerOptions): ListenerCallbackIdentifier;
    private static parseXid;
    /**
     * Whether a notification is about the table of this cache. `table` is the name without its
     * schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
     */
    private isNotificationForTable;
    /**
     * Marks every entry as expired (keeping the values as fallback), discards the reads in flight
     * and forces the next bulk sync: changes may have been missed.
     */
    private expireAll;
    /**
     * Disposes of the cache: stops its database listener, removes it from the singleton registry
     * (if it was created as a singleton) and clears it.
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
     */
    sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null>;
    /**
     * Updates the item in the database and caches the row returned by the database.
     * Only the columns present in `item` are written.
     *
     * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
     * @throws If no row with the item's primary key exists.
     */
    sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null>;
    /**
     * Deletes the row in the database, and caches the key as `null` (also for a protected key).
     */
    sqlDelete(key: K): Promise<void>;
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
 * Reads the changes of a table since `cursor`, and the cursor for the next read.
 *
 * The cursor is the oldest transaction still running at the time of the read: the next read
 * returns every change of that transaction or of later ones, so a transaction that commits after
 * a read is never missed, whatever the order of the commits. A change can therefore be returned
 * by several reads: callers skip the ids they have already processed.
 *
 * Without a cursor (first read, or a cursor no longer trusted), `since.lookback` returns the
 * changes recorded in the last `lookback` milliseconds instead.
 *
 * `tableName` is resolved as the gate's queries resolve it (with the `search_path` when it is not
 * qualified), so a table of the same name in another schema is not mixed up with it. Rows recorded
 * by a version 1 trigger, which had no schema, match any schema.
 */
declare function readLilypadChanges(gate: LilypadDbGate, options: {
    tableName: string;
    since: {
        cursor: bigint;
    } | {
        lookback: number;
    };
    changelogTable?: string;
}): Promise<{
    changes: LilypadChange[];
    cursor: bigint;
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
/** No trigger of the table sends notifications on the channel. */
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

export { LILYPAD_DEFAULT_CHANGELOG_TABLE, type LilypadChange, type LilypadChangelogSqlOptions, LilypadDbCache, type LilypadDbCacheDefaultListenerOptions, type LilypadDbCacheDefaultNotificationPayload, type LilypadDbCacheSchemaVerification, type LilypadDbCacheSync, type LilypadDbColumnType, LilypadDbGate, type LilypadDbGateOptions, type LilypadDbInsertData, type LilypadDbPoolOptions, type LilypadDbSchema, type LilypadDbUpdateData, type LilypadDbWriteResult, LilypadSchemaCheckError, type LilypadSchemaCheckOptions, type LilypadSchemaCheckResult, type LilypadSchemaProblem, type LilypadSchemaProblemCode, type ListenerCallbackIdentifier, checkLilypadSchema, lilypadChangelogSql, lilypadChangelogTriggerSql, lilypadServerlessPool, pruneLilypadChangelog, readLilypadChanges };
