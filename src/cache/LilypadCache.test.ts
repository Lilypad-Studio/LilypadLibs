/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import LilypadCache from './LilypadCache';
import { LilypadLoggerType } from '@/logger/LilypadLogger';

describe('LilypadCache', () => {
  let cache: LilypadCache<string, number>;

  beforeEach(() => {
    cache = new LilypadCache<string, number>(1000);
  });

  afterEach(() => {
    cache.dispose();
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
      cache.set('key1', 42, 100);
      expect(cache.get('key1')).toBe(42);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should remove expired value from cache', async () => {
      cache.set('key1', 42, 100);
      await new Promise((resolve) => setTimeout(resolve, 150));
      cache.get('key1');
      expect(cache.getComprehensive('key1')).toEqual({ type: 'miss' });
    });

    it('should not remove expired value when removeOld is false', async () => {
      cache.set('key1', 42, 100);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cache.get('key1', false)).toBeUndefined();
      expect(cache.getComprehensive('key1').type).toBe('expired');
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
      cache.set('key1', 42, 100);
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 20));
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
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should use errorTtl when caching old value on error', async () => {
      cache.set('key1', 42, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true, errorTtl: 100 }
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      await new Promise((resolve) => setTimeout(resolve, 50));
      cache.purgeExpired();
      expect(cache.get('key1', false)).toBeUndefined();
      expect(cache.get('key2')).toBe(99);
    });

    it('should not remove protected expired entries', async () => {
      cache.set('key1', 42, 10);
      cache.addProtectedKeys(['key1']);
      await new Promise((resolve) => setTimeout(resolve, 50));
      cache.purgeExpired();
      expect(cache.getComprehensive('key1').type).toBe('expired');
    });

    it('should force remove all expired entries including protected', async () => {
      cache.set('key1', 42, 100);
      cache.addProtectedKeys(['key1']);
      await new Promise((resolve) => setTimeout(resolve, 150));
      cache.purgeExpired({ force: true });
      expect(cache.get('key1', false)).toBeUndefined();
    });
  });

  describe('constructor options', () => {
    it('should use custom default TTL', async () => {
      const customCache = new LilypadCache<string, number>(100);
      customCache.set('key1', 42);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(customCache.get('key1')).toBeUndefined();
      customCache.dispose();
    });

    it('should use custom defaultErrorTtl', async () => {
      const customCache = new LilypadCache<string, number>(5000, { defaultErrorTtl: 100 });
      customCache.set('key1', 42, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await customCache.getOrSet(
        'key1',
        async () => {
          throw new Error('fetch failed');
        },
        { returnOldOnError: true }
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 200));
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
      const spy = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 42;
      });
      const promise1 = cache.getOrSet('key1', spy);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const promise2 = cache.getOrSet('key1', spy);
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 20));
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should handle logger when provided', async () => {
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        components: {},
        register: vi.fn(),
        __name: undefined,
      } as unknown as LilypadLoggerType<'error' | 'warn'>;
      const customCache = new LilypadCache<string, number>(1000, { logger: mockLogger });
      customCache.set('key1', 42, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(
        cache.getOrSet('key1', async () => {
          throw new Error('fetch failed');
        })
      ).rejects.toThrow('fetch failed');
    });

    it('should prioritize errorFn over returnOldOnError', async () => {
      cache.set('key1', 42, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
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
      await new Promise((resolve) => setTimeout(resolve, 250));
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
  });
});
