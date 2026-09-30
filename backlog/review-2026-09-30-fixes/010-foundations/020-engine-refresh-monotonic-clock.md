---
depends-on: [review-2026-09-30/900-integration]
---

# Measure the stuck-refresh window of the cache engine on the monotonic clock

## Goal

Make the cache engine's `refreshing` map measure `STUCK_REFRESH_AFTER` with `performance.now()`, so that a step back of the wall clock no longer suppresses the stale-while-revalidate refreshes.

## Context

- Source: finding FND-2 (recommended, confirmed) of the `010-foundations` review. Its fix (commit `ca1e3c3`) moved `rateLimit` and `LilypadBackoff` to `performance.now()`, and its "Impact on other units" said: "The cache engine's own `Date.now()` intervals (`refreshing`, `STUCK_REFRESH_AFTER`, cooldowns) ... should follow the same decision." The report gave no patch for the engine. The fix below was derived from the code while converting that review, and the cooldowns are left out (see the last bullet).
- Location: `src/cache/LilypadCacheEngine.ts`, `LilypadCacheEngine`:
  ```ts
  const STUCK_REFRESH_AFTER = 60_000;
  ...
  private refreshing = new Map<string, number>();
  ...
      Date.now() - (this.refreshing.get(normalizedKey) ?? -Infinity) < STUCK_REFRESH_AFTER ||
  ...
    const scheduledAt = Date.now();
    this.refreshing.set(normalizedKey, scheduledAt);
  ...
  // in purgeExpired():
    const now = Date.now();
    ...
    for (const [normalizedKey, scheduledAt] of this.refreshing) {
      if (now - scheduledAt >= STUCK_REFRESH_AFTER) {
  ```
- Problem: `refreshing` values are local timestamps compared only with each other. After a step back of the wall clock, `Date.now() - scheduledAt` is negative for a refresh scheduled before the step. If that refresh never completes (work after the response dropped by the platform, the case the map exists for), the key gets no new background refresh, and `purgeExpired` doesn't clear it, until the clock catches up. Stale values are served meanwhile, within the stale window.
- Fix: use `performance.now()` for `scheduledAt` and for the two comparisons with `STUCK_REFRESH_AFTER` (in the refresh scheduling and in `purgeExpired`, where `now` also drives the entry and failure checks: take a separate `const monotonicNow = performance.now()` for the `refreshing` loop). The `scheduledAt` identity check in the `finally` keeps working.
- Keep on the wall clock: `expirationTime`, `fetchedAt`, `invalidatedAt` (stored in L2 and compared across instances and with `trustedSince`), and the failure cooldown (`failures`, `inCooldown`, `recordFailure`). `failedAt` is written to L2 by `this.shared?.writeFailure(normalizedKey, failedAt, ...)`, merged from `remote.failedAt`, and compared with `current.fetchedAt` for `refreshFailed`.
- Not breaking: internal timing only. Edge-safe: `performance` is in the `webworker` lib.
- Unit involved: `030-cache-engine`. Its review may have queued a duplicate or changed this code: check first, and read the `LilypadCacheEngine` bullets of `docs/architecture.md`.

## Done when

- A test in `src/cache/LilypadCache.test.ts` (fake timers) schedules a stale-while-revalidate refresh whose work never runs (a platform `afterResponse` that drops it), steps the wall clock back by 1 h with `vi.setSystemTime`, advances the timers by `STUCK_REFRESH_AFTER`, and sees the next stale read schedule a new refresh. It fails before the fix and passes after.
- `npm run check` passes.
