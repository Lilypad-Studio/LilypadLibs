import { LilypadDbMembers } from '@/cache/dbCache/LilypadDbMembers';
import { LilypadOwnWrites } from '@/cache/dbCache/LilypadOwnWrites';
import { LilypadChangelogSync } from '@/cache/dbSync/LilypadChangelogSync';
import {
  lilypadNoSync,
  type LilypadDbCacheSyncOverrides,
  type LilypadDbChangeMode,
  type LilypadDbRowChange,
  type LilypadDbSyncHost,
  type LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import { LilypadListenSync } from '@/cache/dbSync/LilypadListenSync';
import { LilypadCacheEngine } from '@/cache/LilypadCacheEngine';
import { LilypadReadFlights } from '@/cache/LilypadReadFlights';
import {
  LilypadDisposedError,
  type LilypadCacheBulkSyncOptions,
  type LilypadCachedValueType,
  type LilypadCacheEntry,
  type LilypadCacheGetOptions,
  type LilypadCacheKey,
  type LilypadCacheOptions,
  type LilypadCachePeek,
  type LilypadCacheRead,
  type LilypadCacheResult,
} from '@/cache/LilypadCacheTypes';
import {
  resolveLilypadDbTable,
  type LilypadDbConfig,
  type LilypadDbPrimaryKey,
  type LilypadDbRow,
  type LilypadDbTableDefinition,
  type LilypadDbTableName,
} from '@/dbConfig/LilypadDbConfig';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LilypadDbMissingPrimaryKeyError,
  type LilypadDbInsertData,
  type LilypadDbUpdateData,
} from '@/dbGate/LilypadDbSchema';
import type { LilypadDbTable } from '@/dbGate/LilypadDbTable';
import { LilypadFlowControl } from '@/flow/LilypadFlowControl';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  createLilypadSingletonAbleAsync,
  type LilypadSingletonAble,
  type LilypadSingletonRelease,
} from '@/singleton/LilypadSingleton';

export type {
  LilypadDbCacheSyncOverrides,
  LilypadDbNotification,
} from '@/cache/dbSync/LilypadDbSyncTypes';

/** The key type of a table: the type of its primary key column. */
export type LilypadDbKey<V, PK extends keyof V> = V[PK] & LilypadCacheKey;

/** The options of a cache, apart from its table and its gate. */
export type LilypadDbCacheBaseOptions<V extends object, PK extends keyof V = keyof V> = Omit<
  LilypadCacheOptions<LilypadDbKey<V, PK>, V>,
  'bulkSync'
> & {
  /**
   * Changes the options of the sync of the table for this cache (e.g. `connect: 'lazy'`, an
   * `onNotification` callback). The strategy is the one of the table in its config.
   */
  sync?: LilypadDbCacheSyncOverrides;
  /**
   * Loading the whole table (`getAll`): `timeout` bounds each load and each query by primary keys
   * (defaults to 30 seconds); with the `none` strategy, a load stays valid for `ttl` (defaults to
   * the TTL).
   */
  bulkSync?: Omit<LilypadCacheBulkSyncOptions<LilypadDbKey<V, PK>, V>, 'fn'>;
};

/** The options of a cache of a table given as a definition (`db.tables.users`). */
export type LilypadDbCacheOptions<
  V extends object,
  PK extends keyof V = keyof V,
> = LilypadDbCacheBaseOptions<V, PK> & {
  gate: LilypadDbGate;
  /** The table, from a config: `db.tables.users`, whatever the config of the gate. */
  table: LilypadDbTableDefinition<V, PK>;
};

/** The options of a cache of a table given by its key in `config`. */
export type LilypadDbCacheNamedOptions<
  C extends LilypadDbConfig,
  N extends LilypadDbTableName<C>,
> = LilypadDbCacheBaseOptions<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>> & {
  gate: LilypadDbGate;
  config: C;
  table: N;
};

/** The options of a cache of a table given by its key in the config of the gate. */
export type LilypadDbCacheGateNamedOptions<
  C extends LilypadDbConfig,
  N extends LilypadDbTableName<C>,
> = LilypadDbCacheBaseOptions<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>> & {
  gate: LilypadDbGate<C>;
  config?: undefined;
  table: N;
};

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour
const DEFAULT_LOAD_TIMEOUT = 30_000;
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = 0.25;
/**
 * The most keys that notifications make this instance re-read per second. Anyone can send a
 * notification: beyond this budget, the notified keys are only expired, and read again when the
 * application asks for them, so that a flood of notifications cannot flood the database.
 */
const EAGER_REFRESHES_PER_SECOND = 1000;

