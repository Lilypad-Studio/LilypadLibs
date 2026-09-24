import type {
  LilypadDbGate,
  LilypadDbSchema,
  ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import LilypadCache, { LilypadCachedValueType } from './LilypadCache';
import {
  getLilypadSingletonInstanceAsync,
  LilypadSingletonAble,
  removeLilypadSingletonInstance,
} from '@/singleton/LilypadSingleton';

export type LilypadDbCacheDefaultNotificationPayload = {
  table?: string;
  id?: string;
  op: 'UPDATE' | 'DELETE' | 'INSERT';
};

export type LilypadDbCacheDefaultListenerOptions = {
  /**
   * If true, the cache entry is updated from the database (or set to null, for a DELETE)
   * before `callback` is called.
   *
   * Without a `callback` the entry is always updated. With a `callback` this defaults to false:
   * keeping the cache up to date is then the callback's responsibility.
   */
  automaticallyInvalidateDataBeforeCallback?: boolean;
  callback?: (payload: LilypadDbCacheDefaultNotificationPayload) => Promise<void> | void;
};

type LilypadDbCacheConstructorOptions<K extends string, V> = ConstructorParameters<
  typeof LilypadCache<K, V>
>[1] & {
  dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V> };
} & (
    | {
        useDefaultDbListener?: false;
      }
    | {
        useDefaultDbListener: true;
        defaultListenerOptions: LilypadDbCacheDefaultListenerOptions;
      }
  );

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
 * const dbCache = await LilypadDbCache.create<string, MyType>(ttl, {
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
 * - Unless disabled, the cache listens on the `cache_events` channel for JSON payloads shaped as
 *   {@link LilypadDbCacheDefaultNotificationPayload}. The database trigger sending them is not part of this library.
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
  private readonly defaultDbListener?: ListenerCallbackIdentifier;
  private singletonIdentifier?: string;

  /**
   * Creates a cache and, unless disabled, registers its default database listener.
   *
   * @throws If the default database listener cannot be registered (e.g. the database is unreachable).
   */
  public static async create<K extends string & V[keyof V], V extends object>(
    ttl: number = 60000,
    options: LilypadDbCacheConstructorOptions<K, V> & LilypadSingletonAble
  ): Promise<LilypadDbCache<K, V>> {
    if (options.singleton) {
      const identifier = options.singletonIdentifier;
      return getLilypadSingletonInstanceAsync(identifier, async () => {
        const cache = await LilypadDbCache.initializeNew<K, V>(ttl, options);
        cache.singletonIdentifier = identifier;
        return cache;
      });
    }

    return LilypadDbCache.initializeNew<K, V>(ttl, options);
  }

  private static async initializeNew<K extends string & V[keyof V], V extends object>(
    ttl: number,
    options: LilypadDbCacheConstructorOptions<K, V>
  ): Promise<LilypadDbCache<K, V>> {
    const cache = new LilypadDbCache<K, V>(ttl, options);
    if (cache.defaultDbListener) {
      try {
        await cache.dbGate.gate.addListener(cache.defaultDbListener);
      } catch (error) {
        await cache.dispose();
        throw error;
      }
    }
    return cache;
  }

  private constructor(ttl: number, options: LilypadDbCacheConstructorOptions<K, V>) {
    super(ttl, options);
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () =>
      (await this.dbGate.gate.selectAllFromTable<V>(this.dbGate.schema)).map((item) => [
        item[options.dbGate.schema.primaryKey] as K,
        item,
      ]);

    if (options.useDefaultDbListener ?? true) {
      this.defaultDbListener = this.getDefaultDbListener(
        options.useDefaultDbListener ? options.defaultListenerOptions : undefined
      );
    }

    void this.logger?.debug(
      this.id,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}"`
    );
  }

  /**
   * Retrieves a cached value by key, or fetches it from the database if not found in cache.
   * Concurrent calls for the same key share a single database query.
   *
   * @param key - The cache key to retrieve or fetch.
   * @returns A promise that resolves to the cached value (`null` if the row does not exist),
   * or undefined if an error occurs during fetching.
   * @throws Does not throw; errors are logged internally.
   */
  async getOrFetch(key: K): Promise<LilypadCachedValueType<V> | undefined> {
    try {
      return await this.getOrSet(key, () =>
        this.dbGate.gate.selectFromTableByPrimaryKey<V>(this.dbGate.schema, key)
      );
    } catch {
      // Already logged by getOrSet
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
   * @param options.invalidateBulkSync - Whether to invalidate bulk sync when the update fails (default: true).
   * @returns A promise that resolves when the invalidation process is complete.
   */
  override async invalidate(key: K, options: { invalidateBulkSync?: boolean } = {}) {
    try {
      await this.update(key);
    } catch (error) {
      void this.logger?.error(
        this.id,
        `Error updating cache key "${String(key)}" after invalidation: `,
        error
      );
      super.invalidate(key, options);
    }
  }

  /**
   * Updates the cache entry for the specified key by fetching the latest value from the database.
   * A row that does not exist is cached as `null`.
   *
   * @param key - The primary key of the cache entry to update.
   * @returns A promise that resolves to the updated value from the database.
   * @throws Rethrows any error encountered during the database fetch.
   */
  async update(key: K): Promise<LilypadCachedValueType<V>> {
    const value = await this.dbGate.gate.selectFromTableByPrimaryKey<V>(this.dbGate.schema, key);
    this.set(key, value);
    return value;
  }

  async getAll(keys?: K[]): Promise<V[]> {
    const values = await super.bulkAsyncGet({ doSync: true, keys });
    return Array.from(values.values()).filter((item): item is V => item !== null);
  }

  protected getDefaultDbListener(
    options?: LilypadDbCacheDefaultListenerOptions
  ): ListenerCallbackIdentifier {
    return {
      channel: 'cache_events',
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${this.dbGate.schema.tableName}_${this.id}`,
      callback: async (payload: unknown) => {
        void this.logger?.debug(
          this.id,
          this.dbGate.schema.tableName,
          'LilypadDbCache handler has received payload on cache_events channel:',
          payload
        );
        if (typeof payload !== 'string') {
          return;
        }
        let parsedPayload: LilypadDbCacheDefaultNotificationPayload;
        try {
          parsedPayload = JSON.parse(payload);
        } catch (e) {
          void this.logger?.error(this.id, 'Error parsing cache_events payload:', e);
          return;
        }
        if (!parsedPayload.id || !parsedPayload.table) {
          return;
        }
        if (parsedPayload.table === this.dbGate.schema.tableName) {
          void this.logger?.debug(
            this.id,
            this.dbGate.schema.tableName,
            'LilypadDbCache handler is processing payload:',
            parsedPayload
          );
          if (!options?.callback || options.automaticallyInvalidateDataBeforeCallback) {
            if (parsedPayload.op === 'DELETE') {
              this.delete(String(parsedPayload.id) as K, { setNull: true });
            } else {
              await this.invalidate(String(parsedPayload.id) as K, { invalidateBulkSync: false });
            }
          }
          await options?.callback?.(parsedPayload);
          return;
        }
      },
    };
  }

  /**
   * Disposes of the cache: stops its default database listener, removes it from the singleton
   * registry (if it was created as a singleton) and clears it.
   */
  override async dispose(): Promise<void> {
    if (this.singletonIdentifier !== undefined) {
      removeLilypadSingletonInstance(this.singletonIdentifier);
      this.singletonIdentifier = undefined;
    }
    // removeListener unregisters the callback synchronously; only the UNLISTEN is awaited
    const listenerRemoval = this.defaultDbListener
      ? this.dbGate.gate.removeListener(
          this.defaultDbListener.channel,
          this.defaultDbListener.callbackId
        )
      : undefined;
    super.dispose();
    await listenerRemoval;
  }

  private getItemPrimaryKeyValue(item: V): V[keyof V] {
    const keyValue = item[this.dbGate.schema.primaryKey];
    if (keyValue === undefined) {
      throw new Error(
        `Primary key "${String(
          this.dbGate.schema.primaryKey
        )}" is missing in the item data for table "${this.dbGate.schema.tableName}".`
      );
    }
    return keyValue;
  }

  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item: V): Promise<V | null> {
    const row = await this.dbGate.gate.insertToTable<V>(this.dbGate.schema, item);
    if (row !== null) {
      this.set(this.getItemPrimaryKeyValue(row) as K, row);
    }
    return row;
  }

  /**
   * Updates the item in the database and caches the row returned by the database.
   *
   * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws If no row with the item's primary key exists.
   */
  async sqlUpdate(item: V): Promise<V | null> {
    const keyValue = this.getItemPrimaryKeyValue(item);
    const row = await this.dbGate.gate.updateToTable<V>(this.dbGate.schema, item);
    this.set(keyValue as K, row);
    return row;
  }

  async sqlDelete(key: K): Promise<void> {
    await this.dbGate.gate.deleteFromTable<V>(this.dbGate.schema, key);
    this.delete(key, { setNull: true });
  }
}
