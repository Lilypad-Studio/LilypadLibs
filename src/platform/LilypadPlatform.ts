import { withLilypadTimeout } from '@/internal/LilypadTimeout';

/**
 * Keeps the running instance alive until `task` settles, for work that continues after the
 * response has been sent. On Vercel: `waitUntil` from `@vercel/functions`, or `after` from
 * `next/server` (`(task) => after(() => task)`).
 */
export type LilypadBackground = (task: Promise<unknown>) => void;

/**
 * A cache level shared by every instance of the application. Its shape is a subset of the Vercel
 * Runtime Cache (`getCache()` from `@vercel/functions`), which can be passed as it is.
 * Every operation may fail or never answer: the library bounds them with a timeout and treats a
 * failure as a missing entry.
 */
export type LilypadSharedStore = {
  /** Resolves to `null` (or `undefined`) when the key is missing. */
  get(key: string): Promise<unknown>;
  /** `ttl` is in **seconds**, as in the Vercel Runtime Cache. */
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number | undefined; tags?: string[] | undefined }
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

export type LilypadInvalidationEvent = {
  /**
   * What changed the data:
   * - `write`: a write of this instance (`sqlCreate`, `sqlUpdate`, `sqlDelete`);
   * - `changelog`: a change read from the changelog table (made by any instance or by other programs);
   * - `notification`: a `LISTEN/NOTIFY` notification;
   * - `manual`: an explicit `invalidate()` call.
   *
   * The same change can reach every instance (e.g. through the changelog): filter on `source`
   * to act only once, for example only on `write`.
   */
  source: 'write' | 'changelog' | 'notification' | 'manual';
  /** The name of the cache (for a `LilypadDbCache`, its table). */
  cache: string;
  keys: string[];
  /** `<tagPrefix>:<cache>` and `<tagPrefix>:<cache>:<key>` for every key. */
  tags: string[];
};

/**
 * The platform capabilities the library can use. Every field is optional: without them, the
 * library behaves as on a long-running Node.js server.
 *
 * @example
 * ```typescript
 * // Next.js on Vercel (this file belongs to the application, not to the library)
 * import { after } from 'next/server';
 * import { getCache } from '@vercel/functions';
 * import { revalidateTag } from 'next/cache';
 *
 * export const platform: LilypadPlatform = {
 *   background: (task) => after(() => task),
 *   afterResponse: (work) => after(work),
 *   shared: getCache({ namespace: 'lilypad' }),
 *   onInvalidate: ({ source, tags }) => {
 *     if (source === 'write') tags.forEach((tag) => revalidateTag(tag));
 *   },
 * };
 * ```
 */
export type LilypadPlatform = {
  background?: LilypadBackground | undefined;
  /**
   * Runs `work` once the response has been sent, keeping the instance alive until it settles.
   * Used to start background refreshes, so that starting them does not delay the response.
   * On Next.js: `(work) => after(work)`. Without it, refreshes start at once (through `background`).
   */
  afterResponse?: ((work: () => Promise<unknown>) => void) | undefined;
  shared?: LilypadSharedStore | undefined;
  onInvalidate?: ((event: LilypadInvalidationEvent) => void | Promise<void>) | undefined;
};

/**
 * Wraps an error handler so that it never throws: a throwing `onError` would otherwise turn the
 * handled task back into an unhandled rejection, which terminates the Node.js process.
 */
function safeHandler(onError: (error: unknown) => void): (error: unknown) => void {
  return (error) => {
    try {
      onError(error);
    } catch {
      // Ignored: nothing is left to report the error of an error handler to
    }
  };
}

/**
 * Runs `task` without awaiting it: its errors go to `onError` (they never become unhandled
 * rejections, even if `onError` throws), and the platform keeps the instance alive until it settles.
 *
 * @param onPlatformError - Receives the error of `platform.background` itself (e.g. `after` called
 * outside a request scope), which is not an error of the task: the task still runs, without the
 * guarantee. Defaults to ignoring it.
 */
export function runInBackground(
  platform: LilypadPlatform | undefined,
  task: Promise<unknown>,
  onError: (error: unknown) => void,
  onPlatformError: (error: unknown) => void = () => {}
): void {
  const handled = task.catch(safeHandler(onError));
  try {
    platform?.background?.(handled);
  } catch (error) {
    onPlatformError(error);
  }
}

/**
 * Runs `work` after the response when the platform supports it, otherwise at once as background
 * work. Its errors go to `onError`.
 *
 * @param onPlatformError - Receives the error of `platform.afterResponse` or `platform.background`
 * itself: the work then starts at once. It runs once in all, even if the platform scheduled it
 * before throwing. Defaults to ignoring it.
 */
export function runAfterResponse(
  platform: LilypadPlatform | undefined,
  work: () => Promise<unknown>,
  onError: (error: unknown) => void,
  onPlatformError: (error: unknown) => void = () => {}
): void {
  // An `afterResponse` may throw after it scheduled the work: the fallback must not run it twice
  let started = false;
  const once = (): Promise<unknown> => {
    if (started) {
      return Promise.resolve();
    }
    started = true;
    return work();
  };
  if (platform?.afterResponse) {
    try {
      const handler = safeHandler(onError);
      platform.afterResponse(() => once().catch(handler));
      return;
    } catch (error) {
      // e.g. `after` called outside a request scope: fall back to starting the work now
      onPlatformError(error);
    }
  }
  runInBackground(platform, once(), onError, onPlatformError);
}

/**
 * Runs `operation` on the shared store, bounded by `timeout`. A failure or a timeout resolves to
 * `fallback` after calling `onError`: the shared store is never required to answer.
 */
export async function sharedStoreOperation<T>(
  operation: () => Promise<T>,
  fallback: T,
  timeout: number,
  onError: (error: unknown) => void
): Promise<T> {
  try {
    return await withLilypadTimeout(
      () => operation(),
      timeout,
      () => new Error(`Shared store did not answer within ${timeout}ms`)
    );
  } catch (error) {
    onError(error);
    return fallback;
  }
}

/**
 * Converts milliseconds to the whole seconds used by the shared store TTLs (at least 1). A value
 * that is not finite (`NaN`, `Infinity`) gives 1: a shared entry that expires too early is only a
 * miss, and the store never receives a TTL it cannot use.
 */
export function toTtlSeconds(ms: number): number {
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : 1;
}