/**
 * A cache of the rows of one table, kept up to date with the changes made elsewhere.
 *
 * Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
 * table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
 * `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
 * from the table could be kept past its TTL as if it did.
 *
 * Every method throws a {@link LilypadDisposedError} once the cache is disposed, except `dispose`.
 *
 * @typeParam V - The row type.
 * @typeParam PK - The primary key column; the keys of the cache are its values.
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create({ ttl: 60_000, gate, table: db.tables.users, logger });
 * const user = await users.getOrFetch(42); // User, or null when there is no such row
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `refresh` always
 *   re-fetches the key; `getAll` loads the whole table once, then fetches only the rows it does
 *   not hold up to date.
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
 *   notes that the row exists, and `getAll` fetches it.
 * - The name of the cache (shared level keys, invalidation events, logs) defaults to the table name.
 */
export class LilypadDbCache<V extends object, PK extends keyof V = keyof V> {
  private readonly engine: LilypadCacheEngine<LilypadDbKey<V, PK>, V>;
  private readonly table: LilypadDbTable<V, PK>;
  private readonly definition: LilypadDbTableDefinition<V, PK>;
  private readonly sync: LilypadDbSyncStrategy;
  private readonly maxAge: number;
  /** Bounds the loads of the table and the queries by primary keys (`bulkSync.timeout`). */
  private readonly loadFlowControl: LilypadFlowControl;
  /** With the `none` strategy, how long a load of the table stays valid (`bulkSync.ttl`). */
  private readonly loadTtl: number;
  private releaseSingleton: LilypadSingletonRelease = () => {};
  /** The keys of the rows of the table, for `getAll`. */
  private members = new LilypadDbMembers<LilypadDbKey<V, PK>>();
  /** The load of the whole table in flight, shared by concurrent callers. */
  private tableLoad?: Promise<Map<string, V>>;
  /** The queries of `fetchRows` in flight, by normalized key. */
  private rowFetches = new LilypadReadFlights<Map<string, LilypadCachedValueType<V>>>();
  /** The keys to re-read after a notification, gathered into one query (see `refreshInBatch`). */
  private eagerBatch?: { keys: Map<string, LilypadDbKey<V, PK>>; done: Promise<void> };
  /** The keys of the batches of `refreshInBatch` pending or running, with their number. */
  private eagerReads = new Map<string, number>();
  /** The keys re-read after notifications in the current second, for the eager budget. */
  private eagerWindow = { start: 0, count: 0 };
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  private refreshes = new Map<
    string,
    {
      running?: Promise<LilypadCachedValueType<V>>;
      queued?: Promise<LilypadCachedValueType<V>>;
    }
  >();
  /** The writes of this instance, recognized when their changes come back through the sync. */
  private ownWrites = new LilypadOwnWrites();
  /**
   * Whether the primary key holds numbers: declared by `cols[primaryKey].type`, or learned from the
   * rows read. The ids of notifications and of the changelog are then converted to numbers.
   */
  private numericPrimaryKey: boolean;
  private disposing?: Promise<void>;

  /**
   * Creates a cache of a table of a config and, with the `listen` strategy (unless
   * `connect: 'lazy'`), registers its database listener. The table is a definition
   * (`db.tables.users`, from any config), or its key (`'users'`) in `config`, or else in the config
   * of the gate. The row type and the primary key are inferred from it.
   * With `singleton: '<identifier>'`, a later call with the same identifier returns the existing
   * cache and ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * Nothing is compared with the database: `lilypad-doctor` checks it against the config.
   *
   * @throws If the table is not found, or if the database listener cannot be registered (e.g. the
   * database is unreachable).
   */
  static async create<V extends object, PK extends keyof V = keyof V>(
    options: LilypadDbCacheOptions<V, PK> & LilypadSingletonAble
  ): Promise<LilypadDbCache<V, PK>>;
  static async create<C extends LilypadDbConfig, N extends LilypadDbTableName<C>>(
    options: LilypadDbCacheNamedOptions<C, N> & LilypadSingletonAble
  ): Promise<LilypadDbCache<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>>;
  static async create<C extends LilypadDbConfig, N extends LilypadDbTableName<C>>(
    options: LilypadDbCacheGateNamedOptions<C, N> & LilypadSingletonAble
  ): Promise<LilypadDbCache<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>>;
  static async create(
    options: LilypadSingletonAble & {
      gate: LilypadDbGate;
      table: unknown;
      config?: LilypadDbConfig;
      ttl?: number;
      logger?: LilypadLibLogger;
    }
  ): Promise<unknown> {
    const { table, config, ...rest } = options;
    const definition = resolveLilypadDbTable(
      'LilypadDbCache',
      table,
      config ?? options.gate.config
    ) as LilypadDbTableDefinition<object, never>;
    const resolved = { ...rest, table: definition } as LilypadDbCacheOptions<object, never> &
      LilypadSingletonAble;
    return createLilypadSingletonAbleAsync(
      'LilypadDbCache',
      resolved,
      async (release) => {
        const cache = new LilypadDbCache<object, never>(resolved);
        try {
          await cache.sync.start();
        } catch (error) {
          await cache.dispose();
          throw error;
        }
        cache.releaseSingleton = release;
        return cache;
      },
      {
        value: JSON.stringify([definition.db.name, definition.qualifiedName, options.ttl]),
        onMismatch: () =>
          libLog(
            options.logger,
            'warn',
            'LilypadDbCache',
            `Singleton "${options.singleton ?? ''}" already exists with a different table or TTL: the new options are ignored.`
          ),
      }
    );
  }

