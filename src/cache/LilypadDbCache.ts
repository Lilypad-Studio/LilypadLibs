import { DEFAULT_MAX_GAP, LilypadChangelogSync } from '@/cache/dbSync/LilypadChangelogSync';
import {
  lilypadNoSync,
  type LilypadDbCacheSync,
  type LilypadDbChangeMode,
  type LilypadDbRowChange,
  type LilypadDbSyncHost,
  type LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import { LilypadListenSync } from '@/cache/dbSync/LilypadListenSync';
import { LilypadSchemaVerifier } from '@/cache/dbSync/LilypadSchemaVerifier';
import { LilypadCacheCore } from '@/cache/LilypadCacheCore';
import type {
  LilypadCacheBulkSyncOptions,
  LilypadCachedValueType,
  LilypadCacheEntry,
  LilypadCacheGetOptions,
  LilypadCacheKey,
  LilypadCacheOptions,
  LilypadCachePeek,
  LilypadCacheResult,
} from '@/cache/LilypadCacheTypes';
import { lilypadCursorCovers, type LilypadChangelogCursor } from '@/dbGate/LilypadChangelog';
import {
  lilypadMissingPrimaryKeyError,
  type LilypadDbGate,
  type LilypadDbInsertData,
  type LilypadDbSchema,
  type LilypadDbUpdateData,
} from '@/dbGate/LilypadDbGate';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog } from '@/logger/LilypadLibLogger';
import {
  createLilypadSingletonAbleAsync,
  type LilypadSingletonAble,
  type LilypadSingletonRelease,
} from '@/singleton/LilypadSingleton';

export type {
  LilypadDbCacheChangelogSync,
  LilypadDbCacheListenSync,
  LilypadDbCacheSchemaVerification,
  LilypadDbCacheSync,
  LilypadDbCacheTrustedSyncOptions,
  LilypadDbNotification,
} from '@/cache/dbSync/LilypadDbSyncTypes';

/** The key type of a table: the type of its primary key column. */
export type LilypadDbKey<V, PK extends keyof V> = V[PK] & LilypadCacheKey;

export type LilypadDbCacheOptions<V extends object, PK extends keyof V = keyof V> = Omit<
  LilypadCacheOptions<LilypadDbKey<V, PK>, V>,
  'bulkSync'
