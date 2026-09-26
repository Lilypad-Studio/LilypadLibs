import type { LilypadCachedValueType, LilypadSharedCodec } from '@/cache/LilypadCacheTypes';
import {
  runInBackground,
  sharedStoreOperation,
  toTtlSeconds,
  type LilypadPlatform,
  type LilypadSharedStore,
} from '@/platform/LilypadPlatform';

/** The version of the keys and of the envelopes written to the shared store. */
const SHARED_FORMAT_VERSION = 2;

/** What the cache stores in the shared level. */
export type LilypadSharedEnvelope = {
  lilypad: typeof SHARED_FORMAT_VERSION;
  value: unknown;
  fetchedAt: number;
  expiresAt: number;
};

/** An entry read from the shared level, decoded. */
export type LilypadSharedEntry<V> = {
  value: LilypadCachedValueType<V>;
  fetchedAt: number;
  expiresAt: number;
};

export type LilypadSharedLevelOptions<V> = {
  store: LilypadSharedStore;
  codec?: LilypadSharedCodec<V>;
  /** Beyond this time (ms) an operation counts as failed. */
  timeout: number;
  refreshLockTtl?: number;
  checkBeforeWrite: boolean;
  /** The name of the cache: it namespaces the keys. */
  name: string;
  tagPrefix: string;
  platform?: LilypadPlatform;
  /** Logs a failed operation (the cache's logger may change, e.g. on dispose). */
  warn: (...message: unknown[]) => void;
};

/**
 * The tags of an invalidation event, or of a shared entry: the tag of the cache, then the tag of
 * each key. Names and keys are URI-encoded, so that `:` in either cannot make two tags collide.
 */
export function lilypadCacheTags(
  tagPrefix: string,
  name: string,
  normalizedKeys: string[]
): string[] {
  const cacheTag = `${tagPrefix}:${encodeURIComponent(name)}`;
  return [cacheTag, ...normalizedKeys.map((key) => `${cacheTag}:${encodeURIComponent(key)}`)];
}

/**
 * The level of a cache shared by every instance (e.g. the Vercel Runtime Cache). Every operation is
 * bounded by the timeout, and a failure counts as a missing entry: the shared store is never
 * required to answer.
 *
 * Keys are `lilypad:2:<name>:<kind>:<key>`, with the name and the key URI-encoded and `kind` one of
 * `v` (the value), `f` (the time of the last failed fetch) and `l` (the refresh lock), so that no
 * key of one kind or of one cache can collide with another.
 */
export class LilypadSharedLevel<V> {
  constructor(private readonly options: LilypadSharedLevelOptions<V>) {}

  private key(kind: 'v' | 'f' | 'l', normalizedKey: string): string {
    const { name } = this.options;
    return `lilypad:${SHARED_FORMAT_VERSION}:${encodeURIComponent(name)}:${kind}:${encodeURIComponent(normalizedKey)}`;
  }

  valueKey(normalizedKey: string): string {
    return this.key('v', normalizedKey);
  }

  failureKey(normalizedKey: string): string {
    return this.key('f', normalizedKey);
  }

  lockKey(normalizedKey: string): string {
    return this.key('l', normalizedKey);
  }

  private cacheTags(): string[] {
    return lilypadCacheTags(this.options.tagPrefix, this.options.name, []);
  }

  /** An operation bounded by the timeout; a failure resolves to `fallback`. */
  private operation<T>(
    description: string,
    operation: (store: LilypadSharedStore) => Promise<T>,
    fallback: T
  ): Promise<T> {
    const { store, timeout, warn } = this.options;
    return sharedStoreOperation(
      () => operation(store),
      fallback,
      timeout,
      (error) => warn(`Shared cache ${description} failed:`, error)
    );
  }

  private inBackground(
    description: string,
    operation: (store: LilypadSharedStore) => Promise<unknown>
  ) {
    runInBackground(
      this.options.platform,
      this.operation(description, operation, undefined),
      () => {}
    );
  }

  /**
   * Reads the entry of a key, and, when asked, the time of its last failed fetch and its refresh
   * lock, in parallel.
   */
  async read(
    normalizedKey: string,
    withFailure: boolean
  ): Promise<{ entry?: LilypadSharedEntry<V>; failedAt?: number; locked: boolean }> {
    const [raw, failedAt, lock] = await Promise.all([
      this.operation(
        `read of "${normalizedKey}"`,
        (store) => store.get(this.valueKey(normalizedKey)),
        null
      ),
      withFailure
        ? this.operation(
            `read of the failure of "${normalizedKey}"`,
            (store) => store.get(this.failureKey(normalizedKey)),
            null
          )
        : null,
      this.options.refreshLockTtl !== undefined
        ? this.operation(
            `read of the lock of "${normalizedKey}"`,
            (store) => store.get(this.lockKey(normalizedKey)),
            null
          )
        : null,
    ]);
    return {
      entry: this.decode(normalizedKey, raw),
      failedAt: typeof failedAt === 'number' ? failedAt : undefined,
      locked: typeof lock === 'string',
    };
  }

