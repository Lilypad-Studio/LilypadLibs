# Lite review the cache engine and its shared level

## Goal

Check the cache engine and its shared level for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 with five pending changesets (`.changeset/*.md`), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a confirmation lite pass: the previous one (`review-2026-10-01-2`, baseline `157e3a2`) found five blockers, fixed in `884e992`, `1a868f4`, `4cd54d5`, `aa6c69d` and `ea5ce20`, and those fixes were never reviewed: start with what they changed in this unit (`git diff 157e3a2 d9d6cbb -- <unit paths>`), then review the rest of the unit. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `d9d6cbb`. If the unit changed since (`git diff d9d6cbb --stat -- src/cache`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 10, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/cache/` (`LilypadCache.ts`, `LilypadCacheEngine.ts`, `LilypadCacheTypes.ts`, `LilypadReadFlights.ts`, `LilypadSharedLevel.ts`; about 2,320 source lines), with `LilypadCache.test.ts`, `LilypadCache.shared.test.ts`, `LilypadReadFlights.test.ts`.
- Interfaces: exposes the entry `cache` (`LilypadCache`, `LilypadCacheCooldownError` and the cache types). Internal, not exported: `LilypadCacheEngine` (hooks given to its constructor: `onValueStored`, `onEntriesIncomplete`, `hasReadInFlight`, `maxSharedAge`; `beginRead` → `read.store` / `read.storeFetched`, `replaceEntries`, `extendExpiration`, `expire`, `markInvalid`, `expireEverything`, `rejectSharedBefore`, `currentTicket`, `nextTicket`, and its public `flowControl`), `LilypadReadFlights`, `LilypadSharedLevel`. Uses `src/flow/` (timeouts), `src/platform/` (`runAfterResponse`, `sharedStoreOperation`, `toTtlSeconds`), `libLog`, `src/internal/`. Depended on by `LilypadDbCache` (`src/dbCache/`), which holds an engine, drives it through these hooks, and since `4cd54d5` bounds its changelog reads with `engine.flowControl.executeWithTimeout`.
- Out of scope, covered by other tasks: the flow control and platform helpers themselves (`review-2026-10-02/010-foundations-logger`), how `LilypadDbCache` uses the engine (`review-2026-10-02/050-db-cache`; the hook contract and the shared `flowControl`: `review-2026-10-02/900-integration`), L2 as a trust boundary (`review-2026-10-02/070-security`).
- Leads to verify (hints from a quick survey, not conclusions):
  - The code of this unit is unchanged since `157e3a2`, and the last lite pass found no blocker in it: look for what it did not check rather than repeating it (its leads were the invalidation marks carried by `writeEntry`, the bulk sync as a read in flight, `acquireLock`/`releaseLock`, forged `failedAt`, and the ticket floor under evictions).
  - `getOrSetDetailed` with `staleWhileRevalidate` and `failureCooldown`: a background refresh that fails during the cooldown, a `fallback` entry refreshed once the cooldown is over (`freshHit`). Check that a stale value is never served beyond its window, an invalidated one never, and that refreshes of a key cannot loop or run concurrently.
  - `maxEntries` with protected keys: an insert when every stored key is protected, `addProtectedKeys`/`removeProtectedKeys` of keys not stored, protected keys removed with `force`. Check `evictionOrder` stays consistent with the store (no eviction loop, no protected key evicted, no evicted key left in `evictionOrder`).
  - `normalizeKey`: the keys `1` and `'1'` share one entry. Check that `entries()`, `getMany` and `bulkSet` return and store the key the caller expects, and that no path keeps two entries, or two fences, for one normalized key.
  - L2 values the application's codec decodes (`decode` returning a value of the wrong shape, or `null`) and a lock key (`l`) holding something `acquireLock` did not write: `get`/`getOrSet` never throw out of the engine, and a refresh is never blocked for longer than the lock TTL.
  - `dispose()` while a bulk sync, a refresh scheduled with `runAfterResponse`, or an L2 operation is pending: no write after dispose, no unhandled rejection, the `autoCleanupInterval` timer cleared.
- Fix tasks folder: `backlog/review-2026-10-02-fixes/020-cache-engine/`. Task format: `backlog/README.md`.

## Instructions

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit --project edge src/cache`, `npx eslint src/cache --max-warnings 0`, `npm run typecheck`. Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it (input, expected behavior).
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `CACHE-<n>`:

1. The verdict (`solid`, or `not solid` with the number of blockers), then a summary of 3-5 lines.
2. Findings. Each: ID, severity (`blocker`), confidence, `breaking`/`cross-unit` if they apply, location, problem, fix.
3. Tests to add.
4. Checks run: commands and results, or why none ran.

### Apply or queue

If there are no findings, skip to the closing summary. Otherwise ask the user, listing the finding IDs, with these options:

- **Apply now**: fix every listed finding in this task, in the same commit that deletes it.
- **Queue**: create fix tasks instead; change no source code.
- **Mix**: the user names the IDs to apply now; the rest are queued.

Whatever the choice:

- `breaking` and `cross-unit` findings are applied only if the user names their IDs explicitly; otherwise they're queued.
- If you can't ask the user (you run as a subagent), stop here and report `needs decision` with the question, the options and the finding list; you'll be resumed with the answer.

Applying a finding: make the fix, and for a bug, add a test that reproduces it. Run the build (`npm run build`) and the tests covering the unit. A user-facing change needs its changeset (`/write-changeset`).

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- <folder>`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior.
- `depends-on: [review-2026-10-02/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the unit, its tests, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
