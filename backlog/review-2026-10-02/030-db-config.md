# Lite review the database config, its validation and the PostgreSQL types

## Goal

Check the database config, its validation and the PostgreSQL types for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 with five pending changesets (`.changeset/*.md`), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a confirmation lite pass: the previous one (`review-2026-10-01-2`, baseline `157e3a2`) found five blockers, fixed in `884e992`, `1a868f4`, `4cd54d5`, `aa6c69d` and `ea5ce20`, and those fixes were never reviewed: start with what they changed in this unit (`git diff 157e3a2 d9d6cbb -- <unit paths>`), then review the rest of the unit. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `d9d6cbb`. If the unit changed since (`git diff d9d6cbb --stat -- src/dbConfig`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 10, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/dbConfig/` (`LilypadDbConfig.ts`, `LilypadDbConfigDefaults.ts`, `LilypadDbConfigValidation.ts`, `LilypadDbHooks.ts`, `LilypadDbSchema.ts`, `LilypadPgTypes.ts`; about 1,800 source lines), with `LilypadDbConfig.test.ts`, `LilypadDbHooks.test.ts`, `LilypadPgTypes.test.ts`.
- Interfaces: exposes the entry `schema` (edge-safe; re-exported by `db`): `defineLilypadDb`, `defineLilypadTable`, `isLilypadDbConfig`, `isLilypadDbTableDefinition`, `bindLilypadDbHooks`, `normalizeLilypadPgType`, `lilypadColumnTypesOfPgType`, `LILYPAD_DEFAULT_CHANGELOG_TABLE`, `LILYPAD_DEFAULT_DB_CONFIG_NAME`, the errors `LilypadDbNotFoundError`, `LilypadDbMissingPrimaryKeyError`, `LilypadDbEmptyWriteError`, and the config and row types; internally `resolveLilypadDbTable`. Uses `src/internal/` only. Depended on by the gate and `LilypadDbTable` (`src/dbGate/`), `LilypadDbCache`, the schema check (`normalizeLilypadPgType` against `format_type`, the shapes written by `lilypadCreateTableSql`), `loadLilypadDbConfig`, and the `init` template (`src/cli/lilypadDbConfigTemplate.ts`).
- Out of scope, covered by other tasks: the changelog SQL that consumes the channel and table names (`review-2026-10-02/040-db-gate`), the schema check's comparison of types and shapes and the SQL it writes from them (`review-2026-10-02/060-schema-check-cli`), the config as trusted code (`review-2026-10-02/070-security`), the rules shared by the config and the check (`review-2026-10-02/900-integration`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Only a doc comment changed since `157e3a2` (`poll` in `LilypadDbConfig.ts`, `4cd54d5`: check it matches what `LilypadChangelogSync` now does), and the last lite pass found no blocker here: look for what it did not check rather than repeating it (its leads were the idempotence of `normalizeLilypadPgType`, the configs the docs show, UTF-8 identifier lengths, `resolveLilypadDbTable` and `bindLilypadDbHooks(undefined)`).
  - `normalizeLilypadPgType` against spellings it may confuse: `"char"` (the one-byte internal type) and `char`/`character(1)`, `float(24)` (`real`) and `float(25)` (`double precision`), `timestamp(3) with time zone`, `time without time zone`, `interval day to second`, `character varying[]`, `bit varying(n)`, a schema-qualified or quoted user type. Two types normalized to one text hide a mismatch; one type normalized to two texts reports a false `column-type-mismatch`, whose fix SQL `ALTER`s a correct column.
  - `LilypadDbConfigValidation.ts` on values a config file can hold (`lilypad-doctor` imports it): getters that throw, objects with a null prototype, class instances, frozen objects, `__proto__` or `constructor` keys. Check the validation throws its own error (never a `TypeError` from inside it), cannot be polluted, and never accepts a value that later crashes the gate, the cache or the check.
  - `LilypadDbSchema.ts` (`cols`, `default`, `generatedPrimaryKey`, references, unique keys, indexes, checks): check that every shape the validation accepts can be written by `lilypadCreateTableSql` (`src/dbGate/LilypadSchemaShape.ts`) and compared by the check, e.g. a reference to a table of another schema, a composite foreign key, a `generatedPrimaryKey` on a key that is not an integer or a `uuid`.
  - `bindLilypadDbHooks` and the hooks the table applies to rows (`select` on the rows a write returns): a hook that throws or returns a row without its primary key; the error reaches the caller, never an unhandled rejection.
- Fix tasks folder: `backlog/review-2026-10-02-fixes/030-db-config/`. Task format: `backlog/README.md`.

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
