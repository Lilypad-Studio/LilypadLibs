# Review security end to end

## Goal

Review security end to end as a senior reviewer/refactorer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0 (0.8.0 pending: the `.changeset/*.md` files), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is the second full review: `review-2026-09-30` reviewed every unit and its fixes landed in `ca1e3c3`..`370dc71`. Review the whole unit with fresh eyes, with extra attention to the code those commits added (`git log --oneline c612a8c..370dc71 -- <unit paths>`). Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `370dc71`. If the unit changed since (`git diff 370dc71 --stat -- src .github package.json`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, each recorded in a changeset `#### Upgrading` row (`/write-changeset`); they ship with the pending 0.8.0. Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 7, `src/dbGate/LilypadChangelog.ts`); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed (installs then need the fix SQL of `lilypad-doctor`: say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: cross-cutting. The trust boundaries listed in the objectives, across `src/` (mainly `src/dbGate/LilypadChangelog.ts`, `src/dbCache/sync/`, `src/cache/LilypadSharedLevel.ts`, `src/dbGate/loadLilypadDbConfig.ts`, `src/cli/`, `src/logger/formatLogValue.ts`, `src/dbConfig/LilypadDbConfigValidation.ts`, `src/serializer/`), `.github/workflows/`, `.github/dependabot.yml`, `package.json`.
- Interfaces: the boundaries are PostgreSQL (roles that can `NOTIFY` or write tables), the shared store an application plugs in as `platform.shared`, the config files and command line of `lilypad-doctor`, the log sinks, and the npm and GitHub supply chain.
- Out of scope, covered by other tasks: local quoting, parsing and redaction bugs already in the unit tasks (`review-2026-10-01/010-foundations` to `review-2026-10-01/070-schema-check-cli`), CI hygiene that is not about security (`review-2026-10-01/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `textArrayLiteral` (`src/dbGate/LilypadChangelog.ts`, also used by `LilypadSchemaFacts.ts`) builds SQL array literals from strings instead of parameters.
  - `columnSql`/`checkSql` (`src/dbGate/LilypadSchemaShape.ts`) write a config's `default.sql`, `expression` and `pgType` raw into the fix SQL that a user may run as a superuser.
  - `LilypadSharedLevel.acquireLock` is a plain `set`: check whether another writer of the store can hold or break the lock, and what that costs.
  - The `--url` option of `lilypad-doctor` and the connection errors it prints.
  - Notification floods: `LilypadListenSync.takeBudget`/`overflow` and `LilypadEagerRefresh` bound the work per second; check memory too (`LilypadDbMembers` unverified adds, `LilypadNotificationRouter`).
  - `.github/workflows/release.yml`: the permissions it grants, the actions that run with them, what a pull request from a fork can reach.
- Fix tasks folder: `backlog/review-2026-10-01-fixes/090-security/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Vulnerabilities at the trust boundaries, end to end (the unit tasks already checked the local issues):
   - Database: notification payloads are untrusted (any role can `NOTIFY`): `parseLilypadNotification`, the budgets, the eager re-reads. The changelog is trusted because only the triggers may write it: the `SECURITY DEFINER` functions, their `search_path = pg_catalog, pg_temp`, the `REVOKE`s, the `writable-changelog` check, the prune function.
   - SQL text: every identifier from a config is quoted; `textArrayLiteral` values; the raw `default.sql`, `expression` and `pgType` written into the fix SQL; the parameters of `pruneLilypadChangelog` and `lilypadChangelogPruneScheduleSql`.
   - Code and files: `loadLilypadDbConfig` `import()`s a file from the working directory or `--config` (code execution by design: check it is documented and that a name cannot escape to another path); `init` writes files.
   - Secrets: `--url` in argv, `--env-file`, errors that echo connection strings, log redaction (`LILYPAD_DEFAULT_REDACTED_KEYS`, `redactUrlPasswords`), the Discord webhook URL in errors.
   - The shared store (L2): entries planted by another app sharing the store, envelope validation, key encoding, `decode` of untrusted data, the lock.
   - Untrusted objects: prototype pollution in the serializer, the config validation (`__proto__` keys), `toLogJson`, the notification JSON.
2. Denial of service: unbounded maps and queues (rate map, fences, members, own writes, router, Discord queue), the `formatLogValue` budget, notification floods.
3. Supply chain: dependencies (`npm audit`), the postgres.js peer range, GitHub Actions pinned by SHA, release workflow permissions, Dependabot.

Categories: security, error handling (failures that open a boundary), missing tests (a test per boundary that was fixed). The previous security review (`d85f0f2 fix: harden the trust boundaries of the caches, the changelog and the logs`) is a starting point: check that its fixes hold, and look for what it missed.

Read every file on a trust boundary in full, and the rest only as far as needed to follow the data. Run the checks that cover this unit if you can: `npm audit --audit-level=high`, `npm run test:integration` if Docker is running (the privilege tests of the changelog; say so if it isn't). Change nothing until the user has chosen below.

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
- A finding the previous review already reported and deliberately left as is (see its commit message or a comment in the code) is not a finding again, unless you show what it missed.
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `SEC-<n>`:

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

Applying a finding: make the fix, and for a bug, add a test that reproduces it. Run the build and the tests covering the unit. Repo rules that apply (`CLAUDE.md`):

- A user-facing change gets its changeset (`/write-changeset`), with an `#### Upgrading` row if it is `breaking`. Refactors and tests need none.
- A fix that makes a statement of `docs/architecture.md`, `docs/how-it-works.md`, `README.md`, `CLAUDE.md` or `.claude/` false updates it in the same change.
- Before the commit, run the `lilypad-reviewer` subagent on the diff of `src/`, and the `agent-docs` skill with `check --changed`.

Queuing findings: one task per finding, or per group of findings that must change together, in `backlog/review-2026-10-01-fixes/090-security/`, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-10-01-fixes/090-security`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` when the fix touches SQL or the gate).
- `depends-on: [review-2026-10-01/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: `npm run build` and the tests covering the unit pass, and the files it changed are within the files on the boundaries named in the findings, its tests, the docs and changesets the fixes require, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed (`coverage/`, `api-docs/`, packed `*.tgz`; `dist/` is ignored and may stay).
