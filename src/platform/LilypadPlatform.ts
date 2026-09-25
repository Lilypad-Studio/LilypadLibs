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
export interface LilypadSharedStore {
  /** Resolves to `null` (or `undefined`) when the key is missing. */
  get(key: string): Promise<unknown>;
  /** `ttl` is in **seconds**, as in the Vercel Runtime Cache. */
  set(key: string, value: unknown, options?: { ttl?: number; tags?: string[] }): Promise<void>;
  delete(key: string): Promise<void>;
}

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
  background?: LilypadBackground;
  /**
   * Runs `work` once the response has been sent, keeping the instance alive until it settles.
   * Used to start background refreshes, so that starting them does not delay the response.
   * On Next.js: `(work) => after(work)`. Without it, refreshes start at once (through `background`).
   */
  afterResponse?: (work: () => Promise<unknown>) => void;
  shared?: LilypadSharedStore;
  onInvalidate?: (event: LilypadInvalidationEvent) => void | Promise<void>;
};

/**
 * Runs `task` without awaiting it: its errors go to `onError` (they never become unhandled
 * rejections), and the platform keeps the instance alive until it settles.
 */
export function runInBackground(
  platform: LilypadPlatform | undefined,
  task: Promise<unknown>,
  onError: (error: unknown) => void
): void {
  const handled = task.catch(onError);
  try {
    platform?.background?.(handled);
  } catch (error) {
    // e.g. `after` called outside a request scope: the task still runs, without the guarantee
    onError(error);
  }
}

/**
 * Runs `work` after the response when the platform supports it, otherwise at once as background
 * work. Its errors go to `onError`.
 */
export function runAfterResponse(
  platform: LilypadPlatform | undefined,
  work: () => Promise<unknown>,
  onError: (error: unknown) => void
): void {
  if (platform?.afterResponse) {
    try {
      platform.afterResponse(() => work().catch(onError));
      return;
    } catch (error) {
      // e.g. `after` called outside a request scope: fall back to starting the work now
      onError(error);
    }
  }
  runInBackground(platform, work(), onError);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Shared store did not answer within ${timeout}ms`)),
      timeout
    );
  });
  try {
    return await Promise.race([operation(), timeoutPromise]);
  } catch (error) {
    onError(error);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Converts milliseconds to the whole seconds used by the shared store TTLs (at least 1). */
export function toTtlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