  private constructor(options: LilypadDbCacheOptions<V, PK> & LilypadSingletonAble) {
    const {
      gate,
      table: definition,
      sync: overrides = {},
      bulkSync,
      singleton: _singleton,
      ...cacheOptions
    } = options;
    const owner = 'LilypadDbCache';
    assertNumberOption(owner, 'bulkSync.ttl', bulkSync?.ttl, 'non-negative');
    assertNumberOption(owner, 'bulkSync.timeout', bulkSync?.timeout, 'positive-delay');
    assertNumberOption(owner, 'sync.maxAge', overrides.maxAge, 'non-negative');
    assertNumberOption(owner, 'sync.pollInterval', overrides.pollInterval, 'non-negative');
    const tableSync = definition.sync;

    this.engine = new LilypadCacheEngine<LilypadDbKey<V, PK>, V>(
      { ...cacheOptions, name: options.name ?? definition.tableName },
      {
        onValueStored: (entry) => this.followValue(entry),
        hasReadInFlight: (normalizedKey) =>
          this.rowFetches.has(normalizedKey) ||
          this.refreshes.has(normalizedKey) ||
          this.eagerReads.has(normalizedKey),
      }
    );
    this.table = gate.table(definition);
    this.definition = definition;
    this.loadTtl = bulkSync?.ttl ?? this.engine.defaultTtl;
    this.loadFlowControl = new LilypadFlowControl({
      timeout: bulkSync?.timeout ?? DEFAULT_LOAD_TIMEOUT,
    });
    this.numericPrimaryKey = definition.cols[definition.primaryKey]?.type === 'number';
    this.maxAge =
      tableSync.strategy === 'none' ? 0 : (overrides.maxAge ?? tableSync.maxAge ?? DEFAULT_MAX_AGE);

    const host = this.syncHost(gate);
    if (tableSync.strategy === 'listen') {
      this.sync = new LilypadListenSync(host, {
        ...tableSync,
        connect: overrides.connect ?? tableSync.connect,
        applyChanges: overrides.applyChanges ?? tableSync.applyChanges,
        onNotification: overrides.onNotification,
        channel: definition.db.notifyChannel,
      });
    } else if (tableSync.strategy === 'changelog') {
      this.sync = new LilypadChangelogSync(host, {
        ...tableSync,
        pollInterval: overrides.pollInterval ?? tableSync.pollInterval,
        poll: overrides.poll ?? tableSync.poll,
        table: definition.db.changelogTable,
      });
    } else {
      this.sync = lilypadNoSync;
    }

    this.engine.log(
      'debug',
      `LilypadDbCache initialized for table "${definition.qualifiedName}" (sync: ${tableSync.strategy})`
    );
  }

  /** A unique id of the instance. */
  get id(): string {
    return this.engine.id;
  }

  /** The name given in the options, or the table name. */
  get name(): string {
    return this.engine.name;
  }

  /** @throws {LilypadDisposedError} If the cache is disposed. */
  private assertNotDisposed() {
    if (this.engine.disposed) {
      throw new LilypadDisposedError(`LilypadCache "${this.name}"`);
    }
  }

  /** What the sync strategy may use of this cache. */
  private syncHost(gate: LilypadDbGate): LilypadDbSyncHost<LilypadDbKey<V, PK>> {
    const { engine } = this;
    return {
      id: engine.id,
      name: engine.name,
      gate,
      tableName: this.definition.qualifiedName,
      platform: engine.platform,
      log: (level, message, detail) => engine.log(level, message, detail),
      isDisposed: () => engine.disposed,
      applyChange: (op, id, mode, xid) => this.applyChange(op, id, mode, xid),
      applyTruncate: (mode) => this.applyTruncate(mode),
      applyBulkChange: () => this.forgetTable(false),
      expireEverything: () => engine.expireEverything(),
      emitInvalidation: (source, keys, options) => engine.emitInvalidation(source, keys, options),
      forgetOwnWritesCoveredBy: (cursor) => this.ownWrites.forgetCoveredBy(cursor),
      tableSchema: this.definition.schemaName,
      defaultLookback: () => this.defaultLookback(),
    };
  }

  /** The default `lookback` of the changelog: the lifetime of a shared copy, plus 1 minute. */
  private defaultLookback(): number {
    return this.engine.defaultTtl + this.engine.defaultStaleWhileRevalidate + 60_000;
  }

  /** Follows the values stored in the cache: the rows of the table, and the type of their keys. */
  private followValue(entry: LilypadCacheEntry<LilypadDbKey<V, PK>, V>) {
    if (
      !this.numericPrimaryKey &&
      entry.value !== null &&
      typeof entry.value[this.definition.primaryKey] === 'number'
    ) {
      this.numericPrimaryKey = true;
    }
    // A fallback value after an error says nothing about the table
    if (entry.origin !== 'fallback') {
      this.members.follow(
        this.engine.normalizeKey(entry.key),
        entry.key,
        entry.value !== null,
        entry.ticket
      );
    }
  }

