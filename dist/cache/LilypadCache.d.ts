export type LilypadCacheGetOptions<K, V> = {
    ttl?: number;
    skipCache?: boolean;
    /**
     * If true, when the provided `valueFn` (or an in-flight promise) throws/rejects,
     * `getOrSet` will return the currently cached value (if any) instead of
     * rethrowing the error. If there is no cached value the error is rethrown.
     */
    returnOldOnError?: boolean;
    errorFn?: (options: LilypadCacheGetOptionsErrorFn<K, V>) => V | undefined;
    errorTtl?: number;
    data?: unknown;
};
type LilypadCacheGetOptionsErrorFn<K, V> = {
    key: K;
    error: unknown;
    options: LilypadCacheGetOptions<K, V>;
    cache: LilypadCache<K, V>;
};
type LilypadCacheValue<V> = {
    value: V;
    expirationTime: number;
};
type LilypadCacheValueRetrieval<V> = ({
    type: 'hit' | 'expired';
} & LilypadCacheValue<V> | {
    type: 'miss';
});
declare class LilypadCache<K, V> {
    private store;
    private defaultTtl;
    private defaultErrorTtl;
    private cleanupIntervalId?;
    private pendingPromises;
    private protectedKeys;
    constructor(ttl?: number, options?: {
        autoCleanupInterval?: number;
        defaultErrorTtl?: number;
    });
    private createExpirationTime;
    set(key: K, value: V, ttl?: number): void;
    get(key: K): V | undefined;
    getComprehensive(key: K): LilypadCacheValueRetrieval<V>;
    getOrSet(key: K, valueFn: () => Promise<V>, options?: LilypadCacheGetOptions<K, V>): Promise<V>;
    addProtectedKeys(keys: K[]): this;
    removeProtectedKeys(keys: K[]): this;
    delete(key: K): void;
    clear(): void;
    purgeExpired(): void;
    private stopCleanupInterval;
    dispose(): void;
}
export default LilypadCache;
