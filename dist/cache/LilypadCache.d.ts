export interface LilypadCacheGetOptions {
    skipCache?: boolean;
}
declare class LilypadCache<K, V> {
    private store;
    private ttl;
    private timeMap;
    private cleanupIntervalId?;
    private pendingPromises;
    constructor(ttl?: number, options?: {
        autoCleanupInterval?: number;
    });
    set(key: K, value: V): void;
    get(key: K): V | undefined;
    getOrSet(key: K, valueFn: () => Promise<V>, options?: LilypadCacheGetOptions): Promise<V>;
    delete(key: K): void;
    clear(): void;
    purgeExpired(): void;
    private stopCleanupInterval;
    dispose(): void;
}
export default LilypadCache;