  private decode(normalizedKey: string, raw: unknown): LilypadSharedEntry<V> | undefined {
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const envelope = raw as Partial<LilypadSharedEnvelope>;
    const valid =
      typeof raw === 'object' &&
      envelope.lilypad === SHARED_FORMAT_VERSION &&
      typeof envelope.fetchedAt === 'number' &&
      typeof envelope.expiresAt === 'number' &&
      'value' in envelope;
    if (!valid) {
      this.options.warn(`Ignoring a malformed shared entry for "${normalizedKey}"`);
      return undefined;
    }
    const { fetchedAt, expiresAt } = envelope as LilypadSharedEnvelope;
    if (envelope.value === null) {
      return { value: null, fetchedAt, expiresAt };
    }
    const codec = this.options.codec;
    const value = codec ? codec.decode(envelope.value) : (envelope.value as V);
    if (value === null) {
      this.options.warn(`Ignoring a shared entry rejected by the codec: "${normalizedKey}"`);
      return undefined;
    }
    return { value, fetchedAt, expiresAt };
  }

  /**
   * Writes an entry in the background, kept for `lifetime` ms. With `checkBeforeWrite`, it leaves
   * alone a shared value fetched later (a soft check: read and write are not atomic).
   */
  write(normalizedKey: string, entry: LilypadSharedEntry<V>, lifetime: number): void {
    if (lifetime <= 0) {
      return;
    }
    const { codec, checkBeforeWrite } = this.options;
    const envelope: LilypadSharedEnvelope = {
      lilypad: SHARED_FORMAT_VERSION,
      value: entry.value === null || !codec ? entry.value : codec.encode(entry.value),
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expiresAt,
    };
    const key = this.valueKey(normalizedKey);
    this.inBackground(`write of "${normalizedKey}"`, async (store) => {
      if (checkBeforeWrite) {
        const current = (await store.get(key)) as Partial<LilypadSharedEnvelope> | null | undefined;
        if (typeof current?.fetchedAt === 'number' && current.fetchedAt > envelope.fetchedAt) {
          return;
        }
      }
      await store.set(key, envelope, { ttl: toTtlSeconds(lifetime), tags: this.cacheTags() });
    });
  }

  /** Removes the entry of a key, in the background. */
  delete(normalizedKey: string): void {
    this.inBackground(`delete of "${normalizedKey}"`, (store) =>
      store.delete(this.valueKey(normalizedKey))
    );
  }

  /** Records a failed fetch of a key for `ttl` ms, in the background. */
  writeFailure(normalizedKey: string, failedAt: number, ttl: number): void {
    this.inBackground(`write of the failure of "${normalizedKey}"`, (store) =>
      store.set(this.failureKey(normalizedKey), failedAt, {
        ttl: toTtlSeconds(ttl),
        tags: this.cacheTags(),
      })
    );
  }

  /** Forgets the failed fetch of a key, in the background. */
  deleteFailure(normalizedKey: string): void {
    this.inBackground(`delete of the failure of "${normalizedKey}"`, (store) =>
      store.delete(this.failureKey(normalizedKey))
    );
  }

  /** @returns The lock owner id, or undefined when no lock is configured. */
  async acquireLock(normalizedKey: string): Promise<string | undefined> {
    const lockTtl = this.options.refreshLockTtl;
    if (lockTtl === undefined) {
      return undefined;
    }
    const owner = globalThis.crypto.randomUUID();
    await this.operation(
      `write of the lock of "${normalizedKey}"`,
      (store) => store.set(this.lockKey(normalizedKey), owner, { ttl: toTtlSeconds(lockTtl) }),
      undefined
    );
    return owner;
  }

  /** Releases the lock only if it still belongs to `owner`, not to another instance. */
  async releaseLock(normalizedKey: string, owner: string): Promise<void> {
    const current = await this.operation(
      `read of the lock of "${normalizedKey}"`,
      (store) => store.get(this.lockKey(normalizedKey)),
      null
    );
    if (current === owner) {
      await this.operation(
        `delete of the lock of "${normalizedKey}"`,
        (store) => store.delete(this.lockKey(normalizedKey)),
        undefined
      );
    }
  }
}
