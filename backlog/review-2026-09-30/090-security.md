# Review security end-to-end

## Goal

Review the library's trust boundaries end-to-end as a senior security reviewer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 090-security`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`. The repository `Lilypad-Studio/LilypadLibs` has been public; the package is published to GitHub Packages.
- Baseline: commit `a3cfaf4`. If `src/` changed since (`git diff a3cfaf4 --stat -- src .github package.json`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries: any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible.
- Scope: the whole repository, following data across these trust boundaries (the per-unit tasks already check local issues; this one follows the flows between modules):
  - **Database notifications** (any role with access to the database can `NOTIFY` on `cache_events`): `src/dbGate/LilypadDbGate.ts` listeners → `src/cache/dbSync/LilypadNotificationRouter.ts` (`parseLilypadNotification`, `resolveNotifiedKey`) → `src/cache/LilypadDbCache.ts` (eager re-reads, the `takeEagerRefresh` budget, `BULK`/`TRUNCATE` handling).
  - **The shared store (L2)**, possibly shared with other apps or instances: `src/cache/LilypadSharedLevel.ts` (envelopes, the codec, locks, tags) → cache values; `src/platform/LilypadPlatform.ts` (`sharedStoreOperation`).
  - **Identifiers from configs** (schema, table, column, channel, changelog table, cron job names) → generated SQL: `src/dbGate/LilypadChangelog.ts` (`quoteIdentifier`, `quoteLiteral`, `escapeFormat`, the `EXECUTE format(...)` bodies), `src/dbGate/LilypadSchemaShape.ts` (`lilypadCreateTableSql`, `quotedColumns`), the fix SQL of `src/dbGate/LilypadSchemaCheck.ts`, `lilypadChangelogPruneScheduleSql`; and the queries of `src/dbGate/LilypadDbTable.ts` (postgres.js `sql(identifier)` helpers).
  - **Database privileges**: the changelog trigger function, the `SECURITY DEFINER SET search_path FROM CURRENT` prune function (`LilypadChangelog.ts`, around `<changelog>_prune()`), pg_cron jobs, `pruneLilypadChangelog` (`force`, `batchSize`).
  - **The CLI**: `src/cli/LilypadDoctorCli.ts` (`--url`, `--url-env`, `--env-file` parsed with `util.parseEnv`, `--json` output), `src/cli/LilypadInitCli.ts` (file writes, `--force`), `src/dbConfig/loadLilypadDbConfig.ts` (`import()` of a config file: code execution by design; check which paths it accepts).
  - **Secrets**: connection strings (hashed in the singleton signature of `LilypadDbGate.create`; check error messages, logs, CLI output), the Discord webhook URL (`src/logger/components/DiscordLogger.ts`), the logger redaction (`LILYPAD_DEFAULT_REDACTED_KEYS` in `src/logger/formatLogValue.ts`; `record.parts` stay raw).
  - **Writes**: `LilypadDbTable` drops properties not in `cols` (mass assignment), the `write`/`select` hooks.
  - **Resource exhaustion**: unbounded maps and queues (flow control `rateMap`, engine `fences` and `refreshing`, `LilypadOwnWrites`, the singleton signature map, the Discord queue), payload sizes, `selectByPrimaryKeys` with huge key lists.
  - **Supply chain**: `package.json` dependencies, `npm audit`, `.github/workflows/release.yml` (token, permissions, `changesets/action`), `.github/workflows/ci.yml` (`pull_request` from forks, pinned actions), `.npmrc` handling.
- Out of scope, covered by other tasks: local bugs of each module that are not security issues (`review-2026-09-30/010-foundations` through `070-schema-check-cli`), public API design (`review-2026-09-30/080-architecture-api`), CI and tooling quality beyond supply chain (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Can a forged `NOTIFY` make the cache serve wrong data, evict useful entries or generate unbounded queries? The notifications are documented as untrusted: check that every path treats them so.
  - Can a value planted in the shared store be served as a fresh row of `LilypadDbCache` or `LilypadCache`, and is that within the documented trust model?
  - Every config identifier that reaches SQL: quoted as an identifier, a literal, or inside `format()`? Check names with `"`, `'`, `%`, `$`, `;`, and the dollar-quote tags.
  - `SET search_path FROM CURRENT` on a `SECURITY DEFINER` function: with a default `search_path` that includes a schema writable by other roles (`public` on PostgreSQL < 15), can the function resolve an object planted there?
  - Do connection errors from postgres.js, the CLI's messages or `--json` include the password of the URL?
  - Does `lilypad-doctor`'s `--config <path>` or the config discovery load a file from an unexpected place (parent directories, symlinks)?

## Instructions

Objectives, in priority order:

1. Vulnerabilities an attacker with a realistic position can exploit: a database role with `NOTIFY` or `INSERT` rights, a shared store tenant, a contributor to a config file, a pull request author.
2. Hardening that is cheap and removes a class of problems (default redaction, quoting helpers used everywhere, least privilege in SQL and workflows).

Categories: injection (SQL, format strings), privilege escalation, data integrity of the caches, secret exposure, resource exhaustion, supply chain.

Read the code paths listed above in full, following each boundary from input to effect. Run what helps: `npm audit --audit-level=high`, `npx vitest run --project unit src/cache/dbSync src/dbGate`, and `npm run test:integration` if Docker is running to try a payload (say so if it isn't).

Rules:

- Report only issues you can point to in the code: file, function, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- For each finding, state the attacker model: who controls the input, what they gain.
- Confidence: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: exploitable by a realistic attacker: injection, privilege escalation, secret disclosure, cache poisoning that serves wrong data
  - `recommended`: defense in depth with a concrete risk, unbounded resource use reachable from untrusted input
  - `minor`: hardening with little practical risk
- A concrete fix for every finding: a minimal patch or snippet. A fix of the changelog SQL states the `LILYPAD_CHANGELOG_VERSION` bump.
- Don't report theoretical issues the documented trust model already accepts, unless the model itself is the problem (then say why).
- Group `minor` findings of the same kind into one entry.
- If the boundaries hold, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `SEC-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, attacker model, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add (e.g. hostile identifiers and payloads, with the expected behavior).
5. Impact on other units: which unit's code each fix touches, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 090-security` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, an attacker model, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
