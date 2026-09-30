# Review the database cache and its sync strategies

## Goal

Review `LilypadDbCache`, its helpers and its sync strategies as a senior reviewer/refactorer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 060-db-cache`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md` (the `LilypadDbCache` bullets: sync strategies, trust and renewal, changes, notifications).
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/cache/LilypadDbCache.ts src/cache/dbCache src/cache/dbSync`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible. Engine rules: every async read goes through `beginRead()`; every removal through `removeEntry`/`dropEntry`; `beforeRead()` of a sync strategy is awaited inline (`const syncing = ...; if (syncing) await syncing;`), never in an `async` helper.
- Unit: `src/cache/LilypadDbCache.ts`, `src/cache/dbCache/LilypadDbMembers.ts`, `src/cache/dbCache/LilypadOwnWrites.ts`, `src/cache/dbSync/LilypadDbSyncTypes.ts`, `LilypadListenSync.ts`, `LilypadChangelogSync.ts`, `LilypadNotificationRouter.ts`. Tests: `src/cache/LilypadDbCache.test.ts` (a fake gate, see `docs/architecture.md` "Tests"), `src/cache/dbCache/*.test.ts`, `src/cache/dbSync/*.test.ts`; the `LilypadDbCache` cases of `src/dbGate/LilypadDbGate.integration.test.ts`.
- Interfaces:
  - Exposes (entry `db`): `LilypadDbCache` (`create` with three overloads, `get`, `peek`, `getOrFetch`, `getOrFetchDetailed`, `getAll`, `refresh`, `invalidate`, `delete`, `clear`, `purgeExpired`, protected keys, `sqlCreate`/`sqlUpdate`/`sqlDelete`, `dispose`), and its option types (`LilypadDbCacheOptions`, `LilypadDbCacheSyncOverrides`, `LilypadDbKey`, `LilypadDbNotification`, ...).
  - Uses: the engine (`LilypadCacheEngine`: `beginRead`, `replaceEntries`, `extendExpiration`, `expireEverything`, the hooks), `LilypadReadFlights`, `LilypadDbGate` / `LilypadDbTable`, `readLilypadChangesBatch` / `LilypadChangelogReader` / `lilypadCursorCovers`, the table definitions (`src/dbConfig/`), `LilypadFlowControl`, `createLilypadSingletonAbleAsync`, `LilypadBackoff`, the platform.
  - Depended on by: applications only.
- Out of scope, covered by other tasks: the engine itself (`review-2026-09-30/030-cache-engine`), the gate, table, changelog SQL and reader (`review-2026-09-30/050-db-gate`), config validation (`review-2026-09-30/040-db-config`), public API design as a whole (`review-2026-09-30/080-architecture-api`), untrusted notifications end-to-end (`review-2026-09-30/090-security`: here, check local handling), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Every read path (`get`, `peek`, `getOrFetchDetailed`, `getAll`, `refresh`) awaits `beforeRead()` inline and begins its read before any other `await`.
  - `renew()`: origin `source`, not invalidated, `fetchedAt >= trustedSince`, younger than `sync.maxAge`. Check a reconnect between a fetch and its renewal, and `trustedSince()` going `undefined` and back.
  - Own writes: `storeWritten` and `ownWrites.consume`. Check a notification of the own write that arrives before the write resolves (xid not yet known), and whether `ownWrites` can grow forever with the `listen` strategy (no cursor prunes it).
  - `refreshInBatch`: a failed batch expires its keys; `eagerReads` is decremented on every path; the budget of `takeEagerRefresh` (1000 keys per second).
  - `getAll`: the 25% reload threshold, `members` after `maxEntries` evictions, `rowsOf` merging the store and the rows just read, a `getAll` during a table load in flight, `getAll(keys)` with duplicate keys.
  - `LilypadNotificationRouter`: the last subscriber leaving while another subscribes; `resolveNotifiedKey` converting string ids (`"01"`, `"1e3"`, `" 1"`, beyond `Number.MAX_SAFE_INTEGER` with `bigint` keys); malformed payloads logged once.
  - `LilypadChangelogSync`: the lookback read without a trusted cursor expires everything; `maxGap`; a failed `apply` keeps the cursor and backs off; `lilypadNetChanges` with a `TRUNCATE` in the middle of a read.
  - `dispose()`: awaits a LISTEN still starting; a LISTEN that completes after `dispose` unsubscribes; the changelog reader subscription is removed; concurrent calls share one promise.
  - `LilypadListenSync.ts` has no test file of its own: check what `LilypadDbCache.test.ts` covers of `connect: 'lazy'`, its backoff and `applyChanges: false`.
  - `LilypadDbCache.ts` is ~1,120 lines: look for parts worth extracting (write-through, change application, `getAll`) if it simplifies.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit src/cache/LilypadDbCache src/cache/dbCache src/cache/dbSync`, `npx eslint src/cache --max-warnings 0`, `npm run typecheck` (also checks the public API type tests of `LilypadDbCache.test.ts`), and `npm run test:integration` if Docker is running (say so if it isn't).

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption (including a stale row served as fresh after a change), vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine. A fix must keep the `undefined` (not cached) / `null` (cached as missing) distinction.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior). Cache tests run on fake timers: register the assertion on a promise before `vi.advanceTimersByTimeAsync`, await it after.
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `DBC-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this unit, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 060-db-cache` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
