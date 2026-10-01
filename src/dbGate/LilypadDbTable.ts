import { resolveLilypadDbTable, type LilypadDbTableDefinition } from '@/dbConfig/LilypadDbConfig';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LilypadDbEmptyWriteError,
  LilypadDbMissingPrimaryKeyError,
  LilypadDbNotFoundError,
  type LilypadDbDeleteResult,
  type LilypadDbInsertData,
  type LilypadDbPartialRow,
  type LilypadDbUpdateData,
  type LilypadDbWriteResult,
} from '@/dbConfig/LilypadDbSchema';
import type postgres from 'postgres';

/** Rows read at a time by `selectAll`. */
const SELECT_ALL_BATCH_SIZE = 1000;
/** Primary keys per query of `selectByPrimaryKeys`. */
const PRIMARY_KEYS_BATCH_SIZE = 1000;
/** The column that carries the transaction id in the results of writes. */
const XID_COLUMN = '__lilypad_xid';

/**
 * The typed CRUD helpers of one table, created with `gate.table(db.tables.users)` (or
 * `gate.table('users')` on a gate created with a config): every method uses the definition of the
 * table, and the connections of the gate (it rejects once the gate is closed). Queries name the
 * table with its schema (`public.users`), whatever the `search_path`.
 *
 * - Only the `cols` keys are selected (unless there is a `select` hook, which gets `*`) and
 *   written: extra properties of the data (e.g. from a request body) are never written.
 * - Rows are mapped with the `select` hook (see `bindLilypadDbHooks`), or by copying the `cols` keys.
 * - Writes return the id of their transaction (`xid`), as the changelog records it.
 *
 * @example
 * ```typescript
 * const users = gate.table(db.tables.users);
 * const { row } = await users.insert({ name: 'Ada' });
 * const user = await users.selectByPrimaryKey(row!.id);
 * ```
 */
export class LilypadDbTable<T, PK extends keyof T = keyof T> {
  readonly definition: LilypadDbTableDefinition<T, PK>;

  /**
   * Prefer `gate.table(...)`. The definition is checked, and takes the hooks that the config of the
   * gate binds to its table, as with `gate.table`: the hooks cannot be skipped this way.
   *
   * @throws If `definition` is not a table of a config made with `defineLilypadDb`.
   */
  constructor(
    private readonly gate: LilypadDbGate,
    definition: LilypadDbTableDefinition<T, PK>
  ) {
    this.definition = resolveLilypadDbTable(
      'LilypadDbTable',
      definition,
      gate.config
    ) as LilypadDbTableDefinition<T, PK>;
  }

  private get sql(): postgres.Sql {
    return this.gate.sql;
  }

  /**
   * Maps a database row to `T`, using the `select` hook of the table if it has one, otherwise by
   * copying the schema columns.
   */
  private mapRow(row: postgres.Row): T | null {
    const { definition: schema } = this;
    const select = schema.hooks?.select;
    if (select) {
      return select(row);
    }
    const typedRow: Partial<T> = {};
    for (const key in schema.cols) {
      typedRow[key] = row[key] as T[typeof key];
    }
    return typedRow as T;
  }

  private mapRows(rows: Iterable<postgres.Row>, into: T[]) {
    for (const row of rows) {
      const typedRow = this.mapRow(row);
      if (typedRow !== null) {
        into.push(typedRow);
      }
    }
  }

  /**
   * The columns to select. The `select` hook receives the whole row, since it may read columns
   * that are not in the schema; otherwise only the schema columns are needed.
   */
  private selectedColumns() {
    return this.definition.hooks?.select
      ? this.sql`*`
      : this.sql(Object.keys(this.definition.cols));
  }

  /** The `RETURNING` list of a write: the selected columns and the transaction id. */
  private returning() {
    return this
      .sql`${this.selectedColumns()}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}`;
  }

  private get tableName() {
    return this.sql(this.definition.qualifiedName);
  }

  private get primaryKeyColumn() {
    return this.sql(String(this.definition.primaryKey));
  }

  /**
   * Prepares the data of an insert/update:
   * - applies the `write` hook of the table, whose result replaces the data;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table;
   * - leaves the primary key out of the `SET` of an update: it identifies the row;
   * - skips `undefined` values, which postgres.js rejects.
   */
  private prepareWrite(data: LilypadDbPartialRow<T>, operation: 'insert' | 'update') {
    const { definition: schema } = this;
    const write = schema.hooks?.write;
    const writeData: LilypadDbPartialRow<T> = write ? { ...write({ ...data }) } : { ...data };

    const primaryKeyValue = writeData[schema.primaryKey];
    const primaryKeyRequired = operation === 'update' || !schema.generatedPrimaryKey;
    if (primaryKeyRequired && (primaryKeyValue === undefined || primaryKeyValue === null)) {
      throw new LilypadDbMissingPrimaryKeyError(schema, operation);
    }
    if (schema.generatedPrimaryKey) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- writeData is a copy
      delete writeData[schema.primaryKey];
    }

    const columns = (Object.keys(schema.cols) as (keyof T & string)[]).filter(
      (column) =>
        writeData[column] !== undefined && !(operation === 'update' && column === schema.primaryKey)
    );
    if (columns.length === 0) {
      throw new LilypadDbEmptyWriteError(schema.tableName, operation);
    }

