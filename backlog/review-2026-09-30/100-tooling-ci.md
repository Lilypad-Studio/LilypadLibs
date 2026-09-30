# Review the tests, build, CI and dependencies

## Goal

Review the test suite as a whole, the build, the checks, CI, the release and the dependencies as a senior reviewer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules and commands: `CLAUDE.md`; releases: `docs/releasing.md`.
- Baseline: commit `a3cfaf4`. If the scope changed since (`git diff a3cfaf4 --stat -- vitest.config.ts eslint.config.mjs tsconfig.json tsconfig.edge.json tsdown.config.ts knip.json package.json .github .husky .changeset scripts src/entries/entries.test.ts`), say so at the top of the report and review the current files: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row. Tooling changes need no changeset. `package.json` `exports`/`bin` and `CHANGELOG.md` are generated: never propose editing them by hand.
- Scope:
  - Build and checks: `tsdown.config.ts` (build side: format, dts, publint, attw, unused), `tsconfig.json`, `tsconfig.edge.json`, `eslint.config.mjs`, `knip.json`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitattributes`
  - Tests: `vitest.config.ts` (projects `unit`, `edge`, `integration`, coverage), `src/entries/entries.test.ts`, and the test suite as a whole (`src/**/*.test.ts`: coverage gaps and patterns, not each test's content, which the module units check)
  - Package and scripts: `package.json` (scripts, engines, devEngines, dependencies, peer dependencies, lint-staged, commitlint), `.nvmrc`, `scripts/smoke-test.mjs`
  - CI and release: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`, `.husky/pre-commit`, `.husky/commit-msg`, `.changeset/config.json`, `.changeset/changelog.mjs`, `docs/releasing.md`
- Interfaces: CI gates every change to `main`; the release workflow publishes to GitHub Packages; the pre-commit hook runs lint-staged, `npm run typecheck` and `npm test`.
- Out of scope, covered by other tasks: the behavior tested by each module's tests (`review-2026-09-30/010-foundations` through `070-schema-check-cli`), the entries as API (`review-2026-09-30/080-architecture-api`), supply chain and workflow permissions as security (`review-2026-09-30/090-security`: here, report them only as reliability issues).
- Leads to verify (hints from a quick survey, not conclusions):
  - `src/entries/entries.test.ts` parses imports with a regex (`/^\s*(import|export)(\s+type)?\s[^;]*?from\s+['"]([^'"]+)['"]/gms`). Check what it misses: side-effect imports (`import 'x'`), dynamic `import()`, `export * from` with no braces, inline `type` specifiers, `.mts` files. The lint rule and `tsconfig.edge.json` are the other guards: is together enough?
  - The `edge` project `include` list in `vitest.config.ts`: does it cover every edge module's tests? `src/cache/LilypadSharedLevel.ts` has no test file of its own (covered by `LilypadCache.shared.test.ts`?).
  - Modules without a test file of their own: `LilypadListenSync.ts`, `LilypadSharedLevel.ts`, `LilypadDbConfigValidation.ts`, `LilypadSchemaFacts.ts`, `LilypadSchemaPruning.ts`, `LilypadDoctor.ts`, `LilypadTimeout.ts`, `LilypadDbTable.ts` (integration only). Run `npm run coverage` and report the real gaps, not the file count.
  - CI: the integration tests run on Node.js 22 and 24 but not 26; `npm audit` and `npm pack` only on 24; the smoke test only on 22.12.0; the release workflow runs no tests before `changeset publish` (only the `prepack` build). Check what a broken commit on `main` could publish.
  - `devEngines` requires Node.js >= 22.22.1 while CI's `node: 22` resolves to the latest 22.x, and `.nvmrc` is 24: check consistency.
  - `knip.json` is four lines (`entry: scripts/*.mjs`): check that knip analyses the tsdown entries and the test files as intended.
  - The pre-commit hook runs the full typecheck and tests on every commit: check its duration and whether it's the right trade-off.
  - `.changeset/changelog.mjs`: check it produces the house sections (`#### Upgrading`, `#### Added`...) described in `docs/releasing.md`.
  - Flakiness: integration tests with timers, testcontainers timeouts (`hookTimeout` 120 s), fake timers vs real `postgres` sockets.
- Fix tasks folder: `backlog/review-2026-09-30-fixes/100-tooling-ci/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. Checks that catch what they claim to catch: a regression, a broken entry, an edge incompatibility or a broken package must fail CI before release.
2. A suite and pipeline that stay fast, deterministic and maintainable.

Categories: test coverage (missing critical cases, not line counts), test reliability, build correctness, check gaps, CI/release robustness, dependency management, developer experience.

Read every file of the scope in full, and skim the test files to judge coverage. Run what you can: `npm run check` (or through the `check-runner` subagent), `npm run coverage`, and `npm run test:integration` if Docker is running (say so if it isn't). Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to: file, line or key, relevant snippet. Anchor on the snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the file) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: a check that silently passes on broken code, a release that can publish a broken package, a hook or workflow that corrupts the repository
  - `recommended`: significant coverage gaps on critical paths, flaky tests, slow or redundant pipeline steps, inconsistent version constraints
  - `minor`: config style, naming, comments
- A concrete fix for every finding: the config change, the workflow step, or the tests to add (name the cases: input, expected behavior).
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Group `minor` findings of the same kind into one entry.
- If the tooling is sound, say so. Don't pad the report.

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

Applying a finding: make the fix, and for a bug, add a test that reproduces it. A fix that changes user-facing behavior gets its changeset (`/write-changeset`), with a `#### Upgrading` row if it is `breaking`. Run the build and the tests covering the unit.

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-09-30-fixes/100-tooling-ci`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` for database code), and the changeset when the fix changes user-facing behavior.
- `depends-on: [review-2026-09-30/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the unit, its tests, its changeset, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build, coverage or test artifacts left by the checks are removed.
