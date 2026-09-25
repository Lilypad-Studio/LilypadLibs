import {
  lilypadMissingPrimaryKeyError,
  type LilypadDbGate,
  type LilypadDbInsertData,
  type LilypadDbSchema,
  type LilypadDbUpdateData,
  type ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import { LILYPAD_DEFAULT_NOTIFY_CHANNEL, readLilypadChanges } from '@/dbGate/LilypadChangelog';
import {
  checkLilypadSchema,
  formatLilypadSchemaProblems,
  LilypadSchemaCheckError,
} from '@/dbGate/LilypadSchemaCheck';
import LilypadCache, {
  type LilypadCachedValueType,
  type LilypadCacheEntry,
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
  /**
   * The schema of the table. Notifications without it match the table in any schema (the triggers
   * of version 1 of the changelog, and custom triggers that do not send it).
   */
  schema?: string;
  table?: string;
  /**
   * A number when the trigger serializes a numeric primary key as such (e.g. `json_build_object`).
   * Absent for `TRUNCATE`.
   */
  id?: string | number;
  op: 'UPDATE' | 'DELETE' | 'INSERT' | 'TRUNCATE';
  /**
   * The id of the transaction that made the change (sent by the triggers of version 3). It lets
   * the instance that made the change skip its own writes.
   */
  xid?: string;
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
 *
 * `listen` and `changelog` rely on triggers that the library does not install (see
 * `lilypadChangelogSql`). Their `verify` option checks that they exist (`checkLilypadSchema`):
 * - `warn` (default): once, when the cache first uses the database (`LISTEN`, or the first read
 *   of the changelog), without delaying changelog reads; problems are logged as a warning, with the
 *   SQL that fixes them (on `console.warn` without a logger).
 * - `throw`: in `create`, which rejects with a `LilypadSchemaCheckError`. `create` then queries
 *   the database, whatever the strategy.
 * - `off`: no check. With `listen`, notifications of a table of the same name in another schema
 *   are then told apart only if `tableName` is qualified (`schema.table`).
 *
 * While `listen` or `changelog` is trusted (`LISTEN` active, changelog read within `maxGap`), the
 * cache sees every change of the table, so the TTL no longer needs a query: an entry that reaches
 * its TTL without a change of its row is kept until `maxAge`.
 */
export type LilypadDbCacheSync =
  | {
      strategy: 'listen';
      verify?: LilypadDbCacheSchemaVerification;
      /**
       * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
       * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
       */
      connect?: 'eager' | 'lazy';
      listenerOptions?: LilypadDbCacheDefaultListenerOptions;
      /**
       * While the sync is trusted, an entry read from the database (not a copy from the shared
       * level, nor a fallback after an error) that reaches its TTL with no change of its row is
       * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
       * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
       * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
       */
      maxAge?: number;
    }
  | {
      strategy: 'changelog';
      verify?: LilypadDbCacheSchemaVerification;
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
      /**
       * While the sync is trusted, an entry read from the database (not a copy from the shared
       * level, nor a fallback after an error) that reaches its TTL with no change of its row is
       * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
       * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
       * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
       */
      maxAge?: number;
    }
  | { strategy: 'none' };

/** How the cache checks that the database has the triggers it needs (see {@link LilypadDbCacheSync}). */
export type LilypadDbCacheSchemaVerification = 'warn' | 'throw' | 'off';

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

type LilypadDbCacheRowChange = 'INSERT' | 'UPDATE' | 'DELETE';

const DEFAULT_CHANGELOG_MAX_GAP = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = 0.25;
/** Maximum number of primary keys per query of `getAll`. */
const FETCH_BATCH_SIZE = 1000;
/** How long the writes of this instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 10 * 60 * 1000;

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
 *   `invalidate` always re-fetch the key; `getAll` loads the whole table once, then fetches only
 *   the rows it does not hold up to date.
 * - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the result.
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
 *   notes that the row exists, and `getAll` fetches it.
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
  /** Whether the default listener updates the cache (not only a callback of the application). */
  private readonly listenAppliesChanges: boolean = false;
  private listening?: Promise<void>;
  private singletonIdentifier?: string;
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  private tableSchema?: string;
  private schemaCheck?: Promise<void>;

  /**
   * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
   * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
   * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
   */
  private members = new Map<string, { key: K; ticket: number }>();
  /** When the last load of the table started, if one completed. */
  private membersLoadedAt?: number;
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  private membersFloor = 0;

  /** Since when `LISTEN` delivers every change to this instance. */
  private listenTrustedSince?: number;
  /** Since when the chain of changelog reads is unbroken. */
  private changelogTrustedSince?: number;
  /**
   * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
   * entry the last one stored. While the entry holds it, the changes of these writes are already
   * reflected in it.
   */
  private ownWrites = new Map<string, { ticket: number; xids: Set<bigint>; at: number }>();

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
    try {
      if (cache.schemaVerification() === 'throw') {
        await cache.verifySchema();
      }
      if (cache.sync.strategy === 'listen' && cache.sync.connect !== 'lazy') {
        await cache.startListening();
      }
    } catch (error) {
      await cache.dispose();
      throw error;
    }
    return cache;
  }

  private constructor(ttl: number, options: LilypadDbCacheConstructorOptions<K, V, PK>) {
    super(ttl, { ...options, name: options.name ?? options.dbGate.schema.tableName });
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async (signal) => {
      const ticket = this.nextTicket();
      const startedAt = Date.now();
      const entries = (await this.dbGate.gate.selectAllFromTable<V, PK>(this.dbGate.schema)).map(
        (item): [K, V] => [item[this.dbGate.schema.primaryKey] as K, item]
      );
      if (!signal.aborted) {
        this.replaceMembers(entries, ticket, startedAt);
      }
      return entries;
    };

    this.sync = options.sync ?? LilypadDbCache.syncFromLegacyOptions(options);
    const tableNameParts = this.dbGate.schema.tableName.split('.');
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }
    if (this.sync.strategy === 'listen') {
      const listenerOptions = this.sync.listenerOptions;
      this.listenAppliesChanges =
        !listenerOptions?.callback ||
        listenerOptions.automaticallyInvalidateDataBeforeCallback === true;
      this.defaultDbListener = this.getDefaultDbListener(listenerOptions);
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

  // SCHEMA VERIFICATION

  private schemaVerification(): LilypadDbCacheSchemaVerification {
    return this.sync.strategy === 'none' ? 'off' : (this.sync.verify ?? 'warn');
  }

  /**
   * Checks once that the database has the triggers the sync strategy needs, and resolves the schema
   * of the table. With `verify: 'warn'` it never rejects: problems and failures are logged.
   *
   * @throws A `LilypadSchemaCheckError` with `verify: 'throw'`, or the error of the check.
   */
  private verifySchema(): Promise<void> {
    const mode = this.schemaVerification();
    if (mode === 'off') {
      return Promise.resolve();
    }
    this.schemaCheck ??= this.runSchemaCheck(mode);
    return this.schemaCheck;
  }

  private async runSchemaCheck(mode: 'warn' | 'throw'): Promise<void> {
    const { tableName, primaryKey } = this.dbGate.schema;
    const subject = `LilypadDbCache "${tableName}" (sync: ${this.sync.strategy})`;
    try {
      const result = await checkLilypadSchema(this.dbGate.gate, {
        tables: [{ table: tableName, primaryKey: String(primaryKey) }],
        changelog: this.sync.strategy === 'changelog' ? { table: this.sync.table } : false,
        notifyChannel: this.sync.strategy === 'listen' ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false,
      });
      this.tableSchema = result.tables[0]?.schema ?? this.tableSchema;
      if (result.ok) {
        return;
      }
      if (mode === 'throw') {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if (this.logger) {
        void this.logger.warn(this.id, message);
      } else {
        // A missing trigger would otherwise go unnoticed: the cache just stays stale
        console.warn(message);
      }
    } catch (error) {
      if (mode === 'throw') {
        throw error;
      }
      void this.logger?.warn(this.id, `${subject}: could not check the database schema:`, error);
    }
  }

  // SYNCHRONIZATION

  /**
   * Registers the listener once, after the schema check (which resolves the schema of the table,
   * to ignore the notifications of other schemas); a failed registration is retried by the next call.
   */
  private startListening(): Promise<void> {
    if (!this.listening && this.defaultDbListener) {
      const listener = this.defaultDbListener;
      this.listening = this.verifySchema()
        .then(() => this.dbGate.gate.addListener(listener))
        .then(() => {
          if (this.listenAppliesChanges) {
            this.listenTrustedSince = Date.now();
          }
        })
        .catch((error) => {
          this.listening = undefined;
          throw error;
        });
    }
    return this.listening ?? Promise.resolve();
  }

  /**
   * Since when this instance sees every change of the table, or `undefined` if it may miss some:
   * no sync, `LISTEN` not active (or its callback does not update the cache), or changelog not
   * read for longer than `maxGap`.
   */
  private syncTrustedSince(): number | undefined {
    if (this.sync.strategy === 'listen') {
      return this.listenTrustedSince;
    }
    if (this.sync.strategy === 'changelog') {
      const maxGap = this.sync.maxGap ?? DEFAULT_CHANGELOG_MAX_GAP;
      if (this.changelogCursor === undefined || Date.now() - this.lastChangelogRead > maxGap) {
        return undefined;
      }
      return this.changelogTrustedSince;
    }
    return undefined;
  }

  private maxAge(): number {
    return this.sync.strategy === 'none' ? 0 : (this.sync.maxAge ?? DEFAULT_MAX_AGE);
  }

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
    const trustedSince = this.syncTrustedSince();
    const maxAge = this.maxAge();
    if (trustedSince === undefined || entry.fetchedAt < trustedSince) {
      return;
    }
    if (now - entry.fetchedAt >= maxAge) {
      return;
    }
    this.store.set(normalizedKey, {
      ...entry,
      expirationTime: Math.min(now + this.defaultTtl, entry.fetchedAt + maxAge),
    });
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
    if (!this.schemaCheck) {
      // Only diagnostics: reads do not wait for it
      runInBackground(this.platform, this.verifySchema(), () => {});
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
      tableName: this.dbGate.schema.tableName,
      since: trusted ? { cursor: this.changelogCursor! } : { lookback },
      changelogTable: this.sync.table,
    });

    if (!trusted) {
      // First read, or too long since the last one: the local entries may have missed changes,
      // and the recent changes are applied below to the shared level too
      this.appliedChanges.clear();
      this.expireAll();
      // Every change committed from now on is returned by the next reads
      this.changelogTrustedSince = readAt;
    }
    const changedKeys: K[] = [];
    let truncated = false;
    for (const change of changes) {
      if (this.appliedChanges.has(change.id)) {
        continue;
      }
      this.appliedChanges.set(change.id, change.xid);
      if (change.op === 'TRUNCATE') {
        changedKeys.push(...this.applyTruncate());
        truncated = true;
      } else {
        changedKeys.push(await this.applyChange(change.op, change.rowId, 'lazy', change.xid));
      }
    }
    // Changes older than the new cursor will not be returned again
    for (const [id, xid] of this.appliedChanges) {
      if (xid < cursor) {
        this.appliedChanges.delete(id);
      }
    }
    for (const [normalizedKey, own] of this.ownWrites) {
      for (const xid of own.xids) {
        if (xid < cursor) {
          own.xids.delete(xid);
        }
      }
      if (own.xids.size === 0) {
        this.ownWrites.delete(normalizedKey);
      }
    }
    this.changelogCursor = cursor;
    this.lastChangelogRead = readAt;
    this.emitInvalidation('changelog', changedKeys, { wholeCache: truncated });
  }

  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - DELETE: the key is cached as `null`.
   * - INSERT/UPDATE of a key held (or being fetched) by this instance: `eager` re-fetches it at
   *   once; `lazy` expires it, so the next read fetches it. A fetch in flight is always re-fetched,
   *   since it may have read the row before the change.
   * - INSERT/UPDATE of any other key: no query. The shared level entry is removed, and the key is
   *   noted as a row of the table, which the next `getAll` fetches.
   *
   * @param xid - The transaction that made the change, when known.
   * @returns The key of the changed row.
   */
  private async applyChange(
    op: LilypadDbCacheRowChange,
    id: string | number,
    mode: 'eager' | 'lazy',
    xid?: bigint
  ): Promise<K> {
    const key = this.resolveNotifiedKey(id);
    if (xid !== undefined && this.isOwnWrite(key, xid)) {
      return key;
    }
    if (op === 'DELETE') {
      // Also for keys not in cache: the null entry keeps an older, in-flight fetch from caching the row
      this.markDeleted(key);
      return key;
    }
    const inFlight = this.isFetchInFlight(key);
    const cached = this.getComprehensive(key).type !== 'miss';
    if (inFlight || (mode === 'eager' && cached)) {
      await this.refreshKey(key, {});
    } else if (cached) {
      this.markInvalid(key);
    } else {
      // Nobody asked for this row here: no query, but other instances may have shared it
      this.deleteShared(key);
      this.invalidateBulkSync();
      this.addMember(key);
    }
    return key;
  }

  /**
   * Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
   * discarded, the copies of the shared level produced before are ignored, and the table is known
   * to be empty (until the changes that follow).
   *
   * @returns The keys that were cached.
   */
  private applyTruncate(): K[] {
    const keys = [...this.store.values()].map((entry) => entry.key);
    for (const key of keys) {
      this.deleteShared(key);
    }
    this.expireEverything();
    this.rejectSharedBefore(Date.now());
    this.membersFloor = this.nextTicket();
    this.members.clear();
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
   * trusted sync, less than `defaultBulkSyncTtl` ago.
   */
  private isTableLoaded(): boolean {
    if (this.membersLoadedAt === undefined) {
      return false;
    }
    const trustedSince = this.syncTrustedSince();
    if (trustedSince !== undefined && this.membersLoadedAt >= trustedSince) {
      return true;
    }
    return Date.now() < this.membersLoadedAt + this.defaultBulkSyncTtl;
  }

  /** Loads the whole table, even if the bulk sync of the base class still counts as fresh. */
  private async loadTable() {
    if (Date.now() < this.bulkSyncExpirationTime) {
      this.invalidateBulkSync();
    }
    await this.bulkSync(undefined, { throwOnError: true });
  }

  /** The keys whose entry is missing or expired (after renewing the entries still up to date). */
  private staleKeys(keys: K[]): K[] {
    return keys.filter((key) => {
      const normalizedKey = this.normalizeKey(key);
      this.renew(normalizedKey);
      const entry = this.store.get(normalizedKey);
      return !entry || Date.now() >= entry.expirationTime;
    });
  }

  /**
   * Fetches rows by primary key, in batches, and caches them in this instance only (`null` for
   * the keys without a row). Concurrent calls for the same keys share the queries.
   *
   * @throws If a query fails.
   */
  private async fetchRows(keys: K[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const primaryKey = this.dbGate.schema.primaryKey;
    await this.bulkSyncFlowControl.executeFn({
      functionIdentifier: `LilypadDbCache-fetchRows-${keys.map((key) => this.normalizeKey(key)).join(',')}`,
      consumerIdentifier: '',
      errorFn: (error) => {
        void this.logger?.error(this.id, 'Error fetching rows of the table: ', error);
        throw error;
      },
      fn: async (signal) => {
        const ticket = this.nextTicket();
        const fetchedAt = Date.now();
        const rows = new Map<string, V>();
        for (let start = 0; start < keys.length; start += FETCH_BATCH_SIZE) {
          const batch = await this.dbGate.gate.selectFromTableByPrimaryKeys<V, PK>(
            this.dbGate.schema,
            keys.slice(start, start + FETCH_BATCH_SIZE)
          );
          for (const row of batch) {
            rows.set(this.normalizeKey(row[primaryKey] as K), row);
          }
        }
        if (signal.aborted) {
          return false;
        }
        for (const key of keys) {
          const row = rows.get(this.normalizeKey(key));
          // The row keeps the key type of the database
          this.setIfNewer(
            row ? (row[primaryKey] as K) : key,
            row ?? null,
            undefined,
            ticket,
            fetchedAt
          );
        }
        return true;
      },
    });
  }

  /** The cached rows of these keys, leaving out the keys without a row. */
  private rowsOf(keys: K[]): V[] {
    const rows: V[] = [];
    for (const key of keys) {
      const value = this.store.get(this.normalizeKey(key))?.value;
      if (value !== undefined && value !== null) {
        rows.push(value);
      }
    }
    return rows;
  }

  // READS

  override get(key: K, removeOld: boolean = false): LilypadCachedValueType<V> | undefined {
    this.renew(this.normalizeKey(key));
    return super.get(key, removeOld);
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
    this.renew(this.normalizeKey(key));
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
   * @param options.invalidateBulkSync - Whether to invalidate the bulk sync of the base class
   * (`bulkSync`, `bulkAsyncGet`) when the update fails (default: true). `getAll` fetches the key
   * again either way.
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
   * Returns every row of the table, or the rows of `keys`.
   *
   * The whole table is loaded once (again after the sync lost changes, or, with the `none`
   * strategy, after `defaultBulkSyncTtl`). Then only the rows the cache does not hold up to date
   * are queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When
   * they are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level.
   *
   * @throws If the rows cannot be loaded.
   */
  async getAll(keys?: K[]): Promise<V[]> {
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
    if (keys) {
      const uniqueKeys = [...new Map(keys.map((key) => [this.normalizeKey(key), key])).values()];
      await this.fetchRows(this.staleKeys(uniqueKeys));
      return this.rowsOf(uniqueKeys);
    }
    if (!this.isTableLoaded()) {
      await this.loadTable();
    }
    let staleKeys = this.staleKeys(this.memberKeys());
    if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
      await this.loadTable();
      staleKeys = this.staleKeys(this.memberKeys());
    }
    // Also the rows changed while the table was loading
    await this.fetchRows(staleKeys);
    return this.rowsOf(this.memberKeys());
  }

  private memberKeys(): K[] {
    return [...this.members.values()].map((member) => member.key);
  }

  /**
   * The key of the cached entry for a notified id, so that the entry keeps its original key type
   * (a notification may carry a numeric key as a string, or the other way around).
   */
  private resolveNotifiedKey(id: string | number): K {
    const normalizedKey = this.normalizeKey(id as K);
    return this.store.get(normalizedKey)?.key ?? this.members.get(normalizedKey)?.key ?? (id as K);
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
      onReconnect: () => {
        this.expireAll();
        if (this.listenAppliesChanges) {
          this.listenTrustedSince = Date.now();
        }
      },
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
        const { id, op } = parsedPayload;
        const truncate = op === 'TRUNCATE';
        if (
          (!truncate && ((typeof id !== 'string' && typeof id !== 'number') || id === '')) ||
          !parsedPayload.table
        ) {
          return;
        }
        if (this.isNotificationForTable(parsedPayload)) {
          void this.logger?.debug(
            this.id,
            this.dbGate.schema.tableName,
            'LilypadDbCache handler is processing payload:',
            parsedPayload
          );
          if (!options?.callback || options.automaticallyInvalidateDataBeforeCallback) {
            if (truncate) {
              this.emitInvalidation('notification', this.applyTruncate(), { wholeCache: true });
            } else {
              const key = await this.applyChange(
                op,
                id!,
                'eager',
                LilypadDbCache.parseXid(parsedPayload.xid)
              );
              this.emitInvalidation('notification', [key]);
            }
          }
          await options?.callback?.(parsedPayload);
          return;
        }
      },
    };
  }

  private static parseXid(xid: unknown): bigint | undefined {
    return typeof xid === 'string' && /^\d+$/.test(xid) ? BigInt(xid) : undefined;
  }

  /**
   * Whether a notification is about the table of this cache. `table` is the name without its
   * schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
   */
  private isNotificationForTable(payload: LilypadDbCacheDefaultNotificationPayload): boolean {
    if (payload.table !== this.dbGate.schema.tableName.split('.').pop()) {
      return false;
    }
    return (
      typeof payload.schema !== 'string' ||
      this.tableSchema === undefined ||
      payload.schema === this.tableSchema
    );
  }

  /**
   * Marks every entry as expired (keeping the values as fallback), discards the reads in flight
   * and forces the next bulk sync: changes may have been missed.
   */
  private expireAll() {
    this.expireEverything();
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
    this.members.clear();
    this.ownWrites.clear();
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
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && entry.ticket > startTicket) {
      this.markInvalid(key, { invalidateBulkSync: false });
      return;
    }
    this.set(key, value);
    const stored = this.store.get(normalizedKey);
    if (xid !== undefined && stored && this.sync.strategy !== 'none') {
      this.recordOwnWrite(normalizedKey, xid, stored.ticket);
    }
  }

  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item: LilypadDbInsertData<V, PK>): Promise<V | null> {
    const startTicket = this.nextTicket();
    const { row, xid } = await this.dbGate.gate.insertToTableDetailed<V, PK>(
      this.dbGate.schema,
      item
    );
    if (row !== null) {
      const key = this.getItemPrimaryKeyValue(row) as K;
      this.storeWritten(key, row, startTicket, xid);
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
    const startTicket = this.nextTicket();
    const { row, xid } = await this.dbGate.gate.updateToTableDetailed<V, PK>(
      this.dbGate.schema,
      item
    );
    this.storeWritten(key, row, startTicket, xid);
    this.emitInvalidation('write', [key]);
    return row;
  }

  /**
   * Deletes the row in the database, and caches the key as `null` (also for a protected key).
   */
  async sqlDelete(key: K): Promise<void> {
    const startTicket = this.nextTicket();
    const { xid } = await this.dbGate.gate.deleteFromTableDetailed<V, PK>(this.dbGate.schema, key);
    this.storeWritten(key, null, startTicket, xid);
    this.emitInvalidation('write', [key]);
  }
}
