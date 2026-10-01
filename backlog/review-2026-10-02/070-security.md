# Lite review security end to end

## Goal

Check the trust boundaries of the library for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 with five pending changesets (`.changeset/*.md`), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a confirmation lite pass: the previous one (`review-2026-10-01-2`, baseline `157e3a2`) found five blockers, fixed in `884e992`, `1a868f4`, `4cd54d5`, `aa6c69d` and `ea5ce20`, and those fixes were never reviewed: start with the ones on a trust boundary (`ea5ce20`, `aa6c69d`, `884e992`), then review the rest of the boundaries. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `d9d6cbb`. If the files below changed since (`git diff d9d6cbb --stat -- src .github package.json`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 10, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: cross-cutting. The trust boundaries listed in the objectives, across `src/` (mainly `src/dbGate/LilypadChangelog.ts`, `src/dbGate/LilypadSchemaFacts.ts`, `src/dbGate/LilypadSchemaCheck.ts`, `src/dbGate/LilypadSchemaShape.ts`, `src/dbCache/sync/`, `src/dbCache/LilypadDbCache.ts`, `src/cache/LilypadSharedLevel.ts`, `src/dbGate/loadLilypadDbConfig.ts`, `src/cli/`, `src/logger/formatLogValue.ts`, `src/logger/components/DiscordLogger.ts`, `src/dbConfig/LilypadDbConfigValidation.ts`, `src/serializer/`), `.github/workflows/`, `package.json`.
- Interfaces: the boundaries are PostgreSQL (roles that can `NOTIFY`, write the cached tables, or were granted `EXECUTE` on the changelog functions, e.g. the migration role that runs `CREATE TRIGGER`), the shared store an application plugs in as `platform.shared`, the config files and command line of `lilypad-doctor` and the fix SQL it prints, the log sinks, and the npm and GitHub supply chain.
- Out of scope, covered by other tasks: local quoting, parsing and redaction bugs inside one module (`review-2026-10-02/010-foundations-logger` to `review-2026-10-02/060-schema-check-cli`), whether the check reports every trigger version 10 refuses (`review-2026-10-02/060-schema-check-cli`, `review-2026-10-02/900-integration`), tooling and CI hygiene that is not about security (not reviewed in this lite pass).
- Leads to verify (hints from a quick survey, not conclusions):
  - The version 10 guard (`ea5ce20`) runs after the `TRUNCATE` branch, which records `TG_TABLE_SCHEMA`/`TG_TABLE_NAME` and notifies without any check. A role granted `EXECUTE` on the record function can attach it as a `TRUNCATE` trigger to a table of its own: check what that lets it record or notify (a forged `TRUNCATE` of a cached table needs a table of the same schema and name: who can create one, e.g. in `public`?), and whether a `TRUNCATE` trigger can reach anything in `pg_temp`.
  - The other names the `SECURITY DEFINER` bodies (record and prune functions, `recordDoBody`, `pruneDoBody`) resolve with `search_path = pg_catalog, pg_temp`: `pg_temp` is skipped for functions and operators, but not for relations. List every relation the bodies name and check each is qualified, one of the transition tables (now checked by the guard), or in `pg_catalog`; check the guard's own lookup (`pg_catalog.pg_trigger`, matched on `TG_RELID` and `TG_NAME`) cannot be satisfied by a trigger other than the firing one.
  - The fix SQL that `lilypad-doctor --sql` prints, which a user may run as a superuser, and its messages: since `aa6c69d` they contain the names of tables outside the config and the key column read from another role's trigger arguments (`tgargs`). Check that a table, schema or column name containing a newline, `*/`, `--` or `;` cannot break out of a SQL comment or a quoted identifier into a statement of the fix SQL. The `blocked_changelog_tables` query embeds `lilypadSafeKeyTypeSql` with `sql.unsafe` and the config's table names with `textArrayLiteral`: check both stay injection-free.
  - Log redaction after `884e992`: a URL whose scheme is longer than 64 characters is no longer masked. Check that no connection string the library or `lilypad-doctor` logs or prints (postgres.js errors, `--url`, `--env-file` values, `libLog` details) can carry such a scheme, and that `LILYPAD_DEFAULT_REDACTED_KEYS` still catches the password fields of postgres.js options and errors.
  - Forged notifications and L2 entries (unchanged since the last lite pass, which found no blocker there): only check that the reads now bounded by `boundRead` (`4cd54d5`) give an attacker who can hold a lock on the changelog no new way to make every read of the caches wait longer than `fetchTimeout`.
  - `.github/workflows/` and `package.json` are unchanged since the last lite pass: only rerun `npm audit --audit-level=high` and check the postgres.js peer range.
- Fix tasks folder: `backlog/review-2026-10-02-fixes/070-security/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order, all held to the lite bar below:

1. Exploitable vulnerabilities at the trust boundaries above, end to end: code run with another role's privileges, SQL injection (in the SQL the library runs and in the fix SQL it prints), secrets leaked to logs or output, untrusted data that corrupts the cache or the process.
2. Denial of service a realistic attacker can trigger: unbounded maps and queues, notification floods, work amplification, a read that every cache waits for held indefinitely.
3. Supply chain: `npm audit --audit-level=high`, the postgres.js peer range, actions pinned by SHA, release workflow permissions.

The previous security fixes (`ea5ce20 fix(security)!: refuse changelog triggers without their transition tables`, `3ccdc93`, and `d85f0f2` before them) are a starting point: check that they hold, and look for what they missed.

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Read every file on a trust boundary in full, and the rest only as far as needed to follow the data. Run the checks that cover this unit if you can: `npm audit --audit-level=high`, `npm run test:integration` if Docker is running (the privilege tests of the changelog; say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it at the boundary (input, expected behavior); for the changelog privileges, an integration test.
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `SEC-<n>`:

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
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the files its findings name and their tests, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
