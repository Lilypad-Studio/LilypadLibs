---
depends-on:
  [
    review-2026-09-30/010-foundations,
    review-2026-09-30/020-logger,
    review-2026-09-30/030-cache-engine,
    review-2026-09-30/040-db-config,
    review-2026-09-30/050-db-gate,
    review-2026-09-30/060-db-cache,
    review-2026-09-30/070-schema-check-cli,
    review-2026-09-30/080-architecture-api,
    review-2026-09-30/090-security,
    review-2026-09-30/100-tooling-ci,
  ]
---

# Review the integration between the units

## Goal

Review the contracts between the units of the 2026-09-30 review and the fix tasks they queued, report the findings in chat, reconcile the queue, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `a3cfaf4`. The code has changed since (`git log --oneline a3cfaf4..HEAD`): `ca1e3c3` applied the `010-foundations` findings, and other units may have applied fixes. Review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible.
- Unit: the interfaces between the other units, and every fix task they queued in `backlog/review-2026-09-30-fixes/<NNN>-<unit>/`.
- Interfaces, the contracts to check from both sides:
  - Cache engine ↔ `LilypadDbCache`: `beginRead()` / `read.store` / `read.storeFetched`, `replaceEntries`, `extendExpiration`, `expire`, `markInvalid`, `expireEverything`, `rejectSharedBefore`, `emitInvalidation`, and the hooks `onValueStored`, `onEntriesIncomplete`, `hasReadInFlight` (`src/cache/LilypadCacheEngine.ts` ↔ `src/cache/LilypadDbCache.ts`).
  - Gate ↔ sync strategies: `addListener` / `removeListener`, `isListenHealthy`, `onReconnect`, `readLilypadChangesBatch`, `LilypadChangelogReader`, `lilypadCursorCovers`, `LilypadOwnWrites` (`src/dbGate/` ↔ `src/cache/dbSync/`, `src/cache/dbCache/`).
  - Changelog SQL ↔ schema check: `lilypadChangelogSql`, `lilypadChangelogTriggerSql`, `lilypadChangelogPruneScheduleSql`, the version constants (`src/dbGate/LilypadChangelog.ts`) ↔ `LilypadSchemaCheck.ts`, `LilypadSchemaPruning.ts`, `installedLilypadChangelogPrune`, `LilypadDoctor.ts`.
  - Configs ↔ their users: `resolveLilypadDbTable`, `bindLilypadDbHooks`, `LilypadPgTypes.ts` ↔ the gate, the table, `LilypadDbCache`, the schema check and the CLI.
  - Foundations ↔ every module: `libLog`, `LilypadBackoff`, `runInBackground` / `runAfterResponse`, `sharedStoreOperation`, `toTtlSeconds`, `createLilypadSingletonAble(Async)`, `assertNumberOption`.
- Out of scope, covered by other tasks: each module's own findings (`review-2026-09-30/010-foundations` through `review-2026-09-30/100-tooling-ci`). Here, only what crosses a boundary between units, and the queue.
- Queued before the units ran: this review was converted from an older format, whose only finished report was `010-foundations`. Its findings FND-1 to FND-9 were applied in `ca1e3c3`. Its breaking changes are recorded in `.changeset/foundations-robustness.md`: per-call `retries` validated, versioned singleton registry keys (`<namespace>@1:<id>`), `__proto__` refused as a serializer key, `LilypadBackoff.ready()` / `fail()` without a `now` argument. Two items it left open were queued:
  - `review-2026-09-30-fixes/010-foundations/010-changelog-sync-monotonic-clock` (FND-2, in the files of `060-db-cache` and `050-db-gate`)
  - `review-2026-09-30-fixes/010-foundations/020-engine-refresh-monotonic-clock` (FND-2, in the files of `030-cache-engine`)
