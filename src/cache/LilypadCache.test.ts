/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import LilypadCache, { type LilypadCacheKey } from './LilypadCache';
import { LilypadLoggerType } from '@/logger/LilypadLogger';

describe('LilypadCache', () => {
  let cache: LilypadCache<string, number>;

  // Every test runs with fake timers: time only advances through vi.advanceTimersByTimeAsync
  beforeEach(() => {
    vi.useFakeTimers();
    cache = new LilypadCache<string, number>(1000);
  });

  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  describe('set and get', () => {
    it('should store and retrieve a value', () => {
      cache.set('key1', 42);
      expect(cache.get('key1')).toBe(42);
    });

    it('should return undefined for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should return undefined for expired value', async () => {
      cache.set('key1', 42, 50);
      expect(cache.get('key1')).toBe(42);
      await vi.advanceTimersByTimeAsync(80);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should remove expired value from cache when removeOld is true', async () => {
      cache.set('key1', 42, 50);
      await vi.advanceTimersByTimeAsync(80);
      cache.get('key1', true);
      expect(cache.getComprehensive('key1')).toEqual({ type: 'miss' });
    });

    it('should not remove expired value when removeOld is false', async () => {
      cache.set('key1', 42, 50);
      await vi.advanceTimersByTimeAsync(80);
      expect(cache.get('key1', false)).toBeUndefined();
      expect(cache.getComprehensive('key1').type).toBe('expired');
    });

    it('should keep expired value by default, as a fallback for returnOldOnError', async () => {
      cache.set('key1', 42, 50);
      await vi.advanceTimersByTimeAsync(80);
      expect(cache.get('key1')).toBeUndefined();
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      expect(value).toBe(42);
    });
  });

  describe('getComprehensive', () => {
    it('should return type hit for valid cached value', () => {
      cache.set('key1', 42);
      const result = cache.getComprehensive('key1');
      expect(result.type).toBe('hit');
      expect((result as any).value).toBe(42);
    });

    it('should return type expired for stale value', async () => {
      cache.set('key1', 42, 50);
      await vi.advanceTimersByTimeAsync(80);
      const result = cache.getComprehensive('key1');
      expect(result.type).toBe('expired');
      expect((result as any).value).toBe(42);
    });

    it('should return type miss for non-existent key', () => {
      const result = cache.getComprehensive('nonexistent');
      expect(result).toEqual({ type: 'miss' });
    });
  });

  describe('getOrSet', () => {
    it('should return cached value if available', async () => {
      cache.set('key1', 42);
      const value = await cache.getOrSet('key1', async () => 99);
      expect(value).toBe(42);
    });

    it('should compute and cache value if not present', async () => {
      const value = await cache.getOrSet('key1', async () => 42);
      expect(value).toBe(42);
      expect(cache.get('key1')).toBe(42);
    });

    it('should avoid duplicate concurrent fetches', async () => {
      const spy = vi.fn(async () => 42);
      const promise1 = cache.getOrSet('key1', spy);
      const promise2 = cache.getOrSet('key1', spy);
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(42);
      expect(result2).toBe(42);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should skip cache when skipCache is true', async () => {
      cache.set('key1', 42);
      const value = await cache.getOrSet('key1', async () => 99, { skipCache: true });
      expect(value).toBe(99);
    });

    it('should throw error when valueFn fails without an error fallback', async () => {
      await expect(
        cache.getOrSet('key1', async () => {
          throw new Error('fetch failed');
        })
      ).rejects.toThrow('fetch failed');
    });

    it('should return old value on error when returnOldOnError is true', async () => {
      cache.set('key1', 42);
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      expect(value).toBe(42);
    });

    it('should throw error on error fallback when no old value exists', async () => {
      await expect(
        cache.getOrSet(
          'key1',
          async () => {
            throw new Error('fetch failed');
          },
          { returnOldOnError: true }
        )
      ).rejects.toThrow('fetch failed');
    });

    it('should call errorFn on error when provided', async () => {
      cache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      const errorFn = vi.fn(() => {
        return 99;
      });
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed 42');
        },
        { errorFn: errorFn, returnOldOnError: true }
      );
      expect(errorFn).toHaveBeenCalled();
      expect(value).toBe(99);
    });

    it('should use custom TTL when provided', async () => {
      const value = await cache.getOrSet('key1', async () => 42, { ttl: 100 });
      expect(value).toBe(42);
      await vi.advanceTimersByTimeAsync(150);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should use errorTtl when caching old value on error', async () => {
      cache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true, errorTtl: 30 }
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(cache.get('key1', false)).toBeUndefined();
    });

    it('should handle errorFn returning undefined', async () => {
      cache.set('key1', 42);
      const errorFn = vi.fn(() => undefined);
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true, errorFn }
      );
      expect(value).toBe(42);
    });
  });

  describe('protected keys', () => {
    it('should add protected keys', () => {
      cache.set('key1', 42);
      cache.addProtectedKeys(['key1']);
      cache.delete('key1');
      expect(cache.get('key1')).toBe(42);
    });

    it('should allow force deletion of protected keys', () => {
      cache.set('key1', 42);
      cache.addProtectedKeys(['key1']);
      cache.delete('key1', { force: true });
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should remove protected keys', () => {
      cache.set('key1', 42);
      cache.addProtectedKeys(['key1']);
      cache.removeProtectedKeys(['key1']);
      cache.delete('key1');
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should support method chaining', () => {
      const result = cache.addProtectedKeys(['key1']).removeProtectedKeys(['key1']);
      expect(result).toBe(cache);
    });
  });

  describe('invalidate', () => {
    it('should mark cached value as expired', async () => {
      cache.set('key1', 42);
      cache.invalidate('key1');
      await vi.advanceTimersByTimeAsync(10);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should not invalidate non-existent keys', () => {
      cache.invalidate('nonexistent');
      const result = cache.getComprehensive('nonexistent');
      expect(result.type).toBe('miss');
    });
  });

  describe('clear', () => {
    it('should remove all non-protected entries', () => {
      cache.set('key1', 42);
      cache.set('key2', 99);
      cache.clear();
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });

    it('should not remove protected entries', () => {
      cache.set('key1', 42);
      cache.addProtectedKeys(['key1']);
      cache.clear();
      expect(cache.get('key1')).toBe(42);
    });

    it('should force clear all entries including protected', () => {
      cache.set('key1', 42);
      cache.addProtectedKeys(['key1']);
      cache.clear({ force: true });
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('purgeExpired', () => {
    it('should remove expired entries', async () => {
      cache.set('key1', 42, 10);
      cache.set('key2', 99, 5000);
      await vi.advanceTimersByTimeAsync(50);
      cache.purgeExpired();
      expect(cache.get('key1', false)).toBeUndefined();
      expect(cache.get('key2')).toBe(99);
    });

    it('should not remove protected expired entries', async () => {
      cache.set('key1', 42, 10);
      cache.addProtectedKeys(['key1']);
      await vi.advanceTimersByTimeAsync(50);
      cache.purgeExpired();
      expect(cache.getComprehensive('key1').type).toBe('expired');
    });

    it('should force remove all expired entries including protected', async () => {
      cache.set('key1', 42, 100);
      cache.addProtectedKeys(['key1']);
      await vi.advanceTimersByTimeAsync(150);
      cache.purgeExpired({ force: true });
      expect(cache.get('key1', false)).toBeUndefined();
    });
  });

  describe('constructor options', () => {
    it('should use custom default TTL', async () => {
      const customCache = new LilypadCache<string, number>(100);
      customCache.set('key1', 42);
      await vi.advanceTimersByTimeAsync(150);
      expect(customCache.get('key1')).toBeUndefined();
      customCache.dispose();
    });

    it('should use custom defaultErrorTtl', async () => {
      const customCache = new LilypadCache<string, number>(5000, { defaultErrorTtl: 100 });
      customCache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      await customCache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(customCache.get('key1', false)).toBeUndefined();
      customCache.dispose();
    });

    it('should throw on invalid autoCleanupInterval', () => {
      expect(() => new LilypadCache<string, number>(1000, { autoCleanupInterval: -1 })).toThrow(
        'autoCleanupInterval must be a positive finite number'
      );
    });

    it('should setup auto cleanup interval', async () => {
      const customCache = new LilypadCache<string, number>(5000, { autoCleanupInterval: 100 });
      customCache.set('key1', 42, 50);
      await vi.advanceTimersByTimeAsync(200);
      expect(customCache.get('key1', false)).toBeUndefined();
      customCache.dispose();
    });
  });

  describe('dispose', () => {
    it('should clear all entries on dispose', () => {
      cache.set('key1', 42);
      cache.dispose();
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should stop cleanup interval on dispose', () => {
      const customCache = new LilypadCache<string, number>(5000, { autoCleanupInterval: 1000 });
      expect(() => customCache.dispose()).not.toThrow();
    });

    it('should force clear all entries on dispose even if protected', () => {
      cache.set('key1', 42);
      cache.set('key2', 99);
      cache.addProtectedKeys(['key1', 'key2']);
      cache.dispose();
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle getOrSet with expired pending promise', async () => {
      const spy = vi.fn(() => new Promise<number>((resolve) => setTimeout(() => resolve(42), 100)));
      const promise1 = cache.getOrSet('key1', spy);
      await vi.advanceTimersByTimeAsync(50);
      const promise2 = cache.getOrSet('key1', spy);
      await vi.advanceTimersByTimeAsync(50);
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(42);
      expect(result2).toBe(42);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple errors in pending promises', async () => {
      const spy = vi.fn(async () => {
        throw new Error('fetch failed');
      });
      cache.set('key1', 42);
      const promise1 = cache.getOrSet('key1', spy, { returnOldOnError: true });
      const promise2 = cache.getOrSet('key1', spy, { returnOldOnError: true });
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(42);
      expect(result2).toBe(42);
    });

    it('should handle invalidate on expired value', async () => {
      cache.set('key1', 42, 100);
      await vi.advanceTimersByTimeAsync(150);
      cache.invalidate('key1');
      expect(cache.getComprehensive('key1').type).toBeOneOf(['miss', 'expired']);
    });

    it('should handle clear on empty cache', () => {
      expect(() => cache.clear()).not.toThrow();
    });

    it('should handle purgeExpired on empty cache', () => {
      expect(() => cache.purgeExpired()).not.toThrow();
    });

    it('should handle dispose multiple times', () => {
      cache.set('key1', 42);
      expect(() => {
        cache.dispose();
        cache.dispose();
      }).not.toThrow();
    });

    it('should reject errorFn that throws', async () => {
      cache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      await expect(
        cache.getOrSet(
          'key1',
          async () => {
            throw new Error('fetch failed');
          },
          {
            returnOldOnError: true,
            errorFn: () => {
              throw new Error('errorFn failed');
            },
          }
        )
      ).rejects.toThrow('errorFn failed');
    });

    it('should cache value with default TTL when not specified in getOrSet', async () => {
      const value = await cache.getOrSet('key1', async () => 42);
      expect(value).toBe(42);
      expect(cache.get('key1')).toBe(42);
    });

    it('should handle getOrSet with 0 TTL', async () => {
      const value = await cache.getOrSet('key1', async () => 42, { ttl: 0 });
      expect(value).toBe(42);
      await vi.advanceTimersByTimeAsync(10);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should handle logger when provided', async () => {
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        components: {},
        register: vi.fn(),
        __name: undefined,
      } as unknown as LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
      const customCache = new LilypadCache<string, number>(1000, { logger: mockLogger });
      customCache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      await customCache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      expect(mockLogger.error).toHaveBeenCalled();
      customCache.dispose();
    });

    it('should handle getOrSet with expired value and no old value fallback', async () => {
      cache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      await expect(
        cache.getOrSet('key1', async () => {
          throw new Error('fetch failed');
        })
      ).rejects.toThrow('fetch failed');
    });

    it('should prioritize errorFn over returnOldOnError', async () => {
      cache.set('key1', 42, 10);
      await vi.advanceTimersByTimeAsync(20);
      const errorFn = vi.fn(() => 100);
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { errorFn, returnOldOnError: true }
      );
      expect(value).toBe(100);
      expect(errorFn).toHaveBeenCalled();
    });

    it('should handle getOrSet with skipCache and error', async () => {
      cache.set('key1', 42);
      const errorFn = vi.fn(() => 99);
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { skipCache: true, errorFn }
      );
      expect(value).toBe(99);
    });

    it('should handle concurrent pending promise errors independently', async () => {
      const errorFn1 = vi.fn(() => 100);
      const errorFn2 = vi.fn(() => 200);
      cache.set('key1', 42);
      const spy = vi.fn(async () => {
        throw new Error('fetch failed');
      });
      const promise1 = cache.getOrSet('key1', spy, { returnOldOnError: true, errorFn: errorFn1 });
      const promise2 = cache.getOrSet('key1', spy, { returnOldOnError: true, errorFn: errorFn2 });
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(42);
      expect(result2).toBe(42);
    });

    it('should use default TTL when not specified in set', async () => {
      const customCache = new LilypadCache<string, number>(200);
      customCache.set('key1', 42);
      await vi.advanceTimersByTimeAsync(250);
      expect(customCache.get('key1')).toBeUndefined();
      customCache.dispose();
    });

    it('should handle negative TTL values', async () => {
      cache.set('key1', 42, -100);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should handle very large TTL values', async () => {
      cache.set('key1', 42, Number.MAX_SAFE_INTEGER);
      expect(cache.get('key1')).toBe(42);
    });

    it('should handle mixed protected and non-protected keys in clear', () => {
      cache.set('key1', 42);
      cache.set('key2', 99);
      cache.set('key3', 100);
      cache.addProtectedKeys(['key2']);
      cache.clear();
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe(99);
      expect(cache.get('key3')).toBeUndefined();
    });

    it('should handle mixed protected and non-protected keys in purgeExpired', async () => {
      cache.set('key1', 42, 100);
      cache.set('key2', 99, 100);
      cache.set('key3', 100, 5000);
      cache.addProtectedKeys(['key2']);
      await vi.advanceTimersByTimeAsync(150);
      cache.purgeExpired();
      expect(cache.get('key1', false)).toBeUndefined();
      expect(cache.getComprehensive('key2').type).toBe('expired');
      expect(cache.get('key3')).toBe(100);
    });

    it('should not call errorFn when valueFn succeeds', async () => {
      const errorFn = vi.fn(() => 99);
      const value = await cache.getOrSet('key1', async () => 42, { errorFn });
      expect(value).toBe(42);
      expect(errorFn).not.toHaveBeenCalled();
    });

    describe('bulkSet, bulkGet, bulkAsyncGet, and bulkSync', () => {
      it('should set multiple entries with bulkSet (array)', () => {
        cache.bulkSet([
          ['key1', 1],
          ['key2', 2],
        ]);
        expect(cache.get('key1')).toBe(1);
        expect(cache.get('key2')).toBe(2);
      });

      it('should set multiple entries with bulkSet (Map)', () => {
        const map = new Map<string, number>([
          ['key1', 1],
          ['key2', 2],
        ]);
        cache.bulkSet(map);
        expect(cache.get('key1')).toBe(1);
        expect(cache.get('key2')).toBe(2);
      });

      it('should get multiple entries with bulkGet (all)', () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        const result = cache.bulkGet({});
        expect(result.get('key1')).toBe(1);
        expect(result.get('key2')).toBe(2);
      });

      it('should get multiple entries with bulkGet (keys)', () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        cache.set('key3', 3);
        const result = cache.bulkGet({ keys: ['key1', 'key3'] });
        expect(result.get('key1')).toBe(1);
        expect(result.get('key3')).toBe(3);
        expect(result.has('key2')).toBe(false);
      });

      it('should get multiple entries with bulkAsyncGet', async () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        const result = await cache.bulkAsyncGet({ keys: ['key1', 'key2'] });
        expect(result.get('key1')).toBe(1);
        expect(result.get('key2')).toBe(2);
      });

      it('should bulkAsyncGet with doSync and syncFn', async () => {
        const syncFn: () => Promise<[string, number][]> = vi.fn(
          async () =>
            [
              ['keyA', 10],
              ['keyB', 20],
            ] as [string, number][]
        );
        const result = await cache.bulkAsyncGet({ doSync: true, syncFn });
        expect(result.get('keyA')).toBe(10);
        expect(result.get('keyB')).toBe(20);
        expect(syncFn).toHaveBeenCalled();
      });

      it('should bulkSync using instance bulkSyncFn', async () => {
        const customCache = new LilypadCache<string, number>(1000, {
          bulkSyncFn: async () => [
            ['keyX', 123],
            ['keyY', 456],
          ],
        });
        await customCache.bulkSync();
        expect(customCache.get('keyX')).toBe(123);
        expect(customCache.get('keyY')).toBe(456);
        customCache.dispose();
      });

      it('should not bulkSync again before bulkSyncExpirationTime', async () => {
        let callCount = 0;
        const syncFn = vi.fn(async () => {
          callCount++;
          return [
            ['key1', 1],
            ['key2', 2],
          ] as [string, number][];
        });
        const customCache = new LilypadCache<string, number>(1000, {
          defaultBulkSyncTtl: 1000,
          bulkSyncFn: syncFn,
        });
        await customCache.bulkSync();
        await customCache.bulkSync();
        expect(callCount).toBe(1);
        customCache.dispose();
      });

      describe('invalidate', () => {
        it('should expire a valid cached value', () => {
          cache.set('key1', 123, 1000);
          expect(cache.getComprehensive('key1').type).toBe('hit');
          cache.invalidate('key1');
          expect(cache.getComprehensive('key1').type).toBe('expired');
        });

        it('should set bulkSyncExpirationTime to 0 for expired value', async () => {
          cache.set('key1', 123, 1);
          await vi.advanceTimersByTimeAsync(10);
          cache.invalidate('key1');
          expect(cache['bulkSyncExpirationTime']).toBe(0);
        });

        it('should set bulkSyncExpirationTime to 0 for valid value', () => {
          cache.set('key1', 123, 1000);
          cache.invalidate('key1');
          expect(cache['bulkSyncExpirationTime']).toBe(0);
        });

        it('should make the next bulkSync call fetch fresh data', async () => {
          let callCount = 0;

          async function syncFn(): Promise<[string, number][]> {
            callCount++;
            return [
              ['key1', callCount],
              ['test', 999],
            ];
          }

          const customCache = new LilypadCache<string, number>(1000, {
            defaultBulkSyncTtl: 5000,
            bulkSyncFn: syncFn,
          });
          const value = await customCache.bulkAsyncGet();
          expect(value.get('key1')).toBe(1);
          expect(customCache.get('key1')).toBe(1);
          expect(customCache.get('test')).toBe(999);
          // Invalidate to force next bulkSync to fetch fresh data
          customCache.invalidate('key1');
          const value2 = await customCache.bulkAsyncGet();
          expect(value2.get('key1')).toBe(2);
          expect(customCache.get('key1')).toBe(2);
          expect(customCache.get('test')).toBe(999);
          customCache.dispose();
        });

        it('should do nothing for a missing key except bulkSyncExpirationTime', () => {
          expect(cache.getComprehensive('missing').type).toBe('miss');
          cache.invalidate('missing');
          expect(cache.getComprehensive('missing').type).toBe('miss');
          expect(cache['bulkSyncExpirationTime']).toBe(0);
        });

        it('should not change value for already expired key', async () => {
          cache.set('key1', 123, 10);
          await vi.advanceTimersByTimeAsync(20);
          expect(cache.getComprehensive('key1').type).toBe('expired');
          cache.invalidate('key1');
          expect(cache.getComprehensive('key1').type).toBe('expired');
        });

        it('should not set bulkSyncExpirationTime to 0 if invalidateBulkSync is false', () => {
          cache.set('key1', 123, 1000);
          const prev = cache['bulkSyncExpirationTime'];
          cache.invalidate('key1', { invalidateBulkSync: false });
          expect(cache['bulkSyncExpirationTime']).toBe(prev);
        });
      });
    });
  });

  describe('regressions', () => {
    it('should expire bulk synced entries after the default TTL', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncFn: async () => [['key1', 1]],
      });
      await customCache.bulkSync();
      expect(customCache.get('key1')).toBe(1);
      vi.advanceTimersByTime(1001);
      expect(customCache.get('key1')).toBeUndefined();
      customCache.dispose();
    });

    it('should log and swallow bulk sync errors, keeping the current content', async () => {
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
      const customCache = new LilypadCache<string, number>(1000, {
        logger: mockLogger,
        bulkSyncFn: async () => {
          throw new Error('sync failed');
        },
      });
      customCache.set('key1', 42);
      await expect(customCache.bulkSync()).resolves.toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
      expect(customCache.get('key1')).toBe(42);
      customCache.dispose();
    });

    it('should expire protected keys during bulk sync without calling invalidate', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncFn: async () => [['other', 2]],
      });
      customCache.set('protected', 1);
      customCache.addProtectedKeys(['protected']);
      const invalidateSpy = vi.spyOn(customCache, 'invalidate');
      await customCache.bulkSync();
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(customCache.getComprehensive('protected').type).toBe('expired');
      expect(customCache.get('other')).toBe(2);
      customCache.dispose();
    });

    it('should sync by default when bulkAsyncGet receives only keys', async () => {
      const syncFn = vi.fn(async (): Promise<[string, number][]> => [['key1', 1]]);
      const customCache = new LilypadCache<string, number>(1000, { bulkSyncFn: syncFn });
      const result = await customCache.bulkAsyncGet({ keys: ['key1'] });
      expect(syncFn).toHaveBeenCalledOnce();
      expect(result.get('key1')).toBe(1);
      customCache.dispose();
    });

    it('should invalidate bulk sync by default when invalidate receives partial options', () => {
      cache['bulkSyncExpirationTime'] = Date.now() + 10000;
      cache.invalidate('key1', {});
      expect(cache['bulkSyncExpirationTime']).toBe(0);
    });

    it('should protect keys that are numbers at runtime', () => {
      const numericKey = 42 as unknown as string;
      cache.set(numericKey, 1);
      cache.addProtectedKeys([numericKey]);
      expect(cache.delete('42')).toBe(false);
      expect(cache.delete(numericKey)).toBe(false);
      cache.clear();
      expect(cache.get('42')).toBe(1);
      cache.removeProtectedKeys([numericKey]);
      expect(cache.delete('42')).toBe(true);
    });

    it('should not cache a value resolved after the flow control timeout', async () => {
      const customCache = new LilypadCache<string, number>(60000, { flowControlTimeout: 100 });
      const promise = customCache.getOrSet(
        'key1',
        () => new Promise((resolve) => setTimeout(() => resolve(1), 500))
      );
      const assertion = expect(promise).rejects.toThrow('Operation timed out');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      customCache.set('key1', 2); // e.g. a newer value from a database notification
      await vi.advanceTimersByTimeAsync(400);
      expect(customCache.get('key1')).toBe(2);
      customCache.dispose();
    });

    it('should accept 0 as defaultErrorTtl', async () => {
      const customCache = new LilypadCache<string, number>(1000, { defaultErrorTtl: 0 });
      customCache.set('key1', 42, -1);
      await customCache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      expect(customCache.getComprehensive('key1').type).toBe('expired');
      customCache.dispose();
    });
  });

  describe('error handling of shared fetches', () => {
    it('should apply the error options of each caller to a shared failed fetch', async () => {
      cache.set('key1', 42, -1); // expired: a fallback is available
      const spy = vi.fn(async () => {
        throw new Error('fetch failed');
      });

      const withFallback = cache.getOrSet('key1', spy, { returnOldOnError: true });
      const withoutFallback = cache.getOrSet('key1', spy);

      await expect(withFallback).resolves.toBe(42);
      await expect(withoutFallback).rejects.toThrow('fetch failed');
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should log a failed shared fetch once', async () => {
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;
      const customCache = new LilypadCache<string, number>(1000, { logger: mockLogger });
      const failing = async () => {
        throw new Error('fetch failed');
      };

      await Promise.allSettled([
        customCache.getOrSet('key1', failing),
        customCache.getOrSet('key1', failing),
      ]);

      expect(mockLogger.error).toHaveBeenCalledOnce();
      customCache.dispose();
    });

    it('should cache error fallbacks for at most the default TTL', async () => {
      const value = await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { errorFn: () => 7 }
      );

      expect(value).toBe(7);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should pass valueFn a signal that is aborted on timeout', async () => {
      const customCache = new LilypadCache<string, number>(60000, { flowControlTimeout: 100 });
      let received: AbortSignal | undefined;
      const promise = customCache.getOrSet('key1', (signal) => {
        received = signal;
        return new Promise<number>(() => {});
      });
      const assertion = expect(promise).rejects.toThrow('Operation timed out');

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
      expect(received?.aborted).toBe(true);
      customCache.dispose();
    });
  });

  describe('write ordering', () => {
    /** A value source whose resolution the test controls. */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('should not overwrite a value written after the fetch started', async () => {
      const fetch = deferred<number>();
      const promise = cache.getOrSet('key1', () => fetch.promise);

      cache.set('key1', 2); // e.g. a newer value from a database notification
      fetch.resolve(1);

      await expect(promise).resolves.toBe(1);
      expect(cache.get('key1')).toBe(2);
    });

    it('should not cache a fetch that started before an invalidation', async () => {
      cache.set('key1', 1, -1);
      const fetch = deferred<number>();
      const promise = cache.getOrSet('key1', () => fetch.promise);

      cache.set('key1', 2);
      cache.invalidate('key1');
      fetch.resolve(1);
      await promise;

      expect(cache.getComprehensive('key1')).toMatchObject({ type: 'expired', value: 2 });
    });

    it('should keep values written while a bulk sync was running', async () => {
      const sync = deferred<[string, number][]>();
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncFn: () => sync.promise,
      });
      const syncing = customCache.bulkSync();
      await vi.advanceTimersByTimeAsync(0);

      customCache.set('key1', 2);
      sync.resolve([
        ['key1', 1],
        ['key2', 2],
      ]);

      await expect(syncing).resolves.toBe(true);
      expect(customCache.get('key1')).toBe(2);
      expect(customCache.get('key2')).toBe(2);
      customCache.dispose();
    });

    it('should not cache a fetch older than a completed bulk sync', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncFn: async () => [['key2', 2]],
      });
      const fetch = deferred<number>();
      const promise = customCache.getOrSet('key1', () => fetch.promise);

      await customCache.bulkSync();
      fetch.resolve(1);

      await expect(promise).resolves.toBe(1);
      expect(customCache.getComprehensive('key1').type).toBe('miss');
      customCache.dispose();
    });

    it('should not mark the bulk sync fresh when invalidated while it runs', async () => {
      let sync = deferred<[string, number][]>();
      const bulkSyncFn = vi.fn(() => sync.promise);
      const customCache = new LilypadCache<string, number>(1000, { bulkSyncFn });

      const first = customCache.bulkSync();
      await vi.advanceTimersByTimeAsync(0);
      customCache.invalidate('any');
      sync.resolve([]);
      await first;

      sync = deferred();
      const second = customCache.bulkSync();
      await vi.advanceTimersByTimeAsync(0);
      sync.resolve([]);
      await second;

      expect(bulkSyncFn).toHaveBeenCalledTimes(2);
      customCache.dispose();
    });

    it('should ignore fetches that complete after dispose', async () => {
      const fetch = deferred<number>();
      const promise = cache.getOrSet('key1', () => fetch.promise);

      cache.dispose();
      fetch.resolve(1);
      await promise;

      expect(cache.getComprehensive('key1').type).toBe('miss');
    });
  });

  describe('bulk sync outcome', () => {
    it('should not write the data of a bulk sync resolved after its timeout', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncTimeout: 100,
        bulkSyncFn: () => new Promise((resolve) => setTimeout(() => resolve([['key1', 1]]), 500)),
      });
      customCache.set('key0', 0);

      const syncing = customCache.bulkSync();
      await vi.advanceTimersByTimeAsync(100);
      await expect(syncing).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(400);

      expect(customCache.get('key1')).toBeUndefined();
      expect(customCache.get('key0')).toBe(0);
      customCache.dispose();
    });

    it('should not apply flowControlTimeout to bulk sync', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        flowControlTimeout: 100,
        bulkSyncFn: () => new Promise((resolve) => setTimeout(() => resolve([['key1', 1]]), 500)),
      });

      const syncing = customCache.bulkSync();
      await vi.advanceTimersByTimeAsync(500);

      await expect(syncing).resolves.toBe(true);
      expect(customCache.get('key1')).toBe(1);
      customCache.dispose();
    });

    it('should reject a failed bulk sync with throwOnError', async () => {
      const customCache = new LilypadCache<string, number>(1000, {
        bulkSyncFn: async () => {
          throw new Error('sync failed');
        },
      });

      await expect(customCache.bulkSync(undefined, { throwOnError: true })).rejects.toThrow(
        'sync failed'
      );
      customCache.dispose();
    });
  });

  describe('numeric keys', () => {
    it('should address the same entry with a number and its string form', () => {
      const mixed = new LilypadCache<LilypadCacheKey, string>(1000);
      mixed.set(1, 'one');

      expect(mixed.get('1')).toBe('one');
      mixed.dispose();
    });

    it('should return the keys with their original type from bulkGet', () => {
      const numeric = new LilypadCache<number, string>(1000);
      numeric.set(1, 'one');
      numeric.set(2, 'two');

      expect([...numeric.bulkGet({}).keys()]).toEqual([1, 2]);
      numeric.dispose();
    });
  });
});
