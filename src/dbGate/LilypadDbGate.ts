import postgres from 'postgres';

export type LilypadDbGateOptions = {
  connectionString: string;
  listen: { channel: string; callback: (payload: unknown) => void }[];
  singleton?: { dbgate: LilypadDbGate | null };
};

export type LilypadDbColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export type LilypadDbSchema<T> = {
  tableName: string;
  primaryKey: keyof T;
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

  async getAllFromTable<T>(
    options: LilypadDbSchema<T> & { rowFn?: (row: unknown) => T | null }
  ): Promise<T[]> {
    const results = await this.sql`SELECT * FROM ${this.sql(options.tableName)}`;
    const typedResults: T[] = [];

    for (const row of results) {
      if (options.rowFn) {
        const res = options.rowFn(row);
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

  async addToTable<T>(
    options: LilypadDbSchema<T> & { sanitizationFn?: (data: Partial<T>) => Partial<T> },
    data: T
  ): Promise<void> {
    let insertData: Partial<T> = { ...data };
    if (options.sanitizationFn) {
      insertData = { ...insertData, ...options.sanitizationFn(insertData) };
    }

    if (insertData[options.primaryKey] === undefined) {
      throw new Error(
        `Primary key "${String(
          options.primaryKey
        )}" is missing in the insert data for table "${options.tableName}".`
      );
    }

    await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData as Record<string, unknown>)}
    `;

    if (data[options.primaryKey] === undefined || data[options.primaryKey] === null) {
      throw new Error(
        `Primary key "${String(
          options.primaryKey
        )}" is missing in the insert data for table "${options.tableName}".`
      );
    }

    await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(data as Record<string, unknown>)}
    `;
  }

  async updateToTable<T>(
    options: LilypadDbSchema<T> & { sanitizationFn?: (data: Partial<T>) => Partial<T> },
    data: T
  ): Promise<void> {
    let updateData: Partial<T> = { ...data };
    if (options.sanitizationFn) {
      updateData = { ...updateData, ...options.sanitizationFn(updateData) };
    }

    if (updateData[options.primaryKey] === undefined || updateData[options.primaryKey] === null) {
      throw new Error(
        `Primary key "${String(
          options.primaryKey
        )}" is missing in the update data for table "${options.tableName}".`
      );
    }

    await this.sql`
      UPDATE ${this.sql(options.tableName)} 
      SET ${this.sql(updateData as Record<string, unknown>)} 
      WHERE ${this.sql(String(options.primaryKey))} = ${updateData[options.primaryKey] as string}
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
      this.listenerConnection = postgres(this.connectionString, {
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
