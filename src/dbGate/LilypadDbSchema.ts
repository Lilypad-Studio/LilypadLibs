/**
 * The type of a column. For a primary key it tells `LilypadDbCache` how to read the ids that
 * notifications and the changelog carry as text: `number` converts them to numbers; `string` and
 * `bigint` keep them as strings. Declare `bigint`/`bigserial` columns as `bigint`: postgres.js
 * returns them as strings, so their keys and the row property are strings (type them as such).
 */
export type LilypadDbColumnType =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'json'
  | 'array';

/**
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `LilypadDbSchema<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
export type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
  tableName: string;
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
   * The metadata is optional. Only the `type` of the primary key is used: with `number`,
   * `LilypadDbCache` converts to numbers the ids that notifications and the changelog carry as text.
   */
  cols: { [K in keyof T]: LilypadDbColumn<T[K]> };
};

/** The metadata of a column. `nullable` and `default` are descriptive: the library ignores them. */
export type LilypadDbColumn<V = unknown> = {
  type?: LilypadDbColumnType;
  nullable?: boolean;
  default?: V | null;
};

/** The data of an insert: the primary key can be omitted when the database generates it. */
export type LilypadDbInsertData<T, PK extends keyof T = keyof T> = Omit<T, PK> &
  Partial<Pick<T, PK>>;

/** The data of an update: the primary key identifies the row, the other columns are optional. */
export type LilypadDbUpdateData<T, PK extends keyof T = keyof T> = Partial<T> & Pick<T, PK>;

/**
 * The result of an insert or an update: the row as stored by the database (`null` if the
 * `selectSanitizationFn` discards it), and the id of the transaction that wrote it, as recorded
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
