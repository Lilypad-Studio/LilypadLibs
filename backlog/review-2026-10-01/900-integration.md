---
depends-on:
  [
    review-2026-10-01/010-foundations,
    review-2026-10-01/020-logger,
    review-2026-10-01/030-cache-engine,
    review-2026-10-01/040-db-config,
    review-2026-10-01/050-db-gate,
    review-2026-10-01/060-db-cache,
    review-2026-10-01/070-schema-check-cli,
    review-2026-10-01/080-architecture-api,
    review-2026-10-01/090-security,
    review-2026-10-01/100-tooling-ci,
  ]
---

# Review the integration between units

## Goal

Review how the units of `review-2026-10-01` fit together, report the findings in chat, then reconcile the fix tasks the other units queued and ask the user whether to apply the new fixes now or queue them.

## Context

- Project: `@lilypad-studio/libs` 0.7.0 (0.8.0 pending: the `.changeset/*.md` files), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is the second full review: `review-2026-09-30` reviewed every unit and its fixes landed in `ca1e3c3`..`370dc71`. Review the whole unit with fresh eyes, with extra attention to the code those commits added (`git log --oneline c612a8c..370dc71 -- <unit paths>`). Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `370dc71`. The other units may have applied fixes since (`git log --oneline 370dc71..HEAD`): review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, each recorded in a changeset `#### Upgrading` row (`/write-changeset`); they ship with the pending 0.8.0. Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 7, `src/dbGate/LilypadChangelog.ts`); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed (installs then need the fix SQL of `lilypad-doctor`: say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: the interfaces between the other units (`src/` as a whole, read along the boundaries), and the fix tasks they queued in `backlog/review-2026-10-01-fixes/` (every subfolder).
- Interfaces: the dependency graph is `internal` ← `flow`, `platform` ← `cache`; `logger` ← every module; `singleton` ← `logger`, `dbGate`, `dbCache`; `dbConfig` ← `dbGate` ← `dbCache`; `cli` → `dbGate`, `dbConfig`. The diagram is in `docs/architecture.md` ("How the modules depend on each other").
- Out of scope, covered by other tasks: issues inside one unit (the unit tasks: `review-2026-10-01/010-foundations`, `review-2026-10-01/020-logger`, `review-2026-10-01/030-cache-engine`, `review-2026-10-01/040-db-config`, `review-2026-10-01/050-db-gate`, `review-2026-10-01/060-db-cache`, `review-2026-10-01/070-schema-check-cli`, `review-2026-10-01/080-architecture-api`, `review-2026-10-01/090-security`, `review-2026-10-01/100-tooling-ci`). Report one here only if it shows only when units are put together.
- Leads to verify (hints from a quick survey, not conclusions):
  - The engine hooks between `LilypadCacheEngine` (`src/cache/`) and `LilypadDbCache` (`src/dbCache/`): `onValueStored` must not write, how `hasReadInFlight` combines the reads of both, `maxSharedAge` given as the changelog `lookback`, `beginRead` used on every async path of the database cache.
  - Gate and cache: what `isListenHealthy()` means against `trustedSince()`; the `xid` returned by `LilypadDbTable` (`__lilypad_xid`, text) against the `xid` of the notifications and of the changelog rows (`lilypadCursorCovers`, `ownWrites`).
  - The notification payload: written by the trigger SQL of `src/dbGate/LilypadChangelog.ts`, parsed by `parseLilypadNotification` (`src/dbCache/sync/LilypadNotificationRouter.ts`): field names, `id` types (a `bigint` key sent as a string), `BULK` and its threshold, `schema`.
  - Config, doctor and runtime: `lilypadSchemaCheckOptions` (`src/dbGate/LilypadDoctor.ts`) derives `minRetention` from `maxGap`/`lookback`; check it matches what `LilypadChangelogSync` needs, and the channel default (`LILYPAD_DEFAULT_NOTIFY_CHANNEL`) everywhere it is used.
  - Errors across boundaries: a `LilypadDisposedError` of a closed gate reaching the reads of a cache, timeouts of the flow control inside the engine, errors swallowed by `Promise.allSettled` in `LilypadChangelogReader`.
  - Conventions: wall clock against `performance.now()` across the engine, the changelog sync, the backoff and the Discord logger; `libLog` sources and levels; option validation with `assertNumberOption` in every constructor.
- Fix tasks folder for this task: `backlog/review-2026-10-01-fixes/900-integration/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Contracts between units: mismatched caller and callee expectations, errors lost across a boundary, inconsistent conventions, logic duplicated across units.
2. The queue: duplicate or conflicting fix tasks in `backlog/review-2026-10-01-fixes/`.

Categories: correctness at the boundaries, error handling across modules, API and convention consistency, DRY across units, missing tests of the interactions.

Read the interfaces named above on both sides, and every queued fix task. Run `npm run check` (or the `check-runner` subagent) and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

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

Reconciling the queue (report it in a fifth section of the report, "Queue"):

- Merge duplicate or overlapping tasks: the merged task goes in `backlog/review-2026-10-01-fixes/900-integration/` as a new path, and the originals are deleted.
- Rewrite every `depends-on` that points to a merged or deleted task to the new path, or remove it: a deleted target counts as done.
- Conflicting breaking changes get one coherent version, left `blocked: "needs approval: ..."`.
- List in the closing summary every queued task edited, merged or deleted.

Report, in chat. Finding IDs: `INT-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, `breaking`/`cross-unit` if they apply, location, problem, fix.
3. Tests to add.
4. Checks run: commands and results, or why none ran.
5. Queue: the tasks merged, rewritten or deleted, and why.

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

Queuing findings: one task per finding, or per group of findings that must change together, in `backlog/review-2026-10-01-fixes/900-integration/`, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-10-01-fixes/900-integration`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` when the fix touches SQL or the gate).
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the five sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: `npm run build` and the tests covering the unit pass, and the files it changed are within the boundaries named in the findings, its tests, the docs and changesets the fixes require, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed (`coverage/`, `api-docs/`, packed `*.tgz`; `dist/` is ignored and may stay).
- Every queued fix task in `backlog/review-2026-10-01-fixes/` is still valid after the reconciliation: no duplicate, no dangling `depends-on`, conflicting breaking changes merged into one.
