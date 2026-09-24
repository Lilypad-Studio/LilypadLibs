import { LilypadLoggerType } from '@/logger/LilypadLogger';
import {
  getLilypadSingletonInstanceAsync,
  LilypadSingletonAble,
  removeLilypadSingletonInstance,
} from '@/singleton/LilypadSingleton';
import postgres from 'postgres';

type ListenerCallback = (payload: unknown) => void | Promise<void>;
export type ListenerCallbackIdentifier = {
  channel: string;
  callbackId: string;
  callback: ListenerCallback;
};
export type LilypadDbGateOptions = {
  logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
  connectionString: string;
  listenerConnectionString?: string;
  listen: ListenerCallbackIdentifier[];
};

type LilypadDbGateOptionsWithSingleton = LilypadDbGateOptions & LilypadSingletonAble;

export type LilypadDbColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array';

export type LilypadDbSchema<T> = {
  tableName: string;
  primaryKey: keyof T;
  primaryKeyShouldAutoDetermine?: boolean;
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
    } & ({ nullable?: false } | { nullable: true; default: T[K] | null });
  };
};

type ChannelListener = {
  callbacks: Map<string, ListenerCallback>;
  /** Resolves, once LISTEN is active on the channel, with the function that stops listening. */
  ready: Promise<() => Promise<void>>;
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
export class LilypadDbGate {
  private listenerConnectionString: string;
  public sql: postgres.Sql;
  private listenerConnection: postgres.Sql | undefined;
  protected logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
  private listeners: Map<string, ChannelListener> = new Map();
  private singletonIdentifier?: string;

  private constructor(options: LilypadDbGateOptions) {
    this.logger = options.logger;
    this.listenerConnectionString = options.listenerConnectionString || options.connectionString;
    this.sql = postgres(options.connectionString, { prepare: false });
  }

  static async create(options: LilypadDbGateOptionsWithSingleton): Promise<LilypadDbGate> {
    if (options.singleton) {
      const identifier = options.singletonIdentifier;
      return await getLilypadSingletonInstanceAsync<LilypadDbGate>(identifier, async () => {
        const instance = await LilypadDbGate.initializeNew(options);
        instance.singletonIdentifier = identifier;
        return instance;
      });
    }

    return await LilypadDbGate.initializeNew(options);
  }

  private static async initializeNew(options: LilypadDbGateOptions): Promise<LilypadDbGate> {
    const instance = new LilypadDbGate(options);
    try {
      for (const listenOption of options.listen) {
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
  private mapRow<T>(schema: LilypadDbSchema<T>, row: postgres.Row): T | null {
    if (schema.selectSanitizationFn) {
      return schema.selectSanitizationFn(row);
    }
    const typedRow: Partial<T> = {};
    for (const key in schema.cols) {
      typedRow[key] = row[key];
    }
    return typedRow as T;
  }

  /**
   * The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
   * columns that are not in the schema; otherwise only the schema columns are needed.
   */
  private selectedColumns<T>(schema: LilypadDbSchema<T>) {
    return schema.selectSanitizationFn ? this.sql`*` : this.sql(Object.keys(schema.cols));
  }

  /**
   * Prepares the data of an insert/update:
   * - applies the schema's `insertSanitizationFn`;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table.
   */
  private prepareWrite<T>(schema: LilypadDbSchema<T>, data: T, operation: 'insert' | 'update') {
    let writeData: Partial<T> = { ...data };
    if (schema.insertSanitizationFn) {
      writeData = { ...writeData, ...schema.insertSanitizationFn(writeData) };
    }

    const primaryKeyValue = writeData[schema.primaryKey];
    const primaryKeyRequired = operation === 'update' || !schema.primaryKeyShouldAutoDetermine;
    if (primaryKeyRequired && (primaryKeyValue === undefined || primaryKeyValue === null)) {
      throw new Error(
        `Primary key "${String(
          schema.primaryKey
        )}" is missing in the ${operation} data for table "${schema.tableName}".`
      );
    }
    if (schema.primaryKeyShouldAutoDetermine) {
      delete writeData[schema.primaryKey];
    }

    const columns = Object.keys(schema.cols).filter((column) => column in writeData);
    if (columns.length === 0) {
      throw new Error(`No columns to ${operation} for table "${schema.tableName}".`);
    }

    return { data: writeData as postgres.Row, columns, primaryKeyValue };
  }

  async selectAllFromTable<T>(options: LilypadDbSchema<T>): Promise<T[]> {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
    `;
    const typedResults: T[] = [];

    for (const row of results) {
      const typedRow = this.mapRow(options, row);
      if (typedRow !== null) {
        typedResults.push(typedRow);
      }
    }
    return typedResults;
  }

  async selectFromTableByPrimaryKey<T>(
    options: LilypadDbSchema<T>,
    primaryKeyValue: T[keyof T]
  ): Promise<T | null> {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue as string}
    `;

    if (results.length === 0) {
      return null;
    }
    return this.mapRow(options, results[0]);
  }

  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
   */
  async insertToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<T | null> {
    const { data: insertData, columns } = this.prepareWrite(options, data, 'insert');

    const results = await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData, columns)}
      RETURNING *
    `;
    return this.mapRow(options, results[0]);
  }

  /**
   * Updates the row identified by the primary key contained in `data`.
   *
   * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
   * @throws If no row with that primary key exists.
   */
  async updateToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<T | null> {
    const {
      data: updateData,
      columns,
      primaryKeyValue,
    } = this.prepareWrite(options, data, 'update');

    const results = await this.sql`
      UPDATE ${this.sql(options.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue as string}
      RETURNING *
    `;
    if (results.count === 0) {
      throw new Error(
        `No row with primary key "${String(primaryKeyValue)}" found in table "${options.tableName}".`
      );
    }
    return this.mapRow(options, results[0]);
  }

  async deleteFromTable<T>(
    options: LilypadDbSchema<T>,
    primaryKeyValue: T[keyof T]
  ): Promise<void> {
    await this.sql`
      DELETE FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue as string}
    `;
  }

  // LISTENER MANAGEMENT

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
  private getListenerConnection() {
    if (!this.listenerConnection) {
      this.listenerConnection = postgres(this.listenerConnectionString, {
        max: 1,
        idle_timeout: 0,
        max_lifetime: null,
      });
    }
    return this.listenerConnection;
  }

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
  private initializeListener(channel: string): ChannelListener {
    void this.logger?.debug(`Initializing listener for channel "${channel}".`);
    const listener: ChannelListener = {
      callbacks: new Map(),
      ready: this.getListenerConnection()
        .listen(channel, (payload) => this.executeAllListenerCallbacks(channel, payload))
        .then(({ unlisten }) => unlisten)
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
   * Executes all registered listener callbacks for a given channel, passing the provided payload to each callback.
   *
   * Both synchronous throws and rejected promises of async callbacks are caught and logged,
   * so a failing callback can neither affect the others nor cause an unhandled rejection.
   *
   * @param channel - The name of the channel whose listener callbacks should be executed.
   * @param payload - The data to pass to each listener callback.
   */
  private executeAllListenerCallbacks(channel: string, payload: unknown) {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }
    for (const [callbackId, callback] of listener.callbacks) {
      Promise.resolve()
        .then(() => callback(payload))
        .catch((error: unknown) => {
          void this.logger?.error(
            `Error in listener callback "${callbackId}" for channel "${channel}":`,
            error
          );
        });
    }
  }

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
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener({ channel, callbackId, callback }: ListenerCallbackIdentifier) {
    void this.logger?.debug(
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    const listener = this.listeners.get(channel) ?? this.initializeListener(channel);
    listener.callbacks.set(callbackId, callback);
    await listener.ready;

    void this.logger?.debug(
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    );
  }

  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
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
      const unlisten = await listener.ready;
      await unlisten();
    }
    return true;
  }

  async close() {
    this.listeners.clear();
    if (this.singletonIdentifier !== undefined) {
      removeLilypadSingletonInstance(this.singletonIdentifier);
      this.singletonIdentifier = undefined;
    }

    await this.listenerConnection?.end();
    await this.sql.end();
  }
}
