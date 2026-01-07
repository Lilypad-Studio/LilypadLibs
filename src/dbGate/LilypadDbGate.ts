import postgres from 'postgres';

export type LilypadDbGateOptions = {
  connectionString: string;
  listenerConnectionString?: string;
  listen: { channel: string; callback: (payload: unknown) => void }[];
  singleton?: { dbgate: LilypadDbGate | null };
};

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
  private listeners: Map<
    string,
    {
      callback: (payload: unknown) => void;
      connection: postgres.Sql;
    }
  > = new Map();

  private constructor(options: LilypadDbGateOptions) {
    this.connectionString = options.connectionString;
    this.listenerConnectionString = options.listenerConnectionString || options.connectionString;
    this.sql = postgres(this.connectionString);
  }

  static async create(options: LilypadDbGateOptions): Promise<LilypadDbGate> {
    const singleton = options.singleton;
    if (singleton) {
      if (singleton.dbgate) {
        return singleton.dbgate;
      }
    }

    const instance = new LilypadDbGate(options);

    for (const listenOption of options.listen) {
      await instance.addListener(listenOption.channel, listenOption.callback);
    }

    if (singleton) {
      singleton.dbgate = instance;
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

  async addListener(channel: string, callback: (payload: unknown) => void) {
    if (this.listeners.has(channel)) {
      throw new Error(`Listener for channel "${channel}" already exists.`);
    }

    await this.getListenerConnection().listen(channel, (payload) => {
      callback(payload);
    });

    this.listeners.set(channel, { callback, connection: this.getListenerConnection() });
  }

  async close() {
    for (const [channel] of this.listeners) {
      this.listeners.delete(channel);
    }

    await this.listenerConnection?.end();
    await this.sql.end();
  }
}