- Leads to verify (hints, not conclusions):
  - Clocks: FND-2 settled on `performance.now()` for local intervals and `Date.now()` for timestamps stored in L2 or compared with them (`expirationTime`, `fetchedAt`, `failedAt`, `trustedSince`). Check that the other units' queued fixes follow it, and whether `030-cache-engine` or `060-db-cache` queued duplicates of the two tasks above.
  - Errors lost across a boundary: rejections of sync strategies, of each subscriber's `apply` in `LilypadChangelogReader`, of gate listener callbacks and of logger components.
  - Inconsistent conventions: `undefined` (not cached) vs `null` (cached as missing) across the engine and `LilypadDbCache`; option validation through `assertNumberOption` (now a `RangeError`) in every module; milliseconds vs seconds (`toTtlSeconds`, `LilypadSharedStore.set`).
  - Logic duplicated across units: identifier quoting (`quoteIdentifier` in `LilypadChangelog.ts` vs `quotedColumns` / `lilypadCreateTableSql` in `LilypadSchemaShape.ts`), PostgreSQL type knowledge outside `LilypadPgTypes.ts`, key normalization (`resolveNotifiedKey` vs the engine's `normalizeKey`).
  - Format versions: queued fixes from several units that change the changelog SQL or the L2 entries must agree on the `LILYPAD_CHANGELOG_VERSION` / `SHARED_FORMAT_VERSION` bumps, and on raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION`.
  - Skipped units: a unit task deleted without a review leaves its area unreviewed. For each unit, check `git log --format='%h %s' -- backlog/review-2026-09-30/<unit>.md` and say which were skipped.
- Fix tasks folder: `backlog/review-2026-09-30-fixes/900-integration/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Contracts between units: mismatched caller and callee expectations, errors lost across a boundary, inconsistent conventions, logic duplicated across units.
2. The queue: duplicate fix tasks, and breaking changes from different units that conflict or overlap.

Categories: contract mismatches, error propagation, conventions, cross-unit duplication, queue consistency.

Read both sides of each interface above, and every task file in `backlog/review-2026-09-30-fixes/`. Read a module's internals only as far as needed to judge a contract. Run `npm run check`, and `npm run test:integration` if Docker is running (say so if it isn't). Change no source code until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet, on both sides of the boundary. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption (including a stale value served after a change), vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on. Every finding here spans units, so `cross-unit` doesn't apply.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior), and whether they need the integration project.
- Group `minor` findings of the same kind into one entry.
- If the contracts hold, say so. Don't pad the report.

Report, in chat. Finding IDs: `INT-<n>`:

1. Summary (5-10 lines), the units skipped, and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, `breaking` if it applies, location, problem, fix.
3. Tests to add.
4. Checks run: commands and results, or why none ran.

### Reconcile the queue

Edit, merge or delete the queued fix tasks in `backlog/review-2026-09-30-fixes/`:

- Duplicates (the same finding reported by two units) and tasks that must change together are merged into one task in `900-integration/`, at a new path. The originals are deleted, and the merged task quotes every source finding ID.
- Every `depends-on` that points to a merged or deleted task is rewritten to the new path, or removed (a deleted target counts as done).
- Breaking changes that conflict or overlap get one coherent version, left `blocked: "needs approval: <the change, one line>"`.
- A queued task that is already fixed in the current code is deleted.
- The `depends-on: [review-2026-09-30/900-integration]` of the queued tasks stays: it is satisfied once this task file is deleted.

### Apply or queue

If there are no findings, skip to the closing summary. Otherwise ask the user, listing the finding IDs, with these options:

- **Apply now**: fix every listed finding in this task, in the same commit that deletes it.
- **Queue**: create fix tasks instead; change no source code.
- **Mix**: the user names the IDs to apply now; the rest are queued or, for `minor` ones, dropped.

Whatever the choice:

- `breaking` findings are applied only if the user names their IDs explicitly; otherwise they're queued.
- If you can't ask the user (you run as a subagent), stop here and report `needs decision` with the question, the options and the finding list; you'll be resumed with the answer.

Applying a finding: make the fix, and for a bug, add a test that reproduces it. A fix that changes user-facing behavior gets its changeset (`/write-changeset`), with a `#### Upgrading` row if it is `breaking`. Run `npm run check`, and `npm run test:integration` for database code.

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-09-30-fixes/900-integration`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` for database code), and the changeset when the fix changes user-facing behavior.
- Add `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason), and the queue changes (fix tasks edited, merged as old paths → new path, and deleted, each with a reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location on both sides of the boundary, and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every task in `backlog/review-2026-09-30-fixes/` has been read. No finding is covered by two tasks, and conflicting breaking changes are one task, `blocked: "needs approval: ..."`. The closing summary lists every task edited, merged or deleted.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists or is this task.
- If this task applied anything: `npm run check` passes, and the files it changed are the interfaces of its findings, their tests and changesets, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
