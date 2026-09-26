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
  type LilypadCacheSyncFn,
  type LilypadCacheValueFn,
} from '@/cache/LilypadCacheTypes';
import {
  lilypadCacheTags,
  LilypadSharedLevel,
  type LilypadSharedEntry,
} from '@/cache/LilypadSharedLevel';
import { LilypadFlowControl } from '@/flow/LilypadFlowControl';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  runAfterResponse,
  runInBackground,
  type LilypadInvalidationEvent,
  type LilypadPlatform,
} from '@/platform/LilypadPlatform';

/** Whether an entry has reached its expiration time. */
function isStale(entry: { expirationTime: number }): boolean {
  return Date.now() >= entry.expirationTime;
}

const DEFAULT_TTL = 60_000;
const DEFAULT_ERROR_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_FETCH_TIMEOUT = 5000;
const DEFAULT_BULK_SYNC_TIMEOUT = 30_000;
const DEFAULT_SHARED_TIMEOUT = 300;
/**
 * A background refresh scheduled longer ago than this no longer blocks new ones: it may never
 * have started (e.g. the platform dropped the work scheduled after the response).
 */
const STUCK_REFRESH_AFTER = 60_000;

/**
 * The engine of {@link LilypadCache} and `LilypadDbCache`: an in-memory, TTL-based cache with an
 * optional shared level, stale-while-revalidate, a failure cooldown, protected keys, and a bulk
 * sync.
 *
 * Its public methods only read, expire or remove entries. The methods that write values (`set`,
 * `getOrSet`, `bulkSync`...) are protected: `LilypadCache` makes them public, while
 * `LilypadDbCache` keeps them internal, so that its values always come from its table.
 *
 * When a value is returned:
 * - `undefined` means "not in cache";
 * - `null` means "in cache, the value is known not to exist";
 * - any other value means "in cache, the value is X".
 *
 * Asynchronous writes (fetches, bulk syncs, and the refreshes of subclasses) are ordered by the
 * time they started: every entry carries a ticket, and a result that arrives after a write started
 * later is discarded, so a slow, older read can never overwrite a newer value. A key without an
 * entry keeps the ticket of its last entry in a fence while a read of it is in flight.
 *
 * A disposed cache ignores every internal write (fetches still in flight cannot fill it again),
 * and its public methods, except `dispose`, throw.
 */
export abstract class LilypadCacheCore<K extends LilypadCacheKey, V> {
  public readonly id = `LilypadCache-${globalThis.crypto.randomUUID()}`;
  /** The name given in the options, or the id. */
  public readonly name: string;

  protected store: Map<string, LilypadCacheEntry<K, V>> = new Map();
  protected readonly defaultTtl: number;
  protected readonly errorTtl: number;
  protected readonly bulkSyncTtl: number;
  protected readonly defaultStaleWhileRevalidate: number;
  protected readonly failureCooldown: number;
  private cleanupIntervalId?: ReturnType<typeof setInterval> & { unref?: () => void };

  protected protectedKeys: Set<string> = new Set();
  /**
   * With `maxEntries`, the stored keys that can be evicted (not protected), least recently used
   * first. The protected keys stay out of it, so that an eviction never scans them.
   */
  private evictionOrder = new Set<string>();

  protected logger?: LilypadLibLogger;
  protected platform?: LilypadPlatform;
  private shared?: LilypadSharedLevel<V>;
  private readonly maxEntries?: number;
  private readonly cleanupOnAccessEvery?: number;
  private lastCleanup = Date.now();
  private readonly tagPrefix: string;

  protected readonly flowControl: LilypadFlowControl;
  protected readonly bulkSyncFlowControl: LilypadFlowControl;

  /**
   * When the last bulk sync stops counting as fresh. `entries()` returns every entry of the source
   * only while it is fresh.
   */
  protected bulkSyncExpirationTime: number = 0;
  protected bulkSyncFn?: LilypadCacheSyncFn<K, V>;

