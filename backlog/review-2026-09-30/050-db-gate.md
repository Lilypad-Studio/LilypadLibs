# Review the database gate, table and changelog

## Goal

Review `LilypadDbGate`, `LilypadDbTable`, the heartbeat and the changelog as a senior reviewer/refactorer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md` (the "Changelog", "LilypadDbGate" and "LilypadDbTable" bullets).
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/dbGate/LilypadDbGate.ts src/dbGate/LilypadDbTable.ts src/dbGate/LilypadListenHeartbeat.ts src/dbGate/LilypadChangelog.ts src/dbGate/LilypadChangelogReader.ts`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed (installs then need the fix SQL of `lilypad-doctor`, say so in the migration). L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()` (its failed cancel becomes an unhandled rejection in 3.4.x).
- Unit: `src/dbGate/LilypadDbGate.ts`, `LilypadDbTable.ts`, `LilypadListenHeartbeat.ts`, `LilypadChangelog.ts`, `LilypadChangelogReader.ts`. Tests: `LilypadDbGate.test.ts`, `LilypadChangelog.test.ts`, `LilypadChangelogReader.test.ts`, `LilypadListenHeartbeat.test.ts`, and `LilypadDbGate.integration.test.ts` (its schema check and `runLilypadDoctor` parts are reviewed by `070-schema-check-cli`).
- Interfaces:
  - Exposes (entry `db`): `LilypadDbGate` (`create`, `table`, `addListener`/`removeListener`, `isListenHealthy`, `assertOpen`, `close`, `sql`), `lilypadServerlessPool`, `LilypadDbTable` (`selectAll`, `selectByPrimaryKey(s)`, `insert`, `update`, `delete`), `lilypadChangelogSql`, `lilypadChangelogTriggerSql`, `lilypadChangelogPruneScheduleSql`, `pruneLilypadChangelog`, `readLilypadChanges`, the changelog constants and types. Internal: `readLilypadChangesBatch`, `lilypadCursorCovers`, `quoteIdentifier`, `LILYPAD_CHANGELOG_VERSION`, `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION`, `LilypadChangelogReader`.
  - Uses: postgres.js, the table definitions and `resolveLilypadDbTable` (`src/dbConfig/`), `createLilypadSingletonAbleAsync`, `LilypadBackoff`, `assertNumberOption`, `libLog`, `LilypadDisposedError`.
  - Depended on by: `LilypadDbCache` and the sync strategies (`src/cache/`), `LilypadOwnWrites`, the schema check and the doctor (`LilypadSchemaCheck.ts`, `LilypadSchemaFacts.ts`, `LilypadSchemaShape.ts`, `LilypadSchemaPruning.ts`, `LilypadDoctor.ts`).
- Out of scope, covered by other tasks: config validation and PG types (`review-2026-09-30/040-db-config`), how the cache consumes notifications and changelog reads (`review-2026-09-30/060-db-cache`), the schema check and the fix SQL it assembles (`review-2026-09-30/070-schema-check-cli`), public API design as a whole (`review-2026-09-30/080-architecture-api`), SQL privileges and injection end-to-end (`review-2026-09-30/090-security`: here, report local quoting bugs), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Heartbeat: the start/stop race (`heartbeatStop`), the retry of a failed start through `isListenHealthy()` and `LilypadBackoff`, the 2.5-interval health window with timers paused (serverless freeze).
  - `addListener` / `removeListener`: concurrent add and remove of one channel while its LISTEN is in flight, an UNLISTEN of a channel re-added meanwhile, `onReconnect` from the second `onlisten` on, async callbacks that reject.
  - `close({ timeout })`: a LISTEN still starting, the heartbeat timer, the second client (`listenerConnectionString`), and idempotence.
  - `LilypadDbTable`: `selectAll` closes its cursor on abort and on error; `selectByPrimaryKeys` chunks (1000) with duplicate keys and result order; `bigint` string keys; the `write` hook replacing the data; a column really named `__lilypad_xid`; `update` with only the primary key.
  - Changelog SQL: check `quoteIdentifier`, `quoteLiteral` and `escapeFormat` on every name that comes from a config (schema, table, column, channel, changelog table, cron job name), including `%`, `$`, quotes and the dollar-quote tags used in the body (`$notify$`, `$record$`).
  - The prune function: `SECURITY DEFINER SET search_path FROM CURRENT` (around the `<changelog>_prune()` definition). Check what `FROM CURRENT` captures when the migration runs with a default `search_path`.
  - Cursor `{ xmax, xip }`: the query `xid >= xmax OR xid = ANY(xip)` (types xid8 vs text), `readLilypadChangesBatch` with several tables and requests mixing cursors and lookbacks, `lilypadCursorCovers`.
  - `LilypadChangelogReader` (a `WeakMap` per gate): subscribe/unsubscribe during a read in flight, an error delivered to each subscriber, a gate closed during a read.
  - `statementTimeout` applies to the main client: check the listener client and long cursors of `selectAll`.
- Fix tasks folder: `backlog/review-2026-09-30-fixes/050-db-gate/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit src/dbGate`, `npx eslint src/dbGate --max-warnings 0`, `npm run typecheck`, and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it, e.g. an integration test).
- Severity:
  - `blocker`: real bugs, data loss or corruption (including a change missed by the changelog), vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine. A fix of the changelog SQL states the `LILYPAD_CHANGELOG_VERSION` bump.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior), and whether they need the integration project.
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `GATE-<n>`:

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

Applying a finding: make the fix, and for a bug, add a test that reproduces it. A fix that changes user-facing behavior gets its changeset (`/write-changeset`), with a `#### Upgrading` row if it is `breaking`. Run the build and the tests covering the unit.

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-09-30-fixes/050-db-gate`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` for database code), and the changeset when the fix changes user-facing behavior.
- `depends-on: [review-2026-09-30/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the unit, its tests, its changeset, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
