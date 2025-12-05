export interface LilypadCacheGetOptions {
    ttl?: number;
    skipCache?: boolean;
    /**
     * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
     * `getOrSet` will return the currently cached value (if any) instead of
     * rethrowing the error. If there is no cached value the error is rethrown.
     */
    returnOldOnError?: boolean;
    errorTtl?: number;
}
declare class LilypadCache<K, V> {
    private store;
    private defaultTtl;
    private defaultErrorTtl;
    private cleanupIntervalId?;
    private pendingPromises;
    constructor(ttl?: number, options?: {
        autoCleanupInterval?: number;
        defaultErrorTtl?: number;
    });
    set(key: K, value: V, ttl?: number): void;
    get(key: K): V | undefined;
    getOrSet(key: K, valueFn: () => Promise<V>, options?: LilypadCacheGetOptions): Promise<V>;
    delete(key: K): void;
    clear(): void;
    purgeExpired(): void;
    private stopCleanupInterval;
    dispose(): void;
}
export default LilypadCache;
