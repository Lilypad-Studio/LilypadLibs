import { LilypadLoggerType } from '@/logger/LilypadLogger';
import {
  getLilypadSingletonInstanceAsync,
  LilypadSingletonAble,
} from '@/singleton/LilypadSingleton';
import postgres from 'postgres';

type ListenerCallback = (payload: unknown) => void;
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
  cols: {
    [K in keyof T]: {
      type: LilypadDbColumnType;
    } & ({ nullable: false | undefined } | { nullable: true; default: T[K] | null });
  };
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
 * const dbGate = new LilypadDbGate({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   listen: [
 *     { channel: 'my_channel', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 *
 * @typeParam T - The type representing the table schema.
 *
 * @public
 */
export class LilypadDbGate {
  private connectionString!: string;
  private listenerConnectionString!: string;
  public sql: postgres.Sql;
  private listenerConnection: postgres.Sql | undefined;
  protected logger?: LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
  private listeners: Map<
    string,
    {
      listenerCallback: Map<string, ListenerCallback>;
      connection: postgres.Sql;
    }
  > = new Map();

  private constructor(options: LilypadDbGateOptions) {
    this.logger = options.logger;
    this.connectionString = options.connectionString;
    this.listenerConnectionString = options.listenerConnectionString || options.connectionString;
    this.sql = postgres(this.connectionString);
  }

  static async create(options: LilypadDbGateOptionsWithSingleton): Promise<LilypadDbGate> {
    if (options.singleton) {
      const cacheKey = options.singletonIdentifier;
      return await getLilypadSingletonInstanceAsync<LilypadDbGate>(cacheKey, () =>
        LilypadDbGate.initializeNew(options)
      );
    }

    return await LilypadDbGate.initializeNew(options);
  }

  private static async initializeNew(options: LilypadDbGateOptions): Promise<LilypadDbGate> {
    const instance = new LilypadDbGate(options);
    for (const listenOption of options.listen) {
      await instance.addListener({
        channel: listenOption.channel,
        callbackId: listenOption.callbackId,
        callback: listenOption.callback,
      });
    }
    return instance;
  }

  async getAllFromTable<T>(options: LilypadDbSchema<T>): Promise<T[]> {
    const results = await this.sql`SELECT * FROM ${this.sql(options.tableName)}`;
    const typedResults: T[] = [];

    for (const row of results) {
      if (options.selectSanitizationFn) {
        const res = options.selectSanitizationFn(row);
        if (res === null) {
          continue;
        }
        typedResults.push(res);
        continue;
      }
      const typedRow: Partial<T> = {};
      for (const key in options.cols) {
        typedRow[key] = row[key];
      }
      typedResults.push(typedRow as T);
    }
    return typedResults;
  }

  async getFromTableByPrimaryKey<T>(
    options: LilypadDbSchema<T>,
    primaryKeyValue: T[keyof T]
  ): Promise<T | null> {
    const results = await this.sql`
      SELECT * FROM ${this.sql(options.tableName)} 
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue as string}
    `;

    if (results.length === 0) {
      return null;
    }

    const row = results[0];

    if (options.selectSanitizationFn) {
      return options.selectSanitizationFn(row);
    }

    const typedRow: Partial<T> = {};
    for (const key in options.cols) {
      typedRow[key] = row[key];
    }
    return typedRow as T;
  }

  async addToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<void> {
    let insertData: Partial<T> = { ...data };
    if (options.insertSanitizationFn) {
      insertData = { ...insertData, ...options.insertSanitizationFn(insertData) };
    }

    if (options.primaryKeyShouldAutoDetermine) {
      delete insertData[options.primaryKey];
    } else if (
      insertData[options.primaryKey] === undefined ||
      insertData[options.primaryKey] === null
    ) {
      throw new Error(
        `Primary key "${String(
          options.primaryKey
        )}" is missing in the insert data for table "${options.tableName}".`
      );
    }

    await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData as Record<string, unknown>)}
    `;
  }

  async updateToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<void> {
    let updateData: Partial<T> = { ...data };
    if (options.insertSanitizationFn) {
      updateData = { ...updateData, ...options.insertSanitizationFn(updateData) };
    }

    const primaryKeyValue: string = updateData[options.primaryKey] as string;

    if (options.primaryKeyShouldAutoDetermine) {
      delete updateData[options.primaryKey];
    } else if (
      updateData[options.primaryKey] === undefined ||
      updateData[options.primaryKey] === null
    ) {
      throw new Error(
        `Primary key "${String(
          options.primaryKey
        )}" is missing in the update data for table "${options.tableName}".`
      );
    }

    await this.sql`
      UPDATE ${this.sql(options.tableName)} 
      SET ${this.sql(updateData as Record<string, unknown>)} 
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
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

  private async initializeListener(channel: string) {
    this.logger?.debug(`Initializing listener for channel "${channel}".`);
    this.listeners.set(channel, {
      listenerCallback: new Map(),
      connection: this.getListenerConnection(),
    });
    await this.getListenerConnection().listen(
      channel,
      this.executeAllListenerCallbacks.bind(this, channel)
    );
  }

  public executeAllListenerCallbacks(channel: string, payload: unknown) {
    const listener = this.listeners.get(channel);
    if (listener) {
      for (const cb of listener.listenerCallback.values()) {
        try {
          cb(payload);
        } catch (error) {
          this.logger?.error(`Error in listener callback for channel "${channel}":`, error);
        }
      }
    }
  }

  async addListener({ channel, callbackId, callback }: ListenerCallbackIdentifier) {
    this.logger?.debug(
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    if (!this.listeners.has(channel)) {
      await this.initializeListener(channel);
    }

    const listener = this.listeners.get(channel);
    if (listener) {
      listener.listenerCallback.set(callbackId, callback);
    }
    this.logger?.debug(
      `Listener for channel "${channel}" has ${listener ? listener.listenerCallback.size : -1} callbacks.`
    );
  }

  async close() {
    for (const [channel] of this.listeners) {
      this.listeners.delete(channel);
    }

    await this.listenerConnection?.end();
    await this.sql.end();
  }
}