  // TRUST AND RENEWAL

  /**
   * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
   * value was read from the database (or written by this instance) after the sync became trusted,
   * and any change of its row since would have expired it. It is kept until `maxAge`.
   */
  private renew(normalizedKey: string) {
    const entry = this.engine.store.get(normalizedKey);
    const now = Date.now();
    // An expiration time of 0 marks an entry invalidated by a change
    if (!entry || entry.origin !== 'source' || entry.expirationTime === 0) {
      return;
    }
    if (now < entry.expirationTime) {
      return;
    }
    const trustedSince = this.sync.trustedSince();
    if (trustedSince === undefined || entry.fetchedAt < trustedSince) {
      return;
    }
    if (now - entry.fetchedAt >= this.maxAge) {
      return;
    }
    this.engine.extendExpiration(
      normalizedKey,
      Math.min(now + this.engine.defaultTtl, entry.fetchedAt + this.maxAge)
    );
  }

  // CHANGES MADE ELSEWHERE

  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - A change of a key held (or being read) by this instance: `eager` re-fetches it at once
   *   (with the other keys notified meanwhile, in one query, within the eager budget); `lazy`
   *   expires it with no query, which also discards a read in flight (it may predate the change):
   *   the next read fetches it. A `lazy` DELETE caches the key as `null` at once.
   * - A change of any other key: no query, and no entry. The shared level entry is removed.
   * INSERT and UPDATE note the key as a row of the table, which `getAll` returns. An `eager`
   * DELETE of a key not held leaves it there: `getAll` reads it again, and learns whether it is
   * gone. A notification is thus never trusted without a query (any role can send one).
   *
   * @param xid - The transaction that made the change, when known.
   * @returns The key of the changed row.
   */
  private async applyChange(
    op: LilypadDbRowChange,
    id: string | number,
    mode: LilypadDbChangeMode,
    xid?: bigint
  ): Promise<LilypadDbKey<V, PK>> {
    const { engine } = this;
    const key = this.resolveNotifiedKey(id);
    const normalizedKey = engine.normalizeKey(key);
    if (
      xid !== undefined &&
      this.ownWrites.consume(normalizedKey, xid, engine.store.get(normalizedKey)?.ticket)
    ) {
      return key;
    }
    const held = engine.store.has(normalizedKey) || engine.hasReadInFlight(normalizedKey);
    if (op === 'DELETE' && mode === 'lazy') {
      if (held) {
        // The null entry also keeps an older, in-flight read from caching the row
        engine.set(key, null);
      } else {
        // No entry: it would only take the place of the rows this instance reads
        this.members.delete(normalizedKey);
        engine.deleteShared(key);
      }
      return key;
    }
    if (op !== 'DELETE') {
      this.members.add(normalizedKey, key, engine.nextTicket());
    }
    if (!held) {
      // Nobody asked for this row here: no query, but other instances may have shared it
      engine.deleteShared(key);
    } else if (mode === 'eager' && this.takeEagerRefresh()) {
      await this.refreshInBatch(key);
    } else {
      // A change read from the changelog, or a notification beyond the eager budget
      engine.markInvalid(key);
    }
    return key;
  }

  /**
   * Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
   * discarded, and the copies of the shared level produced before are ignored. From the changelog
   * (`lazy`) the table is known to be empty; from a notification (`eager`), which anyone can send,
   * the next `getAll` loads the table again instead.
   *
   * @returns The keys that were cached.
   */
  private applyTruncate(mode: LilypadDbChangeMode): LilypadDbKey<V, PK>[] {
    const keys = [...this.engine.store.values()].map((entry) => entry.key);
    for (const key of keys) {
      this.engine.deleteShared(key);
    }
    this.forgetTable(mode === 'lazy');
    return keys;
  }

  /**
   * Expires every entry, discards the reads started before, ignores the older copies of the shared
   * level, and forgets the rows of the table. It also applies a change of too many rows to follow
   * them one by one (a `BULK` notification, or a read of the changelog with too many keys).
   *
   * @param empty - The table is known to be empty (a `TRUNCATE` read from the changelog); otherwise
   * the next `getAll` loads it again.
   */
  private forgetTable(empty: boolean) {
    this.engine.expireEverything();
    this.engine.rejectSharedBefore(Date.now());
    this.members.forget(this.engine.nextTicket(), empty);
  }

  /** Takes one key of the eager budget: `false` once the budget of this second is spent. */
  private takeEagerRefresh(): boolean {
    const now = Date.now();
    if (now - this.eagerWindow.start >= 1000) {
      this.eagerWindow = { start: now, count: 0 };
    }
    this.eagerWindow.count++;
    return this.eagerWindow.count <= EAGER_REFRESHES_PER_SECOND;
  }

