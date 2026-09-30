---
depends-on:
  [
    review-2026-09-30/010-foundations,
    review-2026-09-30/020-logger,
    review-2026-09-30/030-cache-engine,
    review-2026-09-30/040-db-config,
    review-2026-09-30/050-db-gate,
    review-2026-09-30/060-db-cache,
    review-2026-09-30/070-schema-check-cli,
    review-2026-09-30/080-architecture-api,
    review-2026-09-30/090-security,
    review-2026-09-30/100-tooling-ci,
  ]
---

# Synthesize the 2026-09-30 review into fix tasks

## Goal

Merge the unit review reports under `## Reports` into one prioritized plan and turn it into backlog tasks under `backlog/review-2026-09-30-fixes/`. Give the synthesis in chat, not in a file. Change no source code. The reports are deleted with this file once it's done, so the fix tasks must stand on their own.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `a3cfaf4`.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible.
- Task format: `backlog/README.md`. A fix task that changes user-facing behavior includes its changeset in "Done when".

## Instructions

1. Read every report below in full. A section still marked "Pending" means its unit was skipped: say so in the synthesis. When reports disagree, or a finding looks doubtful, check it against the code.
2. Merge the findings, removing duplicates. Keep every source ID, so each finding stays traceable to its reports.
3. Find problems that only show when units are put together: mismatched contracts between caller and callee (engine ↔ `LilypadDbCache`, gate ↔ sync strategies, changelog SQL ↔ schema check), errors lost across a boundary, inconsistent conventions, logic duplicated across units.
4. Find proposed breaking changes, from different units, that conflict or overlap, and propose one coherent version of each.
5. Write an ordered plan: blockers first, then changes that unlock other improvements, then the rest. For each step: the finding IDs it covers, the files it touches, and its estimated impact (size S/M/L, risk, what or who is affected).
6. Create one backlog task per plan step in `backlog/review-2026-09-30-fixes/`, numbered `010`, `020`... in plan order, following `backlog/README.md`:
   - Context is self-contained: quote the location, the snippet and the proposed fix from the reports, and for cross-unit problems or merged breaking changes, the reasoning behind them.
   - "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` for database code).
   - `depends-on` only for real dependencies, not mere ordering.
   - A step with a breaking change gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
   - `minor` findings: group them by kind into a few tasks, or leave them out of the plan with a reason.

Synthesis, as your final chat message (if you run as a subagent, it's part of your report):

1. Overview (5-10 lines), including skipped units.
2. Cross-unit problems.
3. Breaking changes: conflicts found and the coherent version.
4. Plan: a table with step, task path, finding IDs, impact.
5. Not planned: findings dropped (false positive, won't fix, not worth it), each with a reason.

## Done when

- Every `blocker` and `recommended` finding in the reports is covered by a task in `backlog/review-2026-09-30-fixes/`, or listed under "Not planned" with a reason.
- Every task in `backlog/review-2026-09-30-fixes/` follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- `git status --porcelain` shows no change outside `backlog/`.

## Reports

Each unit task replaces its own placeholder below with its report.

### 010-foundations: Foundations (internal, flow, platform, singleton, serializer)

_Pending: written by `review-2026-09-30/010-foundations`._

### 020-logger: Logger

_Pending: written by `review-2026-09-30/020-logger`._

### 030-cache-engine: Cache engine and LilypadCache

_Pending: written by `review-2026-09-30/030-cache-engine`._

### 040-db-config: Database configs

_Pending: written by `review-2026-09-30/040-db-config`._

### 050-db-gate: Database gate, table and changelog

_Pending: written by `review-2026-09-30/050-db-gate`._

### 060-db-cache: Database cache and sync strategies

_Pending: written by `review-2026-09-30/060-db-cache`._

### 070-schema-check-cli: Schema check and lilypad-doctor CLI

_Pending: written by `review-2026-09-30/070-schema-check-cli`._

### 080-architecture-api: Architecture and public API

_Pending: written by `review-2026-09-30/080-architecture-api`._

### 090-security: Security end-to-end

_Pending: written by `review-2026-09-30/090-security`._

### 100-tooling-ci: Tests, build, CI and dependencies

_Pending: written by `review-2026-09-30/100-tooling-ci`._
