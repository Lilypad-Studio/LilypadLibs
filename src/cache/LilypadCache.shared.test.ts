import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import LilypadCache, { LilypadCacheCooldownError, type LilypadSharedCodec } from './LilypadCache';
import type { LilypadLibLogger } from '@/logger/LilypadLogger';
import type { LilypadPlatform, LilypadSharedStore } from '@/platform/LilypadPlatform';

/**
 * An in-memory shared store. Values are cloned, as a real store serializes them; `ttl` is in
 * seconds. It can be made slow or failing.
 */
function createFakeStore() {
  const data = new Map<string, { value: unknown; expiresAt: number }>();
  const behaviour = { delay: 0, failing: false };
  const disturb = async () => {
    if (behaviour.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, behaviour.delay));
    }
    if (behaviour.failing) {
      throw new Error('store down');
    }
  };
  const store = {
    get: vi.fn(async (key: string) => {
      await disturb();
      const entry = data.get(key);
      return entry && Date.now() < entry.expiresAt ? structuredClone(entry.value) : null;
    }),
    set: vi.fn(async (key: string, value: unknown, options?: { ttl?: number }) => {
      await disturb();
      data.set(key, {
        value: structuredClone(value),
        expiresAt: Date.now() + (options?.ttl ?? 3600) * 1000,
      });
    }),
    delete: vi.fn(async (key: string) => {
      await disturb();
      data.delete(key);
    }),
  } satisfies LilypadSharedStore;
  return { store, data, behaviour };
}

function createMockLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as LilypadLibLogger;
}