  // ROWS OF THE TABLE

  /**
   * Loads every row of the table and replaces the content of the cache with them.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private async loadRows(signal: AbortSignal): Promise<Map<string, V>> {
    const { engine } = this;
    const read = engine.beginRead();
    const primaryKey = this.definition.primaryKey;
    const rows = new Map<string, V>();
    const entries: [LilypadDbKey<V, PK>, V][] = [];
    for (const row of await this.table.selectAll({ signal })) {
      const key = row[primaryKey] as LilypadDbKey<V, PK>;
      rows.set(engine.normalizeKey(key), row);
      entries.push([key, row]);
    }
    // After a timeout the caller already got an error, and a newer load may be running
    if (!signal.aborted && !engine.disposed) {
      this.members.replace(
        entries.map(([key]) => [engine.normalizeKey(key), key] as const),
        read.ticket,
        read.startedAt,
        (normalizedKey) => {
          const entry = engine.store.get(normalizedKey);
          return (
            entry !== undefined &&
            entry.ticket > read.ticket &&
            entry.value === null &&
            entry.origin !== 'fallback'
          );
        }
      );
      engine.replaceEntries(read, entries);
    }
    return rows;
  }

  /**
   * Loads the whole table, bounded by `bulkSync.timeout`. Concurrent calls share one load.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private loadTable(): Promise<Map<string, V>> {
    if (!this.tableLoad) {
      const loading: Promise<Map<string, V>> = this.loadFlowControl
        .executeWithTimeout((signal) => this.loadRows(signal))
        .catch((error: unknown) => {
          this.engine.log('error', 'Error loading the table:', error);
          throw error;
        })
        .finally(() => {
          if (this.tableLoad === loading) {
            this.tableLoad = undefined;
          }
        });
      this.tableLoad = loading;
    }
    return this.tableLoad;
  }

  /**
   * The keys whose entry is missing or expired (after renewing the entries still up to date). A
   * missing entry whose row was just loaded is not stale: `maxEntries` evicted it.
   */
  private staleKeys(keys: LilypadDbKey<V, PK>[], loaded?: Map<string, V>): LilypadDbKey<V, PK>[] {
    const now = Date.now();
    return keys.filter((key) => {
      const normalizedKey = this.engine.normalizeKey(key);
      this.renew(normalizedKey);
      const entry = this.engine.store.get(normalizedKey);
      if (!entry) {
        return !loaded?.has(normalizedKey);
      }
      return now >= entry.expirationTime;
    });
  }

  /**
   * Fetches rows by primary key and caches them in this instance only (`null` for the keys without
   * a row). A key already being fetched by a query that started after its last change shares that
   * query.
   *
   * @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
   * @throws If a query fails.
   */
  private async fetchRows(
    keys: LilypadDbKey<V, PK>[]
  ): Promise<Map<string, LilypadCachedValueType<V>>> {
    const { engine } = this;
    const pending = new Set<Promise<Map<string, LilypadCachedValueType<V>>>>();
    const toFetch = new Map<string, LilypadDbKey<V, PK>>();
    for (const key of keys) {
      const normalizedKey = engine.normalizeKey(key);
      // Not a query started before the last change of the key: it may return the old row
      const joined = this.rowFetches.join(normalizedKey, engine.currentTicket(normalizedKey));
      if (joined) {
        pending.add(joined);
      } else {
        toFetch.set(normalizedKey, key);
      }
    }
    if (toFetch.size > 0) {
      const read = engine.beginRead();
      const fetching = this.queryRows([...toFetch.values()], read);
      this.rowFetches.start(toFetch.keys(), read.ticket, fetching);
      pending.add(fetching);
    }
    const values = new Map<string, LilypadCachedValueType<V>>();
    for (const result of await Promise.all(pending)) {
      for (const [normalizedKey, value] of result) {
        values.set(normalizedKey, value);
      }
    }
    return values;
  }

  /**
   * Reads rows by primary key, bounded by `bulkSync.timeout`, and caches them (`null` for the keys
   * without a row).
   *
   * @param read - Started before the query: its ticket orders the rows among the writes.
   * @param shared - Whether the rows also go to the shared level (and end the failure cooldown of
   * their keys), as a fetch of `getOrFetch` does.
   */
  private async queryRows(
    keys: LilypadDbKey<V, PK>[],
    read: LilypadCacheRead<LilypadDbKey<V, PK>, V>,
    shared: boolean = false
  ): Promise<Map<string, LilypadCachedValueType<V>>> {
    const { engine } = this;
    const primaryKey = this.definition.primaryKey;
    try {
      return await this.loadFlowControl.executeWithTimeout(async (signal) => {
        const rows = new Map<string, V>();
        for (const row of await this.table.selectByPrimaryKeys(keys)) {
          rows.set(engine.normalizeKey(row[primaryKey] as LilypadDbKey<V, PK>), row);
        }
        const values = new Map<string, LilypadCachedValueType<V>>();
        for (const key of keys) {
          const normalizedKey = engine.normalizeKey(key);
          const row = rows.get(normalizedKey) ?? null;
          values.set(normalizedKey, row);
          if (!signal.aborted) {
            // The row keeps the key type of the database
            const storedKey = row ? (row[primaryKey] as LilypadDbKey<V, PK>) : key;
            if (shared) {
              read.storeFetched(storedKey, row);
            } else {
              read.store(storedKey, row);
            }
          }
        }
        return values;
      });
    } catch (error) {
      engine.log('error', 'Error fetching rows of the table:', error);
      throw error;
    }
  }

