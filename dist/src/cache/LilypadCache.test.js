"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-explicit-any */
const vitest_1 = require("vitest");
const LilypadCache_1 = __importDefault(require("./LilypadCache"));
(0, vitest_1.describe)('LilypadCache', () => {
    let cache;
    (0, vitest_1.beforeEach)(() => {
        cache = new LilypadCache_1.default(1000);
    });
    (0, vitest_1.afterEach)(() => {
        cache.dispose();
    });
    (0, vitest_1.describe)('set and get', () => {
        (0, vitest_1.it)('should store and retrieve a value', () => {
            cache.set('key1', 42);
            (0, vitest_1.expect)(cache.get('key1')).toBe(42);
        });
        (0, vitest_1.it)('should return undefined for non-existent key', () => {
            (0, vitest_1.expect)(cache.get('nonexistent')).toBeUndefined();
        });
        (0, vitest_1.it)('should return undefined for expired value', async () => {
            cache.set('key1', 42, 100);
            (0, vitest_1.expect)(cache.get('key1')).toBe(42);
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should remove expired value from cache', async () => {
            cache.set('key1', 42, 100);
            await new Promise((resolve) => setTimeout(resolve, 150));
            cache.get('key1');
            (0, vitest_1.expect)(cache.getComprehensive('key1')).toEqual({ type: 'miss' });
        });
        (0, vitest_1.it)('should not remove expired value when removeOld is false', async () => {
            cache.set('key1', 42, 100);
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(cache.get('key1', false)).toBeUndefined();
            (0, vitest_1.expect)(cache.getComprehensive('key1').type).toBe('expired');
        });
    });
    (0, vitest_1.describe)('getComprehensive', () => {
        (0, vitest_1.it)('should return type hit for valid cached value', () => {
            cache.set('key1', 42);
            const result = cache.getComprehensive('key1');
            (0, vitest_1.expect)(result.type).toBe('hit');
            (0, vitest_1.expect)(result.value).toBe(42);
        });
        (0, vitest_1.it)('should return type expired for stale value', async () => {
            cache.set('key1', 42, 100);
            await new Promise((resolve) => setTimeout(resolve, 150));
            const result = cache.getComprehensive('key1');
            (0, vitest_1.expect)(result.type).toBe('expired');
            (0, vitest_1.expect)(result.value).toBe(42);
        });
        (0, vitest_1.it)('should return type miss for non-existent key', () => {
            const result = cache.getComprehensive('nonexistent');
            (0, vitest_1.expect)(result).toEqual({ type: 'miss' });
        });
    });
    (0, vitest_1.describe)('getOrSet', () => {
        (0, vitest_1.it)('should return cached value if available', async () => {
            cache.set('key1', 42);
            const value = await cache.getOrSet('key1', async () => 99);
            (0, vitest_1.expect)(value).toBe(42);
        });
        (0, vitest_1.it)('should compute and cache value if not present', async () => {
            const value = await cache.getOrSet('key1', async () => 42);
            (0, vitest_1.expect)(value).toBe(42);
            (0, vitest_1.expect)(cache.get('key1')).toBe(42);
        });
        (0, vitest_1.it)('should avoid duplicate concurrent fetches', async () => {
            const spy = vitest_1.vi.fn(async () => 42);
            const promise1 = cache.getOrSet('key1', spy);
            const promise2 = cache.getOrSet('key1', spy);
            const [result1, result2] = await Promise.all([promise1, promise2]);
            (0, vitest_1.expect)(result1).toBe(42);
            (0, vitest_1.expect)(result2).toBe(42);
            (0, vitest_1.expect)(spy).toHaveBeenCalledTimes(1);
        });
        (0, vitest_1.it)('should skip cache when skipCache is true', async () => {
            cache.set('key1', 42);
            const value = await cache.getOrSet('key1', async () => 99, { skipCache: true });
            (0, vitest_1.expect)(value).toBe(99);
        });
        (0, vitest_1.it)('should throw error when valueFn fails without an error fallback', async () => {
            await (0, vitest_1.expect)(cache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            })).rejects.toThrow('fetch failed');
        });
        (0, vitest_1.it)('should return old value on error when returnOldOnError is true', async () => {
            cache.set('key1', 42);
            const value = await cache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            }, { returnOldOnError: true });
            (0, vitest_1.expect)(value).toBe(42);
        });
        (0, vitest_1.it)('should throw error on error fallback when no old value exists', async () => {
            await (0, vitest_1.expect)(cache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            }, { returnOldOnError: true })).rejects.toThrow('fetch failed');
        });
        (0, vitest_1.it)('should call errorFn on error when provided', async () => {
            cache.set('key1', 42, 10);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const errorFn = vitest_1.vi.fn(() => {
                return 99;
            });
            const value = await cache.getOrSet('key1', async () => {
                throw new Error('fetch failed 42');
            }, { errorFn: errorFn, returnOldOnError: true });
            (0, vitest_1.expect)(errorFn).toHaveBeenCalled();
            (0, vitest_1.expect)(value).toBe(99);
        });
        (0, vitest_1.it)('should use custom TTL when provided', async () => {
            const value = await cache.getOrSet('key1', async () => 42, { ttl: 100 });
            (0, vitest_1.expect)(value).toBe(42);
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should use errorTtl when caching old value on error', async () => {
            cache.set('key1', 42, 10);
            await new Promise((resolve) => setTimeout(resolve, 20));
            await cache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            }, { returnOldOnError: true, errorTtl: 100 });
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(cache.get('key1', false)).toBeUndefined();
        });
        (0, vitest_1.it)('should handle errorFn returning undefined', async () => {
            cache.set('key1', 42);
            const errorFn = vitest_1.vi.fn(() => undefined);
            const value = await cache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            }, { returnOldOnError: true, errorFn });
            (0, vitest_1.expect)(value).toBe(42);
        });
    });
    (0, vitest_1.describe)('protected keys', () => {
        (0, vitest_1.it)('should add protected keys', () => {
            cache.set('key1', 42);
            cache.addProtectedKeys(['key1']);
            cache.delete('key1');
            (0, vitest_1.expect)(cache.get('key1')).toBe(42);
        });
        (0, vitest_1.it)('should allow force deletion of protected keys', () => {
            cache.set('key1', 42);
            cache.addProtectedKeys(['key1']);
            cache.delete('key1', { force: true });
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should remove protected keys', () => {
            cache.set('key1', 42);
            cache.addProtectedKeys(['key1']);
            cache.removeProtectedKeys(['key1']);
            cache.delete('key1');
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should support method chaining', () => {
            const result = cache.addProtectedKeys(['key1']).removeProtectedKeys(['key1']);
            (0, vitest_1.expect)(result).toBe(cache);
        });
    });
    (0, vitest_1.describe)('invalidate', () => {
        (0, vitest_1.it)('should mark cached value as expired', async () => {
            cache.set('key1', 42);
            cache.invalidate('key1');
            await new Promise((resolve) => setTimeout(resolve, 10));
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should not invalidate non-existent keys', () => {
            cache.invalidate('nonexistent');
            const result = cache.getComprehensive('nonexistent');
            (0, vitest_1.expect)(result.type).toBe('miss');
        });
    });
    (0, vitest_1.describe)('clear', () => {
        (0, vitest_1.it)('should remove all non-protected entries', () => {
            cache.set('key1', 42);
            cache.set('key2', 99);
            cache.clear();
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
            (0, vitest_1.expect)(cache.get('key2')).toBeUndefined();
        });
        (0, vitest_1.it)('should not remove protected entries', () => {
            cache.set('key1', 42);
            cache.addProtectedKeys(['key1']);
            cache.clear();
            (0, vitest_1.expect)(cache.get('key1')).toBe(42);
        });
        (0, vitest_1.it)('should force clear all entries including protected', () => {
            cache.set('key1', 42);
            cache.addProtectedKeys(['key1']);
            cache.clear({ force: true });
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
    });
    (0, vitest_1.describe)('purgeExpired', () => {
        (0, vitest_1.it)('should remove expired entries', async () => {
            cache.set('key1', 42, 100);
            cache.set('key2', 99, 5000);
            await new Promise((resolve) => setTimeout(resolve, 150));
            cache.purgeExpired();
            (0, vitest_1.expect)(cache.get('key1', false)).toBeUndefined();
            (0, vitest_1.expect)(cache.get('key2')).toBe(99);
        });
        (0, vitest_1.it)('should not remove protected expired entries', async () => {
            cache.set('key1', 42, 100);
            cache.addProtectedKeys(['key1']);
            await new Promise((resolve) => setTimeout(resolve, 150));
            cache.purgeExpired();
            (0, vitest_1.expect)(cache.getComprehensive('key1').type).toBe('expired');
        });
        (0, vitest_1.it)('should force remove all expired entries including protected', async () => {
            cache.set('key1', 42, 100);
            cache.addProtectedKeys(['key1']);
            await new Promise((resolve) => setTimeout(resolve, 150));
            cache.purgeExpired({ force: true });
            (0, vitest_1.expect)(cache.get('key1', false)).toBeUndefined();
        });
    });
    (0, vitest_1.describe)('constructor options', () => {
        (0, vitest_1.it)('should use custom default TTL', async () => {
            const customCache = new LilypadCache_1.default(100);
            customCache.set('key1', 42);
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(customCache.get('key1')).toBeUndefined();
            customCache.dispose();
        });
        (0, vitest_1.it)('should use custom defaultErrorTtl', async () => {
            const customCache = new LilypadCache_1.default(5000, { defaultErrorTtl: 100 });
            customCache.set('key1', 42, 10);
            await new Promise((resolve) => setTimeout(resolve, 20));
            await customCache.getOrSet('key1', async () => {
                throw new Error('fetch failed');
            }, { returnOldOnError: true });
            await new Promise((resolve) => setTimeout(resolve, 150));
            (0, vitest_1.expect)(customCache.get('key1', false)).toBeUndefined();
            customCache.dispose();
        });
        (0, vitest_1.it)('should throw on invalid autoCleanupInterval', () => {
            (0, vitest_1.expect)(() => new LilypadCache_1.default(1000, { autoCleanupInterval: -1 })).toThrow('autoCleanupInterval must be a positive finite number');
        });
        (0, vitest_1.it)('should setup auto cleanup interval', async () => {
            const customCache = new LilypadCache_1.default(5000, { autoCleanupInterval: 100 });
            customCache.set('key1', 42, 50);
            await new Promise((resolve) => setTimeout(resolve, 200));
            (0, vitest_1.expect)(customCache.get('key1', false)).toBeUndefined();
            customCache.dispose();
        });
    });
    (0, vitest_1.describe)('dispose', () => {
        (0, vitest_1.it)('should clear all entries on dispose', () => {
            cache.set('key1', 42);
            cache.dispose();
            (0, vitest_1.expect)(cache.get('key1')).toBeUndefined();
        });
        (0, vitest_1.it)('should stop cleanup interval on dispose', () => {
            const customCache = new LilypadCache_1.default(5000, { autoCleanupInterval: 1000 });
            (0, vitest_1.expect)(() => customCache.dispose()).not.toThrow();
        });
    });
});
