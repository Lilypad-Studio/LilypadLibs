import {
  lilypadMissingPrimaryKeyError,
  type LilypadDbGate,
  type LilypadDbInsertData,
  type LilypadDbSchema,
  type LilypadDbUpdateData,
  type ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import LilypadCache, { LilypadCachedValueType, LilypadCacheKey } from './LilypadCache';
import {
  createLilypadSingletonAbleAsync,
  createLilypadSingletonSignatureValue,
  LilypadSingletonAble,
  removeLilypadSingletonInstance,
} from '@/singleton/LilypadSingleton';

export type LilypadDbCacheDefaultNotificationPayload = {
  table?: string;
  /** A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`). */
  id?: string | number;
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

type LilypadDbCacheConstructorOptions<
  K extends LilypadCacheKey,
  V,
  PK extends keyof V,
> = ConstructorParameters<typeof LilypadCache<K, V>>[1] & {
  dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
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
 * @typeParam K - The type of the cache key: the type of the primary key column.
 * @typeParam V - The type of the cached value, constrained to object.
 * @typeParam PK - The primary key column of `V` (see {@link LilypadDbSchema}).
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create<number, User, 'id'>(60_000, {
 *   dbGate: { gate, schema: usersSchema },
 *   logger,
 * });
 * const user = await users.getOrFetch(42); // User | null (no such row) | undefined (query failed)
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `update` and
 *   `invalidate` always re-fetch the key; `getAll` loads the whole table (at most once per bulk sync TTL).
 * - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the result.
 * - The `bulkAsyncGet` method fetches all items from the database and updates the cache.
 * - Unless disabled, the cache listens on the `cache_events` channel for JSON payloads shaped as
 *   {@link LilypadDbCacheDefaultNotificationPayload}. The database trigger sending them is not part of this library.
 *   Only keys the cache holds (or is fetching) are re-fetched; other changes just force the next bulk sync.
 */
export default class LilypadDbCache<
  K extends LilypadCacheKey & V[PK],
  V extends object,
  PK extends keyof V = keyof V,
> extends LilypadCache<K, V> {
  private readonly dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
  private readonly defaultDbListener?: ListenerCallbackIdentifier;
  private singletonIdentifier?: string;

  /**
   * Creates a cache and, unless disabled, registers its default database listener.
   * With `singleton: true`, a later call with the same identifier returns the existing cache and
   * ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * @throws If the default database listener cannot be registered (e.g. the database is unreachable).
   */
  public static async create<
    K extends LilypadCacheKey & V[PK],
    V extends object,
    PK extends keyof V = keyof V,
  >(
    ttl: number = 60000,
    options: LilypadDbCacheConstructorOptions<K, V, PK> & LilypadSingletonAble
  ): Promise<LilypadDbCache<K, V, PK>> {
    return createLilypadSingletonAbleAsync(
      'LilypadDbCache',
      options,
      async (registryKey) => {
        const cache = await LilypadDbCache.initializeNew<K, V, PK>(ttl, options);
        cache.singletonIdentifier = registryKey;
        return cache;
      },
      {
        value: createLilypadSingletonSignatureValue([options.dbGate.schema.tableName, ttl]),
        onMismatch: () =>
          void options.logger?.warn(
            `LilypadDbCache singleton "${options.singleton ? options.singletonIdentifier : ''}" already exists with a different table or TTL: the new options are ignored.`
          ),
      }
    );
  }

  private static async initializeNew<
    K extends LilypadCacheKey & V[PK],
    V extends object,
    PK extends keyof V,
  >(
    ttl: number,
    options: LilypadDbCacheConstructorOptions<K, V, PK>
  ): Promise<LilypadDbCache<K, V, PK>> {
    const cache = new LilypadDbCache<K, V, PK>(ttl, options);
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

  private constructor(ttl: number, options: LilypadDbCacheConstructorOptions<K, V, PK>) {
    super(ttl, options);
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () =>
      (await this.dbGate.gate.selectAllFromTable<V, PK>(this.dbGate.schema)).map((item) => [
        item[this.dbGate.schema.primaryKey] as K,
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
        this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(this.dbGate.schema, key)
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
   * If a write that started later completes first, the fetched value is returned but not cached.
   *
   * @param key - The primary key of the cache entry to update.
   * @returns A promise that resolves to the updated value from the database.
   * @throws Rethrows any error encountered during the database fetch.
   */
  async update(key: K): Promise<LilypadCachedValueType<V>> {
    const ticket = this.nextTicket();
    const value = await this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(
      this.dbGate.schema,
      key
    );
    this.setIfNewer(key, value, undefined, ticket);
    return value;
  }

  /**
   * Returns every row of the table, loading it if the bulk sync has expired.
   *
   * @throws If the table cannot be loaded.
   */
  async getAll(keys?: K[]): Promise<V[]> {
    await this.bulkSync(undefined, { throwOnError: true });
    const values = this.bulkGet({ keys });
    return Array.from(values.values()).filter((item): item is V => item !== null);
  }

  /**
   * The key of the cached entry for a notified id, so that the entry keeps its original key type
   * (a notification may carry a numeric key as a string, or the other way around).
   */
  private resolveNotifiedKey(id: string | number): K {
    const normalizedKey = this.normalizeKey(id as K);
    return this.store.get(normalizedKey)?.key ?? (id as K);
  }

  /**
   * Caches the key as "does not exist". Unlike `delete(key, { setNull: true })`, it also applies
   * to protected keys: they are protected from removal, not from reflecting a deleted row.
   */
  private markDeleted(key: K) {
    this.set(key, null);
  }

  protected getDefaultDbListener(
    options?: LilypadDbCacheDefaultListenerOptions
  ): ListenerCallbackIdentifier {
    return {
      channel: 'cache_events',
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${this.dbGate.schema.tableName}_${this.id}`,
      // Notifications sent while the connection was down are lost: every entry may be stale
      onReconnect: () => this.expireAll(),
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
        if (typeof parsedPayload !== 'object' || parsedPayload === null) {
          return;
        }
        if (
          (typeof parsedPayload.id !== 'string' && typeof parsedPayload.id !== 'number') ||
          parsedPayload.id === '' ||
          !parsedPayload.table
        ) {
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
            await this.applyNotification(parsedPayload.op, parsedPayload.id);
          }
          await options?.callback?.(parsedPayload);
          return;
        }
      },
    };
  }

  private async applyNotification(
    op: LilypadDbCacheDefaultNotificationPayload['op'],
    id: string | number
  ) {
    const key = this.resolveNotifiedKey(id);
    if (op === 'DELETE') {
      // Also for keys not in cache: the null entry keeps an older, in-flight fetch from caching the row
      this.markDeleted(key);
      return;
    }
    if (this.getComprehensive(key).type !== 'miss' || this.isFetchInFlight(key)) {
      await this.invalidate(key, { invalidateBulkSync: false });
    } else {
      // Nobody asked for this row: no query, but the next getAll must see it
      this.invalidateBulkSync();
    }
  }

  /**
   * Marks every entry as expired (keeping the values as fallback) and forces the next bulk sync.
   */
  private expireAll() {
    for (const entry of [...this.store.values()]) {
      this.expire(entry.key);
    }
    this.invalidateBulkSync();
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

  private getItemPrimaryKeyValue(item: Partial<V>): V[PK] {
    const keyValue = item[this.dbGate.schema.primaryKey];
    if (keyValue === undefined) {
      throw lilypadMissingPrimaryKeyError(this.dbGate.schema, 'item');
    }
    return keyValue as V[PK];
  }

  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null> {
    const row = await this.dbGate.gate.insertToTable<V, PK>(this.dbGate.schema, item);
    if (row !== null) {
      this.set(this.getItemPrimaryKeyValue(row) as K, row);
    }
    return row;
  }

  /**
   * Updates the item in the database and caches the row returned by the database.
   * Only the columns present in `item` are written.
   *
   * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws If no row with the item's primary key exists.
   */
  async sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null> {
    const keyValue = this.getItemPrimaryKeyValue(item);
    const row = await this.dbGate.gate.updateToTable<V, PK>(this.dbGate.schema, item);
    this.set(keyValue as K, row);
    return row;
  }

  async sqlDelete(key: K): Promise<void> {
    await this.dbGate.gate.deleteFromTable<V, PK>(this.dbGate.schema, key);
    this.markDeleted(key);
  }
}