  /**
   * The rows of these keys, keyed as given, leaving out the keys without a row: the fresh entry,
   * else the value read by `sources` (in order), else the expired entry.
   */
  private rowsOf(
    keys: LilypadDbKey<V, PK>[],
    ...sources: Map<string, LilypadCachedValueType<V>>[]
  ): Map<LilypadDbKey<V, PK>, V> {
    const now = Date.now();
    const rows = new Map<LilypadDbKey<V, PK>, V>();
    for (const key of keys) {
      const normalizedKey = this.engine.normalizeKey(key);
      const entry = this.engine.store.get(normalizedKey);
      let value = entry && now < entry.expirationTime ? entry.value : undefined;
      for (const source of sources) {
        if (value !== undefined) {
          break;
        }
        value = source.get(normalizedKey);
      }
      value ??= entry?.value;
      if (value !== undefined && value !== null) {
        rows.set(key, value);
      }
    }
    return rows;
  }

  // READS

  /**
   * Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
   * memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
   */
  get(
    key: LilypadDbKey<V, PK>,
    options?: { removeExpired?: boolean }
  ): LilypadCachedValueType<V> | undefined {
    this.assertNotDisposed();
    this.renew(this.engine.normalizeKey(key));
    return this.engine.get(key, options);
  }

  /**
   * Tells whether the key is cached, and whether its row is up to date or expired, with no query.
   * Like `get`, it first renews an entry the sync keeps up to date.
   */
  peek(key: LilypadDbKey<V, PK>): LilypadCachePeek<V> {
    this.assertNotDisposed();
    this.renew(this.engine.normalizeKey(key));
    return this.engine.peek(key);
  }

  /**
   * Returns the row of the key, from the cache or else from the database. Concurrent calls for the
   * same key share a single query.
   *
   * @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
   * @returns The row, or `null` if it does not exist.
   * @throws If the query fails and `onError` gives no fallback value.
   */
  async getOrFetch(
    key: LilypadDbKey<V, PK>,
    options?: LilypadCacheGetOptions<LilypadDbKey<V, PK>, V>
  ): Promise<LilypadCachedValueType<V>> {
    return (await this.getOrFetchDetailed(key, options)).value;
  }

  /**
   * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
   * failed.
   */
  async getOrFetchDetailed(
    key: LilypadDbKey<V, PK>,
    options?: LilypadCacheGetOptions<LilypadDbKey<V, PK>, V>
  ): Promise<LilypadCacheResult<V>> {
    this.assertNotDisposed();
    // Awaited only when there is something to wait for: otherwise the fetch is registered
    // synchronously, so that a change applied right after this call sees it in flight
    const syncing = this.sync.beforeRead();
    if (syncing) {
      await syncing;
    }
    this.renew(this.engine.normalizeKey(key));
    return this.engine.getOrSetDetailed(key, () => this.table.selectByPrimaryKey(key), options);
  }

  /**
   * Fetches the row of the key from the database and caches it (`null` if it does not exist),
   * here and in the shared level. Concurrent calls share the query; a call made while a query is
   * running waits for one more query, which sees every change made before the call.
   * If a write that started later completes first, the fetched value is returned but not cached.
   *
   * @returns The row read from the database.
   * @throws If the query fails or exceeds `fetchTimeout`.
   */
  refresh(key: LilypadDbKey<V, PK>): Promise<LilypadCachedValueType<V>> {
    this.assertNotDisposed();
    const normalizedKey = this.engine.normalizeKey(key);
    let state = this.refreshes.get(normalizedKey);
    if (!state) {
      state = {};
      this.refreshes.set(normalizedKey, state);
    }
    if (state.queued) {
      return state.queued;
    }
    const current = state;
    const start = () => {
      const running = this.fetchRow(key);
      current.running = running;
      current.queued = undefined;
      const settle = () => {
        if (current.running === running) {
          current.running = undefined;
          if (!current.queued) {
            this.refreshes.delete(normalizedKey);
          }
        }
      };
      void running.then(settle, settle);
      return running;
    };
    if (!current.running) {
      return start();
    }
    // The running query may have read the row before the change the caller wants to see
    const noop = () => {};
    current.queued = current.running.then(noop, noop).then(start);
    return current.queued;
  }

