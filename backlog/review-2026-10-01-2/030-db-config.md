# Lite review the database config, its validation and the PostgreSQL types

## Goal

Check the database config, its validation and the PostgreSQL types for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 (released; no pending changeset), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a lite pass after two full reviews (`review-2026-09-30`, `review-2026-10-01`) whose fixes all landed. The code those fixes added (`git log --oneline 6f58e9b..157e3a2 -- <unit paths>`) and the features merged after them (`18ac82b`, `e1641fd`, `3c44669`) were never reviewed: start there. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `157e3a2`. If the unit changed since (`git diff 157e3a2 --stat -- src/dbConfig`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 9, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/dbConfig/` (`LilypadDbConfig.ts`, `LilypadDbConfigDefaults.ts`, `LilypadDbConfigValidation.ts`, `LilypadDbHooks.ts`, `LilypadDbSchema.ts`, `LilypadPgTypes.ts`; about 1,800 source lines), with `LilypadDbConfig.test.ts`, `LilypadDbHooks.test.ts`, `LilypadPgTypes.test.ts`.
- Interfaces: exposes the entry `schema` (edge-safe; re-exported by `db`): `defineLilypadDb`, `defineLilypadTable`, `isLilypadDbConfig`, `isLilypadDbTableDefinition`, `bindLilypadDbHooks`, `normalizeLilypadPgType`, `lilypadColumnTypesOfPgType`, `LILYPAD_DEFAULT_CHANGELOG_TABLE`, `LILYPAD_DEFAULT_DB_CONFIG_NAME`, the errors `LilypadDbNotFoundError`, `LilypadDbMissingPrimaryKeyError`, `LilypadDbEmptyWriteError`, and the config and row types; internally `resolveLilypadDbTable`. Uses `src/internal/` only. Depended on by the gate and `LilypadDbTable` (`src/dbGate/`), `LilypadDbCache`, the schema check (`normalizeLilypadPgType` against `format_type`), `loadLilypadDbConfig`, and the `init` template (`src/cli/lilypadDbConfigTemplate.ts`).
- Out of scope, covered by other tasks: the changelog SQL that consumes the channel and table names (`review-2026-10-01-2/040-db-gate`), the schema check's comparison of types and shapes (`review-2026-10-01-2/060-schema-check-cli`), the config as trusted code (`review-2026-10-01-2/070-security`), the rule shared by `defineLilypadDb` and `assertLilypadChannel` (`review-2026-10-01-2/900-integration`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `normalizeLilypadPgType` (`LilypadPgTypes.ts`, `ca1a09c`) now maps `numeric(p)`, `bit`, array suffixes, `dec`, `char varying` and `bpchar` to what `format_type` writes: check that it is idempotent on every spelling `format_type` writes, and that no two different column types normalize to the same text (the schema check would miss a mismatch) nor one type to two texts (it would report a false `column-type-mismatch`, and its fix SQL would `ALTER` a correct column).
  - `defineLilypadDb` rejects unknown options at every level, arrays where objects are expected, and ambiguous references (`ca1a09c` and the 0.8.0 validation): check that every config shape the docs show still passes, in particular the `init` template (`src/cli/lilypadDbConfigTemplate.ts`), the README samples, a `sync` of each strategy, and a table reused through its `defineLilypadTable(...)` input. A valid config rejected breaks every consumer at startup.
  - Identifier checks (63 bytes, no dot, `notifyChannel` not an `Object.prototype` key nor containing `__lilypad_`, effda7f): bytes counted on UTF-8, not UTF-16 length.
  - `resolveLilypadDbTable`: a reference to a table of the default schema wins over same-named tables of other schemas; check a schema-qualified `tableName` and a `references.table` written with and without the schema resolve to the same table.
  - `bindLilypadDbHooks` accepts `undefined` (`ca1a09c`): a config without hooks, and hooks bound to a config whose table keys differ.
- Fix tasks folder: `backlog/review-2026-10-01-2-fixes/030-db-config/`. Task format: `backlog/README.md`.

## Instructions

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit --project edge src/dbConfig`, `npx eslint src/dbConfig --max-warnings 0`, `npm run typecheck`. Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it (input, expected behavior).
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `CFG-<n>`:

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
- `depends-on: [review-2026-10-01-2/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
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
