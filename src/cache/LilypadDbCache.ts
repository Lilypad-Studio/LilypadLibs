import {
  lilypadMissingPrimaryKeyError,
  type LilypadDbGate,
  type LilypadDbInsertData,
  type LilypadDbSchema,
  type LilypadDbUpdateData,
  type ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_DEFAULT_NOTIFY_CHANNEL,
  type LilypadChangesRequest,
} from '@/dbGate/LilypadChangelog';
import {
  getLilypadChangelogReader,
  type LilypadChangelogReader,
  type LilypadChangelogReadResult,
  type LilypadChangelogSubscriber,
} from '@/dbGate/LilypadChangelogReader';
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
import { libLog } from '@/logger/LilypadLibLogger';
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

/** The options shared by the strategies that see every change of the table. */
export type LilypadDbCacheTrustedSyncOptions = {
  verify?: LilypadDbCacheSchemaVerification;
  /**
   * While the sync is trusted, an entry read from the database (not a copy from the shared
   * level, nor a fallback after an error) that reaches its TTL with no change of its row is
   * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
   * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
   * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
   */
  maxAge?: number;
};

/**
 * How the cache learns about the changes made by other instances and other programs.
 *
 * - `listen`: `LISTEN/NOTIFY` on a dedicated connection. Near real-time, for long-running servers.
 *   Not suited to serverless platforms: the connection must stay open, it does not work through a
 *   pooler in transaction mode, and notifications sent while an instance is suspended are lost.
 * - `changelog`: each instance reads the changelog table (see `lilypadChangelogSql`) at most once
 *   per `pollInterval`, when the cache is used. The caches of a gate read their tables together,
 *   in one query. No long-lived connection: suited to serverless platforms. Changes are seen
 *   within `pollInterval`.
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
 *
 * When `LISTEN` or a read of the changelog fails, the next attempts back off exponentially (up to
 * one minute), instead of retrying at every read.
 */
export type LilypadDbCacheSync =
  | (LilypadDbCacheTrustedSyncOptions & {
      strategy: 'listen';
      /**
       * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
       * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
       */
      connect?: 'eager' | 'lazy';
      /**
       * If false, the cache does not apply the notifications: keeping it up to date is then up to
       * `onNotification`, and entries are never kept past their TTL. Defaults to true.
       */
      applyChanges?: boolean;
      /** Called with every notification of the table, after the cache has applied it. */
      onNotification?: (payload: LilypadDbCacheDefaultNotificationPayload) => Promise<void> | void;
    })
  | (LilypadDbCacheTrustedSyncOptions & {
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
    })
  | { strategy: 'none' };

/** How the cache checks that the database has the triggers it needs (see {@link LilypadDbCacheSync}). */
export type LilypadDbCacheSchemaVerification = 'warn' | 'throw' | 'off';

export type LilypadDbCacheOptions<
  K extends LilypadCacheKey,
  V,
  PK extends keyof V,
> = LilypadCacheOptions<K, V> & {
  dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
  /** Defaults to `{ strategy: 'listen' }`. */
  sync?: LilypadDbCacheSync;
};

type LilypadDbCacheListenSync = Extract<LilypadDbCacheSync, { strategy: 'listen' }>;
type LilypadDbCacheRowChange = 'INSERT' | 'UPDATE' | 'DELETE';

const DEFAULT_CHANGELOG_MAX_GAP = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = 0.25;
/** How long the writes of this instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 10 * 60 * 1000;
/** The longest wait before retrying a failed `LISTEN` or read of the changelog. */
const MAX_RETRY_DELAY = 60_000;

