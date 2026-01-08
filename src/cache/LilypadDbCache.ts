import type {
  LilypadDbGate,
  LilypadDbSchema,
  ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import LilypadCache, { LilypadCachedValueType } from './LilypadCache';

type LilypadDbCacheConstructorOptions<K extends string, V> = ConstructorParameters<
  typeof LilypadCache<K, V>
>[1] & {
  dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V> };
  useDefaultDbListener?: boolean;
};

/**
 * A cache class that synchronizes with a database table using a provided database gateway and schema.
 *
 * `LilypadDbCache` extends `LilypadCache` to provide automatic cache population and invalidation
 * by fetching data from a database. It supports bulk synchronization and per-key updates from the database.
 *
 * @typeParam K - The type of the cache key, constrained to string and a key of V.
 * @typeParam V - The type of the cached value, constrained to object.
 *
 * @example
 * ```typescript
 * const dbCache = new LilypadDbCache<string, MyType>(ttl, {
 *   dbGate: { gate: myDbGate, schema: mySchema },
 *   // ...other options
 * });
 * ```
 *
 * @remarks
 * - The cache is automatically synchronized with the database using the provided `dbGate`.
 *   - The synchonization does not happen on cache misses, but only when directly invoked via `update` (or when specified otherwise).
 * - The `invalidate` method triggers an update from the database for the given key.
 * - The `bulkAsyncGet` method fetches all items from the database and updates the cache.
 *
 * @see LilypadCache
 * @see LilypadDbGate
 * @see LilypadDbSchema
 */
export default class LilypadDbCache<
  K extends string & V[keyof V],
  V extends object,
> extends LilypadCache<K, V> {
  private readonly dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V> };

  public static create<K extends string & V[keyof V], V extends object>(
    ttl: number = 60000,
    options: LilypadDbCacheConstructorOptions<K, V> & {
      singleton?: { cache: LilypadDbCache<K, V> };
    }
  ): LilypadDbCache<K, V> {
    const singleton = options.singleton;
    if (singleton) {
      if (singleton.cache) {
        return singleton.cache;
      }
    }
    const instance = new LilypadDbCache<K, V>(ttl, options);
    if (singleton) {
      singleton.cache = instance;
    }
    return instance;
  }

  private constructor(ttl: number, options: LilypadDbCacheConstructorOptions<K, V>) {
    super(ttl, options);
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () =>
      (await this.dbGate.gate.getAllFromTable<V>(this.dbGate.schema)).map((item) => [
        item[options.dbGate.schema.primaryKey] as K,
        item,
      ]);
    if (options.useDefaultDbListener ?? true) {
      this.dbGate.gate.addListener(this.getDefaultDbListener());
    }
  }

  async getOrFetch(key: K): Promise<LilypadCachedValueType<V> | undefined> {
    const cachedValue = super.get(key, false);
    if (cachedValue !== undefined) {
      return cachedValue;
    }
    try {
      const value = await this.update(key);
      return value;
    } catch (error) {
      this.logger?.error(`Error fetching and updating cache key "${String(key)}": `, error);
      return undefined;
    }
  }

  /**
   * Invalidates the cache entry for the specified key.
   *
   * Attempts to update the cache for the given key. If the update fails,
   * logs the error and falls back to the base class's invalidate method.
   *
   * @param key - The cache key to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - Whether to invalidate bulk sync (default: true).
   * @returns A promise that resolves when the invalidation process is complete.
   */
  override async invalidate(
    key: K,
    options: { invalidateBulkSync?: boolean } = {
      invalidateBulkSync: true,
    }
  ) {
    try {
      await this.update(key);
    } catch (error) {
      this.logger?.error(`Error updating cache key "${String(key)}" after invalidation: `, error);
      super.invalidate(key, options);
    }
  }

  /**
   * Updates the cache entry for the specified key by fetching the latest value from the database.
   *
   * If the database gateway is available, retrieves the value associated with the given key from the database,
   * updates the cache with this value, and returns it. If an error occurs during the process, logs the error
   * and rethrows it. Returns `undefined` if the database gateway is not available.
   *
   * @param key - The primary key of the cache entry to update.
   * @returns A promise that resolves to the updated value from the database, or `undefined` if the update could not be performed.
   * @throws Rethrows any error encountered during the database fetch or cache update process.
   */
  async update(key: K) {
    try {
      if (this.dbGate && this.dbGate.gate) {
        const value = await this.dbGate.gate.getFromTableByPrimaryKey<V>(this.dbGate.schema, key);
        this.set(key, value);
        return value;
      }
    } catch (error) {
      this.logger?.error(`Error updating cache key "${String(key)}": `, error);
      throw error;
    }
    return undefined;
  }

  async getAll(): Promise<V[]> {
    return Array.from(
      (
        await super.bulkAsyncGet({
          doSync: true,
        })
      )
        .values()
        .filter((item): item is V => item !== undefined)
    );
  }

  public getDefaultDbListener(): ListenerCallbackIdentifier {
    return {
      channel: 'cache_events',
      callbackId: 'lilypad_dbcache_' + this.dbGate.schema.tableName,
      callback: async (payload: unknown) => {
        this.logger?.debug(
          this.dbGate.schema.tableName,
          'LilypadDbCache handler has received payload on cache_events channel:',
          payload
        );
        if (typeof payload !== 'string') {
          return;
        }
        let parsedPayload: { table?: string; id?: string; op: 'UPDATE' | 'DELETE' | 'INSERT' };
        try {
          parsedPayload = JSON.parse(payload);
        } catch (e) {
          this.logger?.error('Error parsing cache_events payload:', e);
          return;
        }
        if (!parsedPayload.id || !parsedPayload.table) {
          return;
        }
        if (parsedPayload.table === this.dbGate.schema.tableName) {
          this.logger?.debug(
            this.dbGate.schema.tableName,
            'LilypadDbCache handler is processing payload:',
            parsedPayload
          );
          await this.invalidate(String(parsedPayload.id) as K, { invalidateBulkSync: false });
        }
      },
    };
  }
}