> & {
  gate: LilypadDbGate;
  schema: LilypadDbSchema<V, PK>;
  /** Defaults to `{ strategy: 'listen' }`. */
  sync?: LilypadDbCacheSync;
  /**
   * Loading the whole table (`getAll`): `timeout` bounds each load and each query by primary keys
   * (defaults to 30 seconds); with the `none` strategy, a load stays valid for `ttl` (defaults to
   * the TTL).
   */
  bulkSync?: Omit<LilypadCacheBulkSyncOptions<LilypadDbKey<V, PK>, V>, 'fn'>;
};

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = 0.25;
/** How long the writes of this instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 10 * 60 * 1000;

/**
 * A cache of the rows of one table, kept up to date with the changes made elsewhere.
 *
 * Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
 * table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
 * `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
 * from the table could be kept past its TTL as if it did.
 *
 * @typeParam V - The row type.
 * @typeParam PK - The primary key column; the keys of the cache are its values.
 *
 * @example
 * ```typescript
 * const users = await LilypadDbCache.create({ ttl: 60_000, gate, schema: usersSchema, logger });
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
export class LilypadDbCache<
  V extends object,
  PK extends keyof V = keyof V,
  K extends LilypadDbKey<V, PK> = LilypadDbKey<V, PK>,
> extends LilypadCacheCore<K, V> {
  private readonly gate: LilypadDbGate;
  private readonly schema: LilypadDbSchema<V, PK>;
  private readonly sync: LilypadDbSyncStrategy;
  private readonly maxAge: number;
  private readonly verifier: LilypadSchemaVerifier;
  private releaseSingleton: LilypadSingletonRelease = () => {};
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  private tableSchema?: string;

  /**
   * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
   * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
   * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
   */
  private members = new Map<string, { key: K; ticket: number }>();
  /** When the last load of the table started, if one completed (and nothing voided it since). */
  private membersLoadedAt?: number;
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  private membersFloor = 0;
  /** The load of the whole table in flight, shared by concurrent callers. */
  private tableLoad?: Promise<Map<string, V>>;
  /** The queries of `fetchRows` in flight, by normalized key. */
  private rowFetches = new Map<string, Promise<Map<string, LilypadCachedValueType<V>>>>();
  /** The keys to re-read after a notification, gathered into one query (see `refreshInBatch`). */
  private eagerBatch?: { keys: Map<string, K>; done: Promise<void> };
  /** The keys of the batches of `refreshInBatch` pending or running, with their number. */
  private eagerReads = new Map<string, number>();
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  private refreshes = new Map<
    string,
    {
      running?: Promise<LilypadCachedValueType<V>>;
      queued?: Promise<LilypadCachedValueType<V>>;
    }
  >();
  /**
   * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
   * entry the last one stored. While the entry holds it, the changes of these writes are already
   * reflected in it.
   */
  private ownWrites = new Map<string, { ticket: number; xids: Set<bigint>; at: number }>();

  /**
   * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
   * database listener. The row type and the primary key are inferred from `schema`.
   * With `singleton: true`, a later call with the same identifier returns the existing cache and
   * ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * @throws If the database listener cannot be registered (e.g. the database is unreachable), or,
   * with `verify: 'throw'`, if the database is not set up.
   */
  public static async create<V extends object, PK extends keyof V = keyof V>(
    options: LilypadDbCacheOptions<V, PK> & LilypadSingletonAble
  ): Promise<LilypadDbCache<V, PK>> {
    return createLilypadSingletonAbleAsync(
      'LilypadDbCache',
      options,
      async (release) => {
        const cache = new LilypadDbCache<V, PK>(options);
        try {
          if (cache.verifier.mode === 'throw') {
            await cache.verifier.verify();
          }
          await cache.sync.start();
        } catch (error) {
          await cache.dispose();
          throw error;
        }
        cache.releaseSingleton = release;
        return cache;
      },
      {
        value: JSON.stringify([options.schema.tableName, options.ttl]),
        onMismatch: () =>
          libLog(
            options.logger,
            'warn',
            'LilypadDbCache',
            `Singleton "${options.singleton ? options.singletonIdentifier : ''}" already exists with a different table or TTL: the new options are ignored.`
          ),
      }
    );
  }

  private constructor(options: LilypadDbCacheOptions<V, PK>) {
    const { gate, schema, sync = { strategy: 'listen' }, bulkSync, ...cacheOptions } = options;
    super({ ...cacheOptions, bulkSync, name: options.name ?? schema.tableName });
    const owner = 'LilypadDbCache';
    if (sync.strategy !== 'none') {
      assertNumberOption(owner, 'sync.maxAge', sync.maxAge, 'non-negative');
    }
    if (sync.strategy === 'changelog') {
      assertNumberOption(owner, 'sync.pollInterval', sync.pollInterval, 'non-negative');
      assertNumberOption(owner, 'sync.maxGap', sync.maxGap, 'positive');
      assertNumberOption(owner, 'sync.lookback', sync.lookback, 'non-negative');
      if (typeof sync.pollInterval !== 'number') {
        throw new Error(`${owner}: sync.pollInterval is required with the changelog strategy.`);
      }
    }

    this.gate = gate;
    this.schema = schema;
    this.maxAge = sync.strategy === 'none' ? 0 : (sync.maxAge ?? DEFAULT_MAX_AGE);
    const tableNameParts = schema.tableName.split('.');
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }

    this.verifier = new LilypadSchemaVerifier({
      gate,
      tableName: schema.tableName,
      primaryKey: String(schema.primaryKey),
      strategy: sync.strategy,
      changelogTable: sync.strategy === 'changelog' ? sync.table : undefined,
      pruning: sync.strategy === 'changelog' ? sync.pruning : undefined,
      // A changelog read needs every row since the last read (maxGap) or of the lookback
      minRetention:
        sync.strategy === 'changelog'
          ? Math.max(sync.maxGap ?? DEFAULT_MAX_GAP, sync.lookback ?? this.defaultLookback())
          : undefined,
      mode: sync.strategy === 'none' ? 'off' : (sync.verify ?? 'warn'),
      platform: this.platform,
      log: (level, ...message) => libLog(this.logger, level, this.name, ...message),
      canWarn: () => this.logger?.warn !== undefined,
      onSchema: (resolved) => {
        this.tableSchema = resolved;
      },
    });
    const host = this.syncHost();
    this.sync =
      sync.strategy === 'listen'
        ? new LilypadListenSync(host, sync, this.verifier)
        : sync.strategy === 'changelog'
          ? new LilypadChangelogSync(host, sync, this.verifier)
          : lilypadNoSync;

    libLog(
      this.logger,
      'debug',
      this.name,
      `LilypadDbCache initialized for table "${schema.tableName}" (sync: ${sync.strategy})`
    );
  }

  /** What the sync strategy may use of this cache. */
  private syncHost(): LilypadDbSyncHost<K> {
    return {
      id: this.id,
      name: this.name,
      gate: this.gate,
      tableName: this.schema.tableName,
      platform: this.platform,
      log: (level, ...message) => libLog(this.logger, level, this.name, ...message),
      isDisposed: () => this.disposed,
      applyChange: (op, id, mode, xid) => this.applyChange(op, id, mode, xid),
      applyTruncate: (mode) => this.applyTruncate(mode),
      expireEverything: () => this.expireEverything(),
      emitInvalidation: (source, keys, options) => this.emitInvalidation(source, keys, options),
      forgetOwnWritesCoveredBy: (cursor) => this.forgetOwnWritesCoveredBy(cursor),
      tableSchema: () => this.tableSchema,
      defaultLookback: () => this.defaultLookback(),
    };
  }

  /** The default `lookback` of the changelog: the lifetime of a shared copy, plus 1 minute. */
  private defaultLookback(): number {
    return this.defaultTtl + this.defaultStaleWhileRevalidate + 60_000;
  }

  /**
   * Loads every row of the table and replaces the content of the cache with them.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private async loadRows(signal: AbortSignal): Promise<Map<string, V>> {
    const read = this.beginRead();
    const primaryKey = this.schema.primaryKey;
    const entries = (await this.gate.selectAllFromTable<V, PK>(this.schema, { signal })).map(
      (row): [K, V] => [row[primaryKey] as K, row]
    );
    // After a timeout the caller already got an error, and a newer load may be running
    if (!signal.aborted && !this.disposed) {
      this.replaceMembers(entries, read.ticket, read.startedAt);
      this.replaceEntries(read, entries);
    }
    return new Map(entries.map(([key, row]) => [this.normalizeKey(key), row]));
  }

  // TRUST AND RENEWAL

  /**
   * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
   * value was read from the database (or written by this instance) after the sync became trusted,
   * and any change of its row since would have expired it. It is kept until `maxAge`.
   */
  private renew(normalizedKey: string) {
    const entry = this.store.get(normalizedKey);
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
    this.store.set(normalizedKey, {
      ...entry,
      expirationTime: Math.min(now + this.defaultTtl, entry.fetchedAt + this.maxAge),
    });
  }

  // CHANGES MADE ELSEWHERE

  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - A change of a key held (or being read) by this instance: `eager` re-fetches it at once
   *   (with the other keys notified meanwhile, in one query); `lazy` expires it with no query,
   *   which also discards a read in flight (it may predate the change): the next read fetches
   *   it. A `lazy` DELETE caches the key as `null` at once.
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
  ): Promise<K> {
    const key = this.resolveNotifiedKey(id);
    if (xid !== undefined && this.isOwnWrite(key, xid)) {
      return key;
    }
    const normalizedKey = this.normalizeKey(key);
    const held = this.store.has(normalizedKey) || this.hasReadInFlight(normalizedKey);
    if (op === 'DELETE' && mode === 'lazy') {
      if (held) {
        // The null entry also keeps an older, in-flight read from caching the row
        this.markDeleted(key);
      } else {
        // No entry: it would only take the place of the rows this instance reads
        this.members.delete(normalizedKey);
        this.deleteShared(key);
      }
      return key;
    }
    if (op !== 'DELETE') {
      this.addMember(key);
    }
    if (!held) {
      // Nobody asked for this row here: no query, but other instances may have shared it
      this.deleteShared(key);
    } else if (mode === 'eager') {
      await this.refreshInBatch(key);
    } else {
      this.markInvalid(key);
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
  private applyTruncate(mode: LilypadDbChangeMode): K[] {
    const keys = [...this.store.values()].map((entry) => entry.key);
    for (const key of keys) {
      this.deleteShared(key);
    }
    this.expireEverything();
    this.rejectSharedBefore(Date.now());
    this.membersFloor = this.nextTicket();
    this.members.clear();
    if (mode === 'eager') {
      this.membersLoadedAt = undefined;
    }
    return keys;
  }

  /**
   * Whether a change is the one of a write of this instance, and the entry still holds the result
   * of the last write of this instance (nothing else replaced it since): that result is at least
   * as recent as the change. The write is forgotten either way.
   */
  private isOwnWrite(key: K, xid: bigint): boolean {
    const normalizedKey = this.normalizeKey(key);
    const own = this.ownWrites.get(normalizedKey);
    if (!own?.xids.delete(xid)) {
      return false;
    }
    if (own.xids.size === 0) {
      this.ownWrites.delete(normalizedKey);
    }
    return this.store.get(normalizedKey)?.ticket === own.ticket;
  }

  private recordOwnWrite(normalizedKey: string, xid: bigint, ticket: number) {
    const now = Date.now();
    // In the order of the last write, so the oldest come first
    for (const [key, own] of this.ownWrites) {
      if (now - own.at <= OWN_WRITE_RETENTION) {
        break;
      }
      this.ownWrites.delete(key);
    }
    const xids = this.ownWrites.get(normalizedKey)?.xids ?? new Set<bigint>();
    xids.add(xid);
    this.ownWrites.delete(normalizedKey);
    this.ownWrites.set(normalizedKey, { ticket, xids, at: now });
  }

  /** Forgets the own writes whose changes a read from this cursor no longer returns. */
  private forgetOwnWritesCoveredBy(cursor: LilypadChangelogCursor) {
    for (const [normalizedKey, own] of this.ownWrites) {
      for (const xid of own.xids) {
        if (lilypadCursorCovers(cursor, xid)) {
          own.xids.delete(xid);
        }
      }
      if (own.xids.size === 0) {
        this.ownWrites.delete(normalizedKey);
      }
    }
  }

  // ROWS OF THE TABLE

  /** Follows the values stored in the cache: a row is a row of the table, `null` is not. */
  protected override onValueStored(entry: LilypadCacheEntry<K, V>): void {
    // A fallback value after an error says nothing about the table
    if (this.membersLoadedAt === undefined || entry.origin === 'fallback') {
      return;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    const member = this.members.get(normalizedKey);
    if (member && member.ticket > entry.ticket) {
      return;
    }
    if (entry.value === null) {
      this.members.delete(normalizedKey);
    } else {
      this.members.set(normalizedKey, { key: entry.key, ticket: entry.ticket });
    }
  }

  /** Notes a row that exists in the table, without fetching it. */
  private addMember(key: K) {
    if (this.membersLoadedAt !== undefined) {
      this.members.set(this.normalizeKey(key), { key, ticket: this.nextTicket() });
    }
  }

  /**
   * Replaces the rows of the table with the result of a load, keeping what changed after the load
   * started: rows added since, rows deleted since.
   */
  private replaceMembers(entries: [K, V][], ticket: number, startedAt: number) {
    if (ticket < this.membersFloor) {
      return;
    }
    const members = new Map<string, { key: K; ticket: number }>();
    for (const [key] of entries) {
      const normalizedKey = this.normalizeKey(key);
      const entry = this.store.get(normalizedKey);
      if (entry && entry.ticket > ticket && entry.value === null && entry.origin !== 'fallback') {
        continue;
      }
      const member = this.members.get(normalizedKey);
      members.set(normalizedKey, member && member.ticket > ticket ? member : { key, ticket });
    }
    for (const [normalizedKey, member] of this.members) {
      if (member.ticket > ticket && !members.has(normalizedKey)) {
        members.set(normalizedKey, member);
      }
    }
    this.members = members;
    this.membersLoadedAt = startedAt;
  }

  /**
   * Whether the rows of the table are known: loaded since the sync became trusted, or, without a
   * trusted sync, less than `bulkSync.ttl` ago.
   */
  private isTableLoaded(): boolean {
    if (this.membersLoadedAt === undefined) {
      return false;
    }
    const trustedSince = this.sync.trustedSince();
    if (trustedSince !== undefined && this.membersLoadedAt >= trustedSince) {
      return true;
    }
    return Date.now() < this.membersLoadedAt + this.bulkSyncTtl;
  }

  /**
   * Loads the whole table, bounded by `bulkSync.timeout`. Concurrent calls share one load.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private loadTable(): Promise<Map<string, V>> {
    if (!this.tableLoad) {
      const loading: Promise<Map<string, V>> = this.bulkSyncFlowControl
        .executeWithTimeout((signal) => this.loadRows(signal))
        .catch((error: unknown) => {
          libLog(this.logger, 'error', this.name, 'Error loading the table: ', error);
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
  private staleKeys(keys: K[], loaded?: Map<string, V>): K[] {
    const now = Date.now();
    return keys.filter((key) => {
      const normalizedKey = this.normalizeKey(key);
      this.renew(normalizedKey);
      const entry = this.store.get(normalizedKey);
      if (!entry) {
        return !loaded?.has(normalizedKey);
      }
      return now >= entry.expirationTime;
    });
  }

  /**
   * Fetches rows by primary key and caches them in this instance only (`null` for the keys without
   * a row). A key already being fetched shares that query.
   *
   * @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
   * @throws If a query fails.
   */
  private async fetchRows(keys: K[]): Promise<Map<string, LilypadCachedValueType<V>>> {
    const pending = new Set<Promise<Map<string, LilypadCachedValueType<V>>>>();
    const toFetch = new Map<string, K>();
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      const inFlight = this.rowFetches.get(normalizedKey);
      if (inFlight) {
        pending.add(inFlight);
      } else {
        toFetch.set(normalizedKey, key);
      }
    }
    if (toFetch.size > 0) {
      const fetching = this.queryRows([...toFetch.values()]);
      for (const normalizedKey of toFetch.keys()) {
        this.rowFetches.set(normalizedKey, fetching);
      }
      const cleanup = () => {
        for (const normalizedKey of toFetch.keys()) {
          if (this.rowFetches.get(normalizedKey) === fetching) {
            this.rowFetches.delete(normalizedKey);
          }
        }
      };
      void fetching.then(cleanup, cleanup);
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
   * @param shared - Whether the rows also go to the shared level (and end the failure cooldown of
   * their keys), as a fetch of `getOrFetch` does.
   */
  private async queryRows(
    keys: K[],
    shared: boolean = false
  ): Promise<Map<string, LilypadCachedValueType<V>>> {
    const primaryKey = this.schema.primaryKey;
    try {
      return await this.bulkSyncFlowControl.executeWithTimeout(async (signal) => {
        const read = this.beginRead();
        const rows = new Map<string, V>();
        for (const row of await this.gate.selectFromTableByPrimaryKeys<V, PK>(this.schema, keys)) {
          rows.set(this.normalizeKey(row[primaryKey] as K), row);
        }
        const values = new Map<string, LilypadCachedValueType<V>>();
        for (const key of keys) {
          const normalizedKey = this.normalizeKey(key);
          const row = rows.get(normalizedKey) ?? null;
          values.set(normalizedKey, row);
          if (!signal.aborted) {
            // The row keeps the key type of the database
            const storedKey = row ? (row[primaryKey] as K) : key;
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
      libLog(this.logger, 'error', this.name, 'Error fetching rows of the table: ', error);
      throw error;
    }
  }

  /**
   * The rows of these keys, leaving out the keys without a row: the fresh entry, else the value
   * read by `sources` (in order), else the expired entry.
   */
  private rowsOf(keys: K[], ...sources: Map<string, LilypadCachedValueType<V>>[]): V[] {
    const now = Date.now();
    const rows: V[] = [];
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      const entry = this.store.get(normalizedKey);
      let value = entry && now < entry.expirationTime ? entry.value : undefined;
      for (const source of sources) {
        if (value !== undefined) {
          break;
        }
        value = source.get(normalizedKey);
      }
      value ??= entry?.value;
      if (value !== undefined && value !== null) {
        rows.push(value);
      }
    }
    return rows;
  }

  private memberKeys(): K[] {
    return [...this.members.values()].map((member) => member.key);
  }

  // READS

  /**
   * Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
   * memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
   *
   * @throws If the cache is disposed.
   */
  override get(
    key: K,
    options: { removeExpired?: boolean } = {}
  ): LilypadCachedValueType<V> | undefined {
    this.assertNotDisposed();
    this.renew(this.normalizeKey(key));
    return super.get(key, options);
  }

  /**
   * Tells whether the key is cached, and whether its row is up to date or expired, with no query.
   * Like `get`, it first renews an entry the sync keeps up to date.
   *
   * @throws If the cache is disposed.
   */
  override peek(key: K): LilypadCachePeek<V> {
    this.assertNotDisposed();
    this.renew(this.normalizeKey(key));
    return super.peek(key);
  }

  /**
   * Returns the row of the key, from the cache or else from the database. Concurrent calls for the
   * same key share a single query.
   *
   * @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
   * @returns The row, or `null` if it does not exist.
   * @throws If the query fails and `onError` gives no fallback value, or if the cache is disposed.
   */
  async getOrFetch(
    key: K,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V>> {
    return (await this.getOrFetchDetailed(key, options)).value;
  }

  /**
   * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
   * failed.
   */
  async getOrFetchDetailed(
    key: K,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    this.assertNotDisposed();
    // Awaited only when there is something to wait for: otherwise the fetch is registered
    // synchronously, so that a change applied right after this call sees it in flight
    const syncing = this.sync.beforeRead();
    if (syncing) {
      await syncing;
    }
    this.renew(this.normalizeKey(key));
    return this.getOrSetDetailed(
      key,
      () => this.gate.selectFromTableByPrimaryKey<V, PK>(this.schema, key),
      options
    );
  }

  /**
   * Fetches the row of the key from the database and caches it (`null` if it does not exist),
   * here and in the shared level. Concurrent calls share the query; a call made while a query is
   * running waits for one more query, which sees every change made before the call.
   * If a write that started later completes first, the fetched value is returned but not cached.
   *
   * @returns The row read from the database.
   * @throws If the query fails or exceeds `fetchTimeout`, or if the cache is disposed.
   */
  refresh(key: K): Promise<LilypadCachedValueType<V>> {
    this.assertNotDisposed();
    return this.refreshRow(key);
  }

  private refreshRow(key: K): Promise<LilypadCachedValueType<V>> {
    const normalizedKey = this.normalizeKey(key);
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

  private fetchRow(key: K): Promise<LilypadCachedValueType<V>> {
    return this.flowControl.executeWithTimeout(async (signal) => {
      const read = this.beginRead();
      const value = await this.gate.selectFromTableByPrimaryKey<V, PK>(this.schema, key);
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
  private refreshInBatch(key: K): Promise<void> {
    let batch = this.eagerBatch;
    if (!batch) {
      const keys = new Map<string, K>();
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
    const normalizedKey = this.normalizeKey(key);
    if (!batch.keys.has(normalizedKey)) {
      batch.keys.set(normalizedKey, key);
      this.eagerReads.set(normalizedKey, (this.eagerReads.get(normalizedKey) ?? 0) + 1);
    }
    return batch.done;
  }

  private async runEagerBatch(keys: Map<string, K>): Promise<void> {
    try {
      if (!this.disposed) {
        await this.queryRows([...keys.values()], true);
      }
    } catch {
      // Logged by queryRows: the next read of these keys fetches them
      if (!this.disposed) {
        for (const key of keys.values()) {
          this.markInvalid(key);
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

  protected override hasReadInFlight(normalizedKey: string): boolean {
    return (
      super.hasReadInFlight(normalizedKey) ||
      this.rowFetches.has(normalizedKey) ||
      this.refreshes.has(normalizedKey) ||
      this.eagerReads.has(normalizedKey)
    );
  }

  /**
   * Returns every row of the table, or the rows of `keys`.
   *
   * The whole table is loaded once (again after the sync lost changes, or, with the `none`
   * strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
   * queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
   * are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level. With
   * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
   * again at each call.
   *
   * @throws If the rows cannot be loaded, or the cache is disposed.
   */
  async getAll(keys?: K[]): Promise<V[]> {
    this.assertNotDisposed();
    const syncing = this.sync.beforeRead();
    if (syncing) {
      await syncing;
    }
    if (keys) {
      const uniqueKeys = [...new Map(keys.map((key) => [this.normalizeKey(key), key])).values()];
      const fetched = await this.fetchRows(this.staleKeys(uniqueKeys));
      return this.rowsOf(uniqueKeys, fetched);
    }
    let loaded: Map<string, V> | undefined;
    if (!this.isTableLoaded()) {
      loaded = await this.loadTable();
    }
    let staleKeys = this.staleKeys(this.memberKeys(), loaded);
    if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
      loaded = await this.loadTable();
      staleKeys = this.staleKeys(this.memberKeys(), loaded);
    }
    // Also the rows changed while the table was loading
    const fetched = await this.fetchRows(staleKeys);
    return this.rowsOf(this.memberKeys(), fetched, loaded ?? new Map<string, V>());
  }

  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the schema declares the primary key as a
   * `number` column.
   */
  private resolveNotifiedKey(id: string | number): K {
    const normalizedKey = String(id);
    const known = this.store.get(normalizedKey)?.key ?? this.members.get(normalizedKey)?.key;
    if (known !== undefined) {
      return known;
    }
    const { cols, primaryKey } = this.schema;
    if (typeof id === 'string' && cols[primaryKey]?.type === 'number') {
      const numeric = Number(id);
      // Only when the conversion is exact (not e.g. a bigint beyond 2^53)
      if (Number.isFinite(numeric) && String(numeric) === id) {
        return numeric as K;
      }
    }
    return id as K;
  }

  /**
   * Caches the key as "does not exist", here and in the shared level. It also applies to protected
   * keys: they are protected from removal, not from reflecting a deleted row.
   */
  private markDeleted(key: K) {
    this.setValue(key, null);
  }

  /**
   * Disposes of the cache: stops its database listener and its changelog reads, removes it from
   * the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
   * starting is awaited, so that its listener is removed too.
   */
  override async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.releaseSingleton();
    await super.dispose();
    this.members.clear();
    this.ownWrites.clear();
    await this.sync.dispose();
  }

  // WRITES

  private getItemPrimaryKeyValue(item: Partial<V>): K {
    const keyValue = item[this.schema.primaryKey];
    if (keyValue === undefined) {
      throw lilypadMissingPrimaryKeyError(this.schema, 'item');
    }
    return keyValue as K;
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
    key: K,
    value: LilypadCachedValueType<V>,
    startTicket: number,
    xid: bigint | undefined
  ) {
    if (this.disposed) {
      return;
    }
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && entry.ticket > startTicket) {
      this.markInvalid(key, { invalidateBulkSync: false });
      return;
    }
    this.setValue(key, value);
    const stored = this.store.get(normalizedKey);
    if (xid !== undefined && stored && this.sync.seesOwnWrites) {
      this.recordOwnWrite(normalizedKey, xid, stored.ticket);
    }
  }

  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `generatedPrimaryKey`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it. A row
   * that the `selectSanitizationFn` returns without its primary key is returned, but not cached.
   * @throws If the cache is disposed.
   */
  async sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null> {
    this.assertNotDisposed();
    const startTicket = this.nextTicket();
    const { row, xid } = await this.gate.insertToTable<V, PK>(this.schema, item);
    if (row === null) {
      return row;
    }
    const key = row[this.schema.primaryKey] as K | undefined;
    if (key === undefined) {
      // The row is inserted: failing now would make the caller insert it again
      libLog(
        this.logger,
        'warn',
        this.name,
        `The row created in "${this.schema.tableName}" has no primary key "${String(this.schema.primaryKey)}" after selectSanitizationFn: it is not cached.`
      );
      return row;
    }
    this.storeWritten(key, row, startTicket, xid);
    this.emitInvalidation('write', [key]);
    return row;
  }

  /**
   * Updates the item in the database and caches the row returned by the database.
   * Only the columns present in `item` are written.
   *
   * @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
   * @throws If the cache is disposed.
   */
  async sqlUpdate(item: LilypadDbUpdateData<V, PK>): Promise<V | null> {
    this.assertNotDisposed();
    const key = this.getItemPrimaryKeyValue(item);
    const startTicket = this.nextTicket();
    const { row, xid } = await this.gate.updateToTable<V, PK>(this.schema, item);
    this.storeWritten(key, row, startTicket, xid);
    this.emitInvalidation('write', [key]);
    return row;
  }

  /**
   * Deletes the row in the database, and caches the key as `null` (also for a protected key).
   *
   * @returns `true` if a row had this key, `false` if there was none (the key is cached as `null`
   * either way).
   * @throws If the cache is disposed.
   */
  async sqlDelete(key: K): Promise<boolean> {
    this.assertNotDisposed();
    const startTicket = this.nextTicket();
    const { deleted, xid } = await this.gate.deleteFromTable<V, PK>(this.schema, key);
    this.storeWritten(key, null, startTicket, xid);
    this.emitInvalidation('write', [key]);
    return deleted;
  }
}
