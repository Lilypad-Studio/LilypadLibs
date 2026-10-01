# Review tests, build, CI and release

## Goal

Review tests, build, CI and release as a senior reviewer/refactorer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0 (0.8.0 pending: the `.changeset/*.md` files), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is the second full review: `review-2026-09-30` reviewed every unit and its fixes landed in `ca1e3c3`..`370dc71`. Review the whole unit with fresh eyes, with extra attention to the code those commits added (`git log --oneline c612a8c..370dc71 -- <unit paths>`). Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `370dc71`. If the unit changed since (`git diff 370dc71 --stat -- .github scripts package.json eslint.config.mjs vitest.config.ts vitest.edge-setup.ts tsconfig.json tsconfig.edge.json tsdown.config.ts edge.config.ts knip.json .husky .changeset/config.json .changeset/changelog.mjs docs/releasing.md`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, each recorded in a changeset `#### Upgrading` row (`/write-changeset`); they ship with the pending 0.8.0. Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 7, `src/dbGate/LilypadChangelog.ts`); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed (installs then need the fix SQL of `lilypad-doctor`: say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: cross-cutting. `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`, `scripts/` (`merge-changelog-sections.ts` and its test, `smoke-test.mjs`), `package.json` (scripts, engines, `devEngines`, dev dependencies, lint-staged, commitlint), `eslint.config.mjs`, `vitest.config.ts`, `vitest.edge-setup.ts`, `tsconfig.json`, `tsconfig.edge.json`, `tsdown.config.ts` (its checks), `edge.config.ts`, `knip.json`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.nvmrc`, `.husky/`, `.changeset/config.json`, `.changeset/changelog.mjs`, `docs/releasing.md`; and the test suites as a whole (not each test's logic).
- Interfaces: `npm run check` is what CI runs (except the integration tests); the pre-commit hook runs lint-staged, the typecheck and the tests; the release workflow calls CI, then changesets opens the version PR and publishes to GitHub Packages.
- Out of scope, covered by other tasks: the logic of each module's tests (the unit tasks `review-2026-10-01/010-foundations` to `review-2026-10-01/070-schema-check-cli`), supply chain security (`review-2026-10-01/090-security`), the entries as API design (`review-2026-10-01/080-architecture-api`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `vitest.edge-setup.ts` removes the Node.js globals: check whether the `edge` project would also fail on a `node:*` import at run time, or only on the globals.
  - Coverage: no threshold, and these have no test file of their own: `src/dbCache/sync/LilypadListenSync.ts`, `src/cache/LilypadSharedLevel.ts`, `src/dbGate/LilypadSchemaPruning.ts`, `src/internal/LilypadTimeout.ts`; `LilypadDbTable.ts` and the catalog queries run only in the integration tests. Run `npm run coverage` and name the critical uncovered branches.
  - `scripts/merge-changelog-sections.ts` rewrites `CHANGELOG.md` in place: idempotence, LF on Windows, a section it does not know.
  - `scripts/smoke-test.mjs`: does it cover every entry with `import` and `require()`, and the command without a database?
  - `release.yml`: what happens if the publish fails after the version PR is merged, concurrency between two pushes to `main`.
  - `devEngines` requires Node.js 22.22.1+ while the CI matrix says `22`: check which 22.x `setup-node` installs, and `@types/node ~22.12.0` with its Dependabot rule.
- Fix tasks folder: `backlog/review-2026-10-01-fixes/100-tooling-ci/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. The checks catch what they claim to catch: the edge project, the typecheck of the edge entries, the lint rules (`eslint.config.mjs`), knip, publint/attw, the smoke test, the integration matrix (Node.js 22, 24, 26; PostgreSQL 13, 16, 18).
2. The release is safe and repeatable: `.github/workflows/release.yml`, changesets, `scripts/merge-changelog-sections.ts`, what happens when a step fails halfway.
3. The test strategy: coverage gaps of critical code, slow or flaky tests, fake timers, tests that pass without asserting.
4. Developer experience: hooks, scripts, Windows (LF, paths), versions (`devEngines`, `.nvmrc`, `@types/node ~22.12.0`, Dependabot rules).

Categories: correctness of the tooling, CI coverage, release safety, missing tests, maintainability of the configs.

Read every file of the unit in full. Run the checks that cover this unit if you can: `npm run check` (or the `check-runner` subagent), `npm run coverage` (then remove `coverage/`), and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

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

Report, in chat. Finding IDs: `TOOL-<n>`:

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

Queuing findings: one task per finding, or per group of findings that must change together, in `backlog/review-2026-10-01-fixes/100-tooling-ci/`, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-10-01-fixes/100-tooling-ci`), following `backlog/README.md`:

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
- If this task applied anything: `npm run build` and the tests covering the unit pass, and the files it changed are within the unit, its tests, the docs and changesets the fixes require, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed (`coverage/`, `api-docs/`, packed `*.tgz`; `dist/` is ignored and may stay).
