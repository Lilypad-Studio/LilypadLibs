//#region src/dbGate/LilypadDbSchema.d.ts
/**
 * The type of a column, as the application sees it. For a primary key it tells `LilypadDbCache` how
 * to read the ids that notifications and the changelog carry as text: `number` converts them to
 * numbers; `string` and `bigint` keep them as strings. Declare `bigint`/`bigserial` columns as
 * `bigint`: postgres.js returns them as strings, so their keys and the row property are strings
 * (type them as such). `lilypad-doctor` also checks that the database type fits it (see `pgType`).
 */
type LilypadDbColumnType = 'string' | 'number' | 'bigint' | 'boolean' | 'date' | 'json' | 'array';
/**
 * The default of a column: `true` when the database has one (whatever it is), or its SQL
 * expression (e.g. `{ sql: 'now()' }`), which `lilypad-doctor` uses in the SQL that fixes the table.
 * The expression is not compared with the installed one.
 */
type LilypadDbColumnDefault = true | {
  sql: string;
};
/**
 * What the database does to the rows that reference a row that is deleted or updated.
 * Defaults to `no action`.
 */
type LilypadDbReferentialAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
/** The access method of an index. Defaults to `btree`. */
type LilypadDbIndexMethod = 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist';
/** A column name of the row type. */
type LilypadDbColumnName<T> = keyof T & string;
/**
 * The table a foreign key references: `table` or `schema.table`. An unqualified name is the table
 * of the config with this `tableName`, or else a table of the `defaultSchema` of the config.
 */
type LilypadDbReference = {
  table: string;
  /**
   * The referenced columns, in the order of the columns of the foreign key. Defaults to the primary
   * key of the referenced table, when it is a table of the config.
   */
  columns?: readonly string[];
  onDelete?: LilypadDbReferentialAction;
  onUpdate?: LilypadDbReferentialAction;
};
/** The foreign key of one column (the `references` of a column). */
type LilypadDbColumnReference = Omit<LilypadDbReference, 'columns'> & {
  /** The referenced column. Defaults to the primary key of the referenced table. */
  column?: string;
};
/** A foreign key of the table, on one or several columns. */
type LilypadDbForeignKey<T> = {
  /** The name of the constraint, used by the SQL that creates it. It is not compared. */
  name?: string;
  columns: readonly LilypadDbColumnName<T>[];
  references: LilypadDbReference;
};
/**
 * A set of columns whose values are unique together: a unique constraint, a unique index (neither
 * partial nor on expressions) or the primary key satisfies it.
 */
type LilypadDbUniqueKey<T> = {
  /** The name of the constraint, used by the SQL that creates it. It is not compared. */
  name?: string;
  columns: readonly LilypadDbColumnName<T>[];
};
/** An index on columns of the table (neither partial nor on expressions). */
type LilypadDbIndex<T> = {
  /** The name of the index, used by the SQL that creates it. It is not compared. */
  name?: string;
  /** The columns, in the order of the index. */
  columns: readonly LilypadDbColumnName<T>[];
  unique?: boolean;
  using?: LilypadDbIndexMethod;
};
/**
 * A `CHECK` constraint, found by its name (its expression is not compared: PostgreSQL rewrites it).
 * With an `expression`, the SQL that fixes the table creates it.
 */
