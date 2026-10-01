# Review the database cache and its sync strategies

## Goal

Review the database cache and its sync strategies as a senior reviewer/refactorer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0 (0.8.0 pending: the `.changeset/*.md` files), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is the second full review: `review-2026-09-30` reviewed every unit and its fixes landed in `ca1e3c3`..`370dc71`. Review the whole unit with fresh eyes, with extra attention to the code those commits added (`git log --oneline c612a8c..370dc71 -- <unit paths>`). Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `370dc71`. If the unit changed since (`git diff 370dc71 --stat -- src/dbCache`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, each recorded in a changeset `#### Upgrading` row (`/write-changeset`); they ship with the pending 0.8.0. Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 7, `src/dbGate/LilypadChangelog.ts`); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed (installs then need the fix SQL of `lilypad-doctor`: say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/dbCache/` (`LilypadDbCache.ts`, `LilypadDbMembers.ts`, `LilypadEagerRefresh.ts`, `LilypadOwnWrites.ts`, `sync/LilypadDbSyncTypes.ts`, `sync/LilypadListenSync.ts`, `sync/LilypadChangelogSync.ts`, `sync/LilypadNotificationRouter.ts`; about 2,370 source lines), with `LilypadDbCache.test.ts`, `LilypadDbMembers.test.ts`, `LilypadEagerRefresh.test.ts`, `LilypadOwnWrites.test.ts`, `sync/LilypadChangelogSync.test.ts`, `sync/LilypadNotificationRouter.test.ts`.
- Interfaces: exposes (entry `db`) `LilypadDbCache` (`create` with three overloads, `get`, `peek`, `getOrFetch`, `getOrFetchDetailed`, `getAll`, `getManyOrFetch`, `refresh`, `invalidate`, `delete`, `clear`, `purgeExpired`, protected keys, `sqlCreate`/`sqlUpdate`/`sqlDelete`, `dispose`) and its types (`LilypadDbCacheOptions`, `LilypadDbCacheSyncOverrides`, `LilypadDbKey`, `LilypadDbNotification`...). Uses the cache engine and its hooks (`src/cache/`), `gate.table()`, `addListener`, `isListenHealthy`, `LilypadChangelogReader`, `readLilypadChangesBatch` and `lilypadCursorCovers` (`src/dbGate/`), `resolveLilypadDbTable` (`src/dbConfig/`), `src/flow/`, `src/platform/`, `src/singleton/`, `libLog`. Depended on by the applications only.
- Out of scope, covered by other tasks: the engine itself (`review-2026-10-01/030-cache-engine`), the gate, the changelog SQL and the reader (`review-2026-10-01/050-db-gate`), the contracts between this cache, the engine and the gate (`review-2026-10-01/900-integration`), untrusted notifications end to end (`review-2026-10-01/090-security`: here, report local handling bugs).
- Leads to verify (hints from a quick survey, not conclusions):
  - `LilypadEagerRefresh` (added by the last review) and `rereadNotified` in `LilypadDbCache.ts`, which has a `catch {}`: check that a failed batch expires its keys and is logged, and the budget of 1000 keys per second on `performance.now()`.
  - `sync/LilypadListenSync.ts` (much extended by the last review, no test file of its own): `takeBudget` and `overflow`, the end-of-second timer, the `tableWide` flag, a `dispose` during `startListening`, `onReconnect` → `applyBulkChange`.
  - `sync/LilypadChangelogSync.ts`: `trustedSince` (`maxGap`, `pollInterval`, two intervals with `poll: 'background'`), the cursor kept on a failed `apply` with its backoff; its test file covers only `lilypadNetChanges`.
  - `LilypadDbMembers`: the bound on unverified `add`s (a quarter of the table, at least 1000), `beginLoad`/`endLoad`, `isLoaded(trustedSince, ttl)`.
  - Write races: `writing`/`storeWritten`, `writesInFlight` with a generated primary key, `ownWrites.consume` when the change of the same `xid` arrives before the write's result.
  - `loadRows` leaving out the rows whose `currentTicket` exceeds the load's ticket, `forgetUnheld`, and `getAll` with a `maxEntries` smaller than the table.
- Fix tasks folder: `backlog/review-2026-10-01-fixes/060-db-cache/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit src/dbCache`, `npx eslint src/dbCache --max-warnings 0`, `npm run typecheck`, and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption, vulnerabilities, crashes
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior).
- Group `minor` findings of the same kind into one entry.
- A finding the previous review already reported and deliberately left as is (see its commit message or a comment in the code) is not a finding again, unless you show what it missed.
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `DBC-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, `breaking`/`cross-unit` if they apply, location, problem, fix.
3. Tests to add.
4. Checks run: commands and results, or why none ran.

### Apply or queue

If there are no findings, skip to the closing summary. Otherwise ask the user, listing the finding IDs, with these options:

- **Apply now**: fix every listed finding in this task, in the same commit that deletes it.
- **Queue**: create fix tasks instead; change no source code.
- **Mix**: the user names the IDs to apply now; the rest are queued or, for `minor` ones, dropped.

Whatever the choice:

- `breaking` and `cross-unit` findings are applied only if the user names their IDs explicitly; otherwise they're queued.
- If you can't ask the user (you run as a subagent), stop here and report `needs decision` with the question, the options and the finding list; you'll be resumed with the answer.

Applying a finding: make the fix, and for a bug, add a test that reproduces it. Run the build and the tests covering the unit. Repo rules that apply (`CLAUDE.md`):

- A user-facing change gets its changeset (`/write-changeset`), with an `#### Upgrading` row if it is `breaking`. Refactors and tests need none.
- A fix that makes a statement of `docs/architecture.md`, `docs/how-it-works.md`, `README.md`, `CLAUDE.md` or `.claude/` false updates it in the same change.
- Before the commit, run the `lilypad-reviewer` subagent on the diff of `src/`, and the `agent-docs` skill with `check --changed`.

Queuing findings: one task per finding, or per group of findings that must change together, in `backlog/review-2026-10-01-fixes/060-db-cache/`, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-10-01-fixes/060-db-cache`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` when the fix touches SQL or the gate).
- `depends-on: [review-2026-10-01/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: `npm run build` and the tests covering the unit pass, and the files it changed are within the unit, its tests, the docs and changesets the fixes require, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed (`coverage/`, `api-docs/`, packed `*.tgz`; `dist/` is ignored and may stay).
