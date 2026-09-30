# Review the database configs

## Goal

Review the database config modules (entry `schema`, and the config loader) as a senior reviewer/refactorer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md` (section "Database configs").
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/dbConfig src/dbGate/LilypadDbSchema.ts`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible (no `node:*`, no `process`/`Buffer`). Configs hold no functions (hooks are bound with `bindLilypadDbHooks`), and `src/dbConfig/LilypadPgTypes.ts` is the only place that knows the PostgreSQL types.
- Unit: `src/dbConfig/LilypadDbConfig.ts`, `LilypadDbConfigValidation.ts`, `LilypadDbConfigDefaults.ts`, `LilypadDbHooks.ts`, `LilypadPgTypes.ts`, `loadLilypadDbConfig.ts` (Node only, exported by `db`), and `src/dbGate/LilypadDbSchema.ts` (column/table description types and the `LilypadDbNotFoundError`, `LilypadDbMissingPrimaryKeyError`, `LilypadDbEmptyWriteError` errors, exported by `schema`). Tests: `src/dbConfig/LilypadDbConfig.test.ts`, `LilypadDbHooks.test.ts`, `LilypadPgTypes.test.ts`, `loadLilypadDbConfig.test.ts`.
- Interfaces:
  - Exposes: everything in `src/entries/schema.ts` (`defineLilypadDb`, `defineLilypadTable`, `bindLilypadDbHooks`, `LILYPAD_DEFAULT_DB_CONFIG_NAME`, `lilypadColumnTypesOfPgType`, the definition, row and column types, the three errors), plus `loadLilypadDbConfig` and `lilypadDbConfigFileNames` (entry `db`). Internal: `resolveLilypadDbTable`, `validateLilypadDbConfigInput`, `normalizeLilypadPgType`, `lilypadColumnTypeMismatch`, `isLilypadSerialPgType`, `isLilypadIntegerPgType`, `lilypadConfigLoadHint`.
  - Uses: `assertNumberOption` and co. (`src/internal/LilypadValidation.ts`) only.
  - Depended on by: `LilypadDbGate` / `LilypadDbTable` (`gate.table(definition | key)`), `LilypadDbCache` and the sync strategies, the schema check (`LilypadSchemaShape.ts`, `LilypadDoctor.ts`), the CLI (`LilypadDoctorCli.ts`, `LilypadInitCli.ts`, `lilypadDbConfigTemplate.ts`).
- Out of scope, covered by other tasks: how the gate and table use the definitions (`review-2026-09-30/050-db-gate`), how the cache uses them (`review-2026-09-30/060-db-cache`), how the doctor compares them with the database (`review-2026-09-30/070-schema-check-cli`), public API design as a whole (`review-2026-09-30/080-architecture-api`), the `import()` of config files as a trust boundary (`review-2026-09-30/090-security`), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `validateLilypadDbConfigInput` throws on the first problem. Check the invalid inputs it may miss: two keys with the same `tableName`/schema, a primary key absent from `cols`, `references` to an unknown table or column, identifiers with quotes, dots or uppercase, an invalid `notifyChannel`, a qualified `changelog.table`, `sync` options that contradict the strategy.
  - `resolveLilypadDbTable` / `withConfigHooks`: hooks are matched by key, config name and `qualifiedName`, with no identity check. Check two configs with the same name (or both unnamed) that share a table, and a definition from a reloaded module.
  - Freezing: check that nested objects of the resolved definitions (`cols`, `unique`, `foreignKeys`, `indexes`, `db`) are frozen too, and that `bindLilypadDbHooks` never mutates its input.
  - `LilypadPgTypes.ts`: coverage of spellings (`timestamp without time zone`, `character varying(255)`, `numeric(10,2)`, arrays such as `int4[]`, `double precision`, enums and domains through `CATEGORY_TYPES`), `bigint` values typed as strings, false positives of `lilypadColumnTypeMismatch`.
  - `loadLilypadDbConfig`: discovery order of `lilypad.config.{ts,mts,mjs,js}` / `lilypad.<name>.config.*`, several matching files, default vs `config` export, the name check, Windows paths (`pathToFileURL`), `lilypadConfigLoadHint` on errors that are not `Error`s.
  - Type level: `defineLilypadTable<T>`'s `cols` mapping and the phantom row type. Check that `@ts-expect-error` tests cover the rejections the docs promise (wrong `type` for `T[K]`, unknown `pgType`, `converted: true`).
  - `LilypadDbSchema.ts` lives in `src/dbGate/` but belongs to the edge `schema` entry, and `dbConfig/` imports it. Check whether it belongs in `dbConfig/`.
- Fix tasks folder: `backlog/review-2026-09-30-fixes/040-db-config/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run src/dbConfig` (runs the `unit` and `edge` projects), `npx eslint src/dbConfig src/dbGate/LilypadDbSchema.ts --max-warnings 0`, `npm run typecheck` (it also checks the `@ts-expect-error` type tests, which vitest does not). Change nothing until the user has chosen below.

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
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `CFG-<n>`:

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

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-09-30-fixes/040-db-config`), following `backlog/README.md`:

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