  /** Source of the write tickets. */
  private lastTicket = 0;
  /**
   * Writes of missing keys with a ticket below this one are discarded: a completed bulk sync
   * already holds data newer than theirs.
   */
  private ticketFloor = 0;
  /** Ticket of the last bulk sync invalidation, which a bulk sync started earlier must not undo. */
  private bulkSyncInvalidationTicket = 0;
  /**
   * Tickets below which the reads of keys without an entry are discarded (normalized keys): set
   * when such a key is expired, or its entry removed, while a read of it is in flight, since that
   * read may predate the change. Removed once a value is stored, or once no read is in flight.
   */
  private fences = new Map<string, number>();
  /** Values of the shared level produced before this time are not adopted. */
  private sharedNotBefore = 0;
  protected disposed = false;

  /** When the last fetch of each key failed (normalized keys), for `failureCooldown`. */
  private failures = new Map<string, number>();
  /** Keys whose background refresh is scheduled or running, with the time it was scheduled. */
  private refreshing = new Map<string, number>();

  protected constructor(options: LilypadCacheOptions<K, V> = {}) {
    const owner = 'LilypadCache';
    assertNumberOption(owner, 'ttl', options.ttl, 'positive');
    assertNumberOption(owner, 'staleWhileRevalidate', options.staleWhileRevalidate, 'non-negative');
    assertNumberOption(owner, 'failureCooldown', options.failureCooldown, 'non-negative');
    assertNumberOption(owner, 'maxEntries', options.maxEntries, 'positive-integer');
    assertNumberOption(owner, 'cleanupOnAccessEvery', options.cleanupOnAccessEvery, 'non-negative');
    assertNumberOption(owner, 'autoCleanupInterval', options.autoCleanupInterval, 'positive');
    assertNumberOption(owner, 'errorTtl', options.errorTtl, 'non-negative');
    assertNumberOption(owner, 'fetchTimeout', options.fetchTimeout, 'positive');
    assertNumberOption(owner, 'bulkSync.ttl', options.bulkSync?.ttl, 'non-negative');
    assertNumberOption(owner, 'bulkSync.timeout', options.bulkSync?.timeout, 'positive');
    assertNumberOption(owner, 'shared.timeout', options.shared?.timeout, 'positive');
    assertNumberOption(owner, 'shared.refreshLockTtl', options.shared?.refreshLockTtl, 'positive');

    const ttl = options.ttl ?? DEFAULT_TTL;
    this.defaultTtl = ttl;
    this.bulkSyncTtl = options.bulkSync?.ttl ?? ttl;
    this.bulkSyncFn = options.bulkSync?.fn;
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
        warn: (...message) => libLog(this.logger, 'warn', this.name, ...message),
      });
    }

    this.flowControl = new LilypadFlowControl({
      timeout: options.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT,
    });
    this.bulkSyncFlowControl = new LilypadFlowControl({
      timeout: options.bulkSync?.timeout ?? DEFAULT_BULK_SYNC_TIMEOUT,
    });

    if (options.autoCleanupInterval) {
      this.cleanupIntervalId = setInterval(() => this.purgeEntries(), options.autoCleanupInterval);
      // Do not keep the Node.js event loop alive
      this.cleanupIntervalId.unref?.();
    }

    libLog(this.logger, 'debug', this.name, `LilypadCache initialized`);
  }

  private createExpirationTime(ttl?: number): number {
    return Date.now() + (ttl ?? this.defaultTtl);
  }

  /** Normalizes a key to the string form used by the store and by the protected keys. */
  protected normalizeKey(key: K): string {
    return String(key);
  }

  /** Takes a write ticket. */
  protected nextTicket(): number {
    return ++this.lastTicket;
  }

  /**
   * Starts an asynchronous read of the source: every path that reads the source and stores the
   * result must go through it, so that a slow, older read never overwrites a newer value.
   */
  protected beginRead(): LilypadCacheRead<K, V> {
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
   * floor of the missing keys and the fence of the key.
   */
  private currentTicket(normalizedKey: string): number {
    const entry = this.store.get(normalizedKey);
    if (entry) {
      return entry.ticket;
    }
    return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0);
  }

  /**
   * Whether a read of the key is in flight. Subclasses that read the source in other ways add
   * their own reads.
   */
  protected hasReadInFlight(normalizedKey: string): boolean {
    return this.flowControl.isInFlight(this.getOrSetFlightId(normalizedKey));
  }

  /**
   * @param newValue - False when the entry keeps its value (e.g. it is only expired): then
   * {@link onValueStored} is not called.
   * @returns `false` if the cache is disposed, and the entry was not stored.
   */
  private writeEntry(entry: LilypadCacheEntry<K, V>, newValue: boolean = true): boolean {
    // A disposed cache stays empty, even when in-flight fetches complete
    if (this.disposed) {
      return false;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    this.store.set(normalizedKey, entry);
    this.markUsed(normalizedKey);
    // The ticket of the entry now orders the reads of the key
    this.fences.delete(normalizedKey);
    if (newValue) {
      this.onValueStored(entry);
      // Otherwise entries() would leave the key out while the bulk sync still counts as fresh
      if (entry.expirationTime < this.bulkSyncExpirationTime) {
        this.forceNextBulkSync();
      }
    }
    this.evictOverflow();
    return true;
  }

  /**
   * Called each time a value is stored in this instance (not when an entry is only expired or
   * removed). Subclasses override it to follow the values; it must not write to the cache.
   */
  protected onValueStored(_entry: LilypadCacheEntry<K, V>): void {}

  /**
   * Removes an entry from the store. A read of the key in flight may have started before the entry
   * was last written or expired: the ticket of the entry stays as the fence of the key, so that
   * such a read cannot store its older value once the entry is gone.
   */
  private dropEntry(normalizedKey: string, entry: LilypadCacheEntry<K, V>) {
    if (this.hasReadInFlight(normalizedKey)) {
      this.fences.set(normalizedKey, Math.max(entry.ticket, this.fences.get(normalizedKey) ?? 0));
    }
    this.store.delete(normalizedKey);
    this.evictionOrder.delete(normalizedKey);
  }

  /**
   * Removes the least recently used entries beyond `maxEntries`, sparing protected keys. An
   * eviction forces the next bulk sync, since `entries()` would no longer return the evicted keys.
   */
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
      this.forceNextBulkSync();
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
    const entry = {
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket: this.nextTicket(),
      origin,
    };
    return this.writeEntry(entry) ? entry : undefined;
  }

  /**
   * Stores a value here and in the shared level, taking a new ticket (reads started before it
   * cannot overwrite it). Ignored once the cache is disposed.
   */
  protected setValue(key: K, value: LilypadCachedValueType<V>, ttl?: number) {
    const entry = this.writeLocal(key, value, ttl);
    if (entry) {
      this.writeShared(entry);
    }
  }

  /**
   * Stores a value in the cache, and in the shared level (in the background).
   *
   * @param ttl - Time to live in milliseconds; defaults to the cache's TTL.
   * @throws If the cache is disposed.
   */
  protected set(key: K, value: LilypadCachedValueType<V>, ttl?: number) {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    this.setValue(key, value, ttl);
  }

  /**
   * Stores the result of an asynchronous read, unless a write that started later has already
   * stored a value for the key.
   *
   * @returns `true` if the value was stored.
   */
  private setIfNewer(
    key: K,
    value: LilypadCachedValueType<V>,
    ttl: number | undefined,
    ticket: number,
    fetchedAt: number
  ): boolean {
    if (ticket <= this.currentTicket(this.normalizeKey(key))) {
      return false;
    }
    return this.writeEntry({
      key,
      value,
      expirationTime: this.createExpirationTime(ttl),
      fetchedAt,
      ticket,
      origin: 'source',
    });
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
   * @throws If the cache is disposed.
   */
  get(key: K, options: { removeExpired?: boolean } = {}): LilypadCachedValueType<V> | undefined {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && !isStale(entry)) {
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
   *
   * @throws If the cache is disposed.
   */
  peek(key: K): LilypadCachePeek<V> {
    this.assertNotDisposed();
    return this.peekEntry(key);
  }

  private peekEntry(key: K): LilypadCachePeek<V> {
    const entry = this.store.get(this.normalizeKey(key));
    if (!entry) {
      return { type: 'miss' };
    }
    return {
      type: isStale(entry) ? 'expired' : 'hit',
      value: entry.value,
      expirationTime: entry.expirationTime,
    };
  }

  /**
   * The fallback of a failed fetch, chosen for each caller with its own `onError` options, and
   * cached in this instance only for `onError.ttl` (or the cache's `errorTtl`). The stale value
   * returned as it is keeps its age: it is not a newer value.
   *
   * @throws The original error if no fallback value is determined.
   */
  private errorReturn(
    error: unknown,
    options: LilypadCacheGetOptions<K, V>,
    key: K
  ): LilypadCachedValueType<V> {
    // The current entry, not the one seen before the fetch: it may have been updated meanwhile
    const current = this.store.get(this.normalizeKey(key));
    const stale = current && { value: current.value, fetchedAt: current.fetchedAt };
    const fallback = options.onError?.fallback;
    const value =
      fallback === 'stale' ? stale?.value : fallback?.({ key, error, stale: stale || undefined });

    if (value === undefined) {
      throw error;
    }
    const fetchedAt = stale && value === stale.value ? stale.fetchedAt : Date.now();
    this.writeLocal(key, value, options.onError?.ttl ?? this.errorTtl, 'fallback', fetchedAt);
    return value;
  }

  private getOrSetFlightId(normalizedKey: string): string {
    return `LilypadCache-getOrSet-${normalizedKey}`;
  }

  /** @returns `true` if a `getOrSet` fetch for the key is in flight. */
  protected isFetchInFlight(key: K): boolean {
    return this.flowControl.isInFlight(this.getOrSetFlightId(this.normalizeKey(key)));
  }

  /** Throws if the cache is disposed. */
  protected assertNotDisposed() {
    if (this.disposed) {
      throw new Error(`LilypadCache "${this.name}" is disposed.`);
    }
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
    const failedAt = Date.now();
    this.failures.set(normalizedKey, failedAt);
    if (this.failureCooldown > 0) {
      this.shared?.writeFailure(normalizedKey, failedAt, this.failureCooldown);
    }
  }

  /**
   * Gets a value from the cache, or fetches it with `valueFn` and caches it. Concurrent calls for
   * the same key share one fetch; the `onError` options still apply separately to each caller.
   *
   * @param valueFn - Produces the value; it receives a signal aborted when the fetch times out.
   * @throws The error of `valueFn` (or the timeout error) when `onError` gives no fallback value.
   */
  protected async getOrSet(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCachedValueType<V>> {
    return (await this.getOrSetDetailed(key, valueFn, options)).value;
  }

  /**
   * Like `getOrSet`, but also tells where the value comes from and whether the last fetch failed.
   *
   * The lookup order is: memory of this instance, shared level, stale value (returned at once and
   * refreshed in the background, within `staleWhileRevalidate`), fetch.
   *
   * A fallback cached after a failed fetch is returned with `refreshFailed: true` until it
   * expires. With `failureCooldown`, it is also refreshed in the background once the cooldown
   * is over.
   *
   * @throws If the cache is disposed.
   */
  protected async getOrSetDetailed(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V> = {}
  ): Promise<LilypadCacheResult<V>> {
    this.assertNotDisposed();
    this.cleanupOnAccess();
    const normalizedKey = this.normalizeKey(key);

    if (!options.skipCache) {
      const local = this.store.get(normalizedKey);
      if (local && !isStale(local)) {
        this.markUsed(normalizedKey);
        return this.freshHit(key, local, 'L1-HIT', valueFn, options);
      }

      let refreshLocked = false;
      if (this.shared) {
        const read = this.beginRead();
        const remote = await this.shared.read(normalizedKey, this.failureCooldown > 0);
        refreshLocked = remote.locked;
        if (remote.failedAt !== undefined) {
          this.failures.set(
            normalizedKey,
            Math.max(remote.failedAt, this.failures.get(normalizedKey) ?? 0)
          );
        }
        const adopted = remote.entry && this.adoptShared(key, remote.entry, read.ticket);
        const current = this.store.get(normalizedKey);
        if (current && !isStale(current)) {
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

    if (this.inCooldown(normalizedKey) && !this.isFetchInFlight(key)) {
      const error = new LilypadCacheCooldownError(normalizedKey, this.failureCooldown);
      return { value: this.errorReturn(error, options, key), status: 'MISS', refreshFailed: true };
    }
    try {
      const value = await this.fetchAndStore(key, valueFn, options);
      return { value, status: 'MISS', refreshFailed: false };
    } catch (error) {
      return { value: this.errorReturn(error, options, key), status: 'MISS', refreshFailed: true };
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

  /** Fetches the value (one fetch per key at a time) and stores it. */
  private fetchAndStore(
    key: K,
    valueFn: LilypadCacheValueFn<V>,
    options: LilypadCacheGetOptions<K, V>
  ): Promise<LilypadCachedValueType<V>> {
    const normalizedKey = this.normalizeKey(key);
    return this.flowControl.singleFlight(this.getOrSetFlightId(normalizedKey), () =>
      this.flowControl
        .executeWithTimeout(async (signal) => {
          const read = this.beginRead();
          const value = await valueFn(signal);
          // After a timeout the caller already got an error/fallback: a late result is not cached
          if (!signal.aborted) {
            read.storeFetched(key, value, options.ttl, options.staleWhileRevalidate);
          }
          return value;
        }, options.timeout)
        .catch((error: unknown) => {
          // Once per fetch, while the fallback is chosen per caller in errorReturn
          libLog(
            this.logger,
            'error',
            this.name,
            `Error fetching cache key "${normalizedKey}": `,
            error
          );
          this.recordFailure(normalizedKey);
          throw error;
        })
    );
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
    runAfterResponse(
      this.platform,
      async () => {
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
      () => {}
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
    // A copy read before the invalidation, whose removal from the shared level failed or was
    // undone by another instance
    if (current?.invalidatedAt !== undefined && remote.fetchedAt < current.invalidatedAt) {
      return false;
    }
    if (remote.fetchedAt < this.sharedNotBefore) {
      return false;
    }
    if (ticket <= this.currentTicket(normalizedKey)) {
      return false;
    }
    return this.writeEntry({
      key,
      value: remote.value,
      expirationTime: remote.expiresAt,
      fetchedAt: remote.fetchedAt,
      ticket,
      origin: 'shared',
    });
  }

  /**
   * Writes an entry to the shared level in the background, kept through the stale window: the
   * cache's, or a longer one asked by the read that fetched it.
   */
  private writeShared(entry: LilypadCacheEntry<K, V>, staleWhileRevalidate: number = 0) {
    const staleWindow = Math.max(staleWhileRevalidate, this.defaultStaleWhileRevalidate);
    this.shared?.write(
      this.normalizeKey(entry.key),
      { value: entry.value, fetchedAt: entry.fetchedAt, expiresAt: entry.expirationTime },
      entry.expirationTime + staleWindow - Date.now()
    );
  }

  /** Removes a key from the shared level, in the background. */
  protected deleteShared(key: K) {
    this.shared?.delete(this.normalizeKey(key));
  }

  // INVALIDATION EVENTS

  /**
   * Sends an invalidation event to `platform.onInvalidate`, in the background.
   *
   * @param options.wholeCache - The whole cache changed (e.g. a table was emptied): the event is
   * sent even without keys, and its tags always include the tag of the cache.
   */
  protected emitInvalidation(
    source: LilypadInvalidationEvent['source'],
    keys: K[],
    options: { wholeCache?: boolean } = {}
  ) {
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
      (error) => libLog(this.logger, 'error', this.name, 'Error in onInvalidate:', error)
    );
  }

  // BULK SYNC

  /**
   * Synchronizes the cache in bulk with `bulkSync.fn`.
   *
   * Concurrent calls share one sync. Errors are logged; unless `throwOnError` is set they are not
   * rethrown: the cache keeps its current content, and the next call retries the sync.
   * Bulk syncs fill the memory of this instance only, not the shared level.
   *
   * @param options.throwOnError - If true, a failed sync rejects instead of resolving to `false`.
   * @returns `true` if the cache is synced (now or by a recent sync), `false` if the sync failed,
   * returned no data, or there is no `bulkSync.fn`.
   * @throws If the cache is disposed.
   */
  protected async bulkSync(options: { throwOnError?: boolean } = {}): Promise<boolean> {
    this.assertNotDisposed();
    const bulkSyncFn = this.bulkSyncFn;
    if (!bulkSyncFn) {
      if (options.throwOnError) {
        throw new Error(`LilypadCache "${this.name}" has no bulkSync.fn.`);
      }
      return false;
    }
    try {
      return await this.bulkSyncFlowControl.singleFlight('LilypadCache-bulkSync', () =>
        this.bulkSyncFlowControl
          .executeWithTimeout((signal) => this.runBulkSync(bulkSyncFn, signal))
          .catch((error: unknown) => {
            libLog(this.logger, 'error', this.name, 'Error during bulk sync: ', error);
            throw error;
          })
      );
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      return false;
    }
  }

  private async runBulkSync(
    bulkSyncFn: LilypadCacheSyncFn<K, V>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (Date.now() < this.bulkSyncExpirationTime) {
      return true;
    }
    const read = this.beginRead();
    const data = await bulkSyncFn(signal);
    if (signal.aborted) {
      // Timed out: the caller already got an error, and a newer sync may be running
      return false;
    }
    if (!data) {
      libLog(this.logger, 'warn', this.name, 'Bulk sync function returned no data');
      return false;
    }
    // Taken before the entries are written, which expire at the earliest `defaultTtl` after it
    const storedAt = Date.now();
    this.replaceEntries(read, data);

    // An invalidation that happened while the sync was running may not be reflected in its data
    if (this.bulkSyncInvalidationTicket < read.ticket) {
      // Never beyond the expiration of the entries: `entries()` would then return an incomplete
      // (or empty) set while the sync still counts as fresh
      this.bulkSyncExpirationTime = storedAt + Math.min(this.bulkSyncTtl, this.defaultTtl);
    }
    return true;
  }

  /**
   * Replaces the content of the cache with a complete load of the source, started with `read`:
   * the loaded entries are stored (unless written since), the others are removed (protected keys
   * are only expired), and the reads of missing keys started before the load are discarded. The
   * entries written after the load started are kept: they are newer than its data.
   */
  protected replaceEntries(
    read: LilypadCacheRead<K, V>,
    data: Iterable<readonly [K, LilypadCachedValueType<V>]>
  ) {
    const incoming = new Map<string, readonly [K, LilypadCachedValueType<V>]>();
    for (const [key, value] of data) {
      incoming.set(this.normalizeKey(key), [key, value]);
    }
    if (this.maxEntries !== undefined && incoming.size > this.maxEntries) {
      libLog(
        this.logger,
        'warn',
        this.name,
        `Loaded ${incoming.size} entries, more than maxEntries (${this.maxEntries}): the cache cannot hold them all.`
      );
    }
    // A copy of the entries, which the loop removes or rewrites
    for (const [normalizedKey, entry] of [...this.store]) {
      // Entries written after the sync started are newer than its data; incoming keys are overwritten below
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

  /** Forces the next bulk sync to fetch fresh data, even if a sync is currently running. */
  protected forceNextBulkSync() {
    this.bulkSyncExpirationTime = 0;
    this.bulkSyncInvalidationTicket = this.nextTicket();
  }

  /**
   * Returns the fresh values of `keys`, keyed as given. Missing and expired keys are left out.
   *
   * @throws If the cache is disposed.
   */
  protected getMany(keys: Iterable<K>): Map<K, LilypadCachedValueType<V>> {
    this.assertNotDisposed();
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
   *
   * @throws If the cache is disposed.
   */
  protected entries(): Map<K, LilypadCachedValueType<V>> {
    this.assertNotDisposed();
    const result = new Map<K, LilypadCachedValueType<V>>();
    for (const entry of this.store.values()) {
      if (!isStale(entry)) {
        result.set(entry.key, entry.value);
      }
    }
    return result;
  }

  /**
   * Like `entries()`, after a `bulkSync` (unless `sync` is false).
   *
   * @throws If the cache is disposed.
   */
  protected async getAllEntries({ sync = true }: { sync?: boolean } = {}): Promise<
    Map<K, LilypadCachedValueType<V>>
  > {
    if (sync) {
      await this.bulkSync();
    }
    return this.entries();
  }

  /**
   * Stores several values at once, like `set` (so also in the shared level).
   *
   * @throws If the cache is disposed.
   */
  protected bulkSet(entries: Iterable<readonly [K, LilypadCachedValueType<V>]>): void {
    for (const [key, value] of entries) {
      this.set(key, value);
    }
  }

  // PROTECTED KEYS

  /**
   * Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
   *
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  addProtectedKeys(keys: K[]): this {
    this.assertNotDisposed();
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      this.protectedKeys.add(normalizedKey);
      // Never evicted
      this.evictionOrder.delete(normalizedKey);
    }
    return this;
  }

  /**
   * @returns The cache, for chaining.
   * @throws If the cache is disposed.
   */
  removeProtectedKeys(keys: K[]): this {
    this.assertNotDisposed();
    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      if (this.protectedKeys.delete(normalizedKey) && this.store.has(normalizedKey)) {
        this.markUsed(normalizedKey);
      }
    }
    return this;
  }

  // INVALIDATION AND REMOVAL

  /**
   * Invalidates the entry of the key.
   *
   * The entry is marked as expired: it is no longer returned, not even as a stale value, but it
   * stays available as a fallback (`onError: { fallback: 'stale' }`). A fetch of the key already
   * in flight is not cached. The key is also removed from the shared level, and
   * `platform.onInvalidate` receives a `manual` event.
   *
   * @param options.invalidateBulkSync - If true (default), forces the next bulk sync. With false,
   * `entries()` leaves the key out until the next bulk sync.
   * @throws If the cache is disposed.
   */
  invalidate(key: K, { invalidateBulkSync = true }: { invalidateBulkSync?: boolean } = {}) {
    this.assertNotDisposed();
    this.markInvalid(key, { invalidateBulkSync });
    this.emitInvalidation('manual', [key]);
  }

  /**
   * The effect of `invalidate` on the data, without the invalidation event: expires the entry in
   * this instance, removes it from the shared level and optionally forces the next bulk sync.
   */
  protected markInvalid(
    key: K,
    { invalidateBulkSync = true }: { invalidateBulkSync?: boolean } = {}
  ) {
    this.expire(key);
    this.deleteShared(key);
    if (invalidateBulkSync) {
      this.forceNextBulkSync();
    }
  }

  /**
   * Marks an entry as expired, keeping its value as a fallback. It is never served as a stale
   * value either. Only this instance is affected. A read of the key already in flight is
   * discarded, since it may predate the change.
   */
  protected expire(key: K) {
    this.expireNormalized(this.normalizeKey(key));
  }

  private expireNormalized(normalizedKey: string) {
    const entry = this.store.get(normalizedKey);
    if (!entry) {
      if (this.hasReadInFlight(normalizedKey)) {
        this.fences.set(normalizedKey, this.nextTicket());
      }
      return;
    }
    if (entry.expirationTime > 0) {
      this.writeEntry(
        { ...entry, expirationTime: 0, ticket: this.nextTicket(), invalidatedAt: Date.now() },
        false
      );
    }
  }

  /**
   * Expires every entry, forces the next bulk sync, and discards the results of the reads started
   * before (fetches and bulk syncs): the source may have changed in any way.
   */
  protected expireEverything() {
    for (const normalizedKey of [...this.store.keys()]) {
      this.expireNormalized(normalizedKey);
    }
    this.ticketFloor = Math.max(this.ticketFloor, this.nextTicket());
    this.fences.clear();
    this.forceNextBulkSync();
  }

  /**
   * From now on, the values of the shared level produced before `time` are ignored (e.g. the
   * source was emptied at that time, and the shared level may still hold older copies).
   */
  protected rejectSharedBefore(time: number) {
    this.sharedNotBefore = Math.max(this.sharedNotBefore, time);
  }

  /**
   * Deletes the key from the cache, and from the shared level. To cache the key as "does not
   * exist" instead, write `null`.
   *
   * @param options.force - If true, also deletes a protected key.
   * @returns `false` if the key is protected and was left untouched.
   * @throws If the cache is disposed.
   */
  delete(key: K, options: { force?: boolean } = {}): boolean {
    this.assertNotDisposed();
    const deleted = this.removeEntry(this.normalizeKey(key), options.force);
    if (deleted) {
      this.deleteShared(key);
    }
    return deleted;
  }

  /** @returns `false` if the key is protected (and `force` is not set). */
  private removeEntry(normalizedKey: string, force: boolean = false): boolean {
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
   * Removes all entries from the memory of this instance (not from the shared level), and forces
   * the next bulk sync. Protected keys are kept, unless `force` is set.
   *
   * @throws If the cache is disposed.
   */
  clear(options: { force?: boolean } = {}) {
    this.assertNotDisposed();
    this.clearEntries(options.force);
  }

  private clearEntries(force?: boolean) {
    for (const normalizedKey of [...this.store.keys()]) {
      this.removeEntry(normalizedKey, force);
    }
    // Otherwise a bulk sync still fresh would let entries() return the emptied cache as complete
    this.forceNextBulkSync();
  }

  /**
   * Removes all expired entries, except those still within the `staleWhileRevalidate` window of
   * the cache, and the bookkeeping that no longer serves.
   *
   * @param options.force - If true, also removes the expired protected keys.
   * @throws If the cache is disposed.
   */
  purgeExpired(options: { force?: boolean } = {}) {
    this.assertNotDisposed();
    this.purgeEntries(options.force);
  }

  private purgeEntries(force?: boolean) {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    for (const [normalizedKey, entry] of [...this.store]) {
      if (now >= entry.expirationTime + this.defaultStaleWhileRevalidate) {
        this.removeEntry(normalizedKey, force);
      }
    }
    for (const [normalizedKey, failedAt] of this.failures) {
      if (now - failedAt >= this.failureCooldown) {
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
  }

  /** Purges expired entries at most once per `cleanupOnAccessEvery`. */
  private cleanupOnAccess() {
    if (this.cleanupOnAccessEvery === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCleanup >= this.cleanupOnAccessEvery) {
      this.lastCleanup = now;
      this.purgeEntries();
    }
  }

  /**
   * Disposes of the cache: stops the cleanup timer and removes every entry. A disposed cache
   * ignores every later internal write, including the ones of fetches still in flight, and its
   * public methods throw. The shared level is left untouched. Calling it again does nothing.
   *
   * It is asynchronous so that subclasses can release their resources (e.g. a database listener):
   * always await it.
   */
  dispose(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.clearEntries(true);
    this.logger = undefined;
    this.fences.clear();
    this.refreshing.clear();
    this.failures.clear();
    this.disposed = true;
    return Promise.resolve();
  }
}