type LilypadDbCheck = {
  name: string;
  expression?: string;
};
/**
 * The description of a table: what the library reads and writes, and what `lilypad-doctor`
 * expects to find in the database. Define it with `defineLilypadTable`, in a config file (see
 * `defineLilypadDb`).
 *
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `defineLilypadTable<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
  /** The table, unqualified (`users`), or qualified (`app.users`) instead of `schemaName`. */
  tableName: string;
  /** The PostgreSQL schema of the table. Defaults to the `defaultSchema` of the config. */
  schemaName?: string;
  /**
   * The primary key: one column, whose values are the keys of `LilypadDbCache`. `lilypad-doctor`
   * checks that it is the primary key of the table.
   */
  primaryKey: PK;
  /**
   * The database generates the primary key (e.g. `serial`, `identity`, a default): inserts leave
   * it out, even when the data has one, and return the generated one.
   */
  generatedPrimaryKey?: boolean;
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
   * At runtime, only the `type` of the primary key is used: with `number`, `LilypadDbCache` converts
   * to numbers the ids that notifications and the changelog carry as text. `lilypad-doctor` checks
   * the rest against the database.
   */
  cols: { [K in keyof T]: LilypadDbColumn; };
  /** The sets of columns that are unique together (see also the `unique` of a column). */
  unique?: readonly LilypadDbUniqueKey<T>[];
  /** The foreign keys of the table (see also the `references` of a column). */
  foreignKeys?: readonly LilypadDbForeignKey<T>[];
  indexes?: readonly LilypadDbIndex<T>[];
  checks?: readonly LilypadDbCheck[];
};
/**
 * The metadata of a column. The library reads only the `type` of the primary key at runtime;
 * `lilypad-doctor` compares the rest with the database.
 */
