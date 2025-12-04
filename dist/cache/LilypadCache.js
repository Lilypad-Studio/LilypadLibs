class LilypadCache {
    constructor(ttl = 60000, options = {}) {
        this.pendingPromises = new Map();
        this.store = new Map();
        this.ttl = ttl;
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
    set(key, value) {
        this.store.set(key, value);
        this.timeMap.set(key, Date.now());
    }
    get(key) {
        const timeStored = this.timeMap.get(key);
        if (timeStored && Date.now() - timeStored < this.ttl) {
            return this.store.get(key);
        }
        else {
            this.store.delete(key);
            this.timeMap.delete(key);
            return undefined;
        }
    }
    async getOrSet(key, valueFn, options = {}) {
        if (!options.skipCache) {
            const existing = this.get(key);
            if (existing !== undefined) {
                return existing;
            }
        }
        // Check for pending promise to avoid duplicate calls
        const pending = this.pendingPromises.get(key);
        if (pending) {
            return pending;
        }
        const promise = valueFn();
        this.pendingPromises.set(key, promise);
        try {
            const value = await promise;
            this.set(key, value);
            return value;
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
            if (now - timeStored >= this.ttl) {
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
