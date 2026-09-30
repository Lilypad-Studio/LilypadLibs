# Review the tests, build, CI and dependencies

## Goal

Review the test suite as a whole, the build, the checks, CI, the release and the dependencies as a senior reviewer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 100-tooling-ci`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules and commands: `CLAUDE.md`; releases: `docs/releasing.md`.
- Baseline: commit `a3cfaf4`. If the scope changed since (`git diff a3cfaf4 --stat -- vitest.config.ts eslint.config.mjs tsconfig.json tsconfig.edge.json tsdown.config.ts knip.json package.json .github .husky .changeset scripts src/entries/entries.test.ts`), say so at the top of the report and review the current files.
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

## Instructions

Objectives, in priority order:

1. Checks that catch what they claim to catch: a regression, a broken entry, an edge incompatibility or a broken package must fail CI before release.
2. A suite and pipeline that stay fast, deterministic and maintainable.

Categories: test coverage (missing critical cases, not line counts), test reliability, build correctness, check gaps, CI/release robustness, dependency management, developer experience.

Read every file of the scope in full, and skim the test files to judge coverage. Run what you can: `npm run check` (or through the `check-runner` subagent), `npm run coverage`, and `npm run test:integration` if Docker is running (say so if it isn't).

Rules:

- Report only issues you can point to: file, line or key, relevant snippet. Anchor on the snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the file) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: a check that silently passes on broken code, a release that can publish a broken package, a hook or workflow that corrupts the repository
  - `recommended`: significant coverage gaps on critical paths, flaky tests, slow or redundant pipeline steps, inconsistent version constraints
  - `minor`: config style, naming, comments
- A concrete fix for every finding: the config change, the workflow step, or the tests to add (name the cases: input, expected behavior).
- Group `minor` findings of the same kind into one entry.
- If the tooling is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `TOOL-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration (e.g. engines, required Node.js version).
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this scope, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 100-tooling-ci` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build, coverage or test artifacts left by the checks are removed.
