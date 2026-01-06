import postgres from 'postgres';

type LilypadDbGateOptions = {
  connectionString: string;
  listen: { channel: string; callback: (payload: unknown) => void }[];
};

type LilypadDbSchema<T> = {
  tableName: string;
  primaryKey: keyof T;
  obj: {
    [K in keyof T]: {} & (
      | { nullable: false | undefined }
      | { nullable: true; default: T[K] | null }
    );
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
  private connectionString: string = 'lilypad-db-connection';
  private sql: postgres.Sql;
  private listeners: Map<
    string,
    {
      callback: (payload: unknown) => void;
      connection: postgres.Sql;
      listener: postgres.ListenMeta;
    }
  > = new Map();

  private constructor(options: LilypadDbGateOptions) {
    this.connectionString = options.connectionString;
    this.sql = postgres(this.connectionString, { ssl: true });
  }

  static async create(options: LilypadDbGateOptions): Promise<LilypadDbGate> {
    const instance = new LilypadDbGate(options);

    for (const listenOption of options.listen) {
      await instance.addListener(listenOption.channel, listenOption.callback);
    }

    return instance;
  }

  async getAllFromTable<T>(options: LilypadDbSchema<T>): Promise<T[]> {
    const results = await this.sql`SELECT * FROM ${this.sql(options.tableName)}`;
    const typedResults: T[] = [];

    for (const row of results) {
      const typedRow: Partial<T> = {};
      for (const key in options.obj) {
        typedRow[key] = row[key];
      }
      typedResults.push(typedRow as T);
    }
    return typedResults;
  }

  async addToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<void> {
    await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(data as Record<string, unknown>)}
    `;
  }

  async updateToTable<T>(options: LilypadDbSchema<T>, data: T): Promise<void> {
    const updateData: Partial<T> = {};
    const primaryKeyValue = data[options.primaryKey];

    if (primaryKeyValue === undefined) {
      throw new Error(`Missing primary key field: ${String(options.primaryKey)}`);
    }

    for (const key in options.obj) {
      if (key !== String(options.primaryKey) && data[key] !== undefined) {
        updateData[key] = data[key];
      }
    }

    await this.sql`
      UPDATE ${this.sql(options.tableName)} 
      SET ${this.sql(updateData as Record<string, unknown>)} 
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue as string}
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

  async addListener(channel: string, callback: (payload: unknown) => void) {
    if (this.listeners.has(channel)) {
      throw new Error(`Listener for channel "${channel}" already exists.`);
    }

    const connection = postgres(this.connectionString, { ssl: true });
    const listener = await connection.listen(channel, (payload) => {
      callback(payload);
    });

    this.listeners.set(channel, { callback, connection, listener });
  }

  async removeListener(channel: string) {
    const listenerData = this.listeners.get(channel);
    if (!listenerData) {
      throw new Error(`No listener found for channel "${channel}".`);
    }

    await listenerData.connection.end();
    this.listeners.delete(channel);
  }

  async close() {
    for (const [channel, listenerData] of this.listeners) {
      await listenerData.connection.end();
      this.listeners.delete(channel);
    }
    await this.sql.end();
  }
}
