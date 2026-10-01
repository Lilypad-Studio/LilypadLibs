---
depends-on: [review-2026-09-30/900-integration]
---

# Measure the changelog sync intervals on the monotonic clock

## Goal

Make `LilypadChangelogSync` measure `pollInterval` and `maxGap` with `performance.now()`, so that a step back of the wall clock no longer stops the changelog reads or keeps a broken chain trusted.

## Context

- Source: finding FND-2 (recommended, confirmed) of the `010-foundations` review, whose fix (commit `ca1e3c3`) moved `LilypadFlowControl.rateLimit` and `LilypadBackoff` to `performance.now()`. The report left this caller open: "`LilypadChangelogSync.beforeRead` compares `Date.now()` with `lastRead` (a wall-clock `readAt`) for `pollInterval`."
- Location: `src/dbCache/sync/LilypadChangelogSync.ts`, class `LilypadChangelogSync` (moved from `src/cache/dbSync/` by `55ad0f5`):
  ```ts
  private lastRead = 0;
  ...
  beforeRead(): Promise<void> | undefined {
    const now = Date.now();
    if (now - this.lastRead < this.options.pollInterval || !this.backoff.ready()) {
  ...
  trustedSince(): number | undefined {
    ...
    if (this.cursor === undefined || Date.now() - this.lastRead > this.maxGap || !current) {
  ...
  private request(readAt: number): LilypadChangesRequest {
    if (this.cursor !== undefined && readAt - this.lastRead <= this.maxGap) {
  ...
      this.lastRead = readAt;   // in apply()
  ```
  The `!current` condition (finding DBC-1 of `060-db-cache`, applied) already uses the monotonic clock: `lastApplied = performance.now()`, set at the end of `apply()`, is compared with `pollInterval`. Only the `lastRead` comparisons remain on the wall clock.
  `readAt` is `Date.now()`, taken in `LilypadChangelogReader.readAll` (`src/dbGate/LilypadChangelogReader.ts`: `const readAt = Date.now(); const requests = subscribers.map((subscriber) => subscriber.request(readAt));`) and passed back in `LilypadChangelogReadResult`.
- Problem: when the wall clock steps back (NTP correction, VM resume) by more than `pollInterval`, `now - this.lastRead` stays negative, so `beforeRead` skips every read until the clock catches up: the cache stops applying changes and serves stale rows for up to the size of the step. The same step makes `readAt - this.lastRead` and `Date.now() - this.lastRead` smaller, so a chain broken for longer than `maxGap` is still trusted (the cursor is reused instead of a lookback, and `trustedSince()` stays defined). A step forward does the reverse: an extra lookback that expires everything, which is safe.
- Fix: two clocks, one per use.
  - Wall clock, unchanged: `readAt` and `chainStartedAt`. `trustedSince()` returns `chainStartedAt`, which `LilypadDbCache.renew` compares with each entry's wall-clock `fetchedAt` (`entry.fetchedAt < trustedSince`).
  - Monotonic: the intervals. `LilypadChangelogReader.readAll` also takes `const readAtMonotonic = performance.now()`, passes it to `request(readAt, readAtMonotonic)` and adds it to `LilypadChangelogReadResult`. `LilypadChangelogSync` keeps `private lastReadMonotonic = -Infinity` (not `0`: `performance.now()` starts near 0, so `0` would skip the first read within `pollInterval` ms of startup, the same trap FND-2 hit in `rateLimit`). It sets it in `apply` from `readAtMonotonic`, and uses it in the three comparisons:
    ```ts
    if (performance.now() - this.lastReadMonotonic < this.options.pollInterval || !this.backoff.ready()) {
    ...
    if (this.cursor === undefined || performance.now() - this.lastReadMonotonic > this.maxGap) {
    ...
    if (this.cursor !== undefined && readAtMonotonic - this.lastReadMonotonic <= this.maxGap) {
    ```
  - The reader types are internal (not exported by any entry), so this is not a breaking change. `performance.now()` is available in edge runtimes too, but this file is only reached from `db`.
- Tests: `vi.useFakeTimers()` fakes `performance` in the installed vitest, and `vi.setSystemTime` moves only the wall clock. See the existing tests "should not lock the keys out when the wall clock steps back" (`src/flow/LilypadFlowControl.test.ts`) and "should not postpone the next attempt when the wall clock steps back" (`src/internal/LilypadBackoff.test.ts`).
- Units involved: `060-db-cache` (`LilypadChangelogSync.ts`) and `050-db-gate` (`LilypadChangelogReader.ts`). Checked by `review-2026-09-30/900-integration`: their reviews queued no duplicate, and the `lastRead` comparisons above are still on the wall clock at `ee36fe2`.

## Done when

- A test in `src/dbCache/sync/LilypadChangelogSync.test.ts` (or `src/dbCache/LilypadDbCache.test.ts`) reads once, steps the wall clock back by 1 h with `vi.setSystemTime`, advances the timers past `pollInterval`, and sees the next read happen. It fails before the fix and passes after.
- A test steps the wall clock back by 1 h, advances the timers past `maxGap`, and sees the next read use a lookback (and `trustedSince()` return `undefined` before it).
- A test shows that the first `beforeRead` right after construction, with the fake clock near 0, reads.
- `npm run check` and `npm run test:integration` pass.