/** Exponential backoff from `base`, up to {@link MAX_RETRY_DELAY} (or `base`, if longer). */
function retryDelay(failures: number, base: number): number {
  return Math.max(base, Math.min(base * 2 ** (failures - 1), MAX_RETRY_DELAY));
}

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
 * const users = await LilypadDbCache.create<number, User, 'id'>({
 *   ttl: 60_000,
 *   dbGate: { gate, schema: usersSchema },
 *   logger,
 * });
 * const user = await users.getOrFetch(42); // User, or null when there is no such row
 * await users.dispose();
 * ```
 *
 * @remarks
 * - `get` reads memory only. `getOrFetch` queries the database on a miss; `refresh` always
 *   re-fetches the key; `getAll` loads the whole table once, then fetches only the rows it does
 *   not hold up to date.
 * - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the result.
 * - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
 *   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
 *   notes that the row exists, and `getAll` fetches it.
 * - The name of the cache (shared level keys, invalidation events, logs) defaults to the table name.
 */
export default class LilypadDbCache<
  K extends LilypadCacheKey & V[PK],
  V extends object,
  PK extends keyof V = keyof V,
> extends LilypadCache<K, V> {
  private readonly dbGate: { gate: LilypadDbGate; schema: LilypadDbSchema<V, PK> };
  private readonly sync: LilypadDbCacheSync;
  private readonly defaultDbListener?: ListenerCallbackIdentifier;
  /** Whether the default listener updates the cache (not only `onNotification`). */
  private readonly listenAppliesChanges: boolean = false;
  private listening?: Promise<void>;
  private listenFailures = 0;
  private listenRetryAt = 0;
  private singletonIdentifier?: string;
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  private tableSchema?: string;
  /** The schema check, once it has run or while it runs; reset when it could not run. */
  private schemaCheck?: Promise<void>;
  private schemaCheckFailures = 0;
  private schemaCheckRetryAt = 0;

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
  /** Receive the rows of the next load of the table (see `loadTable`). */
  private tableLoadWaiters = new Set<(rows: Map<string, V>) => void>();
  /** The queries of `fetchRows` in flight, by normalized key. */
  private rowFetches = new Map<string, Promise<Map<string, LilypadCachedValueType<V>>>>();
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  private refreshes = new Map<
    string,
    {
      running?: Promise<LilypadCachedValueType<V>>;
      queued?: Promise<LilypadCachedValueType<V>>;
    }
  >();

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
  private changelogReader?: LilypadChangelogReader;
  private changelogSubscriber?: LilypadChangelogSubscriber;
  private unsubscribeChangelog?: () => void;
  private changelogCursor?: bigint;
  /** Changes already applied, by id, with their transaction id, until the cursor passes them. */
  private appliedChanges = new Map<string, bigint>();
  private lastChangelogRead = 0;
  private changelogFailures = 0;
  private changelogRetryAt = 0;

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
    options: LilypadDbCacheOptions<K, V, PK> & LilypadSingletonAble
  ): Promise<LilypadDbCache<K, V, PK>> {
    return createLilypadSingletonAbleAsync(
      'LilypadDbCache',
      options,
      async (registryKey) => {
        const cache = await LilypadDbCache.initializeNew<K, V, PK>(options);
        cache.singletonIdentifier = registryKey;
        return cache;
      },
      {
        value: JSON.stringify([options.dbGate.schema.tableName, options.ttl]),
        onMismatch: () =>
          libLog(
            options.logger,
            'warn',
            `LilypadDbCache singleton "${options.singleton ? options.singletonIdentifier : ''}" already exists with a different table or TTL: the new options are ignored.`
          ),
      }
    );
  }

  private static async initializeNew<
    K extends LilypadCacheKey & V[PK],
    V extends object,
    PK extends keyof V,
  >(options: LilypadDbCacheOptions<K, V, PK>): Promise<LilypadDbCache<K, V, PK>> {
    const cache = new LilypadDbCache<K, V, PK>(options);
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

  private constructor(options: LilypadDbCacheOptions<K, V, PK>) {
    super({ ...options, name: options.name ?? options.dbGate.schema.tableName });
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async (signal) => {
      const read = this.beginRead();
      const entries = (await this.dbGate.gate.selectAllFromTable<V, PK>(this.dbGate.schema)).map(
        (item): [K, V] => [item[this.dbGate.schema.primaryKey] as K, item]
      );
      if (!signal.aborted) {
        this.replaceMembers(entries, read.ticket, read.startedAt);
        if (this.tableLoadWaiters.size > 0) {
          const rows = new Map(entries.map(([key, row]) => [this.normalizeKey(key), row]));
          for (const waiter of this.tableLoadWaiters) {
            waiter(rows);
          }
        }
      }
      return entries;
    };

    this.sync = options.sync ?? { strategy: 'listen' };
    const tableNameParts = this.dbGate.schema.tableName.split('.');
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }
    if (this.sync.strategy === 'listen') {
      this.listenAppliesChanges = this.sync.applyChanges !== false;
      this.defaultDbListener = this.getDefaultDbListener(this.sync);
    }
    if (this.sync.strategy === 'changelog') {
      this.changelogReader = getLilypadChangelogReader(this.dbGate.gate, this.sync.table);
      this.changelogSubscriber = {
        request: (readAt: number): LilypadChangesRequest => this.changelogRequest(readAt),
        apply: (
          result: LilypadChangelogReadResult,
          request: LilypadChangesRequest
        ): Promise<void> => this.applyChangelog(result, 'cursor' in request.since),
      };
      this.unsubscribeChangelog = this.changelogReader.subscribe(this.changelogSubscriber);
    }

    libLog(
      this.logger,
      'debug',
      this.name,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}" (sync: ${this.sync.strategy})`
    );
  }

  // SCHEMA VERIFICATION

  private schemaVerification(): LilypadDbCacheSchemaVerification {
    return this.sync.strategy === 'none' ? 'off' : (this.sync.verify ?? 'warn');
  }

  /**
   * Checks once that the database has the triggers the sync strategy needs, and resolves the schema
   * of the table. With `verify: 'warn'` it never rejects: problems and failures are logged. A check
   * that could not run (e.g. the database was unreachable) is forgotten, so that a later read runs
   * it again (see {@link checkSchemaInBackground}); a check that found problems is not repeated.
   *
   * @throws A `LilypadSchemaCheckError` with `verify: 'throw'`, or the error of the check.
   */
  private verifySchema(): Promise<void> {
    const mode = this.schemaVerification();
    if (mode === 'off') {
      return Promise.resolve();
    }
    if (!this.schemaCheck) {
      // Reset in a callback, not in runSchemaCheck: the check must be registered before it can be forgotten
      const check: Promise<void> = this.runSchemaCheck(mode).then((ran) => {
        if (!ran && this.schemaCheck === check) {
          this.schemaCheck = undefined;
        }
      });
      this.schemaCheck = check;
    }
    return this.schemaCheck;
  }

  /**
   * Runs the schema check in the background, unless it has already run, is running, or failed less
   * than a backoff ago. Reads call it to retry a check that could not run.
   */
  private checkSchemaInBackground(now: number) {
    if (this.schemaCheck || now < this.schemaCheckRetryAt || this.schemaVerification() === 'off') {
      return;
    }
    // Only diagnostics: reads do not wait for it
    runInBackground(this.platform, this.verifySchema(), () => {});
  }

  /** @returns `false` if the check could not run (with `verify: 'warn'`; `throw` rejects). */
  private async runSchemaCheck(mode: 'warn' | 'throw'): Promise<boolean> {
    const { tableName, primaryKey } = this.dbGate.schema;
    const subject = `LilypadDbCache "${tableName}" (sync: ${this.sync.strategy})`;
    try {
      const result = await checkLilypadSchema(this.dbGate.gate, {
        tables: [{ table: tableName, primaryKey: String(primaryKey) }],
        changelog: this.sync.strategy === 'changelog' ? { table: this.sync.table } : false,
        notifyChannel: this.sync.strategy === 'listen' ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false,
      });
      this.tableSchema = result.tables[0]?.schema ?? this.tableSchema;
      this.schemaCheckFailures = 0;
      this.schemaCheckRetryAt = 0;
      if (result.ok) {
        return true;
      }
      if (mode === 'throw') {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if (this.logger?.warn) {
        libLog(this.logger, 'warn', this.name, message);
      } else {
        // A missing trigger would otherwise go unnoticed: the cache just stays stale
        console.warn(message);
      }
      return true;
    } catch (error) {
      if (mode === 'throw') {
        throw error;
      }
      this.schemaCheckFailures++;
      this.schemaCheckRetryAt = Date.now() + retryDelay(this.schemaCheckFailures, 1000);
      libLog(
        this.logger,
        'warn',
        this.name,
        `${subject}: could not check the database schema:`,
        error
      );
      return false;
    }
  }

  // SYNCHRONIZATION

  /**
   * Registers the listener once, after the schema check (which resolves the schema of the table,
   * to ignore the notifications of other schemas). A failed registration is retried by the next
   * call, after a backoff for the lazy `LISTEN` of the reads.
   */
  private startListening(): Promise<void> {
    if (!this.listening && this.defaultDbListener) {
      const listener = this.defaultDbListener;
      this.listening = this.verifySchema()
        .then(() => this.dbGate.gate.addListener(listener))
        .then(() => {
          this.listenFailures = 0;
          this.listenRetryAt = 0;
          if (this.listenAppliesChanges) {
            this.listenTrustedSince = Date.now();
          }
        })
        .catch((error: unknown) => {
          this.listening = undefined;
          this.listenFailures++;
          this.listenRetryAt = Date.now() + retryDelay(this.listenFailures, 1000);
          throw error;
        });
    }
    return this.listening ?? Promise.resolve();
  }

  /**
   * Since when this instance sees every change of the table, or `undefined` if it may miss some:
   * no sync, `LISTEN` not active (or it does not update the cache), or changelog not read for
   * longer than `maxGap`.
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
    const now = Date.now();
    if (this.sync.strategy === 'listen') {
      if (this.listening) {
        // Starting LISTEN ran the check: this only retries one that could not run
        this.checkSchemaInBackground(now);
        return undefined;
      }
      if (this.sync.connect !== 'lazy' || now < this.listenRetryAt) {
        return undefined;
      }
      return this.startListening().catch((error: unknown) => {
        libLog(this.logger, 'error', this.name, 'Error starting LISTEN for the cache:', error);
      });
    }
    if (this.sync.strategy !== 'changelog') {
      return undefined;
    }
    if (now - this.lastChangelogRead < this.sync.pollInterval || now < this.changelogRetryAt) {
      return undefined;
    }
    this.checkSchemaInBackground(now);
    const reading = this.readChangelog();
    if (this.sync.poll === 'background') {
      runInBackground(this.platform, reading, () => {});
      return undefined;
    }
    return reading;
  }

  /**
   * Reads the changelog (with the other caches of the gate); errors are logged, and the next read
   * waits for a backoff.
   */
  private readChangelog(): Promise<void> {
    if (!this.changelogReader || !this.changelogSubscriber || this.sync.strategy !== 'changelog') {
      return Promise.resolve();
    }
    const pollInterval = this.sync.pollInterval;
    return this.changelogReader.read(this.changelogSubscriber).catch((error: unknown) => {
      this.changelogFailures++;
      this.changelogRetryAt =
        Date.now() + retryDelay(this.changelogFailures, Math.max(pollInterval, 1000));
      libLog(this.logger, 'error', this.name, 'Error reading the changelog:', error);
    });
  }

  /** What to read for this cache: the changes since its cursor, or a lookback if it lost it. */
  private changelogRequest(readAt: number): LilypadChangesRequest {
    const tableName = this.dbGate.schema.tableName;
    if (this.sync.strategy !== 'changelog') {
      return { tableName, since: { lookback: 0 } };
    }
    const maxGap = this.sync.maxGap ?? DEFAULT_CHANGELOG_MAX_GAP;
    if (this.changelogCursor !== undefined && readAt - this.lastChangelogRead <= maxGap) {
      return { tableName, since: { cursor: this.changelogCursor } };
    }
    const lookback =
      this.sync.lookback ?? this.defaultTtl + this.defaultStaleWhileRevalidate + 60_000;
    return { tableName, since: { lookback } };
  }

  /**
   * Applies a read of the changelog. Its errors are logged: the other caches read with it must not
   * be affected.
   *
   * @param trusted - Whether the read started from the cursor of this cache.
   */
  private async applyChangelog(
    { changes, cursor, readAt }: LilypadChangelogReadResult,
    trusted: boolean
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      if (!trusted) {
        // First read, or too long since the last one: the local entries may have missed changes,
        // and the recent changes are applied below to the shared level too
        this.appliedChanges.clear();
        this.expireEverything();
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
      this.changelogFailures = 0;
      this.changelogRetryAt = 0;
      this.emitInvalidation('changelog', changedKeys, { wholeCache: truncated });
    } catch (error) {
      libLog(this.logger, 'error', this.name, 'Error applying the changelog:', error);
    }
  }

  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - DELETE: the key is cached as `null`.
   * - INSERT/UPDATE of a key held (or being read) by this instance: `eager` re-fetches it at once;
   *   `lazy` expires it with no query, which also discards a read in flight (it may predate the
   *   change): the next read fetches it.
   * - INSERT/UPDATE of any other key: no query. The shared level entry is removed.
   * In every INSERT/UPDATE case, the key is noted as a row of the table, which `getAll` returns.
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
    const normalizedKey = this.normalizeKey(key);
    const held = this.store.has(normalizedKey) || this.hasReadInFlight(normalizedKey);
    this.addMember(key);
    if (!held) {
      // Nobody asked for this row here: no query, but other instances may have shared it
      this.deleteShared(key);
      this.invalidateBulkSync();
    } else if (mode === 'eager') {
      await this.refreshKey(key);
    } else {
      this.markInvalid(key);
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

  /**
   * Loads the whole table, even if the bulk sync of the base class still counts as fresh.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  private async loadTable(): Promise<Map<string, V>> {
    let loaded = new Map<string, V>();
    const waiter = (rows: Map<string, V>) => {
      loaded = rows;
    };
    this.tableLoadWaiters.add(waiter);
    try {
      if (Date.now() < this.bulkSyncExpirationTime) {
        this.invalidateBulkSync();
      }
      await this.bulkSync({ throwOnError: true });
    } finally {
      this.tableLoadWaiters.delete(waiter);
    }
    return loaded;
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

  /** One read of `fetchRows`, bounded by `bulkSyncTimeout`. */
  private async queryRows(keys: K[]): Promise<Map<string, LilypadCachedValueType<V>>> {
    const primaryKey = this.dbGate.schema.primaryKey;
    try {
      return await this.bulkSyncFlowControl.executeWithTimeout(async (signal) => {
        const read = this.beginRead();
        const rows = new Map<string, V>();
        for (const row of await this.dbGate.gate.selectFromTableByPrimaryKeys<V, PK>(
          this.dbGate.schema,
          keys
        )) {
          rows.set(this.normalizeKey(row[primaryKey] as K), row);
        }
        const values = new Map<string, LilypadCachedValueType<V>>();
        for (const key of keys) {
          const normalizedKey = this.normalizeKey(key);
          const row = rows.get(normalizedKey) ?? null;
          values.set(normalizedKey, row);
          if (!signal.aborted) {
            // The row keeps the key type of the database
            read.store(row ? (row[primaryKey] as K) : key, row);
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

  // READS

  override get(
    key: K,
    options: { removeExpired?: boolean } = {}
  ): LilypadCachedValueType<V> | undefined {
    this.renew(this.normalizeKey(key));
    return super.get(key, options);
  }

  override async getOrSetDetailed(
    key: K,
    valueFn: (signal: AbortSignal) => Promise<LilypadCachedValueType<V>>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    this.assertNotDisposed();
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
   * @param options - The `getOrSet` options (e.g. `staleWhileRevalidate`, `timeout`, `errorFn`).
   * @returns The row, or `null` if it does not exist.
   * @throws If the query fails and the options give no fallback value (see `getOrSet`).
   */
  async getOrFetch(
    key: K,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V>> {
    return (await this.getOrFetchDetailed(key, options)).value;
  }

  /**
   * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
   * failed (see `getOrSetDetailed`).
   */
  getOrFetchDetailed(
    key: K,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    return this.getOrSetDetailed(
      key,
      () => this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(this.dbGate.schema, key),
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
   * @throws If the query fails or exceeds `flowControlTimeout`.
   */
  refresh(key: K): Promise<LilypadCachedValueType<V>> {
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
      const value = await this.dbGate.gate.selectFromTableByPrimaryKey<V, PK>(
        this.dbGate.schema,
        key
      );
      if (!signal.aborted) {
        read.storeFetched(key, value);
      }
      return value;
    });
  }

  /** Re-fetches a key; if the query fails, expires it instead. */
  private async refreshKey(key: K) {
    try {
      await this.refresh(key);
    } catch (error) {
      libLog(
        this.logger,
        'error',
        this.name,
        `Error updating cache key "${String(key)}" after a change: `,
        error
      );
      this.markInvalid(key);
    }
  }

  protected override hasReadInFlight(normalizedKey: string): boolean {
    return (
      super.hasReadInFlight(normalizedKey) ||
      this.rowFetches.has(normalizedKey) ||
      this.refreshes.has(normalizedKey)
    );
  }

  /**
   * Returns every row of the table, or the rows of `keys`.
   *
   * The whole table is loaded once (again after the sync lost changes, or, with the `none`
   * strategy, after `defaultBulkSyncTtl`). Then only the rows the cache does not hold up to date
   * are queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When
   * they are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level. With
   * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
   * again at each call.
   *
   * @throws If the rows cannot be loaded, or the cache is disposed.
   */
  async getAll(keys?: K[]): Promise<V[]> {
    this.assertNotDisposed();
    const syncing = this.syncBeforeRead();
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

  private memberKeys(): K[] {
    return [...this.members.values()].map((member) => member.key);
  }

  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the schema declares the primary key as a
   * `number` column.
   */
  private resolveNotifiedKey(id: string | number): K {
    const normalizedKey = this.normalizeKey(id as K);
    const known = this.store.get(normalizedKey)?.key ?? this.members.get(normalizedKey)?.key;
    if (known !== undefined) {
      return known;
    }
    const { cols, primaryKey } = this.dbGate.schema;
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
    this.set(key, null);
  }

  protected getDefaultDbListener(options: LilypadDbCacheListenSync): ListenerCallbackIdentifier {
    return {
      channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${this.dbGate.schema.tableName}_${this.id}`,
      // Notifications sent while the connection was down are lost: every entry may be stale
      onReconnect: () => {
        this.expireEverything();
        if (this.listenAppliesChanges) {
          this.listenTrustedSince = Date.now();
        }
      },
      callback: async (payload: unknown) => {
        libLog(
          this.logger,
          'debug',
          this.name,
          'LilypadDbCache handler has received payload on cache_events channel:',
          payload
        );
        if (typeof payload !== 'string') {
          return;
        }
        let parsedPayload: LilypadDbCacheDefaultNotificationPayload;
        try {
          parsedPayload = JSON.parse(payload) as LilypadDbCacheDefaultNotificationPayload;
        } catch (e) {
          libLog(this.logger, 'error', this.name, 'Error parsing cache_events payload:', e);
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
        if (!this.isNotificationForTable(parsedPayload)) {
          return;
        }
        libLog(
          this.logger,
          'debug',
          this.name,
          'LilypadDbCache handler is processing payload:',
          parsedPayload
        );
        if (this.listenAppliesChanges) {
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
        await options.onNotification?.(parsedPayload);
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
   * Disposes of the cache: stops its database listener and its changelog reads, removes it from
   * the singleton registry (if it was created as a singleton) and clears it.
   */
  override async dispose(): Promise<void> {
    if (this.singletonIdentifier !== undefined) {
      removeLilypadSingletonInstance(this.singletonIdentifier);
      this.singletonIdentifier = undefined;
    }
    this.unsubscribeChangelog?.();
    this.unsubscribeChangelog = undefined;
    // removeListener unregisters the callback synchronously; only the UNLISTEN is awaited
    const listenerRemoval = this.defaultDbListener
      ? this.dbGate.gate.removeListener(
          this.defaultDbListener.channel,
          this.defaultDbListener.callbackId
        )
      : undefined;
    await super.dispose();
    this.members.clear();
    this.ownWrites.clear();
    this.appliedChanges.clear();
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
