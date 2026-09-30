import {
  LilypadCacheCooldownError,
  type LilypadCachedValueType,
  type LilypadCacheEntry,
  type LilypadCacheEntryOrigin,
  type LilypadCacheGetOptions,
  type LilypadCacheKey,
  type LilypadCacheOptions,
  type LilypadCachePeek,
  type LilypadCacheRead,
  type LilypadCacheResult,
  type LilypadCacheValueFn,
} from '@/cache/LilypadCacheTypes';
import { LilypadReadFlights } from '@/cache/LilypadReadFlights';
import {
  lilypadCacheTags,
  LilypadSharedLevel,
  type LilypadSharedEntry,
} from '@/cache/LilypadSharedLevel';
import { LilypadFlowControl } from '@/flow/LilypadFlowControl';
import { LilypadDisposedError } from '@/internal/LilypadDisposedError';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  runAfterResponse,
  runInBackground,
  type LilypadInvalidationEvent,
  type LilypadPlatform,
} from '@/platform/LilypadPlatform';

/** Whether an entry has reached its expiration time. */
function isLilypadEntryStale(entry: { expirationTime: number }): boolean {
  return Date.now() >= entry.expirationTime;
}

const DEFAULT_TTL = 60_000;
const DEFAULT_ERROR_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_FETCH_TIMEOUT = 5000;
const DEFAULT_SHARED_TIMEOUT = 300;
/**
 * A background refresh scheduled longer ago than this no longer blocks new ones: it may never
 * have started (e.g. the platform dropped the work scheduled after the response).
 */
const STUCK_REFRESH_AFTER = 60_000;
/**
 * The size of the bookkeeping maps (failures, fences, refreshes, invalidations) from which they are
 * swept without waiting for `purgeExpired`, which may never run.
 */
const BOOKKEEPING_SWEEP_SIZE = 1000;

/** The options of the engine: those of a cache, without its bulk sync. */
export type LilypadCacheEngineOptions<K extends LilypadCacheKey, V> = Omit<
  LilypadCacheOptions<K, V>,
  'bulkSync'
>;

/** What the cache that owns the engine follows or adds. */
export type LilypadCacheEngineHooks<K extends LilypadCacheKey, V> = {
  /**
   * Called each time a value is stored (not when an entry is only expired or removed). It must not
   * write to the cache.
   */
  onValueStored?(entry: LilypadCacheEntry<K, V>): void;
  /**
   * Called when entries were removed or expired while the source still has them (an eviction,
   * `clear`, `expireEverything`): the entries no longer hold the whole source.
   */
  onEntriesIncomplete?(): void;
  /** Whether the owner reads the key from the source in another way than `getOrSet`. */
  hasReadInFlight?(normalizedKey: string): boolean;
};

/**
 * The engine of {@link LilypadCache} and `LilypadDbCache`: an in-memory, TTL-based cache with an
 * optional shared level, stale-while-revalidate, a failure cooldown and protected keys.
 *
 * It is internal: the caches hold one and expose what fits them (`LilypadDbCache` never lets
 * values in that do not come from its table). Its methods do not check whether it is disposed:
 * the caches do, before calling them, while the engine ignores every write once disposed (fetches
 * still in flight cannot fill it again, nor record a failure in the shared level), starts no
 * scheduled refresh, and fails a `getOrSetDetailed` disposed while it read the shared level.
 *
 * When a value is returned:
 * - `undefined` means "not in cache";
 * - `null` means "in cache, the value is known not to exist";
 * - any other value means "in cache, the value is X".
 *
 * Asynchronous writes (fetches, bulk loads, and the refreshes of the caches) are ordered by the
 * time they started: every entry carries a ticket, and a result that arrives after a write started
 * later is discarded, so a slow, older read can never overwrite a newer value. A key without an
 * entry keeps the ticket of its last entry in a fence while a read of it is in flight.
 */
export class LilypadCacheEngine<K extends LilypadCacheKey, V> {
  readonly id: string = `LilypadCache-${globalThis.crypto.randomUUID()}`;
  /** The name given in the options, or the id. */
  readonly name: string;

  /** The entries, by normalized key. Read it freely; every write goes through the methods. */
  // eslint-disable-next-line @typescript-eslint/consistent-generic-constructors -- a public field needs its type (isolatedDeclarations)
  readonly store: Map<string, LilypadCacheEntry<K, V>> = new Map();
  readonly defaultTtl: number;
  readonly defaultStaleWhileRevalidate: number;
  private readonly errorTtl: number;
  private readonly failureCooldown: number;
  private cleanupIntervalId?:
    (ReturnType<typeof setInterval> & { unref?: (() => void) | undefined }) | undefined;

  private protectedKeys = new Set<string>();
  /**
   * With `maxEntries`, the stored keys that can be evicted (not protected), least recently used
   * first. The protected keys stay out of it, so that an eviction never scans them.
   */
  private evictionOrder = new Set<string>();

  /** Undefined once disposed. */
  logger?: LilypadLibLogger | undefined;
  readonly platform?: LilypadPlatform | undefined;
  private shared?: LilypadSharedLevel<V> | undefined;
  private readonly maxEntries?: number | undefined;
  private readonly cleanupOnAccessEvery?: number | undefined;
  private lastCleanup = Date.now();
  private readonly tagPrefix: string;