type LilypadDbColumn = {
  type?: LilypadDbColumnType;
  /**
   * The exact PostgreSQL type (e.g. `uuid`, `int4`, `varchar(64)`, `timestamptz`, `text[]`),
   * compared with the installed one; common aliases are accepted (`int4` is `integer`). Without it,
   * `lilypad-doctor` only checks that the database type fits `type`, and cannot generate the SQL
   * that creates the column.
   */
  pgType?: string;
  /** Whether the column accepts `NULL`. Checked when set. */
  nullable?: boolean;
  /** Whether the column has a default (see {@link LilypadDbColumnDefault}). Checked when set. */
  default?: LilypadDbColumnDefault;
  /** The values of the column are unique (a unique key on this column alone). */
  unique?: boolean;
  /** The column is a foreign key to this table. */
  references?: LilypadDbColumnReference;
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
/** Thrown by the writes when the data has no primary key where one is needed. */
declare class LilypadDbMissingPrimaryKeyError extends Error {
  readonly tableName: string;
  readonly primaryKey: string;
  constructor(schema: {
    primaryKey: PropertyKey;
    tableName: string;
  }, context: string);
}
/** Thrown by an insert or an update whose data has no column of the schema to write. */
declare class LilypadDbEmptyWriteError extends Error {
  readonly tableName: string;
  constructor(tableName: string, operation: 'insert' | 'update');
}
/** Thrown by `updateToTable` when no row has the primary key of the data. */
declare class LilypadDbNotFoundError extends Error {
  readonly tableName: string;
  readonly primaryKeyValue: unknown;
  constructor(tableName: string, primaryKeyValue: unknown);
}
//#endregion
//#region src/dbConfig/LilypadDbConfig.d.ts
/**
 * The config of a database: the tables the library reads and writes, how each one is kept in sync,
 * and what the database must provide for it (the changelog, the notification triggers, the
 * pruning). The application imports it at runtime, where nothing is compared with the database;
 * `lilypad-doctor` loads the same file and checks the database against it.
 */
/** Marks the objects made by `defineLilypadDb` (shared by every copy of the library). */
declare const LILYPAD_DB_CONFIG: unique symbol;
/** Marks the table definitions made by `defineLilypadDb`. */
declare const LILYPAD_DB_TABLE: unique symbol;
/** Carries the row type of a definition, for the types only. */
declare const lilypadRowType: unique symbol;
/**
 * How the old changelog rows are deleted:
 * - `detect`: the check looks for the `prune` option of the trigger and for a pg_cron job that
 *   deletes them, and suggests the best one for the database if it finds neither;
 * - `trigger`: the same, but it always suggests the `prune` option of the trigger;
 * - `cron`: the same, but it always suggests a pg_cron job, even where it cannot tell whether
 *   pg_cron runs in this database (e.g. when the role cannot read `cron.database_name`);
 * - `external`: a job the database cannot show deletes them (e.g. `pruneLilypadChangelog` called
 *   from a scheduled function): nothing is suggested, only the age of the oldest row is checked.
 */
type LilypadChangelogPruning = 'detect' | 'trigger' | 'cron' | 'external';
/** The options shared by the strategies that see every change of the table. */
type LilypadDbTableTrustedSync = {
  /**
   * While the sync is trusted, an entry read from the database (not a copy from the shared
   * level, nor a fallback after an error) that reaches its TTL with no change of its row is
   * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
   * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
   * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
   */
  maxAge?: number;
};
type LilypadDbTableListenSync = LilypadDbTableTrustedSync & {
  strategy: 'listen';
  /**
   * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
   * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
   */
  connect?: 'eager' | 'lazy';
  /**
   * If false, the cache does not apply the notifications: keeping it up to date is then up to
   * `onNotification` (an option of `LilypadDbCache.create`), and entries are never kept past their
   * TTL. Defaults to true.
   */
  applyChanges?: boolean;
};
type LilypadDbTableChangelogSync = LilypadDbTableTrustedSync & {
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
   * changelog: `lilypad-doctor` reports a pruning with a shorter one. Defaults to 1 hour.
   */
  maxGap?: number;
  /**
   * On the first read, or after `maxGap`, the changes of this many ms are applied, so that
   * copies in the shared level older than those changes are removed too. It must cover the
   * lifetime of a shared entry. Defaults to the TTL plus `staleWhileRevalidate`, plus 1 minute:
   * declare it when that exceeds `maxGap`, so that `lilypad-doctor` checks the retention for it.
   */
  lookback?: number;
};
/**
 * How `LilypadDbCache` learns about the changes made by other instances and other programs.
 *
 * - `listen` (default): `LISTEN/NOTIFY` on a dedicated connection, on the `notifyChannel` of the
 *   config. Near real-time, for long-running servers. Not suited to serverless platforms: the
 *   connection must stay open, it does not work through a pooler in transaction mode, and
 *   notifications sent while an instance is suspended are lost. Notifications are only hints (any
 *   role can send them): the cache reads the rows again, it never trusts their content.
 * - `changelog`: each instance reads the changelog table of the config at most once per
 *   `pollInterval`, when the cache is used. The caches of a gate read their tables together, in one
 *   query. No long-lived connection: suited to serverless platforms.
 * - `none`: only the writes of this instance and the TTL keep the cache up to date.
 *
 * `listen` and `changelog` rely on triggers that the library does not install at runtime (see
 * `lilypadChangelogSql`): `lilypad-doctor` checks them, and prints the SQL that installs them.
 *
 * While `listen` or `changelog` is trusted (`LISTEN` active and its heartbeat recent, changelog
 * read within `maxGap`), the cache sees every change of the table, so the TTL no longer needs a
 * query: an entry that reaches its TTL without a change of its row is kept until `maxAge`.
 */
type LilypadDbTableSync = LilypadDbTableListenSync | LilypadDbTableChangelogSync | {
  strategy: 'none';
};
/**
 * A table of a config, before `defineLilypadDb` resolves it: its description, how it is kept in
 * sync, and whether `lilypad-doctor` also reports what the database has and the description lacks.
 */
type LilypadDbTableInput<T, PK extends keyof T = keyof T> = LilypadDbSchema<T, PK> & {
  /** Defaults to `{ strategy: 'listen' }`. */
  sync?: LilypadDbTableSync;
  /** Overrides the `strict` of the config for this table. */
  strict?: boolean;
};
/** A unique key, resolved: its columns, including the `unique` columns. */
type LilypadDbResolvedUniqueKey = {
  name?: string;
  columns: readonly string[];
};
/** A foreign key, resolved: the referenced table is qualified, and every default is applied. */
type LilypadDbResolvedForeignKey = {
  name?: string;
  columns: readonly string[];
  references: {
    table: string;
    columns: readonly string[];
  };
  onDelete: LilypadDbReferentialAction;
  onUpdate: LilypadDbReferentialAction;
};
type LilypadDbResolvedIndex = {
  name?: string;
  columns: readonly string[];
  unique: boolean;
  using: LilypadDbIndexMethod;
};
/** The settings of the config that a table definition carries. */
type LilypadDbConfigSettings = {
  /** The name of the config (`default` for `lilypad.config.*`). */
  readonly name: string;
  readonly defaultSchema: string;
  /** The channel of the `listen` strategy. */
  readonly notifyChannel: string;
  /** The changelog table of the `changelog` strategy. */
  readonly changelogTable: string;
};
/** What every table definition has, whatever its row type. */
type LilypadDbTableDefinitionBase = {
  readonly [LILYPAD_DB_TABLE]: true;
  readonly [lilypadRowType]?: unknown;
  /** The key of the table in the `tables` of the config. */
  readonly key: string;
  /** The name of the table, unqualified. */
  readonly tableName: string;
  /** Its PostgreSQL schema. */
  readonly schemaName: string;
  /** `schema.table`: every query of the library names the table this way. */
  readonly qualifiedName: string;
  readonly primaryKey: PropertyKey;
  readonly generatedPrimaryKey?: boolean;
  readonly writeSanitizationFn?: (data: never) => unknown;
  readonly selectSanitizationFn?: (row: unknown) => unknown;
  readonly cols: Readonly<Record<string, LilypadDbColumn>>;
  readonly sync: LilypadDbTableSync;
  readonly strict: boolean;
  readonly unique: readonly LilypadDbResolvedUniqueKey[];
  readonly foreignKeys: readonly LilypadDbResolvedForeignKey[];
  readonly indexes: readonly LilypadDbResolvedIndex[];
  readonly checks: readonly LilypadDbCheck[];
  /** The settings of the config the table belongs to. */
  readonly db: LilypadDbConfigSettings;
};
/**
 * A table of a config (`db.tables.users`), as `gate.table()` and `LilypadDbCache.create()` take it.
 * Only `defineLilypadDb` makes them.
 *
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column.
 */
type LilypadDbTableDefinition<T, PK extends keyof T = keyof T> = Omit<LilypadDbTableDefinitionBase, typeof lilypadRowType | 'primaryKey' | 'writeSanitizationFn' | 'selectSanitizationFn' | 'cols'> & {
  readonly [lilypadRowType]?: T;
  readonly primaryKey: PK;
  readonly writeSanitizationFn?: (data: Partial<T>) => Partial<T>;
  readonly selectSanitizationFn?: (row: unknown) => T | null;
  readonly cols: { readonly [K in keyof T]: LilypadDbColumn; };
};
/** The input of a table, whatever its row type. */
type LilypadDbTableInputBase = Omit<LilypadDbTableInput<Record<string, unknown>, string>, 'writeSanitizationFn' | 'selectSanitizationFn' | 'cols' | 'primaryKey' | 'unique' | 'foreignKeys' | 'indexes'> & {
  readonly [lilypadRowType]?: unknown;
  primaryKey: PropertyKey;
  writeSanitizationFn?: (data: never) => unknown;
  selectSanitizationFn?: (row: unknown) => unknown;
  cols: Readonly<Record<string, LilypadDbColumn>>;
  unique?: readonly {
    name?: string;
    columns: readonly string[];
  }[];
  foreignKeys?: readonly {
    name?: string;
    columns: readonly string[];
    references: LilypadDbReference;
  }[];
  indexes?: readonly {
    name?: string;
    columns: readonly string[];
    unique?: boolean;
    using?: LilypadDbIndexMethod;
  }[];
};
/** A table input made by `defineLilypadTable`, which carries its row type. */
type LilypadDbTableDraft<T, PK extends keyof T = keyof T> = LilypadDbTableInput<T, PK> & {
  readonly [lilypadRowType]?: T;
};
/**
 * The definition `defineLilypadDb` makes of a table input: typed by `defineLilypadTable`, or else
 * with the columns of `cols` (of unknown types).
 */
type LilypadDbTableDefinitionOf<I> = I extends LilypadDbTableDraft<infer T, infer PK> ? LilypadDbTableDefinition<T, PK> : I extends {
  cols: infer Cols;
  primaryKey: infer PK;
} ? LilypadDbTableDefinition<{ [K in keyof Cols]: unknown; }, PK & keyof Cols> : LilypadDbTableDefinitionBase;
type LilypadDbConfigInput<Tables extends Record<string, LilypadDbTableInputBase>> = {
  /**
   * The name of the config: `default` (the default) for `lilypad.config.*`, the `<name>` of
   * `lilypad.<name>.config.*` for the others. Letters, digits, `_` and `-`.
   */
  name?: string;
  /** The schema of the tables whose name is not qualified. Defaults to `public`. */
  defaultSchema?: string;
  /** The channel the triggers notify, for the `listen` tables. Defaults to `cache_events`. */
  notifyChannel?: string;
  /** The changelog, for the `changelog` tables. */
  changelog?: {
    /** Defaults to `lilypad_cache_changes`. */
    table?: string;
    /** How the old rows are deleted (see {@link LilypadChangelogPruning}). Defaults to `detect`. */
    pruning?: LilypadChangelogPruning;
    /**
     * The shortest retention of the changelog, in ms: a pruning found with a retention that is not
     * longer is an error. `lilypad-doctor` also raises it to the `maxGap` and `lookback` of each
     * table. Defaults to 1 hour.
     */
    minRetention?: number;
  };
  /**
   * `lilypad-doctor` also warns about what the database has and the description lacks: columns,
   * foreign keys, unique keys and indexes. Defaults to false.
   */
  strict?: boolean;
  /** The tables, by key: `db.tables.<key>`. */
  tables: Tables;
};
/** A config made by {@link defineLilypadDb}. */
type LilypadDbConfig<Tables extends Record<string, LilypadDbTableDefinitionBase> = Record<string, LilypadDbTableDefinitionBase>> = {
  readonly [LILYPAD_DB_CONFIG]: true;
  readonly name: string;
  readonly defaultSchema: string;
  readonly notifyChannel: string;
  readonly changelog: {
    readonly table: string;
    readonly pruning: LilypadChangelogPruning;
    readonly minRetention: number;
  };
  readonly strict: boolean;
  readonly tables: Tables;
};
/** The keys of the tables of a config. */
type LilypadDbTableName<C> = C extends LilypadDbConfig<infer Tables> ? keyof Tables & string : never;
/**
 * The row type of a table of a config (`Record<string, unknown>` when the config type does not
 * carry it, e.g. on a gate typed `LilypadDbGate`).
 */
type LilypadDbRow<C, N> = C extends LilypadDbConfig<infer Tables> ? N extends keyof Tables ? Tables[N] extends LilypadDbTableDefinition<infer T extends object, infer _PK> ? T : Record<string, unknown> : never : never;
/** The primary key column of a table of a config. */
type LilypadDbPrimaryKey<C, N> = C extends LilypadDbConfig<infer Tables> ? N extends keyof Tables ? Tables[N] extends {
  readonly primaryKey: infer PK;
} ? PK & keyof LilypadDbRow<C, N> : never : never : never;
/**
 * Describes a table, for the `tables` of {@link defineLilypadDb}. It returns its input: it only
 * carries the row type.
 *
 * @example
 * ```typescript
 * export const users = defineLilypadTable<User, 'id'>({
 *   tableName: 'users',
 *   primaryKey: 'id',
 *   generatedPrimaryKey: true,
 *   cols: {
 *     id: { type: 'number', pgType: 'int4' },
 *     orgId: { type: 'number', pgType: 'int4', references: { table: 'orgs', onDelete: 'cascade' } },
 *     email: { type: 'string', pgType: 'text', nullable: false, unique: true },
 *   },
 *   indexes: [{ columns: ['orgId'] }],
 *   sync: { strategy: 'changelog', pollInterval: 1000 },
 * });
 * ```
 */
declare function defineLilypadTable<T, PK extends keyof T = keyof T>(input: LilypadDbTableInput<T, PK>): LilypadDbTableDraft<T, PK>;
/** Whether a value is a config made by {@link defineLilypadDb} (by any copy of the library). */
declare function isLilypadDbConfig(value: unknown): value is LilypadDbConfig;
/** Whether a value is a table definition made by {@link defineLilypadDb}. */
declare function isLilypadDbTableDefinition(value: unknown): value is LilypadDbTableDefinitionBase;
/**
 * Defines a database config: export it as the default export of `lilypad.config.ts` (or
 * `lilypad.<name>.config.ts` for another config), and import it where the application creates its
 * gates and caches. It checks the config itself (a primary key that is not a column, a duplicate
 * table...), never the database: `lilypad-doctor` does that.
 *
 * @example
 * ```typescript
 * export default defineLilypadDb({
 *   notifyChannel: 'cache_events',
 *   changelog: { pruning: 'cron' },
 *   tables: { users, orgs },
 * });
 * ```
 *
 * @throws If the config is not valid.
 */
declare function defineLilypadDb<Tables extends Record<string, LilypadDbTableInputBase>>(input: LilypadDbConfigInput<Tables>): LilypadDbConfig<{ [K in keyof Tables]: LilypadDbTableDefinitionOf<Tables[K]>; }>;
//#endregion
//#region src/dbConfig/LilypadDbConfigDefaults.d.ts
/** The defaults of the database configs (see `defineLilypadDb`). */
declare const LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
/** The name of the config of `lilypad.config.*`: the others are `lilypad.<name>.config.*`. */
declare const LILYPAD_DEFAULT_DB_CONFIG_NAME = "default";
//#endregion
export { LilypadDbColumnReference as A, LilypadDbReference as B, defineLilypadTable as C, LilypadDbColumn as D, LilypadDbCheck as E, LilypadDbIndex as F, LilypadDbWriteResult as G, LilypadDbSchema as H, LilypadDbIndexMethod as I, LilypadDbInsertData as L, LilypadDbDeleteResult as M, LilypadDbEmptyWriteError as N, LilypadDbColumnDefault as O, LilypadDbForeignKey as P, LilypadDbMissingPrimaryKeyError as R, defineLilypadDb as S, isLilypadDbTableDefinition as T, LilypadDbUniqueKey as U, LilypadDbReferentialAction as V, LilypadDbUpdateData as W, LilypadDbTableInputBase as _, LilypadDbConfigInput as a, LilypadDbTableSync as b, LilypadDbResolvedForeignKey as c, LilypadDbRow as d, LilypadDbTableChangelogSync as f, LilypadDbTableInput as g, LilypadDbTableDraft as h, LilypadDbConfig as i, LilypadDbColumnType as j, LilypadDbColumnName as k, LilypadDbResolvedIndex as l, LilypadDbTableDefinitionBase as m, LILYPAD_DEFAULT_DB_CONFIG_NAME as n, LilypadDbConfigSettings as o, LilypadDbTableDefinition as p, LilypadChangelogPruning as r, LilypadDbPrimaryKey as s, LILYPAD_DEFAULT_CHANGELOG_TABLE as t, LilypadDbResolvedUniqueKey as u, LilypadDbTableListenSync as v, isLilypadDbConfig as w, LilypadDbTableTrustedSync as x, LilypadDbTableName as y, LilypadDbNotFoundError as z };
//# sourceMappingURL=schema-B8RIzo97.d.mts.map