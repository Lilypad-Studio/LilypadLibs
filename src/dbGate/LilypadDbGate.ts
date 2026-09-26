import { createHash } from 'node:crypto';
import { LilypadListenHeartbeat } from '@/dbGate/LilypadListenHeartbeat';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  createLilypadSingletonAbleAsync,
  type LilypadSingletonAble,
  type LilypadSingletonRelease,
} from '@/singleton/LilypadSingleton';
import postgres from 'postgres';

type ListenerCallback = (payload: unknown) => void | Promise<void>;
export type ListenerCallbackIdentifier = {
  channel: string;
  callbackId: string;
  callback: ListenerCallback;
  /**
   * Called when LISTEN is active again after the listener connection was lost and re-established.
   * Notifications sent while the connection was down are lost: use it to resynchronize.
   */
  onReconnect?: () => void | Promise<void>;
};
export type LilypadDbGateOptions = {
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

export type LilypadDbPoolOptions = {
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
export const lilypadServerlessPool: Readonly<LilypadDbPoolOptions> = Object.freeze({
  max: 3,
  idleTimeout: 5_000,
  connectTimeout: 10_000,
});

/** postgres.js takes durations in seconds. */
function toPostgresPoolOptions(pool: LilypadDbPoolOptions | undefined) {
  const seconds = (ms: number | undefined) => (ms === undefined ? undefined : ms / 1000);
  return Object.fromEntries(
    Object.entries({
      max: pool?.max,
      idle_timeout: seconds(pool?.idleTimeout),
      connect_timeout: seconds(pool?.connectTimeout),
      max_lifetime: seconds(pool?.maxLifetime),
    }).filter(([, value]) => value !== undefined)
  );
}

type LilypadDbGateOptionsWithSingleton = LilypadDbGateOptions & LilypadSingletonAble;

export type LilypadDbColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array';

/**
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column. Declare it (e.g. `LilypadDbSchema<User, 'id'>`) to get
 * precise types for inserts and updates; it defaults to any column of `T`.
 */
export type LilypadDbSchema<T, PK extends keyof T = keyof T> = {
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

/** Rows read at a time by `selectAllFromTable`. */
const SELECT_ALL_BATCH_SIZE = 1000;
/** Primary keys per query of `selectFromTableByPrimaryKeys`. */
const PRIMARY_KEYS_BATCH_SIZE = 1000;
/** The column that carries the transaction id in the results of writes. */
const XID_COLUMN = '__lilypad_xid';
const DEFAULT_LISTEN_HEARTBEAT = 15_000;

export function lilypadMissingPrimaryKeyError(
  schema: { primaryKey: PropertyKey; tableName: string },
  context: string
): Error {
  return new Error(
    `Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`
  );
}

type ChannelListener = {
  callbacks: Map<string, ListenerCallbackIdentifier>;
  /** Resolves, once LISTEN is active on the channel, with the function that stops listening. */
  ready: Promise<() => Promise<void>>;
  /** Becomes true on the first LISTEN: later ones are reconnections. */
  listening: boolean;
};

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
export class LilypadDbGate {
  public readonly id = `LilypadDbGate-${globalThis.crypto.randomUUID()}`;
  public readonly sql: postgres.Sql;
  /** Only when `listenerConnectionString` differs: otherwise `sql` listens. */
  private readonly listenerClient?: postgres.Sql;
  protected logger?: LilypadLibLogger;
  private listeners: Map<string, ChannelListener> = new Map();
  private releaseSingleton: LilypadSingletonRelease = () => {};
  private readonly heartbeat?: LilypadListenHeartbeat;
  private readonly heartbeatChannel = `lilypad_heartbeat_${this.id.slice(-36).replace(/-/g, '')}`;
  private heartbeatStop?: Promise<() => Promise<void>>;

  private constructor(options: LilypadDbGateOptions) {
    assertNumberOption('LilypadDbGate', 'statementTimeout', options.statementTimeout, 'positive');
    if (options.listenHeartbeat !== false) {
      assertNumberOption('LilypadDbGate', 'listenHeartbeat', options.listenHeartbeat, 'positive');
    }
    this.logger = options.logger;
    this.sql = postgres(options.connectionString, {
      prepare: false,
      ...toPostgresPoolOptions(options.pool),
      ...(options.statementTimeout !== undefined && {
        connection: { statement_timeout: options.statementTimeout },
      }),
    });
    const listenerConnectionString = options.listenerConnectionString;
    if (listenerConnectionString && listenerConnectionString !== options.connectionString) {
      // postgres.js opens its own single, long-lived connection for LISTEN: no pool options needed
      this.listenerClient = postgres(listenerConnectionString);
    }
    if (options.listenHeartbeat !== false) {
      this.heartbeat = new LilypadListenHeartbeat(
        options.listenHeartbeat ?? DEFAULT_LISTEN_HEARTBEAT,
        () => this.sql`SELECT pg_notify(${this.heartbeatChannel}, '')`,
        (error) => libLog(this.logger, 'debug', this.id, 'LISTEN heartbeat failed:', error)
      );
    }
  }

  /**
   * Creates a gate and registers the listeners of `options.listen`.
   * Without listeners it opens no connection: the pool connects on the first query, so creating a
   * gate at module level does not reach the database (e.g. during a build).
   * With `singleton: true`, a later call with the same identifier returns the existing gate and
   * ignores its own options (a warning is logged if they differ).
   */
  static async create(options: LilypadDbGateOptionsWithSingleton): Promise<LilypadDbGate> {
    return createLilypadSingletonAbleAsync(
      'LilypadDbGate',
      options,
      async (release) => {
        const instance = await LilypadDbGate.initializeNew(options);
        instance.releaseSingleton = release;
        return instance;
      },
      {
        // Hashed: the connection strings contain credentials
        value: createHash('sha256')
          .update(
            JSON.stringify([
              options.connectionString,
              options.listenerConnectionString,
              options.statementTimeout,
              options.pool,
              options.listenHeartbeat,
            ])
          )
          .digest('hex'),
        onMismatch: () =>
          libLog(
            options.logger,
            'warn',
            'LilypadDbGate',
            `Singleton "${options.singleton ? options.singletonIdentifier : ''}" already exists with different connection options: the new options are ignored.`
          ),
      }
    );
  }

  private static async initializeNew(options: LilypadDbGateOptions): Promise<LilypadDbGate> {
    const instance = new LilypadDbGate(options);
    try {
      for (const listenOption of options.listen ?? []) {
        await instance.addListener(listenOption);
      }
    } catch (error) {
      // Do not leak the connection pools of an instance that is never returned
      await instance.close();
      throw error;
    }
    return instance;
  }

  // CRUD OPERATIONS

  /**
   * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
   * otherwise by copying the schema columns.
   */
  private mapRow<T, PK extends keyof T>(
    schema: LilypadDbSchema<T, PK>,
    row: postgres.Row
  ): T | null {
    if (schema.selectSanitizationFn) {
      return schema.selectSanitizationFn(row);
    }
    const typedRow: Partial<T> = {};
    for (const key in schema.cols) {
      typedRow[key] = row[key] as T[typeof key];
    }
    return typedRow as T;
  }

  /**
   * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
   * columns that are not in the schema; otherwise only the schema columns are needed.
   */
  private selectedColumns<T, PK extends keyof T>(schema: LilypadDbSchema<T, PK>) {
    return schema.selectSanitizationFn ? this.sql`*` : this.sql(Object.keys(schema.cols));
  }

  /**
   * Prepares the data of an insert/update:
   * - applies the schema's `writeSanitizationFn`, whose result replaces the data;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table;
   * - skips `undefined` values, which postgres.js rejects.
   */
  private prepareWrite<T, PK extends keyof T>(
    schema: LilypadDbSchema<T, PK>,
    data: Partial<T>,
    operation: 'insert' | 'update'
  ) {
    const writeData: Partial<T> = schema.writeSanitizationFn
      ? { ...schema.writeSanitizationFn({ ...data }) }
      : { ...data };

    const primaryKeyValue = writeData[schema.primaryKey];
    const primaryKeyRequired = operation === 'update' || !schema.primaryKeyShouldAutoDetermine;
    if (primaryKeyRequired && (primaryKeyValue === undefined || primaryKeyValue === null)) {
      throw lilypadMissingPrimaryKeyError(schema, operation);
    }
    if (schema.primaryKeyShouldAutoDetermine) {
      delete writeData[schema.primaryKey];
    }

    const columns = (Object.keys(schema.cols) as (keyof T & string)[]).filter(
      (column) => writeData[column] !== undefined
    );
    if (columns.length === 0) {
      throw new Error(`No columns to ${operation} for table "${schema.tableName}".`);
    }

    return { data: writeData as postgres.Row, columns, primaryKeyValue };
  }

  /**
   * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
   * of the whole table is never held in memory at once.
   *
   * @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
   * rejects with the reason of the signal.
   */
  async selectAllFromTable<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T[]> {
    const { signal } = options;
    signal?.throwIfAborted();
    const typedResults: T[] = [];
    const cursor = this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
    `.cursor(SELECT_ALL_BATCH_SIZE);

    for await (const rows of cursor) {
      // Leaving the loop closes the cursor
      signal?.throwIfAborted();
      for (const row of rows) {
        const typedRow = this.mapRow(schema, row);
        if (typedRow !== null) {
          typedResults.push(typedRow);
        }
      }
    }
    return typedResults;
  }

  /**
   * Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
   * the parameters of a query). Keys without a row are left out of the result, as are the rows the
   * `selectSanitizationFn` discards.
   */
  async selectFromTableByPrimaryKeys<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    primaryKeyValues: T[PK][]
  ): Promise<T[]> {
    const typedRows: T[] = [];
    for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
      const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
      const results = await this.sql`
        SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
        WHERE ${this.sql(String(schema.primaryKey))} IN ${this.sql(batch as string[])}
      `;
      for (const row of results) {
        const typedRow = this.mapRow(schema, row);
        if (typedRow !== null) {
          typedRows.push(typedRow);
        }
      }
    }
    return typedRows;
  }

  async selectFromTableByPrimaryKey<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    primaryKeyValue: T[PK]
  ): Promise<T | null> {
    const results = await this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue as string}
    `;

    const [row] = results;
    return row ? this.mapRow(schema, row) : null;
  }

  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key (`null` if the `selectSanitizationFn` discards it), and the id of
   * the transaction that wrote it.
   */
  async insertToTable<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    data: LilypadDbInsertData<T, PK>
  ): Promise<LilypadDbWriteResult<T>> {
    const { data: insertData, columns } = this.prepareWrite(schema, data as Partial<T>, 'insert');

    const results = await this.sql`
      INSERT INTO ${this.sql(schema.tableName)} ${this.sql(insertData, columns)}
      RETURNING ${this.selectedColumns(schema)}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    return this.writeResult(schema, results);
  }

  /** Splits a row returned by a write into the row and the id of its transaction. */
  private writeResult<T, PK extends keyof T>(
    schema: LilypadDbSchema<T, PK>,
    results: postgres.RowList<postgres.Row[]>
  ): LilypadDbWriteResult<T> {
    const [returned] = results;
    if (!returned) {
      throw new Error(`The write to table "${schema.tableName}" returned no row.`);
    }
    const { [XID_COLUMN]: xid, ...row } = returned;
    return { row: this.mapRow(schema, row), xid: BigInt(xid as string) };
  }

  /**
   * Updates the row identified by the primary key contained in `data`. Only the columns present
   * in `data` are written.
   *
   * @returns The row as stored by the database (`null` if the `selectSanitizationFn` discards it),
   * and the id of the transaction that wrote it.
   * @throws {LilypadDbNotFoundError} If no row with that primary key exists.
   */
  async updateToTable<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    data: LilypadDbUpdateData<T, PK>
  ): Promise<LilypadDbWriteResult<T>> {
    const {
      data: updateData,
      columns,
      primaryKeyValue,
    } = this.prepareWrite(schema, data, 'update');

    const results = await this.sql`
      UPDATE ${this.sql(schema.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue as string}
      RETURNING ${this.selectedColumns(schema)}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    if (results.count === 0) {
      throw new LilypadDbNotFoundError(schema.tableName, primaryKeyValue);
    }
    return this.writeResult(schema, results);
  }

  /**
   * Deletes the row with this primary key.
   *
   * @returns Whether a row had this primary key, and the id of the transaction that deleted it.
   */
  async deleteFromTable<T, PK extends keyof T = keyof T>(
    schema: LilypadDbSchema<T, PK>,
    primaryKeyValue: T[PK]
  ): Promise<LilypadDbDeleteResult> {
    const results = await this.sql`
      DELETE FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue as string}
      RETURNING pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    const [deleted] = results;
    return deleted
      ? { deleted: true, xid: BigInt(deleted[XID_COLUMN] as string) }
      : { deleted: false };
  }

  // LISTENER MANAGEMENT

  /** The client that listens: postgres.js keeps one dedicated connection per client for LISTEN. */
  private listenClient(): postgres.Sql {
    return this.listenerClient ?? this.sql;
  }

  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   */
  private initializeListener(channel: string): ChannelListener {
    libLog(this.logger, 'debug', this.id, `Initializing listener for channel "${channel}".`);
    const listener: ChannelListener = {
      callbacks: new Map(),
      listening: false,
      ready: this.listenClient()
        .listen(
          channel,
          (payload) => this.executeAllListenerCallbacks(channel, payload),
          // postgres.js calls it on the first LISTEN and again after every reconnection
          () => {
            if (listener.listening) {
              this.executeReconnectCallbacks(channel, listener);
            }
            listener.listening = true;
          }
        )
        .then((meta) => () => meta.unlisten())
        .catch((error: unknown) => {
          if (this.listeners.get(channel) === listener) {
            this.listeners.delete(channel);
          }
          throw error;
        }),
    };
    this.listeners.set(channel, listener);
    return listener;
  }

  /**
   * Runs a listener callback, catching both synchronous throws and rejected promises,
   * so a failing callback can neither affect the others nor cause an unhandled rejection.
   */
  private runCallbackSafely(
    channel: string,
    callbackId: string,
    callback: () => void | Promise<void>
  ) {
    Promise.resolve()
      .then(callback)
      .catch((error: unknown) => {
        libLog(
          this.logger,
          'error',
          this.id,
          `Error in listener callback "${callbackId}" for channel "${channel}":`,
          error
        );
      });
  }

  /** Runs every callback of a channel with the payload of a notification. */
  private executeAllListenerCallbacks(channel: string, payload: unknown) {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }
    for (const [callbackId, { callback }] of listener.callbacks) {
      this.runCallbackSafely(channel, callbackId, () => callback(payload));
    }
  }

  private executeReconnectCallbacks(channel: string, listener: ChannelListener) {
    libLog(
      this.logger,
      'warn',
      this.id,
      `LISTEN on channel "${channel}" was re-established: notifications sent meanwhile are lost.`
    );
    for (const [callbackId, identifier] of listener.callbacks) {
      if (identifier.onReconnect) {
        this.runCallbackSafely(channel, callbackId, () => identifier.onReconnect?.());
      }
    }
  }

  /**
   * Adds a listener callback for a channel. Adding a callback with an existing `callbackId` on the
   * same channel replaces the previous one.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener(identifier: ListenerCallbackIdentifier) {
    const { channel, callbackId } = identifier;
    libLog(
      this.logger,
      'debug',
      this.id,
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    const listener = this.listeners.get(channel) ?? this.initializeListener(channel);
    listener.callbacks.set(callbackId, identifier);
    await listener.ready;
    // Unless the callback was removed while LISTEN was starting
    if (this.listeners.get(channel) === listener) {
      await this.startHeartbeat();
    }

    libLog(
      this.logger,
      'debug',
      this.id,
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    );
  }

  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
   * It never rejects: a failed UNLISTEN is logged (the connection keeps the channel, whose
   * notifications are then ignored).
   *
   * @returns `true` if the callback was registered.
   */
  async removeListener(channel: string, callbackId: string): Promise<boolean> {
    const listener = this.listeners.get(channel);
    if (!listener || !listener.callbacks.delete(callbackId)) {
      return false;
    }
    if (listener.callbacks.size === 0) {
      this.listeners.delete(channel);
      if (this.listeners.size === 0) {
        await this.stopHeartbeat();
      }
      try {
        const unlisten = await listener.ready;
        await unlisten();
      } catch (error) {
        // LISTEN itself failed (nothing to undo), or UNLISTEN failed
        libLog(this.logger, 'warn', this.id, `Could not stop listening on "${channel}":`, error);
      }
    }
    return true;
  }

  private async startHeartbeat() {
    const heartbeat = this.heartbeat;
    if (!heartbeat || this.heartbeatStop) {
      return;
    }
    this.heartbeatStop = this.listenClient()
      .listen(this.heartbeatChannel, () => heartbeat.beat())
      .then((meta) => {
        heartbeat.start();
        return () => meta.unlisten();
      });
    try {
      await this.heartbeatStop;
    } catch (error) {
      // Without a heartbeat, isListenHealthy() stays false: the caches just trust LISTEN less
      this.heartbeatStop = undefined;
      libLog(this.logger, 'warn', this.id, 'Could not start the LISTEN heartbeat:', error);
    }
  }

  private async stopHeartbeat() {
    const stop = this.heartbeatStop;
    this.heartbeatStop = undefined;
    this.heartbeat?.stop();
    try {
      await (
        await stop
      )?.();
    } catch {
      // The heartbeat is only a diagnostic
    }
  }

  /**
   * Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
   * recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as a channel is
   * listened to. `false` while no channel is listened to.
   */
  isListenHealthy(): boolean {
    if (!this.heartbeat) {
      return this.listeners.size > 0;
    }
    return this.heartbeat.healthy();
  }

  async close() {
    this.listeners.clear();
    this.heartbeat?.stop();
    this.heartbeatStop = undefined;
    this.releaseSingleton();

    await this.listenerClient?.end();
    await this.sql.end();
  }
}