  /** Bounds the fetches (`fetchTimeout`). */
  readonly flowControl: LilypadFlowControl;

  /** Source of the write tickets. */
  private lastTicket = 0;
  /**
   * Writes of missing keys with a ticket below this one are discarded: a completed load of the
   * whole source already holds data newer than theirs.
   */
  private ticketFloor = 0;
  /**
   * Tickets below which the reads of keys without an entry are discarded (normalized keys): set
   * when such a key is expired, or its entry removed, while a read of it is in flight, since that
   * read may predate the change. Removed once a value is stored, or once no read is in flight.
   */
  private fences = new Map<string, number>();
  /** Values of the shared level produced before this time are not adopted. */
  private sharedNotBefore = 0;
  /**
   * When the shared copy of each key without an entry was last invalidated (normalized keys, with
   * a shared level only): older copies are not adopted, even if their removal failed. The entries
   * carry the same mark as `invalidatedAt`. Forgotten after `invalidationMemory`.
   */
  private invalidatedMissing = new Map<string, number>();
  /**
   * How long an invalidation of a key without an entry is remembered: the default lifetime of a
   * shared copy fetched before it (TTL, fetch timeout and stale window).
   */
  private readonly invalidationMemory: number;
  private isDisposed = false;

  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  private failures = new Map<string, number>();
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  private refreshing = new Map<string, number>();
  /** The size of the bookkeeping maps that triggers their next sweep. */
  private nextBookkeepingSweep = BOOKKEEPING_SWEEP_SIZE;
  /** The fetches of `getOrSet` in flight, which the calls for the same key join. */
  private fetches = new LilypadReadFlights<LilypadCachedValueType<V>>();

  /** @throws If an option is not valid. */
  constructor(
    options: LilypadCacheEngineOptions<K, V> = {},
    private readonly hooks: LilypadCacheEngineHooks<K, V> = {}
  ) {
    const owner = 'LilypadCache';
    assertNumberOption(owner, 'ttl', options.ttl, 'positive');
    assertNumberOption(owner, 'staleWhileRevalidate', options.staleWhileRevalidate, 'non-negative');
    assertNumberOption(owner, 'failureCooldown', options.failureCooldown, 'non-negative');
    assertNumberOption(owner, 'maxEntries', options.maxEntries, 'positive-integer');
    assertNumberOption(owner, 'cleanupOnAccessEvery', options.cleanupOnAccessEvery, 'non-negative');
    // The durations given to timers must fit them: beyond 2^31 - 1 ms a timer fires at once
    assertNumberOption(owner, 'autoCleanupInterval', options.autoCleanupInterval, 'positive-delay');
    assertNumberOption(owner, 'errorTtl', options.errorTtl, 'non-negative');
    assertNumberOption(owner, 'fetchTimeout', options.fetchTimeout, 'positive-delay');
    assertNumberOption(owner, 'shared.timeout', options.shared?.timeout, 'positive-delay');
    assertNumberOption(owner, 'shared.refreshLockTtl', options.shared?.refreshLockTtl, 'positive');

    const ttl = options.ttl ?? DEFAULT_TTL;
    this.defaultTtl = ttl;
    // A transient error must not pin its fallback for longer than a regular value
    this.errorTtl = options.errorTtl ?? Math.min(ttl, DEFAULT_ERROR_TTL);
    this.defaultStaleWhileRevalidate = options.staleWhileRevalidate ?? 0;
    this.failureCooldown = options.failureCooldown ?? 0;
    this.logger = options.logger;
    this.platform = options.platform;
    this.name = options.name ?? this.id;
    this.maxEntries = options.maxEntries;
    this.cleanupOnAccessEvery = options.cleanupOnAccessEvery;
    this.tagPrefix = options.tagPrefix ?? 'lilypad';

    if (options.shared) {
      const store = options.shared.store ?? options.platform?.shared;
      if (!store) {
        throw new Error('LilypadCache: `shared` needs a `store`, or a `platform.shared` store.');
      }
      if (options.name === undefined) {
        throw new Error('LilypadCache: `name` is required with `shared`.');
      }
      this.shared = new LilypadSharedLevel<V>({
        store,
        codec: options.shared.codec,
        timeout: options.shared.timeout ?? DEFAULT_SHARED_TIMEOUT,
        refreshLockTtl: options.shared.refreshLockTtl,
        checkBeforeWrite: options.shared.checkBeforeWrite ?? false,
        name: this.name,
        tagPrefix: this.tagPrefix,
        platform: this.platform,
        warn: (message, detail) => this.log('warn', message, detail),
        onPlatformError: (error) => this.logPlatformError(error),
      });
    }

    const fetchTimeout = options.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT;
    this.flowControl = new LilypadFlowControl({ timeout: fetchTimeout });
    this.invalidationMemory = ttl + fetchTimeout + this.defaultStaleWhileRevalidate;

    if (options.autoCleanupInterval) {
      this.cleanupIntervalId = setInterval(() => this.purgeExpired(), options.autoCleanupInterval);
      // Do not keep the Node.js event loop alive
      this.cleanupIntervalId.unref?.();
    }

    this.log('debug', 'LilypadCache initialized');
  }

