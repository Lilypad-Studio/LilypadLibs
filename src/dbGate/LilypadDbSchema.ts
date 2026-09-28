import type {
  LilypadDbColumnType,
  LilypadDbColumnTypeOf,
  LilypadPgTypeOf,
} from '@/dbConfig/LilypadPgTypes';

/**
 * The default of a column: `true` when the database has one (whatever it is), or its SQL
 * expression (e.g. `{ sql: 'now()' }`), which `lilypad-doctor` uses in the SQL that fixes the table.
 * The expression is not compared with the installed one.
 */
export type LilypadDbColumnDefault = true | { sql: string };

/**
 * What the database does to the rows that reference a row that is deleted or updated.
 * Defaults to `no action`.
 */
export type LilypadDbReferentialAction =
  | 'no action'
  | 'restrict'
  | 'cascade'
  | 'set null'
  | 'set default';

/** The access method of an index. Defaults to `btree`. */
export type LilypadDbIndexMethod = 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist';

/** A column name of the row type. */
export type LilypadDbColumnName<T> = keyof T & string;

/**
 * The table a foreign key references: `table` or `schema.table`. An unqualified name is the table
 * of the config with this `tableName`, or else a table of the `defaultSchema` of the config.
 */
export type LilypadDbReference = {
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
export type LilypadDbColumnReference = Omit<LilypadDbReference, 'columns'> & {
  /** The referenced column. Defaults to the primary key of the referenced table. */
  column?: string;
};

/** A foreign key of the table, on one or several columns. */
export type LilypadDbForeignKey<T> = {
  /** The name of the constraint, used by the SQL that creates it. It is not compared. */
  name?: string;
  columns: readonly LilypadDbColumnName<T>[];
  references: LilypadDbReference;
};

/**
 * A set of columns whose values are unique together: a unique constraint, a unique index (neither
 * partial nor on expressions) or the primary key satisfies it.
 */
export type LilypadDbUniqueKey<T> = {
  /** The name of the constraint, used by the SQL that creates it. It is not compared. */
  name?: string;
  columns: readonly LilypadDbColumnName<T>[];
};

/** An index on columns of the table (neither partial nor on expressions). */
export type LilypadDbIndex<T> = {
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
export type LilypadDbCheck = { name: string; expression?: string };

/**
 * The description of a table: what the library reads and writes, and what `lilypad-doctor`
 * expects to find in the database. Define it with `defineLilypadTable`, in a config file (see
 * `defineLilypadDb`). It holds no function: the functions applied to the rows are bound to the
 * config by the application (see `bindLilypadDbHooks`).
 *
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `defineLilypadTable<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
export type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
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
   * The columns of the table, one for each property of `T`.
   * - Without a `select` hook (see `bindLilypadDbHooks`), only these columns are selected.
   * - Only these columns are written by inserts and updates: any other property of the data is ignored.
   *
   * At runtime, only the `type` of the primary key is used: with `number`, `LilypadDbCache` converts
   * to numbers the ids that notifications and the changelog carry as text. `lilypad-doctor` checks
   * the rest against the database.
   *
   * The `type` or `pgType` of each column must fit the property of `T` (see
   * {@link LilypadDbColumnFor}).
   */
  cols: { [K in keyof T]: LilypadDbColumnFor<T[K]> };
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
export type LilypadDbColumn = {
  /**
   * What postgres.js returns for the column. It follows from a known `pgType` (`int4` is a
   * `number`, `timestamptz` a `date`, `int8` a `bigint`...): declare it only for the other types
   * (enums, domains, the types of extensions), or without `pgType`. `defineLilypadDb` rejects a
   * `type` that does not fit a known `pgType`.
   */
  type?: LilypadDbColumnType;
  /**
   * The exact PostgreSQL type (e.g. `uuid`, `int4`, `varchar(64)`, `timestamptz`, `text[]`),
   * compared with the installed one; common aliases are accepted (`int4` is `integer`). Without it,
   * `lilypad-doctor` only checks that the database type fits `type`, and cannot generate the SQL
   * that creates the column.
   */
  pgType?: string;
  /**
   * The hooks of the table (see `bindLilypadDbHooks`) convert this column between its database
   * value and the property of the row type, so its type in `T` is not compared with `type` and
   * `pgType` (e.g. a `timestamptz` read as an ISO string). Types only: nothing changes at runtime.
   */
  converted?: boolean;
  /** Whether the column accepts `NULL`. Checked when set. */
  nullable?: boolean;
  /** Whether the column has a default (see {@link LilypadDbColumnDefault}). Checked when set. */
  default?: LilypadDbColumnDefault;
  /** The values of the column are unique (a unique key on this column alone). */
  unique?: boolean;
  /** The column is a foreign key to this table. */
  references?: LilypadDbColumnReference;
};

type LilypadDbColumnFields = Omit<LilypadDbColumn, 'type' | 'pgType' | 'converted'>;

/**
 * The description of a column whose row property has the type `V` (the `cols` of
 * `defineLilypadTable`):
 * - with a `type`, it must fit `V` (see {@link LilypadDbColumnTypeOf}), and `defineLilypadDb`
 *   checks that it fits the `pgType`, which may be any type (an enum, a domain...);
 * - without a `type`, the `pgType` must be a known type that fits `V` (see
 *   {@link LilypadPgTypeOf}): `int4` for a `number`, `uuid` for a `string`, `jsonb` for an object;
 * - with `converted: true` (the hooks convert it), neither is compared with `V`.
 */
export type LilypadDbColumnFor<V> =
  | (LilypadDbColumnFields & {
      type: LilypadDbColumnTypeOf<V>;
      pgType?: string;
      converted?: false;
    })
  | (LilypadDbColumnFields & {
      type?: undefined;
      pgType?: LilypadPgTypeOf<LilypadDbColumnTypeOf<V>>;
      converted?: false;
    })
  | (LilypadDbColumnFields & {
      type?: LilypadDbColumnType;
      pgType?: string;
      converted: true;
    });

/** The data of an insert: the primary key can be omitted when the database generates it. */
export type LilypadDbInsertData<T, PK extends keyof T = keyof T> = Omit<T, PK> &
  Partial<Pick<T, PK>>;

/** The data of an update: the primary key identifies the row, the other columns are optional. */
export type LilypadDbUpdateData<T, PK extends keyof T = keyof T> = Partial<T> & Pick<T, PK>;

/**
 * The result of an insert or an update: the row as stored by the database (`null` if the
 * `select` hook discards it), and the id of the transaction that wrote it, as recorded
 * by the changelog (`xid`).
 */
export type LilypadDbWriteResult<T> = { row: T | null; xid: bigint };

/**
 * The result of a delete: whether a row had this primary key, and the id of the transaction that
 * deleted it.
 */
export type LilypadDbDeleteResult = { deleted: boolean; xid?: bigint };

/** Thrown by the writes when the data has no primary key where one is needed. */
export class LilypadDbMissingPrimaryKeyError extends Error {
  readonly tableName: string;
  readonly primaryKey: string;

  constructor(schema: { primaryKey: PropertyKey; tableName: string }, context: string) {
    super(
      `Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`
    );
    this.name = 'LilypadDbMissingPrimaryKeyError';
    this.tableName = schema.tableName;
    this.primaryKey = String(schema.primaryKey);
  }
}

/** Thrown by an insert or an update whose data has no column of the schema to write. */
export class LilypadDbEmptyWriteError extends Error {
  readonly tableName: string;

  constructor(tableName: string, operation: 'insert' | 'update') {
    super(`No columns to ${operation} for table "${tableName}".`);
    this.name = 'LilypadDbEmptyWriteError';
    this.tableName = tableName;
  }
}

/** Thrown by `updateToTable` when no row has the primary key of the data. */
export class LilypadDbNotFoundError extends Error {
  readonly tableName: string;
  readonly primaryKeyValue: unknown;

  constructor(tableName: string, primaryKeyValue: unknown) {
    super(`No row with primary key "${String(primaryKeyValue)}" found in table "${tableName}".`);
    this.name = 'LilypadDbNotFoundError';
    this.tableName = tableName;
    this.primaryKeyValue = primaryKeyValue;
  }
}
