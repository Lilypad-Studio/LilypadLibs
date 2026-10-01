# Lite review the database gate, table and changelog

## Goal

Check the database gate, table and changelog for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 with five pending changesets (`.changeset/*.md`), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a confirmation lite pass: the previous one (`review-2026-10-01-2`, baseline `157e3a2`) found five blockers, fixed in `884e992`, `1a868f4`, `4cd54d5`, `aa6c69d` and `ea5ce20`, and those fixes were never reviewed: start with what they changed in this unit (`git diff 157e3a2 d9d6cbb -- <unit paths>`), then review the rest of the unit. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `d9d6cbb`. If the unit changed since (`git diff d9d6cbb --stat -- src/dbGate/LilypadDbGate.ts src/dbGate/LilypadDbTable.ts src/dbGate/LilypadListenHeartbeat.ts src/dbGate/LilypadChangelog.ts src/dbGate/LilypadChangelogReader.ts`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 10, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/dbGate/LilypadDbGate.ts`, `LilypadDbTable.ts`, `LilypadListenHeartbeat.ts`, `LilypadChangelog.ts`, `LilypadChangelogReader.ts` (about 2,110 source lines). Tests: `LilypadDbGate.test.ts`, `LilypadChangelog.test.ts`, `LilypadChangelogReader.test.ts`, `LilypadListenHeartbeat.test.ts`, and the gate, table, listener and changelog parts of `LilypadDbGate.integration.test.ts` (its schema check and `runLilypadDoctor` parts belong to `060-schema-check-cli`).
- Interfaces: exposes (entry `db`) `LilypadDbGate` (`create`, `table`, `addListener`/`removeListener`, `isListenHealthy`, `assertOpen`, `close`, `sql`), `lilypadServerlessPool`, `LilypadDbTable` (`selectAll`, `selectByPrimaryKey(s)`, `insert`, `update`, `delete`), `lilypadChangelogSql`, `lilypadChangelogTriggerSql`, `lilypadChangelogPruneScheduleSql`, `pruneLilypadChangelog`, `readLilypadChanges`; internally `readLilypadChangesBatch`, `lilypadCursorCovers`, `lilypadSafeKeyTypeSql`, `assertLilypadChannel`, `quoteIdentifier`, `quoteLiteral`, `textArrayLiteral`, `installedLilypadChangelogPrune`, `LilypadChangelogReader`, `LILYPAD_CHANGELOG_VERSION` (10), `LILYPAD_CHANGELOG_OLD_ROWS`/`NEW_ROWS`. Uses postgres.js, `resolveLilypadDbTable` (`src/dbConfig/`), `createLilypadSingletonAbleAsync`, `LilypadBackoff`, `assertNumberOption`, `libLog`, `LilypadDisposedError`. Depended on by `src/dbCache/` (the cache, its sync strategies, `LilypadOwnWrites`) and by the schema check and the doctor (`LilypadSchemaCheck.ts`, `LilypadSchemaFacts.ts`, `LilypadSchemaPruning.ts`, `LilypadDoctor.ts`).
- Out of scope, covered by other tasks: config validation and PG types (`review-2026-10-02/030-db-config`), how the cache bounds and consumes the changelog reads (`review-2026-10-02/050-db-cache`), the schema check and the fix SQL it assembles, including whether it reports every trigger version 10 refuses (`review-2026-10-02/060-schema-check-cli`), whether the version 10 guard closes the `pg_temp` hole and what else the `SECURITY DEFINER` body resolves (`review-2026-10-02/070-security`: here, check it refuses no legitimate trigger), the payload contract between the trigger and the router (`review-2026-10-02/900-integration`).
- Leads to verify (hints from a quick survey, not conclusions):
  - The version 10 guard in the record function (`ea5ce20`, after the `TRUNCATE` and `ROW` branches): it looks up `pg_trigger` by `TG_RELID` and `TG_NAME` and requires `tgoldtable`/`tgnewtable` per `TG_OP`. Check that every statement trigger any earlier release of `lilypadChangelogTriggerSql` installed (statement triggers since changelog version 4; `git log -p -- src/dbGate/LilypadChangelog.ts`) declares exactly `lilypad_old`/`lilypad_new` for its event, since a mismatch fails every write of the table once version 10 is installed; and that it does not refuse a legitimate firing: a trigger on a partitioned table (and the partitions attached later), a trigger renamed with `ALTER TRIGGER ... RENAME`, a `TRUNCATE` inside the same statement as other changes.
  - Upgrading a live database from version 9 to 10 with `lilypadChangelogSql` while writers run: no write lost, no write failing between the old and the new function, and the version 9 upgrade statements still upgrade an install of version 7 or 8 in one run.
  - `statementTimeout` has no default anymore (`1a868f4`): check that no `statement_timeout` startup parameter is sent when it is unset or `false`, on the main client and on the listener client of `listenerConnectionString`, that `lilypadServerlessPool()` passes, and that a gate behind PgBouncer in transaction mode works with the defaults (`prepare: false` kept).
  - Without a server-side timeout, a query can now hang (a lock, a dead connection). `LilypadChangelogReader.read`: while `current` never settles, every read of a subscriber it does not include queues behind it in `queued`; check the reader recovers once the stuck query ends or fails, and never runs two reads that apply overlapping cursors. `close({ timeout })` with a stuck query: it ends the connections after its timeout and the stuck promise rejects instead of hanging its caller.
  - Listener lifecycle: `addListener`/`removeListener`/`close` concurrent with a LISTEN that is starting or reconnecting, and the heartbeat after `close()`: no callback left registered on a closed client, no reconnection loop.
- Fix tasks folder: `backlog/review-2026-10-02-fixes/040-db-gate/`. Task format: `backlog/README.md`.

## Instructions

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit src/dbGate/LilypadDbGate.test.ts src/dbGate/LilypadChangelog.test.ts src/dbGate/LilypadChangelogReader.test.ts src/dbGate/LilypadListenHeartbeat.test.ts`, `npx eslint src/dbGate --max-warnings 0`, `npm run typecheck`, and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it (input, expected behavior).
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `GATE-<n>`:

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
