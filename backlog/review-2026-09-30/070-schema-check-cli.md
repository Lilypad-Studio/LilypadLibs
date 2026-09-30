# Review the schema check and the lilypad-doctor CLI

## Goal

Review the schema check, `runLilypadDoctor` and the `lilypad-doctor` command as a senior reviewer/refactorer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 070-schema-check-cli`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md` (the `src/cli/` paragraph); per-module invariants: `docs/architecture.md` (the "Schema check" bullets).
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/dbGate/LilypadSchemaCheck.ts src/dbGate/LilypadSchemaFacts.ts src/dbGate/LilypadSchemaPruning.ts src/dbGate/LilypadSchemaShape.ts src/dbGate/LilypadDoctor.ts src/cli`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI (flags, exit codes, `--json` output) are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries: any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible. Problem messages and error messages are matched by tests: a change updates them.
- Unit:
  - `src/dbGate/LilypadSchemaCheck.ts`, `LilypadSchemaFacts.ts`, `LilypadSchemaPruning.ts`, `LilypadSchemaShape.ts`, `LilypadDoctor.ts`
  - `src/cli/lilypad-doctor.ts`, `LilypadDoctorCli.ts`, `LilypadInitCli.ts`, `lilypadDbConfigTemplate.ts`
  - Tests: `src/dbGate/LilypadSchemaCheck.test.ts`, `LilypadSchemaShape.test.ts`, `src/cli/LilypadDoctorCli.test.ts`, `LilypadInitCli.test.ts`, and the schema check and `runLilypadDoctor` cases of `src/dbGate/LilypadDbGate.integration.test.ts`
- Interfaces:
  - Exposes (entry `db`): `checkLilypadSchema`, `LilypadSchemaCheckError`, `normalizeLilypadPgType`, `lilypadSchemaCheckOptions`, `runLilypadDoctor` and their types; the `lilypad-doctor` bin (`--config`, `--url`, `--url-env`, `--env-file`, `--sql`, `--json`, `--help`; `init [--config] [--empty] [--force]`; exit codes 0/1/2). Internal: `evaluateLilypadSchema`, `readLilypadSchemaFacts`, `evaluatePruning`, `suggestPruning`, `lilypadCommandDeletesFrom`, `lilypadPruneCommandRetention`, `evaluateLilypadTableShape`, `lilypadCreateTableSql`, `installedLilypadChangelogPrune`.
  - Uses: `LilypadDbGate` `sql` (catalog queries), the changelog SQL builders and versions (`LilypadChangelog.ts`), the config and PG types (`src/dbConfig/`), `loadLilypadDbConfig`.
  - Depended on by: users running the command, and applications calling `runLilypadDoctor` / `checkLilypadSchema`.
- Out of scope, covered by other tasks: the changelog SQL itself and its quoting (`review-2026-09-30/050-db-gate`), config validation and loading (`review-2026-09-30/040-db-config`), public API design as a whole (`review-2026-09-30/080-architecture-api`), secrets and SQL injection end-to-end (`review-2026-09-30/090-security`), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Fix SQL order: tables first, deferred foreign keys, pruning last. Check the concatenated fix for a missing table with a foreign key to another missing table, for several schemas, and what happens when it is run twice.
  - `LilypadSchemaPruning.ts`: `lilypadCommandDeletesFrom`, `lilypadPruneCommandRetention` and `parseInterval` parse arbitrary cron SQL with regexes. Check quoted and qualified names, comments, case, `USING`, CTEs, `now() - '1 day 2 hours'::interval`, ISO intervals.
  - `installedLilypadChangelogPrune` reads a `lilypad-prune:` comment back: a malformed or hand-edited comment.
  - `LilypadSchemaFacts.ts`: every table in one query. Check tables with the same name in two schemas, case-sensitive names, partitioned tables, and missing privileges (`cron.job`, `pg_stat_user_tables`): best effort must not turn into a crash.
  - `evaluateLilypadTableShape`: unique-key equivalence (partial, expression and `NULLS NOT DISTINCT` indexes), foreign-key action comparison, defaults (`nextval` vs identity for `generatedPrimaryKey`).
  - CLI: the exit code of every failure path (config load error, connection error, invalid arguments, a thrown non-`Error`); `--env-file` values never written to `process.env`; the stability of `--json`; the URL or password in connection error messages.
  - `init --force` overwrites only the target path and leaves the other files of the same config (`existing`). Check whether this leaves two files for one config, which `loadLilypadDbConfig` then has to pick from.
  - Type-only import cycle: `LilypadSchemaFacts.ts`, `LilypadSchemaShape.ts` and `LilypadSchemaPruning.ts` import types from `LilypadSchemaCheck.ts`, which re-exports them. Check whether the shared types belong in their own module.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness (a false "ok", a false error, a fix SQL that fails or damages data), error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit src/dbGate/LilypadSchema src/cli`, `npx eslint src/dbGate src/cli --max-warnings 0`, `npm run typecheck`, `npm run build` then `node dist/lilypad-doctor.mjs --help`, and `npm run test:integration` if Docker is running (say so if it isn't).

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption (a fix SQL that drops or rewrites data), vulnerabilities, crashes
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior), and whether they need the integration project.
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `DOC-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this unit, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 070-schema-check-cli` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
