import {
  lilypadMissingPrimaryKeyError,
  type LilypadDbGate,
  type LilypadDbInsertData,
  type LilypadDbSchema,
  type LilypadDbUpdateData,
  type ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import { LILYPAD_DEFAULT_NOTIFY_CHANNEL, readLilypadChanges } from '@/dbGate/LilypadChangelog';
import LilypadCache, {
  type LilypadCachedValueType,
  type LilypadCacheGetOptions,
  type LilypadCacheKey,
  type LilypadCacheOptions,
  type LilypadCacheResult,
} from './LilypadCache';
import { runInBackground } from '@/platform/LilypadPlatform';
import {
  createLilypadSingletonAbleAsync,
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

/**
 * How the cache learns about the changes made by other instances and other programs.
 *
 * - `listen`: `LISTEN/NOTIFY` on a dedicated connection. Near real-time, for long-running servers.
 *   Not suited to serverless platforms: the connection must stay open, it does not work through a
 *   pooler in transaction mode, and notifications sent while an instance is suspended are lost.
 * - `changelog`: each instance reads the changelog table (see `lilypadChangelogSql`) at most once
 *   per `pollInterval`, when the cache is used. No long-lived connection: suited to serverless
 *   platforms. Changes are seen within `pollInterval`.
 * - `none`: only the writes of this instance and the TTL keep the cache up to date.
 */
export type LilypadDbCacheSync =
  | {
      strategy: 'listen';
      /**
       * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
       * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
       */
      connect?: 'eager' | 'lazy';
      listenerOptions?: LilypadDbCacheDefaultListenerOptions;
    }
  | {
      strategy: 'changelog';
      /** Minimum time between two reads of the changelog, in ms. Changes are seen within it. */
      pollInterval: number;
      /**
       * `await` (default): a read that is due waits for the changelog, so it never returns data
       * older than `pollInterval`. `background`: the read does not wait, and may return data one
       * interval older.
       */
      poll?: 'await' | 'background';
      /**
       * If the changelog has not been read for this long (ms), the instance no longer trusts it:
       * every entry is expired instead. It must be much shorter than the retention of the
       * changelog (see `pruneLilypadChangelog`). Defaults to 1 hour.
       */
      maxGap?: number;
      /**
       * On the first read, or after `maxGap`, the changes of this many ms are applied, so that
       * copies in the shared level older than those changes are removed too. It must cover the
       * lifetime of a shared entry. Defaults to the TTL plus `staleWhileRevalidate`, plus 1 minute.
       */
      lookback?: number;
      /** The changelog table, if not `lilypad_cache_changes`. */
      table?: string;
    }
  | { strategy: 'none' };

type LilypadDbCacheConstructorOptions<
  K extends LilypadCacheKey,
  V,
  PK extends keyof V,
> = LilypadCacheOptions<K, V> & {
  dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
  /** Defaults to `{ strategy: 'listen' }`, or to what `useDefaultDbListener` asks for. */
  sync?: LilypadDbCacheSync;
} & (
    | {
        /** @deprecated Use `sync: { strategy: 'none' }`. */
        useDefaultDbListener?: false;
      }
    | {
        /** @deprecated Use `sync: { strategy: 'listen', listenerOptions }`. */
        useDefaultDbListener: true;
        /** @deprecated Use `sync: { strategy: 'listen', listenerOptions }`. */
        defaultListenerOptions: LilypadDbCacheDefaultListenerOptions;
      }
  );

const DEFAULT_CHANGELOG_MAX_GAP = 60 * 60 * 1000; // 1 hour

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
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched; other changes just force the next bulk sync.
 * - The name of the cache (shared level keys, invalidation events) defaults to the table name.
 */
export default class LilypadDbCache<
  K extends LilypadCacheKey & V[PK],
  V extends object,
  PK extends keyof V = keyof V,
> extends LilypadCache<K, V> {
  private readonly dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
  private readonly sync: LilypadDbCacheSync;
  private readonly defaultDbListener?: ListenerCallbackIdentifier;
  private listening?: Promise<void>;
  private singletonIdentifier?: string;

  // Changelog strategy state
  private changelogCursor?: bigint;
  /** Changes already applied, by id, with their transaction id, until the cursor passes them. */
  private appliedChanges = new Map<string, bigint>();
  private lastChangelogRead = 0;
  private changelogRead?: Promise<void>;

  /**
   * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
   * database listener.
   * With `singleton: true`, a later call with the same identifier returns the existing cache and
   * ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * @throws If the database listener cannot be registered (e.g. the database is unreachable).
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
        value: JSON.stringify([options.dbGate.schema.tableName, ttl]),
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
    if (cache.sync.strategy === 'listen' && cache.sync.connect !== 'lazy') {
      try {
        await cache.startListening();
      } catch (error) {
        await cache.dispose();
        throw error;
      }
    }
    return cache;
  }

  private constructor(ttl: number, options: LilypadDbCacheConstructorOptions<K, V, PK>) {
    super(ttl, { ...options, name: options.name ?? options.dbGate.schema.tableName });
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () =>
      (await this.dbGate.gate.selectAllFromTable<V, PK>(this.dbGate.schema)).map((item) => [
        item[this.dbGate.schema.primaryKey] as K,
        item,
      ]);

    this.sync = options.sync ?? LilypadDbCache.syncFromLegacyOptions(options);
    if (this.sync.strategy === 'listen') {
      this.defaultDbListener = this.getDefaultDbListener(this.sync.listenerOptions);
    }

    void this.logger?.debug(
      this.id,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}" (sync: ${this.sync.strategy})`
    );
  }

  private static syncFromLegacyOptions(options: {
    useDefaultDbListener?: boolean;
    defaultListenerOptions?: LilypadDbCacheDefaultListenerOptions;
  }): LilypadDbCacheSync {
    if (options.useDefaultDbListener === false) {
      return { strategy: 'none' };
    }
    return {
      strategy: 'listen',
      listenerOptions: options.useDefaultDbListener ? options.defaultListenerOptions : undefined,
    };
  }

  // SYNCHRONIZATION

  /** Registers the listener once; a failed registration is retried by the next call. */
  private startListening(): Promise<void> {
    if (!this.listening && this.defaultDbListener) {
      this.listening = this.dbGate.gate.addListener(this.defaultDbListener).catch((error) => {
        this.listening = undefined;
        throw error;
      });
    }
    return this.listening ?? Promise.resolve();
  }

  /**
   * Brings the cache up to date with the changes made elsewhere before a read: starts a lazy
   * `LISTEN`, or reads the changelog when it is due. It never throws: a failure is logged, and
   * the read goes on with the cache as it is.
   *
   * @returns A promise to await, or `undefined` when there is nothing to wait for: the read then
   * goes on synchronously, as without synchronization.
   */
  protected syncBeforeRead(): Promise<void> | undefined {
    if (this.sync.strategy === 'listen' && this.sync.connect === 'lazy') {
      if (this.listening) {
        return undefined;
      }
      return this.startListening().catch((error) => {
        void this.logger?.error(this.id, 'Error starting LISTEN for the cache:', error);
      });
    }
    if (this.sync.strategy !== 'changelog') {
      return undefined;
    }
    if (Date.now() - this.lastChangelogRead < this.sync.pollInterval) {
      return undefined;
    }
    const reading = this.readChangelog();
    if (this.sync.poll === 'background') {
      runInBackground(this.platform, reading, () => {});
      return undefined;
    }
    return reading;
  }

  /** Reads the changelog once at a time; errors are logged. */
  private readChangelog(): Promise<void> {
    if (!this.changelogRead) {
      this.changelogRead = this.applyChangelog()
        .catch((error) => {
          void this.logger?.error(this.id, 'Error reading the changelog:', error);
        })
        .finally(() => {
          this.changelogRead = undefined;
        });
    }
    return this.changelogRead;
  }

  private async applyChangelog(): Promise<void> {
    if (this.sync.strategy !== 'changelog') {
      return;
    }
    const maxGap = this.sync.maxGap ?? DEFAULT_CHANGELOG_MAX_GAP;
    const readAt = Date.now();
    const trusted = this.changelogCursor !== undefined && readAt - this.lastChangelogRead <= maxGap;
    const lookback =
      this.sync.lookback ?? this.defaultTtl + this.defaultStaleWhileRevalidate + 60_000;
    const { changes, cursor } = await readLilypadChanges(this.dbGate.gate, {
      // The trigger records the table name without its schema
      tableName: this.dbGate.schema.tableName.split('.').pop()!,
      since: trusted ? { cursor: this.changelogCursor! } : { lookback },
      changelogTable: this.sync.table,
    });

    if (!trusted) {
      // First read, or too long since the last one: the local entries may have missed changes,
      // and the recent changes are applied below to the shared level too
      this.appliedChanges.clear();
      this.expireAll();
    }
    const changedKeys: K[] = [];
    for (const change of changes) {
      if (this.appliedChanges.has(change.id)) {
        continue;
      }
      this.appliedChanges.set(change.id, change.xid);
      changedKeys.push(await this.applyChange(change.op, change.rowId, 'lazy'));
    }
    // Changes older than the new cursor will not be returned again
    for (const [id, xid] of this.appliedChanges) {
      if (xid < cursor) {
        this.appliedChanges.delete(id);
      }
    }
    this.changelogCursor = cursor;
    this.lastChangelogRead = readAt;
    this.emitInvalidation('changelog', changedKeys);
  }

  /**
   * Applies a change of a row made elsewhere.
   * - DELETE: the key is cached as `null`.
   * - INSERT/UPDATE of a key held (or being fetched) by this instance: `eager` re-fetches it at
   *   once; `lazy` expires it, so the next read fetches it. A fetch in flight is always re-fetched,
   *   since it may have read the row before the change.
   * - INSERT/UPDATE of any other key: no query, but the shared level entry is removed and the next
   *   `getAll` reloads the table.
   *
   * @returns The key of the changed row.
   */
  private async applyChange(
    op: LilypadDbCacheDefaultNotificationPayload['op'],
    id: string | number,
    mode: 'eager' | 'lazy'
  ): Promise<K> {
    const key = this.resolveNotifiedKey(id);
    if (op === 'DELETE') {
      // Also for keys not in cache: the null entry keeps an older, in-flight fetch from caching the row
      this.markDeleted(key);
      return key;
    }
    const inFlight = this.isFetchInFlight(key);
    if (inFlight || (mode === 'eager' && this.getComprehensive(key).type !== 'miss')) {
      await this.refreshKey(key, { invalidateBulkSync: false });
    } else if (this.getComprehensive(key).type !== 'miss') {
      this.markInvalid(key, { invalidateBulkSync: false });
    } else {
      // Nobody asked for this row here: no query, but other instances may have shared it
      this.deleteShared(key);
      this.invalidateBulkSync();
    }
    return key;
  }

  override async getOrSetDetailed(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
    return super.getOrSetDetailed(key, valueFn, options);
  }

  /**
   * Retrieves a cached value by key, or fetches it from the database if not found in cache.
   * Concurrent calls for the same key share a single database query.
   *
   * @param key - The cache key to retrieve or fetch.
   * @param options - The `getOrSet` options (e.g. `staleWhileRevalidate`, `timeout`).
   * @returns A promise that resolves to the cached value (`null` if the row does not exist),
   * or undefined if an error occurs during fetching.
   * @throws Does not throw; errors are logged internally.
   */
  async getOrFetch(
    key: K,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V> | undefined> {
    try {
      return await this.getOrSet(
        key,
        () => this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(this.dbGate.schema, key),
        options
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
   * logs the error and expires the entry, as the base class's invalidate method does.
   * `platform.onInvalidate` receives a `manual` event.
   *
   * @param key - The cache key to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - Whether to invalidate bulk sync when the update fails (default: true).
   * @returns A promise that resolves when the invalidation process is complete.
   */
  override async invalidate(key: K, options: { invalidateBulkSync?: boolean } = {}) {
    await this.refreshKey(key, options);
    this.emitInvalidation('manual', [key]);
  }

  /** Re-fetches a key; if the query fails, expires it instead. */
  private async refreshKey(key: K, options: { invalidateBulkSync?: boolean }) {
    try {
      await this.update(key);
    } catch (error) {
      void this.logger?.error(
        this.id,
        `Error updating cache key "${String(key)}" after invalidation: `,
        error
      );
      this.markInvalid(key, options);
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
    const fetchedAt = Date.now();
    const value = await this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(
      this.dbGate.schema,
      key
    );
    this.storeFetched(key, value, undefined, ticket, fetchedAt);
    return value;
  }

  /**
   * Returns every row of the table, loading it if the bulk sync has expired.
   * The table is loaded into the memory of this instance only, not into the shared level.
   *
   * @throws If the table cannot be loaded.
   */
  async getAll(keys?: K[]): Promise<V[]> {
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
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
   * Caches the key as "does not exist", here and in the shared level. Unlike
   * `delete(key, { setNull: true })`, it also applies to protected keys: they are protected from
   * removal, not from reflecting a deleted row.
   */
  private markDeleted(key: K) {
    this.set(key, null);
  }

  protected getDefaultDbListener(
    options?: LilypadDbCacheDefaultListenerOptions
  ): ListenerCallbackIdentifier {
    return {
      channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
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
        // The trigger sends the table name without its schema
        if (parsedPayload.table === this.dbGate.schema.tableName.split('.').pop()) {
          void this.logger?.debug(
            this.id,
            this.dbGate.schema.tableName,
            'LilypadDbCache handler is processing payload:',
            parsedPayload
          );
          if (!options?.callback || options.automaticallyInvalidateDataBeforeCallback) {
            const key = await this.applyChange(parsedPayload.op, parsedPayload.id, 'eager');
            this.emitInvalidation('notification', [key]);
          }
          await options?.callback?.(parsedPayload);
          return;
        }
      },
    };
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
   * Disposes of the cache: stops its database listener, removes it from the singleton registry
   * (if it was created as a singleton) and clears it.
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
      const key = this.getItemPrimaryKeyValue(row) as K;
      this.set(key, row);
      this.emitInvalidation('write', [key]);
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
    const key = this.getItemPrimaryKeyValue(item) as K;
    const row = await this.dbGate.gate.updateToTable<V, PK>(this.dbGate.schema, item);
    this.set(key, row);
    this.emitInvalidation('write', [key]);
    return row;
  }

  async sqlDelete(key: K): Promise<void> {
    await this.dbGate.gate.deleteFromTable<V, PK>(this.dbGate.schema, key);
    this.markDeleted(key);
    this.emitInvalidation('write', [key]);
  }
}
