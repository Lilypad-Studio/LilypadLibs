class LilypadCache {
    constructor(ttl = 60000, options = {}) {
        var _a;
        this.pendingPromises = new Map();
        this.store = new Map();
        this.defaultTtl = ttl;
        this.defaultErrorTtl = (_a = options.defaultErrorTtl) !== null && _a !== void 0 ? _a : 5 * 60 * 1000; // 5 minutes;
        this.timeMap = new Map();
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
    set(key, value, ttl) {
        this.store.set(key, value);
        this.timeMap.set(key, Date.now() + (ttl !== null && ttl !== void 0 ? ttl : this.defaultTtl));
    }
    get(key) {
        const expirationTime = this.timeMap.get(key);
        if (expirationTime && Date.now() < expirationTime) {
            return this.store.get(key);
        }
        else {
            this.store.delete(key);
            this.timeMap.delete(key);
            return undefined;
        }
    }
    async getOrSet(key, valueFn, options = {}) {
        var _a;
        const { skipCache, returnOldOnError } = options;
        // Capture an existing (non-expired) value for early return or fallback
        let oldValue;
        if (returnOldOnError) {
            oldValue = this.store.get(key);
        }
        if (!skipCache) {
            const existing = this.get(key);
            if (existing !== undefined) {
                return existing;
            }
        }
        // Check for pending promise to avoid duplicate calls. If there's a
        // pending promise and the caller requested fallback-on-error, return a
        // wrapped promise that falls back to `existing` on rejection.
        const pending = this.pendingPromises.get(key);
        if (pending) {
            if (returnOldOnError && oldValue !== undefined) {
                return pending.catch(() => oldValue);
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
        catch (err) {
            if (returnOldOnError && oldValue !== undefined) {
                this.set(key, oldValue, (_a = options.errorTtl) !== null && _a !== void 0 ? _a : this.defaultErrorTtl);
                return oldValue;
            }
            throw err;
        }
        finally {
            this.pendingPromises.delete(key);
        }
    }
    delete(key) {
        this.store.delete(key);
        this.timeMap.delete(key);
    }
    clear() {
        this.store.clear();
        this.timeMap.clear();
    }
    purgeExpired() {
        const now = Date.now();
        for (const [key, timeStored] of this.timeMap.entries()) {
            if (now >= timeStored) {
                this.store.delete(key);
                this.timeMap.delete(key);
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
        this.clear();
    }
}
export default LilypadCache;
