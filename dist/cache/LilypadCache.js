function isStale(retrieval) {
    return Date.now() >= retrieval.expirationTime;
}
class LilypadCache {
    constructor(ttl = 60000, options = {}) {
        var _a;
        this.pendingPromises = new Map();
        this.protectedKeys = new Set();
        this.store = new Map();
        this.defaultTtl = ttl;
        this.defaultErrorTtl = (_a = options.defaultErrorTtl) !== null && _a !== void 0 ? _a : 5 * 60 * 1000; // 5 minutes;
        if (options.autoCleanupInterval) {
            if (!Number.isFinite(options.autoCleanupInterval) || options.autoCleanupInterval <= 0) {
                throw new Error('autoCleanupInterval must be a positive finite number');
            }
            this.cleanupIntervalId = setInterval(() => this.purgeExpired(), options.autoCleanupInterval);
            // prevent keeping the Node.js event loop alive when running in Node.js
            if (this.cleanupIntervalId && typeof this.cleanupIntervalId.unref === 'function') {
                this.cleanupIntervalId.unref();
            }
        }
    }
    createExpirationTime(ttl) {
        return Date.now() + (ttl !== null && ttl !== void 0 ? ttl : this.defaultTtl);
    }
    set(key, value, ttl) {
        this.store.set(key, { value, expirationTime: this.createExpirationTime(ttl) });
    }
    get(key) {
        const cacheValue = this.store.get(key);
        if (cacheValue && !isStale(cacheValue)) {
            return cacheValue.value;
        }
        else {
            this.delete(key);
            return undefined;
        }
    }
    getComprehensive(key) {
        const cacheValue = this.store.get(key);
        if (cacheValue && !isStale(cacheValue)) {
            return { ...cacheValue, type: 'hit' };
        }
        else {
            if (cacheValue) {
                return { ...cacheValue, type: 'expired' };
            }
            return { type: 'miss' };
        }
    }
    async getOrSet(key, valueFn, options = {}) {
        var _a;
        const fetched = this.getComprehensive(key);
        if (!options.skipCache && fetched.type === 'hit') {
            return fetched.value;
        }
        // Check for pending promise to avoid duplicate calls. If there's a
        // pending promise and the caller requested fallback-on-error, return a
        // wrapped promise that falls back to `existing` on rejection.
        const pending = this.pendingPromises.get(key);
        if (pending) {
            if (options.returnOldOnError && fetched.type !== 'miss') {
                return pending.catch((error) => {
                    if (options.errorFn) {
                        const res = options.errorFn({ key, error, options, cache: this });
                        if (res !== undefined) {
                            return res;
                        }
                    }
                    return fetched.value;
                });
            }
            return pending;
        }
        const promise = valueFn();
        this.pendingPromises.set(key, promise);
        try {
            const value = await promise;
            this.set(key, value, options.ttl);
            return value;
        }
        catch (error) {
            if (options.returnOldOnError && fetched.type !== 'miss') {
                if (options.errorFn) {
                    const res = options.errorFn({ key, error, options, cache: this });
                    if (res !== undefined) {
                        return res;
                    }
                }
                this.set(key, fetched.value, (_a = options.errorTtl) !== null && _a !== void 0 ? _a : this.defaultErrorTtl);
                return fetched.value;
            }
            throw error;
        }
        finally {
            this.pendingPromises.delete(key);
        }
    }
    addProtectedKeys(keys) {
        for (const key of keys) {
            this.protectedKeys.add(key);
        }
        return this;
    }
    removeProtectedKeys(keys) {
        for (const key of keys) {
            this.protectedKeys.delete(key);
        }
        return this;
    }
    delete(key) {
        if (this.protectedKeys.has(key)) {
            return;
        }
        this.store.delete(key);
    }
    clear() {
        for (const key of this.store.keys()) {
            this.delete(key);
        }
    }
    purgeExpired() {
        const now = Date.now();
        for (const [key, cacheValue] of this.store.entries()) {
            if (now >= cacheValue.expirationTime) {
                this.delete(key);
            }
        }
    }
    stopCleanupInterval() {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = undefined;
        }
    }
    dispose() {
        this.stopCleanupInterval();
        this.removeProtectedKeys(Array.from(this.protectedKeys));
        this.clear();
    }
}
export default LilypadCache;