  private fetchRow(key: LilypadDbKey<V, PK>): Promise<LilypadCachedValueType<V>> {
    return this.engine.flowControl.executeWithTimeout(async (signal) => {
      const read = this.engine.beginRead();
      const value = await this.table.selectByPrimaryKey(key);
      if (!signal.aborted) {
        read.storeFetched(key, value);
      }
      return value;
    });
  }

  /**
   * Re-reads a key after a notification, together with the other keys notified meanwhile: a change
   * of many rows notifies each of them, and one query per row would flood the pool. The batch is
   * sent once the notifications received together have been handled (a microtask later). The keys
   * of a failed query are expired instead.
   *
   * The query of a batch starts after the notifications of its keys: it sees their changes, even
   * when an older read of the key is still running.
   */
  private refreshInBatch(key: LilypadDbKey<V, PK>): Promise<void> {
    let batch = this.eagerBatch;
    if (!batch) {
      const keys = new Map<string, LilypadDbKey<V, PK>>();
      const done = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (this.eagerBatch?.keys === keys) {
            this.eagerBatch = undefined;
          }
          resolve(this.runEagerBatch(keys));
        });
      });
      batch = { keys, done };
      this.eagerBatch = batch;
    }
    const normalizedKey = this.engine.normalizeKey(key);
    if (!batch.keys.has(normalizedKey)) {
      batch.keys.set(normalizedKey, key);
      this.eagerReads.set(normalizedKey, (this.eagerReads.get(normalizedKey) ?? 0) + 1);
    }
    return batch.done;
  }

  private async runEagerBatch(keys: Map<string, LilypadDbKey<V, PK>>): Promise<void> {
    try {
      if (!this.engine.disposed) {
        await this.queryRows([...keys.values()], this.engine.beginRead(), true);
      }
    } catch {
      // Logged by queryRows: the next read of these keys fetches them
      if (!this.engine.disposed) {
        for (const key of keys.values()) {
          this.engine.markInvalid(key);
        }
      }
    } finally {
      for (const normalizedKey of keys.keys()) {
        const count = (this.eagerReads.get(normalizedKey) ?? 1) - 1;
        if (count > 0) {
          this.eagerReads.set(normalizedKey, count);
        } else {
          this.eagerReads.delete(normalizedKey);
        }
      }
    }
  }

  /**
   * Returns every row of the table, or the rows of `keys`, keyed by primary key (the keys without a
   * row are left out).
   *
   * The whole table is loaded once (again after the sync lost changes, or, with the `none`
   * strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
   * queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
   * are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level. With
   * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
   * again at each call.
   *
   * @throws If the rows cannot be loaded.
   */
  async getAll(keys?: LilypadDbKey<V, PK>[]): Promise<Map<LilypadDbKey<V, PK>, V>> {
    this.assertNotDisposed();
    const syncing = this.sync.beforeRead();
    if (syncing) {
      await syncing;
    }
    if (keys) {
      const uniqueKeys = [
        ...new Map(keys.map((key) => [this.engine.normalizeKey(key), key])).values(),
      ];
      const fetched = await this.fetchRows(this.staleKeys(uniqueKeys));
      return this.rowsOf(uniqueKeys, fetched);
    }
    let loaded: Map<string, V> | undefined;
    if (!this.members.isLoaded(this.sync.trustedSince(), this.loadTtl)) {
      loaded = await this.loadTable();
    }
    let staleKeys = this.staleKeys(this.members.keys(), loaded);
    if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
      loaded = await this.loadTable();
      staleKeys = this.staleKeys(this.members.keys(), loaded);
    }
    // Also the rows changed while the table was loading
    const fetched = await this.fetchRows(staleKeys);
    return this.rowsOf(this.members.keys(), fetched, loaded ?? new Map<string, V>());
  }

  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the primary key holds numbers (declared as a
   * `number` column, or seen in the rows read).
   */
  private resolveNotifiedKey(id: string | number): LilypadDbKey<V, PK> {
    const normalizedKey = String(id);
    const known = this.engine.store.get(normalizedKey)?.key ?? this.members.keyOf(normalizedKey);
    if (known !== undefined) {
      return known;
    }
    if (typeof id === 'string' && this.numericPrimaryKey) {
      const numeric = Number(id);
      // Only when the conversion is exact (not e.g. a bigint beyond 2^53)
      if (Number.isFinite(numeric) && String(numeric) === id) {
        return numeric as LilypadDbKey<V, PK>;
      }
    }
    return id as LilypadDbKey<V, PK>;
  }

  // INVALIDATION AND REMOVAL

  /**
   * Invalidates the entry of the key: it is no longer returned, not even as a stale value (but it
   * stays a fallback for `onError: { fallback: 'stale' }`), a fetch already in flight is not
   * cached, the key is removed from the shared level, and `platform.onInvalidate` receives a
   * `manual` event.
   */
  invalidate(key: LilypadDbKey<V, PK>): void {
    this.assertNotDisposed();
    this.engine.invalidate(key);
  }

  /**
   * Deletes the key from the cache (not from the table), and from the shared level.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key: LilypadDbKey<V, PK>, options?: { force?: boolean }): boolean {
    this.assertNotDisposed();
    return this.engine.delete(key, options);
  }

  /**
   * Removes all entries from the memory of this instance (not from the shared level). Protected
   * keys are kept, unless `force` is set.
   */
  clear(options?: { force?: boolean }): void {
    this.assertNotDisposed();
    this.engine.clear(options);
  }

  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window.
   *
   * @param options.force - If true, also removes the expired protected keys.
   */
  purgeExpired(options?: { force?: boolean }): void {
    this.assertNotDisposed();
    this.engine.purgeExpired(options);
  }

  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   */
  addProtectedKeys(keys: LilypadDbKey<V, PK>[]): this {
    this.assertNotDisposed();
    this.engine.addProtectedKeys(keys);
    return this;
  }

  /** @returns The cache, for chaining. */
  removeProtectedKeys(keys: LilypadDbKey<V, PK>[]): this {
    this.assertNotDisposed();
    this.engine.removeProtectedKeys(keys);
    return this;
  }

  /**
   * Disposes of the cache: stops its database listener and its changelog reads, removes it from
   * the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
   * starting is awaited, so that its listener is removed too. Every call returns the same promise.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.disposeResources();
    return this.disposing;
  }

  private async disposeResources(): Promise<void> {
    this.releaseSingleton();
    this.engine.dispose();
    this.members.clear();
    this.ownWrites.clear();
    await this.sync.dispose();
  }

  /** `await using cache = ...` disposes of the cache at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  // WRITES

  private getItemPrimaryKeyValue(item: Partial<V>): LilypadDbKey<V, PK> {
    const keyValue = item[this.definition.primaryKey];
    if (keyValue === undefined) {
      throw new LilypadDbMissingPrimaryKeyError(this.definition, 'item');
    }
    return keyValue as LilypadDbKey<V, PK>;
  }

  /**
   * Caches the row returned by a write of this instance, and remembers the write, so that its
   * change is not applied again when it comes back through the sync.
   * If the entry changed while the write was running (a change applied meanwhile, or a fetch that
   * may have read the row before the write), it is expired instead: the next read fetches the row.
   *
   * @param startTicket - A ticket taken before the write.
   * @param xid - The transaction of the write, if it changed a row.
   */
  private storeWritten(
    key: LilypadDbKey<V, PK>,
    value: LilypadCachedValueType<V>,
    startTicket: number,
    xid: bigint | undefined
  ) {
    const { engine } = this;
    if (engine.disposed) {
      return;
    }
    const normalizedKey = engine.normalizeKey(key);
    const entry = engine.store.get(normalizedKey);
    if (entry && entry.ticket > startTicket) {
      engine.markInvalid(key);
      return;
    }
    engine.set(key, value);
    const stored = engine.store.get(normalizedKey);
    if (xid !== undefined && stored && this.sync.seesOwnWrites) {
      this.ownWrites.record(normalizedKey, xid, stored.ticket);
    }
  }

  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `generatedPrimaryKey`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the `select` hook of the table discards it. A row
   * that the `select` hook returns without its primary key is returned, but not cached.
   */
  async sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null> {
    this.assertNotDisposed();
    const startTicket = this.engine.nextTicket();
    const { row, xid } = await this.table.insert(item);
    if (row === null) {
      return row;
    }
    const key = row[this.definition.primaryKey] as LilypadDbKey<V, PK> | undefined;
    if (key === undefined) {
      // The row is inserted: failing now would make the caller insert it again
      this.engine.log(
        'warn',
        `The row created in "${this.definition.tableName}" has no primary key "${String(this.definition.primaryKey)}" after its select hook: it is not cached.`
      );
      return row;
    }
    this.storeWritten(key, row, startTicket, xid);
    this.engine.emitInvalidation('write', [key]);
    return row;
  }

  /**
   * Updates the item in the database and caches the row returned by the database.
   * Only the columns present in `item` are written.
   *
   * @returns The updated row, or `null` if the `select` hook of the table discards it.
   * @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
   */
  async sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null> {
    this.assertNotDisposed();
    const key = this.getItemPrimaryKeyValue(item);
    const startTicket = this.engine.nextTicket();
    const { row, xid } = await this.table.update(item);
    this.storeWritten(key, row, startTicket, xid);
    this.engine.emitInvalidation('write', [key]);
    return row;
  }

  /**
   * Deletes the row in the database, and caches the key as `null` (also for a protected key).
   *
   * @returns `true` if a row had this key, `false` if there was none (the key is cached as `null`
   * either way).
   */
  async sqlDelete(key: LilypadDbKey<V, PK>): Promise<boolean> {
    this.assertNotDisposed();
    const startTicket = this.engine.nextTicket();
    const { deleted, xid } = await this.table.delete(key);
    this.storeWritten(key, null, startTicket, xid);
    this.engine.emitInvalidation('write', [key]);
    return deleted;
  }
}
