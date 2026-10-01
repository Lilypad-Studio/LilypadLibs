---
depends-on:
  [
    review-2026-10-01-2/010-foundations-logger,
    review-2026-10-01-2/020-cache-engine,
    review-2026-10-01-2/030-db-config,
    review-2026-10-01-2/040-db-gate,
    review-2026-10-01-2/050-db-cache,
    review-2026-10-01-2/060-schema-check-cli,
    review-2026-10-01-2/070-security,
  ]
---

# Lite review integration

## Goal

Check the contracts between the units for severe problems only, reconcile the fix tasks the units queued, and give the overall verdict of this lite pass: report in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 (released; no pending changeset), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a lite pass after two full reviews (`review-2026-09-30`, `review-2026-10-01`) whose fixes all landed. The code those fixes added (`git log --oneline 6f58e9b..157e3a2 -- <unit paths>`) and the features merged after them (`18ac82b`, `e1641fd`, `3c44669`) were never reviewed: start there. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `157e3a2`. The other units may have applied fixes since (`git log --oneline 157e3a2..HEAD`): review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 9, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: the interfaces between the other units, and the fix tasks they queued in `backlog/review-2026-10-01-2-fixes/` (`010-foundations-logger/` to `070-security/`).
- Interfaces, the contracts to check:
  - Engine hooks ↔ `LilypadDbCache`: `onValueStored`, `onEntriesIncomplete`, `hasReadInFlight`, `maxSharedAge`, `beginRead`/`read.store`/`read.storeFetched`, `markInvalid`, `rejectSharedBefore`, `currentTicket`/`nextTicket` (`src/cache/LilypadCacheEngine.ts` ↔ `src/dbCache/LilypadDbCache.ts`). The engine changed in `9bc2248` (invalidation marks carried, bulk sync as a read in flight) and the database cache in `45568eb` (reload of `getAll`): check each side still meets what the other assumes.
  - Trigger payload ↔ router: what the record function and `lilypadChangelogTriggerSql` send (`pg_notify` payloads, `BULK`/`TRUNCATE` above `LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD`) ↔ `parseLilypadNotification` and `LilypadNotificationRouter` (`src/dbCache/sync/`).
  - Changelog SQL ↔ schema check: `LILYPAD_CHANGELOG_VERSION` and the version comment, `lilypadSafeKeyTypeSql` shared by the record function and the `unsupported-key-type` check, `installedLilypadChangelogPrune` ↔ the prune comment, the fixes withheld while a newer or unsafe install exists (`src/dbGate/LilypadChangelog.ts` ↔ `LilypadSchemaCheck.ts`).
  - Config ↔ changelog SQL ↔ check: `defineLilypadDb`'s identifier and `notifyChannel` rules ↔ `assertLilypadChannel` ↔ what the check accepts; `normalizeLilypadPgType` (`src/dbConfig/LilypadPgTypes.ts`) ↔ the `format_type` text read by `LilypadSchemaFacts.ts`.
  - Gate ↔ database cache: errors across the boundary (`LilypadDisposedError` on a closed gate, postgres.js errors, timeouts) reach the caller or the logger, never an unhandled rejection; `libLog` used by every module never throws.
- Out of scope: what lies inside one unit (`review-2026-10-01-2/010-foundations-logger` to `review-2026-10-01-2/070-security`).
- Fix tasks folder: `backlog/review-2026-10-01-2-fixes/900-integration/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order, all held to the lite bar below:

1. Contracts between units: mismatched caller and callee expectations, errors lost across a boundary, a format or version rule one side applies and the other does not.
2. The queued fix tasks in `backlog/review-2026-10-01-2-fixes/`: merge duplicates, and reconcile breaking changes that conflict or overlap into one coherent version. You may edit, merge or delete queued fix tasks, and must list which ones in the closing summary:
   - merged tasks go in this task's fix folder, `900-integration/`, as new paths; the originals are deleted
   - every `depends-on` that points to a merged or deleted task is rewritten to the new path, or removed: a deleted target counts as done
   - conflicting breaking changes get one coherent version, left `blocked: "needs approval: ..."`

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Overall verdict, at the top of the report. Unit reports aren't kept, so derive it from what the units left: fix tasks queued in `backlog/review-2026-10-01-2-fixes/`, and fixes applied since the baseline (`git log --stat 157e3a2..HEAD`: commits that delete a `review-2026-10-01-2` unit task and change files outside `backlog/`), plus this task's own findings. `solid` if there are none, otherwise `not solid` with the count. `solid`: the code is solid enough, stop iterating reviews. `not solid`: run the blocker fixes, then `/plan-review --lite` again to confirm.

Read both sides of each contract above in full where they meet; read the queued fix tasks in full. Run the checks if you can: `npm run check`, and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it (input, expected behavior).
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `INT-<n>`:

1. The overall verdict (see above), then a summary of 3-5 lines, and the queued fix tasks merged, edited or deleted.
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
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every fix task left in `backlog/review-2026-10-01-2-fixes/` follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the files on both sides of the contracts its findings name, their tests, the fix tasks folder, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
