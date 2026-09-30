# Review the cache engine and LilypadCache

## Goal

Review the cache engine, `LilypadCache` and the shared level as a senior reviewer/refactorer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 030-cache-engine`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md` (the `LilypadCacheEngine` bullets of "How the modules depend on each other": read them first, they state the ticket/fence rules a fix must keep).
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/cache/LilypadCacheEngine.ts src/cache/LilypadCache.ts src/cache/LilypadCacheTypes.ts src/cache/LilypadReadFlights.ts src/cache/LilypadSharedLevel.ts`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible (no `node:*`, no `process`/`Buffer`).
- Unit: `src/cache/LilypadCacheEngine.ts`, `src/cache/LilypadCache.ts`, `src/cache/LilypadCacheTypes.ts`, `src/cache/LilypadReadFlights.ts`, `src/cache/LilypadSharedLevel.ts`, and their tests `src/cache/LilypadCache.test.ts`, `src/cache/LilypadCache.shared.test.ts`, `src/cache/LilypadReadFlights.test.ts`.
- Interfaces:
  - Exposes: `LilypadCache`, `LilypadCacheCooldownError`, `LilypadDisposedError` and the cache types (entry `cache`). Internal: `LilypadCacheEngine`, whose public methods and constructor hooks (`onValueStored`, `onEntriesIncomplete`, `hasReadInFlight`) serve `LilypadDbCache`: `beginRead()` / `read.store` / `read.storeFetched`, `replaceEntries`, `extendExpiration`, `expire`, `markInvalid`, `expireEverything`, `rejectSharedBefore`, `emitInvalidation`, `log`.
  - Uses: `LilypadFlowControl` (fetch and bulk sync timeouts), the platform (`runAfterResponse`, `runInBackground`, `sharedStoreOperation`, `toTtlSeconds`), `assertNumberOption`, `libLog`.
  - Depended on by: `LilypadDbCache` (`src/cache/LilypadDbCache.ts`); `LilypadDbGate` imports `LilypadDisposedError` from `LilypadCacheTypes.ts`.
- Out of scope, covered by other tasks: flow control and platform internals (`review-2026-09-30/010-foundations`), `LilypadDbCache` and its use of the engine (`review-2026-09-30/060-db-cache`), public API design as a whole (`review-2026-09-30/080-architecture-api`), trust in L2 values end-to-end (`review-2026-09-30/090-security`), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Write ordering: check that every async read path goes through `beginRead()` and every removal through `removeEntry`/`dropEntry` (grep for `store.delete`), and that every change of a key (`set`, `expire`, `invalidate`, `expireEverything`, `replaceEntries`) raises what `currentTicket(key)` compares, so `getOrSetDetailed` never joins a superseded fetch.
  - `fences`: check that they are removed once no read of the key is in flight (growth with many distinct keys).
  - Stale-while-revalidate: the `refreshing` map with `STUCK_REFRESH_AFTER` (60 s). A refresh slower than 60 s gets a second concurrent one. Check the cleanup loop (around `for (const [normalizedKey, scheduledAt] of this.refreshing)`) and `dispose`.
  - `failureCooldown` and fallbacks: `refreshFailed`, the background refresh once the cooldown is over. Check that it can't loop, or run after `dispose`.
  - `LilypadSharedLevel`: validation of envelopes read back (malformed or foreign values, `expiresAt` in the past, clock skew between instances), the lock key `l` (TTL, released on failure?), `toTtlSeconds` rounding a short TTL to 0, the codec errors (a warning and a miss, never a failed read).
  - `maxEntries` LRU (`evictionOrder`): protecting or unprotecting a stored key, and `force` removals, keep the `Set` consistent with the store.
  - Bulk sync: `forceNextBulkSync()` while a sync runs, `bulkSync.ttl` vs the entry `ttl`, `entries()` right after an eviction.
  - `LilypadCache`: every public method calls `assertNotDisposed`; `dispose()` is idempotent and clears `autoCleanupInterval`.
  - `LilypadCacheEngine.ts` is ~1,070 lines: look for a split (L2 adoption, SWR/cooldown, eviction) that would simplify it without weakening the invariants.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface (`LilypadDbCache.ts` uses the engine's internal methods: check how before proposing to change them). Run the tests and linters that cover this unit if you can: `npx vitest run src/cache/LilypadCache src/cache/LilypadReadFlights` (runs the `unit` and `edge` projects), `npx eslint src/cache --max-warnings 0`, `npm run typecheck`.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption (including a stale value served after an invalidation), vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine. A fix must keep the `undefined` (not cached) / `null` (cached as missing) distinction.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior). Cache tests run on fake timers: register the assertion on a promise before `vi.advanceTimersByTimeAsync`, await it after.
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `CACHE-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this unit, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 030-cache-engine` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