  /** Whether `dispose` was called: every write is then ignored. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Logs through the logger of the cache, with its name as the source. */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, detail?: unknown): void {
    libLog(this.logger, level, this.name, message, detail);
  }

  /** Logs a failure of the platform function that keeps the instance alive for background work. */
  logPlatformError(error: unknown): void {
    this.log(
      'warn',
      'The platform could not keep the instance alive for background work (it still runs):',
      error
    );
  }

  private createExpirationTime(ttl?: number): number {
    return Date.now() + (ttl ?? this.defaultTtl);
  }

  /** Normalizes a key to the string form used by the store and by the protected keys. */
  normalizeKey(key: K): string {
    return String(key);
  }

  /** Takes a write ticket. */
  nextTicket(): number {
    return ++this.lastTicket;
  }

  /**
   * Starts an asynchronous read of the source: every path that reads the source and stores the
   * result must go through it, so that a slow, older read never overwrites a newer value.
   */
  beginRead(): LilypadCacheRead<K, V> {
    const ticket = this.nextTicket();
    const startedAt = Date.now();
    return {
      ticket,
      startedAt,
      store: (key, value, ttl) => this.setIfNewer(key, value, ttl, ticket, startedAt),
      storeFetched: (key, value, ttl, staleWhileRevalidate) =>
        this.storeFetched(key, value, ttl, ticket, startedAt, staleWhileRevalidate),
    };
  }

  /**
   * The ticket a read must exceed to store a value for the key: the one of its entry, or else the
   * floor of the missing keys and the fence of the key. A read in flight with a lower ticket may
   * return an outdated value: new callers must not join it.
   */
  currentTicket(normalizedKey: string): number {
    const entry = this.store.get(normalizedKey);
    if (entry) {
      return entry.ticket;
    }
    return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0);
  }

  /** Whether a read of the key is in flight: a fetch of `getOrSet`, or a read of the owner. */
  hasReadInFlight(normalizedKey: string): boolean {
    return (
      this.fetches.has(normalizedKey) || (this.hooks.hasReadInFlight?.(normalizedKey) ?? false)
    );
  }

  /**
   * @param newValue - False when the entry keeps its value (e.g. it is only expired): then
   * `onValueStored` is not called, and the entry keeps its place in the order of use.
   * @returns The stored entry, or `undefined` if the cache is disposed and nothing was stored.
   */
  private writeEntry(
    entry: LilypadCacheEntry<K, V>,
    newValue = true
  ): LilypadCacheEntry<K, V> | undefined {
    // A disposed cache stays empty, even when in-flight fetches complete
    if (this.isDisposed) {
      return undefined;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    // A value produced before the last invalidation of the key (e.g. a stale fallback) keeps its
    // mark, so that the shared copies of that time are still refused
    const invalidatedAt =
      this.store.get(normalizedKey)?.invalidatedAt ?? this.invalidatedMissing.get(normalizedKey);
    const stored =
      entry.invalidatedAt === undefined &&
      invalidatedAt !== undefined &&
      entry.fetchedAt < invalidatedAt
        ? { ...entry, invalidatedAt }
        : entry;
    this.store.set(normalizedKey, stored);
    if (newValue || !this.evictionOrder.has(normalizedKey)) {
      this.markUsed(normalizedKey);
    }
    // The ticket and the mark of the entry now order the reads of the key
    this.fences.delete(normalizedKey);
    this.invalidatedMissing.delete(normalizedKey);
    if (newValue) {
      this.hooks.onValueStored?.(stored);
    }
    this.evictOverflow();
    return stored;
  }

  /**
   * Removes an entry from the store. A read of the key in flight may have started before the entry
   * was last written or expired: the ticket of the entry stays as the fence of the key, so that
   * such a read cannot store its older value once the entry is gone.
   */
  private dropEntry(normalizedKey: string, entry: LilypadCacheEntry<K, V>) {
    this.store.delete(normalizedKey);
    this.evictionOrder.delete(normalizedKey);
    if (entry.invalidatedAt !== undefined) {
      this.rememberInvalidation(normalizedKey, entry.invalidatedAt);
    }
    if (this.hasReadInFlight(normalizedKey)) {
      this.fences.set(normalizedKey, Math.max(entry.ticket, this.fences.get(normalizedKey) ?? 0));
      this.sweepBookkeepingIfLarge();
    }
  }

  /**
   * Remembers that the shared copies of a key without an entry, produced before `time`, are
   * outdated. Without a shared level there is nothing to refuse.
   */
  private rememberInvalidation(normalizedKey: string, time: number) {
    if (!this.shared) {
      return;
    }
    this.invalidatedMissing.set(
      normalizedKey,
      Math.max(time, this.invalidatedMissing.get(normalizedKey) ?? 0)
    );
    this.sweepBookkeepingIfLarge();
  }

  /** Removes the least recently used entries beyond `maxEntries`, sparing protected keys. */
  private evictOverflow() {
    if (this.maxEntries === undefined) {
      return;
    }
    let evicted = false;
    while (this.store.size > this.maxEntries) {
      const oldest = this.evictionOrder.values().next();
      if (oldest.done) {
        // Only protected keys are left
        break;
      }
      this.dropEntry(oldest.value, this.store.get(oldest.value)!);
      evicted = true;
    }
    if (evicted) {
      this.hooks.onEntriesIncomplete?.();
    }
  }

  /** Marks a stored key as the most recently used one, for `maxEntries`. */
  private markUsed(normalizedKey: string) {
    if (this.maxEntries !== undefined && !this.protectedKeys.has(normalizedKey)) {
      this.evictionOrder.delete(normalizedKey);
      this.evictionOrder.add(normalizedKey);
    }
  }

  /**
   * Writes to this instance only.
   *
   * @returns The stored entry, or `undefined` if the cache is disposed.
   */
  private writeLocal(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl?: number,
    origin: LilypadCacheEntryOrigin = 'source',
    fetchedAt: number = Date.now()
  ): LilypadCacheEntry<K, V> | undefined {
    return this.writeEntry({
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket: this.nextTicket(),
      origin,
    });
  }

  /**
   * Stores a value here and in the shared level (in the background), taking a new ticket: reads
   * started before it cannot overwrite it. Ignored once the cache is disposed.
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   * @throws {RangeError} If `ttl` is not a finite number (0 or less stores an expired value).
   */
  set(key: K, value: LilypadCachedValueType<V>, ttl?: number): void {
    assertNumberOption('LilypadCache', 'ttl', ttl, 'finite');
    this.cleanupOnAccess();
    const entry = this.writeLocal(key, value, ttl);
    if (entry) {
      this.writeShared(entry);
    }
  }

  /**
   * Extends the expiration of an entry that is known to be up to date, without a new ticket (its
   * value does not change). Nothing happens if the key has no entry.
   */
  extendExpiration(normalizedKey: string, expirationTime: number): void {
    const entry = this.store.get(normalizedKey);
    if (entry && !this.isDisposed) {
      this.store.set(normalizedKey, { ...entry, expirationTime });
    }
  }

  /**
   * Stores the result of an asynchronous read (or the fallback of a failed one), unless a write
   * that started later has already stored a value for the key.
   *
   * @returns `true` if the value was stored.
   */
  private setIfNewer(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number,
    fetchedAt: number,
    origin: LilypadCacheEntryOrigin = 'source'
  ): boolean {
    if (ticket <= this.currentTicket(this.normalizeKey(key))) {
      return false;
    }
    const entry = {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket,
      origin,
    };
    return this.writeEntry(entry) !== undefined;
  }

  /**
   * Stores a value just read from the source: in this instance (if no newer write happened) and
   * in the shared level. It also ends the key's failure cooldown.
   *
   * @returns `true` if the value was stored.
   */
  private storeFetched(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number,
    fetchedAt: number,
    staleWhileRevalidate?: number
  ): boolean {
    const normalizedKey = this.normalizeKey(key);
    if (this.failures.delete(normalizedKey) && this.failureCooldown > 0) {
      this.shared?.deleteFailure(normalizedKey);
    }
    if (!this.setIfNewer(key, value, ttl, ticket, fetchedAt)) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (entry) {
      this.writeShared(entry, staleWhileRevalidate);
    }
    return true;
  }

  /**
   * Returns the value of the key if it is cached and fresh, otherwise `undefined`. It reads the
   * memory of this instance only: `getOrSet` also reads the shared level.
   *
   * @param options.removeExpired - If true, an expired value is also removed. Defaults to false, so
   * that the old value stays available as a fallback (`onError: { fallback: 'stale' }`).
   */
  get(
    key: K,
    options: { removeExpired?: boolean | undefined } = {}
  ): LilypadCachedValueType<V> | undefined {
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && !isLilypadEntryStale(entry)) {
      this.markUsed(normalizedKey);
      return entry.value;
    }
    if (options.removeExpired) {
      this.removeEntry(normalizedKey);
    }
    return undefined;
  }

  /**
   * Tells whether the key is cached, and whether its value is fresh or expired, without side
   * effects (no cleanup, no change of the order of use).
   */
  peek(key: K): LilypadCachePeek<V> {
    const entry = this.store.get(this.normalizeKey(key));
    if (!entry) {
      return { type: 'miss' };
    }
    return {
      type: isLilypadEntryStale(entry) ? 'expired' : 'hit',
      value: entry.value,
      expirationTime: entry.expirationTime,
    };
  }

  /**
   * The result of a failed fetch for one caller: the fallback chosen with its own `onError`
   * options, cached in this instance only for `onError.ttl` (or the cache's `errorTtl`). The stale
   * value returned as it is keeps its age: it is not a newer value.
   *
   * A fresh value written while the fetch was failing (e.g. by `set`, or by a write of the owner)
   * is newer than anything the fetch could have returned: it is returned and kept as it is.
   *
   * The fallback is cached only if the key did not change since the call started (`attempt`): a
   * newer fetch, started after an invalidation, must not lose to the fallback of an older one.
   *
   * @param seen - The entry of the key before the fetch: a different entry was written since.
   * @param attempt - The ticket taken when the call started to fetch.
   * @throws The original error if no fallback value is determined.
   */
  private fallbackResult(
    error: unknown,
    options: LilypadCacheGetOptions<K, V>,
    key: K,
    seen: LilypadCacheEntry<K, V> | undefined,
    attempt: number
  ): LilypadCacheResult<V> {
    // The current entry, not the one seen before the fetch: it may have been updated meanwhile
    const current = this.store.get(this.normalizeKey(key));
    if (
      current &&
      current !== seen &&
      !isLilypadEntryStale(current) &&
      current.origin !== 'fallback'
    ) {
      return { value: current.value, status: 'L1-HIT', refreshFailed: false };
    }
    const stale = current && { value: current.value, fetchedAt: current.fetchedAt };
    const fallback = options.onError?.fallback;
    const value =
      fallback === 'stale' ? stale?.value : fallback?.({ key, error, stale: stale ?? undefined });

    if (value === undefined) {
      throw error;
    }
    const fetchedAt = stale?.value === value ? stale.fetchedAt : Date.now();
    const ttl = options.onError?.ttl ?? this.errorTtl;
    this.setIfNewer(key, value, ttl, attempt, fetchedAt, 'fallback');
    return { value, status: 'MISS', refreshFailed: true };
  }

  /**
   * @returns `true` if a `getOrSet` fetch of the key is in flight that a new call would join: one
   * started after the last change of the key.
   */
  private isFetchInFlight(key: K): boolean {
    const normalizedKey = this.normalizeKey(key);
    return this.fetches.join(normalizedKey, this.currentTicket(normalizedKey)) !== undefined;
  }

  private inCooldown(normalizedKey: string): boolean {
    const failedAt = this.failures.get(normalizedKey);
    return (
      this.failureCooldown > 0 &&
      failedAt !== undefined &&
      Date.now() - failedAt < this.failureCooldown
    );
  }

  private recordFailure(normalizedKey: string) {
    // e.g. a fetch cut short by the shutdown: it must not put the other instances in cooldown
    if (this.isDisposed) {
      return;
    }
    const failedAt = Date.now();
    this.failures.set(normalizedKey, failedAt);
    this.sweepBookkeepingIfLarge();
    if (this.failureCooldown > 0) {
      this.shared?.writeFailure(normalizedKey, failedAt, this.failureCooldown);
    }
  }

  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it, and tells where the
   * value comes from and whether the last fetch failed. Concurrent calls for the same key share one
   * fetch; the `onError` options still apply separately to each caller.
   *
   * The lookup order is: memory of this instance, shared level, stale value (returned at once and
   * refreshed in the background, within `staleWhileRevalidate`), fetch.
   *
   * A fallback cached after a failed fetch is returned with `refreshFailed: true` until it
   * expires. With `failureCooldown`, it is also refreshed in the background once the cooldown
   * is over.
   *
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
   * @throws {RangeError} If a numeric option of the call is not valid.
   * @throws {LilypadDisposedError} If the cache is disposed while the shared level is read.
   */
  async getOrSetDetailed(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    // Checked before any fetch: a timer given NaN, or more than 2^31 - 1 ms, fires at once
    assertNumberOption('LilypadCache', 'timeout', options.timeout, 'positive-delay');
    // A NaN would never expire, an infinite stale window would serve invalidated values
    assertNumberOption('LilypadCache', 'ttl', options.ttl, 'finite');
    assertNumberOption(
      'LilypadCache',
      'staleWhileRevalidate',
      options.staleWhileRevalidate,
      'non-negative'
    );
    assertNumberOption('LilypadCache', 'onError.ttl', options.onError?.ttl, 'finite');
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);

    if (!options.skipCache) {
      const local = this.store.get(normalizedKey);
      if (local && !isLilypadEntryStale(local)) {
        this.markUsed(normalizedKey);
        return this.freshHit(key, local, 'L1-HIT', valueFn, options);
      }

      let refreshLocked = false;
      if (this.shared) {
        const read = this.beginRead();
        const remote = await this.shared.read(normalizedKey, this.failureCooldown > 0);
        if (this.isDisposed) {
          // Nothing may be fetched for a disposed cache
          throw new LilypadDisposedError(`LilypadCache "${this.name}"`);
        }
        refreshLocked = remote.locked;
        if (remote.failedAt !== undefined) {
          this.failures.set(
            normalizedKey,
            Math.max(remote.failedAt, this.failures.get(normalizedKey) ?? 0)
          );
        }
        const adopted = remote.entry && this.adoptShared(key, remote.entry, read.ticket);
        const current = this.store.get(normalizedKey);
        if (current && !isLilypadEntryStale(current)) {
          return this.freshHit(key, current, adopted ? 'L2-HIT' : 'L1-HIT', valueFn, options);
        }
      }

      const current = this.store.get(normalizedKey);
      const staleWindow = options.staleWhileRevalidate ?? this.defaultStaleWhileRevalidate;
      if (current && staleWindow > 0 && Date.now() < current.expirationTime + staleWindow) {
        this.refreshInBackground(key, valueFn, options, refreshLocked);
        const failedAt = this.failures.get(normalizedKey);
        return {
          value: current.value,
          status: 'STALE',
          refreshFailed: failedAt !== undefined && failedAt >= current.fetchedAt,
        };
      }
    }

    // Every write replaces the entry object: another one after the fetch was written meanwhile
    const seen = this.store.get(normalizedKey);
    // Orders the fallback of this call: a change of the key after this point supersedes it
    const attempt = this.nextTicket();
    if (this.inCooldown(normalizedKey) && !this.isFetchInFlight(key)) {
      const error = new LilypadCacheCooldownError(normalizedKey, this.failureCooldown);
      return this.fallbackResult(error, options, key, seen, attempt);
    }
    try {
      const value = await this.fetchAndStore(key, valueFn, options);
      return { value, status: 'MISS', refreshFailed: false };
    } catch (error) {
      return this.fallbackResult(error, options, key, seen, attempt);
    }
  }

  /**
   * The result of a fresh entry. A fallback is reported as such, and refreshed in the background
   * once the failure cooldown is over: otherwise it would hide the recovery of the source for as
   * long as its TTL.
   */
  private freshHit(
    key: K,
    entry: LilypadCacheEntry<K, V>,
    status: 'L1-HIT' | 'L2-HIT',
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V>
  ): LilypadCacheResult<V> {
    const fallback = entry.origin === 'fallback';
    if (fallback && this.failureCooldown > 0) {
      this.refreshInBackground(key, valueFn, options, false);
    }
    return { value: entry.value, status, refreshFailed: fallback };
  }

  /**
   * Fetches the value and stores it. A fetch of the key in flight is joined, unless it started
   * before the last change of the key (an invalidation, a removal, a newer write): it may return
   * the old value, so another fetch starts.
   */
  private fetchAndStore(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V>
  ): Promise<LilypadCachedValueType<V>> {
    const normalizedKey = this.normalizeKey(key);
    const joined = this.fetches.join(normalizedKey, this.currentTicket(normalizedKey));
    if (joined) {
      return joined;
    }
    const read = this.beginRead();
    const fetching = this.flowControl
      .executeWithTimeout(async (signal) => {
        const value = await valueFn(signal);
        // After a timeout the caller already got an error/fallback: a late result is not cached
        if (!signal.aborted) {
          read.storeFetched(key, value, options.ttl, options.staleWhileRevalidate);
        }
        return value;
      }, options.timeout)
      .catch((error: unknown) => {
        // Once per fetch, while the fallback is chosen per caller in fallbackResult
        this.log('error', `Error fetching cache key "${normalizedKey}":`, error);
        this.recordFailure(normalizedKey);
        throw error;
      });
    // Registered before the callers get the promise: it is forgotten before they continue
    this.fetches.start([normalizedKey], read.ticket, fetching);
    return fetching;
  }

  /**
   * Refreshes a stale key after the response (or at once, without `platform.afterResponse`),
   * unless it is already being refreshed, locked by another instance, or in its failure cooldown.
   */
  private refreshInBackground(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V>,
    lockedByOtherInstance: boolean
  ) {
    const normalizedKey = this.normalizeKey(key);
    if (
      lockedByOtherInstance ||
      Date.now() - (this.refreshing.get(normalizedKey) ?? -Infinity) < STUCK_REFRESH_AFTER ||
      this.isFetchInFlight(key) ||
      this.inCooldown(normalizedKey)
    ) {
      return;
    }
    const scheduledAt = Date.now();
    this.refreshing.set(normalizedKey, scheduledAt);
    this.sweepBookkeepingIfLarge();
    runAfterResponse(
      this.platform,
      async () => {
        // Disposed before the platform ran it: nothing may be fetched any more
        if (this.isDisposed) {
          return;
        }
        const owner = await this.shared?.acquireLock(normalizedKey);
        try {
          await this.fetchAndStore(key, valueFn, options);
        } finally {
          // A newer refresh may have replaced a stuck one meanwhile
          if (this.refreshing.get(normalizedKey) === scheduledAt) {
            this.refreshing.delete(normalizedKey);
          }
          if (owner) {
            await this.shared?.releaseLock(normalizedKey, owner);
          }
        }
      },
      // The fetch error has already been logged by fetchAndStore
      () => {},
      (error) => this.logPlatformError(error)
    );
  }

  // SHARED LEVEL

  /**
   * Copies an entry of the shared level into this instance, if it is newer than the local one,
   * produced after the local one was invalidated, and no local write started after the read of
   * the shared level.
   *
   * @returns `true` if the entry was copied.
   */
  private adoptShared(key: K, remote: LilypadSharedEntry<V>, ticket: number): boolean {
    const normalizedKey = this.normalizeKey(key);
    const current = this.store.get(normalizedKey);
    if (current && current.fetchedAt >= remote.fetchedAt) {
      return false;
    }
    // A copy read before the invalidation, whose removal from the shared level failed, is still
    // under way, or was undone by another instance
    const invalidatedAt = current
      ? current.invalidatedAt
      : this.invalidatedMissing.get(normalizedKey);
    if (invalidatedAt !== undefined && remote.fetchedAt < invalidatedAt) {
      return false;
    }
    if (remote.fetchedAt < this.sharedNotBefore) {
      return false;
    }
    if (ticket <= this.currentTicket(normalizedKey)) {
      return false;
    }
    const stored = this.writeEntry({
      key,
      value: remote.value,
      expirationTime: remote.expiresAt,
      fetchedAt: remote.fetchedAt,
      ticket,
      origin: 'shared',
    });
    return stored !== undefined;
  }

  /**
   * Writes an entry to the shared level in the background, kept through the stale window: the
   * cache's, or a longer one asked by the read that fetched it.
   */
  private writeShared(entry: LilypadCacheEntry<K, V>, staleWhileRevalidate = 0) {
    const staleWindow = Math.max(staleWhileRevalidate, this.defaultStaleWhileRevalidate);
    this.shared?.write(
      this.normalizeKey(entry.key),
      { value: entry.value, fetchedAt: entry.fetchedAt, expiresAt: entry.expirationTime },
      entry.expirationTime + staleWindow - Date.now()
    );
  }

  /**
   * Removes a key from the shared level, in the background. If the key has no entry, the copies
   * produced before now are no longer adopted, even if the removal fails or lands after a read
   * (an entry is marked by `expire` instead).
   */
  deleteShared(key: K): void {
    const normalizedKey = this.normalizeKey(key);
    if (!this.store.has(normalizedKey)) {
      this.rememberInvalidation(normalizedKey, Date.now());
    }
    this.shared?.delete(normalizedKey);
  }

  // INVALIDATION EVENTS

  /**
   * Sends an invalidation event to `platform.onInvalidate`, in the background.
   *
   * @param options.wholeCache - The whole cache changed (e.g. a table was emptied): the event is
   * sent even without keys, and its tags always include the tag of the cache.
   */
  emitInvalidation(
    source: LilypadInvalidationEvent['source'],
    keys: K[],
    options: { wholeCache?: boolean | undefined } = {}
  ): void {
    const onInvalidate = this.platform?.onInvalidate;
    if (!onInvalidate || (keys.length === 0 && !options.wholeCache)) {
      return;
    }
    const normalizedKeys = keys.map((key) => this.normalizeKey(key));
    const event: LilypadInvalidationEvent = {
      source,
      cache: this.name,
      keys: normalizedKeys,
      tags: lilypadCacheTags(this.tagPrefix, this.name, normalizedKeys),
    };
    runInBackground(
      this.platform,
      Promise.resolve().then(() => onInvalidate(event)),
      (error) => this.log('error', 'Error in onInvalidate:', error),
      (error) => this.logPlatformError(error)
    );
  }

  // LOADS OF THE WHOLE SOURCE

  /**
   * Replaces the content of the cache with a complete load of the source, started with `read`:
   * the loaded entries are stored (unless written since), the others are removed (protected keys
   * are only expired), and the reads of missing keys started before the load are discarded. The
   * entries written after the load started are kept: they are newer than its data.
   */
  replaceEntries(
    read: LilypadCacheRead<K, V>,
    data: Iterable<readonly [K, LilypadCachedValueType<V>]>
  ): void {
    const incoming = new Map<string, readonly [K, LilypadCachedValueType<V>]>();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    if (this.maxEntries !== undefined && incoming.size > this.maxEntries) {
      this.log(
        'warn',
        `Loaded ${incoming.size} entries, more than maxEntries (${this.maxEntries}): the cache cannot hold them all.`
      );
    }
    // A copy of the entries, which the loop removes or rewrites
    for (const [normalizedKey, entry] of [...this.store]) {
      // Entries written after the load started are newer than its data; incoming keys are overwritten below
      if (entry.ticket > read.ticket || incoming.has(normalizedKey)) {
        continue;
      }
      if (!this.removeEntry(normalizedKey)) {
        this.expireNormalized(normalizedKey); // protected keys are kept, but marked as stale
      }
    }
    for (const [key, value] of incoming.values()) {
      read.store(key, value);
    }
    this.ticketFloor = Math.max(this.ticketFloor, read.ticket);
  }

  /** Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out. */
  getMany(keys: Iterable<K>): Map<K, LilypadCachedValueType<V>> {
    const result = new Map<K, LilypadCachedValueType<V>>();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        result.set(key, value);
      }
    }
    return result;
  }

  /**
   * Returns every fresh entry, keyed by the key it was stored with (e.g. a number stays a number).
   * Expired entries are left out.
   */
  entries(): Map<K, LilypadCachedValueType<V>> {
    const result = new Map<K, LilypadCachedValueType<V>>();
    for (const entry of this.store.values()) {
      if (!isLilypadEntryStale(entry)) {
        result.set(entry.key, entry.value);
      }
    }
    return result;
  }

  // PROTECTED KEYS

  /** Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed. */
  addProtectedKeys(keys: K[]): void {
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      this.protectedKeys.add(normalizedKey);
      // Never evicted
      this.evictionOrder.delete(normalizedKey);
    }
  }

  removeProtectedKeys(keys: K[]): void {
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      if (this.protectedKeys.delete(normalizedKey) && this.store.has(normalizedKey)) {
        this.markUsed(normalizedKey);
      }
    }
    // The keys can be evicted again: the store may hold more than `maxEntries`
    this.evictOverflow();
  }

  // INVALIDATION AND REMOVAL

  /**
   * Invalidates the entry of the key: it is marked as expired (never served as a stale value, but
   * kept as a fallback for `onError: { fallback: 'stale' }`), a fetch of the key already in flight
   * is not cached, the key is removed from the shared level, and `platform.onInvalidate` receives a
   * `manual` event.
   */
  invalidate(key: K): void {
    this.markInvalid(key);
    this.emitInvalidation('manual', [key]);
  }

  /**
   * The effect of `invalidate` on the data, without the invalidation event: expires the entry in
   * this instance and removes it from the shared level.
   */
  markInvalid(key: K): void {
    this.expire(key);
    this.deleteShared(key);
  }

  /**
   * Marks an entry as expired, keeping its value as a fallback. It is never served as a stale
   * value either. Only this instance is affected. A read of the key already in flight is
   * discarded, since it may predate the change.
   */
  expire(key: K): void {
    this.expireNormalized(this.normalizeKey(key));
  }

  private expireNormalized(normalizedKey: string) {
    const entry = this.store.get(normalizedKey);
    if (!entry) {
      if (this.hasReadInFlight(normalizedKey)) {
        this.fences.set(normalizedKey, this.nextTicket());
        this.sweepBookkeepingIfLarge();
      }
      return;
    }
    // Even if already invalidated: a read started since the last change may predate this one
    this.writeEntry(
      { ...entry, expirationTime: 0, ticket: this.nextTicket(), invalidatedAt: Date.now() },
      false
    );
  }

  /**
   * Expires every entry and discards the results of the reads started before (fetches and loads):
   * the source may have changed in any way.
   */
  expireEverything(): void {
    for (const normalizedKey of [...this.store.keys()]) {
      this.expireNormalized(normalizedKey);
    }
    this.ticketFloor = Math.max(this.ticketFloor, this.nextTicket());
    this.fences.clear();
    this.hooks.onEntriesIncomplete?.();
  }

  /**
   * From now on, the values of the shared level produced before `time` are ignored (e.g. the
   * source was emptied at that time, and the shared level may still hold older copies).
   */
  rejectSharedBefore(time: number): void {
    this.sharedNotBefore = Math.max(this.sharedNotBefore, time);
  }

  /**
   * Deletes the key from the cache, and from the shared level. To cache the key as "does not
   * exist" instead, write `null`.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   */
  delete(key: K, options: { force?: boolean | undefined } = {}): boolean {
    const deleted = this.removeEntry(this.normalizeKey(key), options.force);
    if (deleted) {
      this.deleteShared(key);
    }
    return deleted;
  }

  /** @returns `false` if the key is protected (and `force` is not set). */
  private removeEntry(normalizedKey: string, force = false): boolean {
    if (this.protectedKeys.has(normalizedKey) && !force) {
      return false;
    }
    const entry = this.store.get(normalizedKey);
    if (entry) {
      this.dropEntry(normalizedKey, entry);
    }
    return true;
  }

  /**
   * Removes all entries from the memory of this instance (not from the shared level). Protected
   * keys are kept, unless `force` is set.
   */
  clear(options: { force?: boolean | undefined } = {}): void {
    for (const normalizedKey of [...this.store.keys()]) {
      this.removeEntry(normalizedKey, options.force);
    }
    this.hooks.onEntriesIncomplete?.();
  }

  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window of
   * the cache, and the bookkeeping that no longer serves.
   *
   * @param options.force - If true, also removes the expired protected keys.
   */
  purgeExpired(options: { force?: boolean | undefined } = {}): void {
    if (this.isDisposed) {
      return;
    }
    const now = Date.now();
    for (const [normalizedKey, entry] of [...this.store]) {
      if (now >= entry.expirationTime + this.defaultStaleWhileRevalidate) {
        this.removeEntry(normalizedKey, options.force);
      }
    }
    this.pruneBookkeeping(now);
  }

  /** Removes the failures, refreshes, fences and invalidations that no longer serve. */
  private pruneBookkeeping(now: number) {
    for (const [normalizedKey, failedAt] of this.failures) {
      // The failure of a cached key still tells a stale read that its refresh failed
      if (now - failedAt >= this.failureCooldown && !this.store.has(normalizedKey)) {
        this.failures.delete(normalizedKey);
      }
    }
    // Refreshes that never started (e.g. work after the response dropped by the platform)
    for (const [normalizedKey, scheduledAt] of this.refreshing) {
      if (now - scheduledAt >= STUCK_REFRESH_AFTER) {
        this.refreshing.delete(normalizedKey);
      }
    }
    for (const normalizedKey of this.fences.keys()) {
      if (!this.hasReadInFlight(normalizedKey)) {
        this.fences.delete(normalizedKey);
      }
    }
    for (const [normalizedKey, invalidatedAt] of this.invalidatedMissing) {
      if (now - invalidatedAt >= this.invalidationMemory) {
        this.invalidatedMissing.delete(normalizedKey);
      }
    }
  }

  /**
   * Prunes the bookkeeping once it has doubled since the last time, so that it stays bounded when
   * `purgeExpired` never runs, at an amortized constant cost. Called after each map grows.
   */
  private sweepBookkeepingIfLarge() {
    const size = () =>
      Math.max(
        this.failures.size,
        this.refreshing.size,
        this.fences.size,
        this.invalidatedMissing.size
      );
    if (size() < this.nextBookkeepingSweep) {
      return;
    }
    this.pruneBookkeeping(Date.now());
    this.nextBookkeepingSweep = Math.max(BOOKKEEPING_SWEEP_SIZE, 2 * size());
  }

  /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
  private cleanupOnAccess() {
    if (this.cleanupOnAccessEvery === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCleanup >= this.cleanupOnAccessEvery) {
      this.lastCleanup = now;
      this.purgeExpired();
    }
  }

  /**
   * Stops the cleanup timer and removes every entry: every later write is ignored, including the
   * ones of fetches still in flight. The shared level is left untouched. Calling it again does
   * nothing.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.clear({ force: true });
    this.logger = undefined;
    this.fences.clear();
    this.refreshing.clear();
    this.failures.clear();
    this.invalidatedMissing.clear();
    this.isDisposed = true;
  }
}