/** A value source whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promises and zero-delay timers (e.g. background shared writes) run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('LilypadCache platform features', () => {
  let fake: ReturnType<typeof createFakeStore>;
  const caches: LilypadCache<string, unknown>[] = [];

  /** Two caches with the same name and store stand for two instances of the application. */
  function createInstance<V>(
    options: ConstructorParameters<typeof LilypadCache<string, V>>[0] = {}
  ) {
    const cache = new LilypadCache<string, V>({
      ttl: 1000,
      name: 'products',
      shared: { store: fake.store },
      ...options,
    });
    caches.push(cache as LilypadCache<string, unknown>);
    return cache;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fake = createFakeStore();
  });

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((cache) => cache.dispose()));
    vi.useRealTimers();
  });

  describe('configuration', () => {
    it('should require a name and a store for the shared level', () => {
      expect(() => new LilypadCache({ ttl: 1000, shared: { store: fake.store } })).toThrow(
        '`name` is required'
      );
      expect(() => new LilypadCache({ ttl: 1000, name: 'x', shared: {} })).toThrow(
        'needs a `store`'
      );
    });

    it('should use the store of the platform by default', async () => {
      const cache = new LilypadCache<string, number>({
        ttl: 1000,
        name: 'products',
        platform: { shared: fake.store },
        shared: {},
      });

      cache.set('p1', 1);
      await settle();

      expect(fake.store.set).toHaveBeenCalledWith(
        'lilypad:products:p1',
        expect.objectContaining({ value: 1 }),
        expect.objectContaining({ tags: ['lilypad:products'] })
      );
      void cache.dispose();
    });
  });

  describe('shared level', () => {
    it('should serve a value fetched by another instance as L2-HIT', async () => {
      const first = createInstance<number>();
      const second = createInstance<number>();
      await first.getOrSet('p1', async () => 42);
      await settle();

      const fetch = vi.fn(async () => 0);
      const result = await second.getOrSetDetailed('p1', fetch);

      expect(result).toEqual({ value: 42, status: 'L2-HIT', refreshFailed: false });
      expect(fetch).not.toHaveBeenCalled();
      expect((await second.getOrSetDetailed('p1', fetch)).status).toBe('L1-HIT');
    });

    it('should measure the age of a shared value from when it was fetched', async () => {
      const first = createInstance<number>();
      const second = createInstance<number>();
      await first.getOrSet('p1', async () => 42);
      await settle();

      await vi.advanceTimersByTimeAsync(600);
      await second.getOrSet('p1', async () => 0);
      await vi.advanceTimersByTimeAsync(400);

      // Fetched 1000 ms ago with a TTL of 1000 ms: expired, although it entered `second` 400 ms ago
      expect(second.getComprehensive('p1').type).toBe('expired');
    });

    it('should share null values ("does not exist")', async () => {
      const first = createInstance<number>();
      const second = createInstance<number>();
      await first.getOrSet('missing', async () => null);
      await settle();

      const result = await second.getOrSetDetailed('missing', async () => 1);

      expect(result).toMatchObject({ value: null, status: 'L2-HIT' });
    });

    it('should keep answering when the shared store fails', async () => {
      const logger = createMockLogger();
      const cache = createInstance<number>({ logger });
      fake.behaviour.failing = true;

      const result = await cache.getOrSetDetailed('p1', async () => 7);

      expect(result).toMatchObject({ value: 7, status: 'MISS' });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should not wait for a slow shared store beyond its timeout', async () => {
      const cache = createInstance<number>({
        shared: { store: fake.store, timeout: 300 },
      });
      fake.behaviour.delay = 60_000;

      const result = cache.getOrSetDetailed('p1', async () => 7);
      await vi.advanceTimersByTimeAsync(300);

      await expect(result).resolves.toMatchObject({ value: 7, status: 'MISS' });
    });

    it('should encode, decode and validate values with the codec', async () => {
      type Stamp = { at: Date };
      const codec: LilypadSharedCodec<Stamp> = {
        encode: (value) => value.at.toISOString(),
        decode: (raw) => (typeof raw === 'string' ? { at: new Date(raw) } : null),
      };
      const first = createInstance<Stamp>({ shared: { store: fake.store, codec } });
      const second = createInstance<Stamp>({ shared: { store: fake.store, codec } });
      await first.getOrSet('s', async () => ({ at: new Date('2026-01-01T00:00:00.000Z') }));
      await settle();

      const value = await second.getOrSet('s', async () => null);

      expect(value?.at).toBeInstanceOf(Date);
      expect(value?.at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should ignore shared values rejected by the codec or malformed', async () => {
      const codec: LilypadSharedCodec<number> = { encode: (v) => v, decode: () => null };
      const cache = createInstance<number>({ shared: { store: fake.store, codec } });
      await fake.store.set('lilypad:products:bad', {
        lilypad: 1,
        value: 1,
        fetchedAt: 0,
        expiresAt: 9e15,
      });
      await fake.store.set('lilypad:products:malformed', { unexpected: true });

      expect((await cache.getOrSetDetailed('bad', async () => 2)).status).toBe('MISS');
      expect((await cache.getOrSetDetailed('malformed', async () => 3)).status).toBe('MISS');
    });

    it('should write without reading the shared entry first by default', async () => {
      const cache = createInstance<number>();

      cache.set('a', 1);
      await settle();

      expect(fake.store.get).not.toHaveBeenCalled();
      expect(fake.data.has('lilypad:products:a')).toBe(true);
    });

    it('should not replace a shared value fetched later with checkBeforeWrite', async () => {
      const shared = { store: fake.store, checkBeforeWrite: true };
      const slow = createInstance<number>({ shared });
      const fast = createInstance<number>({ shared });
      const slowFetch = deferred<number>();
      const slowResult = slow.getOrSet('p1', () => slowFetch.promise);
      await vi.advanceTimersByTimeAsync(10);
      await fast.getOrSet('p1', async () => 2); // fetched after the slow one started
      await settle();

      slowFetch.resolve(1);
      await slowResult;
      await settle();

      expect(fake.data.get('lilypad:products:p1')?.value).toMatchObject({ value: 2 });
    });

    it('should write set values to the shared level and remove deleted or invalidated ones', async () => {
      const cache = createInstance<number>();

      cache.set('a', 1);
      cache.set('b', 2);
      await settle();
      expect(fake.data.has('lilypad:products:a')).toBe(true);

      cache.delete('a');
      cache.invalidate('b');
      await settle();

      expect(fake.data.has('lilypad:products:a')).toBe(false);
      expect(fake.data.has('lilypad:products:b')).toBe(false);
    });

    it('should register shared writes as background work', async () => {
      const background = vi.fn();
      const cache = createInstance<number>({ platform: { background } });

      cache.set('p1', 1);

      expect(background).toHaveBeenCalled();
    });
  });

  describe('stale-while-revalidate', () => {
    it('should return a stale value at once and refresh it in the background', async () => {
      const background = vi.fn();
      const cache = createInstance<number>({
        staleWhileRevalidate: 5000,
        platform: { background },
      });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      const refresh = deferred<number>();

      const result = await cache.getOrSetDetailed('p1', () => refresh.promise);

      expect(result).toEqual({ value: 1, status: 'STALE', refreshFailed: false });
      refresh.resolve(2);
      await settle();
      expect(cache.get('p1')).toBe(2);
      expect(background).toHaveBeenCalled();
    });

    it('should start the refresh only after the response when afterResponse is given', async () => {
      const works: (() => Promise<unknown>)[] = [];
      const cache = createInstance<number>({
        staleWhileRevalidate: 5000,
        platform: { afterResponse: (work) => works.push(work) },
      });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      const fetch = vi.fn(async () => 2);

      await cache.getOrSetDetailed('p1', fetch);
      expect(fetch).not.toHaveBeenCalled();

      await works[0]!();
      expect(fetch).toHaveBeenCalledOnce();
      expect(cache.get('p1')).toBe(2);
    });

    it('should run one background refresh per key', async () => {
      const cache = createInstance<number>({ staleWhileRevalidate: 5000 });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      const refresh = deferred<number>();
      const fetch = vi.fn(() => refresh.promise);

      await cache.getOrSetDetailed('p1', fetch);
      await cache.getOrSetDetailed('p1', fetch);
      refresh.resolve(2);
      await settle();

      expect(fetch).toHaveBeenCalledOnce();
    });

    it('should not stay blocked by a refresh the platform never started', async () => {
      const cache = createInstance<number>({
        staleWhileRevalidate: 600_000,
        platform: { afterResponse: () => {} }, // drops the work
      });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      await cache.getOrSetDetailed('p1', async () => 2);
      const retried = vi.fn(async () => 3);

      await cache.getOrSetDetailed('p1', retried);
      expect(cache.get('p1')).toBeUndefined(); // still blocked by the dropped refresh

      await vi.advanceTimersByTimeAsync(60_000);
      // From now on the platform runs the work at once
      (cache as unknown as { platform: undefined }).platform = undefined;
      await cache.getOrSetDetailed('p1', retried);
      await settle();

      expect(retried).toHaveBeenCalledOnce();
    });

    it('should not serve an invalidated value as stale', async () => {
      const cache = createInstance<number>({ staleWhileRevalidate: 5000 });
      await cache.getOrSet('p1', async () => 1);

      cache.invalidate('p1');
      const result = await cache.getOrSetDetailed('p1', async () => 2);

      expect(result).toMatchObject({ value: 2, status: 'MISS' });
    });

    it('should not refresh while another instance holds the refresh lock', async () => {
      const cache = createInstance<number>({
        staleWhileRevalidate: 5000,
        shared: { store: fake.store, refreshLockTtl: 10_000 },
      });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      await fake.store.set('lilypad:products:p1:lock', 'other-instance');
      fake.data.delete('lilypad:products:p1'); // only the local stale copy is left
      const fetch = vi.fn(async () => 2);

      const result = await cache.getOrSetDetailed('p1', fetch);
      await settle();

      expect(result.status).toBe('STALE');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should release its own refresh lock', async () => {
      const cache = createInstance<number>({
        staleWhileRevalidate: 5000,
        shared: { store: fake.store, refreshLockTtl: 10_000 },
      });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      fake.data.delete('lilypad:products:p1');

      await cache.getOrSetDetailed('p1', async () => 2);
      await settle();

      expect(fake.store.set).toHaveBeenCalledWith(
        'lilypad:products:p1:lock',
        expect.any(String),
        expect.objectContaining({ ttl: 10 })
      );
      expect(fake.data.has('lilypad:products:p1:lock')).toBe(false);
    });

    it('should keep entries within the stale window when purging', async () => {
      const cache = createInstance<number>({ staleWhileRevalidate: 5000 });
      cache.set('p1', 1);
      await vi.advanceTimersByTimeAsync(1500);

      cache.purgeExpired();
      expect(cache.getComprehensive('p1').type).toBe('expired');

      await vi.advanceTimersByTimeAsync(5000);
      cache.purgeExpired();
      expect(cache.getComprehensive('p1').type).toBe('miss');
    });
  });

  describe('failure cooldown', () => {
    const failing = async (): Promise<number> => {
      throw new Error('source down');
    };

    it('should not retry the source during the cooldown', async () => {
      const cache = createInstance<number>({ failureCooldown: 10_000 });
      await expect(cache.getOrSet('p1', failing)).rejects.toThrow('source down');
      const fetch = vi.fn(async () => 1);

      await expect(cache.getOrSet('p1', fetch)).rejects.toBeInstanceOf(LilypadCacheCooldownError);
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(cache.getOrSet('p1', fetch)).resolves.toBe(1);
    });

    it('should still use the fallbacks during the cooldown', async () => {
      const cache = createInstance<number>({ failureCooldown: 10_000 });
      cache.set('p1', 5, -1);
      await expect(cache.getOrSet('p1', failing)).rejects.toThrow('source down');

      await expect(cache.getOrSet('p2', failing)).rejects.toThrow('source down');
      const fetch = vi.fn(failing);

      await expect(cache.getOrSet('p1', fetch, { returnOldOnError: true })).resolves.toBe(5);
      await expect(cache.getOrSet('p2', fetch, { errorFn: () => 9 })).resolves.toBe(9);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should share the cooldown with the other instances', async () => {
      const first = createInstance<number>({ failureCooldown: 10_000 });
      const second = createInstance<number>({ failureCooldown: 10_000 });
      await expect(first.getOrSet('p1', failing)).rejects.toThrow('source down');
      await settle();
      const fetch = vi.fn(async () => 1);

      await expect(second.getOrSet('p1', fetch)).rejects.toBeInstanceOf(LilypadCacheCooldownError);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should report a failed refresh on the stale value it serves', async () => {
      const cache = createInstance<number>({ staleWhileRevalidate: 60_000 });
      await cache.getOrSet('p1', async () => 1);
      await vi.advanceTimersByTimeAsync(1500);
      await cache.getOrSetDetailed('p1', failing);
      await settle();

      const result = await cache.getOrSetDetailed('p1', failing);

      expect(result).toEqual({ value: 1, status: 'STALE', refreshFailed: true });
    });
  });

  describe('memory bounds and cleanup', () => {
    it('should remove the least recently used entries beyond maxEntries, sparing protected keys', () => {
      const cache = createInstance<number>({ maxEntries: 2 });
      cache.set('config', 0);
      cache.addProtectedKeys(['config']);
      cache.set('a', 1);
      cache.set('b', 2); // 3 entries: 'a' is the least recently used unprotected one

      expect(cache.getComprehensive('a').type).toBe('miss');
      cache.get('config');
      cache.set('c', 3);

      expect(cache.getComprehensive('b').type).toBe('miss');
      expect(cache.get('config')).toBe(0);
      expect(cache.get('c')).toBe(3);
    });

    it('should purge expired entries on access, at most once per interval', async () => {
      const cache = createInstance<number>({ cleanupOnAccessEvery: 1000 });
      cache.set('old', 1, 10);
      await vi.advanceTimersByTimeAsync(500);
      cache.get('other');
      expect(cache.getComprehensive('old').type).toBe('expired');

      await vi.advanceTimersByTimeAsync(500);
      cache.get('other');
      expect(cache.getComprehensive('old').type).toBe('miss');
    });
  });

  describe('per-call timeout', () => {
    it('should apply the timeout of the call instead of the cache timeout', async () => {
      const cache = createInstance<number>({ flowControlTimeout: 60_000 });

      const result = cache.getOrSet('p1', () => new Promise<number>(() => {}), { timeout: 50 });
      const assertion = expect(result).rejects.toThrow('Operation timed out');
      await vi.advanceTimersByTimeAsync(50);

      await assertion;
    });
  });

  describe('invalidation events', () => {
    it('should send manual invalidations to onInvalidate, with tags', async () => {
      const onInvalidate = vi.fn();
      const cache = createInstance<number>({ platform: { onInvalidate }, tagPrefix: 'app' });

      cache.invalidate('p1');
      await settle();

      expect(onInvalidate).toHaveBeenCalledWith({
        source: 'manual',
        cache: 'products',
        keys: ['p1'],
        tags: ['app:products', 'app:products:p1'],
      });
    });

    it('should log the errors of onInvalidate instead of throwing', async () => {
      const logger = createMockLogger();
      const platform: LilypadPlatform = {
        onInvalidate: () => {
          throw new Error('revalidate failed');
        },
      };
      const cache = createInstance<number>({ platform, logger });

      expect(() => cache.invalidate('p1')).not.toThrow();
      await settle();

      expect(logger.error).toHaveBeenCalledWith(
        cache.name,
        'Error in onInvalidate:',
        expect.any(Error)
      );
    });
  });

  describe('cached fallbacks', () => {
    const failing = async (): Promise<number> => {
      throw new Error('source down');
    };

    it('should report a cached fallback as a failed refresh', async () => {
      const cache = createInstance<number>();
      await cache.getOrSetDetailed('p1', failing, { errorFn: () => 7 });

      const result = await cache.getOrSetDetailed('p1', async () => 1);

      expect(result).toEqual({ value: 7, status: 'L1-HIT', refreshFailed: true });
    });

    it('should refresh a cached fallback in the background once the cooldown is over', async () => {
      const cache = createInstance<number>({ failureCooldown: 10_000 });
      await cache.getOrSetDetailed('p1', failing, { errorFn: () => 7, errorTtl: 60_000 });
      const fetch = vi.fn(async () => 1);

      await cache.getOrSetDetailed('p1', fetch);
      await settle();
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(cache.getOrSetDetailed('p1', fetch)).resolves.toMatchObject({ value: 7 });
      await settle();

      expect(fetch).toHaveBeenCalledOnce();
      await expect(cache.getOrSetDetailed('p1', fetch)).resolves.toEqual({
        value: 1,
        status: 'L1-HIT',
        refreshFailed: false,
      });
    });
  });

  describe('invalidation and the shared level', () => {
    it('should not adopt a shared copy produced before the key was invalidated', async () => {
      const cache = createInstance<number>();
      await cache.getOrSet('p1', async () => 1);
      await settle();
      await vi.advanceTimersByTimeAsync(100);
      const producedBefore = Date.now();
      await vi.advanceTimersByTimeAsync(100);
      cache.invalidate('p1');
      await settle();
      // e.g. another instance that read the row before the change, writing after the removal
      fake.data.set('lilypad:products:p1', {
        value: { lilypad: 1, value: 2, fetchedAt: producedBefore, expiresAt: Date.now() + 1000 },
        expiresAt: Date.now() + 1000,
      });

      await expect(cache.getOrSetDetailed('p1', async () => 3)).resolves.toMatchObject({
        value: 3,
        status: 'MISS',
      });
    });
  });
});