    return { data: writeData as postgres.Row, columns, primaryKeyValue };
  }

  /** Splits a row returned by a write into the row and the id of its transaction. */
  private writeResult(results: postgres.RowList<postgres.Row[]>): LilypadDbWriteResult<T> {
    const [returned] = results;
    if (!returned) {
      throw new Error(`The write to table "${this.definition.tableName}" returned no row.`);
    }
    const { [XID_COLUMN]: xid, ...row } = returned;
    return { row: this.mapRow(row), xid: BigInt(xid as string) };
  }

  /**
   * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
   * of the whole table is never held in memory at once.
   *
   * The cursor is an SQL one (`DECLARE`, then one `FETCH` per batch, in a transaction): the
   * `statementTimeout` of the gate bounds each batch. A postgres.js cursor is one statement, which
   * the timeout would cancel once the whole table takes longer to read.
   *
   * @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
   * rejects with the reason of the signal.
   */
  async selectAll(options: { signal?: AbortSignal | undefined } = {}): Promise<T[]> {
    this.gate.assertOpen();
    const { signal } = options;
    signal?.throwIfAborted();
    const typedRows: T[] = [];
    // Ending the transaction, or rolling it back on a throw, closes the cursor
    await this.sql.begin(async (sql) => {
      await sql`
        DECLARE lilypad_select_all NO SCROLL CURSOR FOR
        SELECT ${this.selectedColumns()} FROM ${this.tableName}
      `;
      let rows: postgres.RowList<postgres.Row[]>;
      do {
        signal?.throwIfAborted();
        rows =
          await sql`FETCH ${sql.unsafe(String(SELECT_ALL_BATCH_SIZE))} FROM lilypad_select_all`;
        this.mapRows(rows, typedRows);
      } while (rows.length === SELECT_ALL_BATCH_SIZE);
    });
    return typedRows;
  }

  /**
   * Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
   * the parameters of a query). Keys without a row are left out of the result, as are the rows the
   * `select` hook discards.
   *
   * @param options.signal - Stops before the next batch once aborted: the promise then rejects
   * with the reason of the signal.
   */
  async selectByPrimaryKeys(
    primaryKeyValues: T[PK][],
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<T[]> {
    this.gate.assertOpen();
    const { signal } = options;
    const typedRows: T[] = [];
    for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
      this.mapRows(
        await this.sql`
          SELECT ${this.selectedColumns()} FROM ${this.tableName}
          WHERE ${this.primaryKeyColumn} IN ${this.sql(batch as string[])}
        `,
        typedRows
      );
    }
    return typedRows;
  }

  /** Selects the row with this primary key, or `null`. */
  async selectByPrimaryKey(primaryKeyValue: T[PK]): Promise<T | null> {
    this.gate.assertOpen();
    const [row] = await this.sql`
      SELECT ${this.selectedColumns()} FROM ${this.tableName}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue as string}
    `;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key (`null` if the `select` hook discards it), and the id of
   * the transaction that wrote it.
   * @throws {LilypadDbMissingPrimaryKeyError} Without the primary key, unless it is generated.
   * @throws {LilypadDbEmptyWriteError} If the data has no column of the schema.
   */
  async insert(data: LilypadDbInsertData<T, PK>): Promise<LilypadDbWriteResult<T>> {
    this.gate.assertOpen();
    const { data: insertData, columns } = this.prepareWrite(
      data as LilypadDbPartialRow<T>,
      'insert'
    );
    return this.writeResult(
      await this.sql`
        INSERT INTO ${this.tableName} ${this.sql(insertData, columns)}
        RETURNING ${this.returning()}
      `
    );
  }

  /**
   * Updates the row identified by the primary key contained in `data`. Only the columns present
   * in `data` are written.
   *
   * @returns The row as stored by the database (`null` if the `select` hook discards it),
   * and the id of the transaction that wrote it.
   * @throws {LilypadDbNotFoundError} If no row with that primary key exists.
   * @throws {LilypadDbMissingPrimaryKeyError} Without the primary key.
   * @throws {LilypadDbEmptyWriteError} If the data has no other column of the schema.
   */
  async update(data: LilypadDbUpdateData<T, PK>): Promise<LilypadDbWriteResult<T>> {
    this.gate.assertOpen();
    const { data: updateData, columns, primaryKeyValue } = this.prepareWrite(data, 'update');
    const results = await this.sql`
      UPDATE ${this.tableName}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue as string}
      RETURNING ${this.returning()}
    `;
    if (results.count === 0) {
      throw new LilypadDbNotFoundError(this.definition.tableName, primaryKeyValue);
    }
    return this.writeResult(results);
  }

  /**
   * Deletes the row with this primary key.
   *
   * @returns Whether a row had this primary key, and the id of the transaction that deleted it.
   */
  async delete(primaryKeyValue: T[PK]): Promise<LilypadDbDeleteResult> {
    this.gate.assertOpen();
    const [deleted] = await this.sql`
      DELETE FROM ${this.tableName}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue as string}
      RETURNING pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    return deleted
      ? { deleted: true, xid: BigInt(deleted[XID_COLUMN] as string) }
      : { deleted: false };
  }
}
