# Review the foundations (internal, flow, platform, singleton, serializer)

## Goal

Review the foundation modules as a senior reviewer/refactorer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 010-foundations`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/internal src/flow src/platform src/singleton src/serializer`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible (no `node:*`, no `process`/`Buffer`).
- Unit:
  - `src/internal/`: `LilypadBackoff.ts`, `LilypadTimeout.ts`, `LilypadValidation.ts` (+ their tests)
  - `src/flow/LilypadFlowControl.ts` (+ `LilypadFlowControl.test.ts`)
  - `src/platform/LilypadPlatform.ts` (+ `LilypadPlatform.test.ts`)
  - `src/singleton/LilypadSingleton.ts` (+ `LilypadSingleton.test.ts`)
  - `src/serializer/LilypadSerializer.ts` (+ `LilypadSerializer.test.ts`, which also holds `@ts-expect-error` type tests)
- Interfaces:
  - Exposes: `LilypadFlowControl`, `LilypadTimeoutError`, `LilypadRateLimitError` (entry `flow`); the platform types (entry `platform`, types only); the singleton functions and types (entry `singleton`); `LilypadSerializer` (entry `serializer`). Internal: `assertNumberOption`, `LILYPAD_MAX_TIMER_DELAY`, `withLilypadTimeout`, `LilypadBackoff`, `runInBackground`, `runAfterResponse`, `sharedStoreOperation`, `toTtlSeconds`.
  - Uses: nothing outside the unit.
  - Depended on by: the cache engine (flow control timeouts, platform, validation), `LilypadDbCache` (flow control, `createLilypadSingletonAbleAsync`), `LilypadDbGate` (singleton, backoff, validation), the logger (singleton, platform background), the changelog sync (backoff), `LilypadDiscordLogger` (validation).
- Out of scope, covered by other tasks: logger (`review-2026-09-30/020-logger`), cache engine and L2 (`review-2026-09-30/030-cache-engine`), public API design as a whole (`review-2026-09-30/080-architecture-api`), end-to-end security (`review-2026-09-30/090-security`), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `LilypadFlowControl.singleFlight` / `executeFn`: check that no `await` sits between the lookup of the in-flight promise and its registration on every path (`rateLimit` must stay synchronous), and that a rejected flight is removed from the map.
  - `LilypadFlowControl.rateLimit`: `rateMap` is pruned only when its size exceeds `RATE_MAP_PRUNE_THRESHOLD` (1000), at most once per `rate`. Check memory with many one-off keys and a large `rate`, and the behavior with `rate: 0`.
  - `executeWithRetries`: check retries vs attempts, and whether a timed-out attempt keeps running with its later rejection unhandled.
  - `withLilypadTimeout`: the operation keeps running after the timeout. Check that its later rejection is always observed.
  - `getLilypadSingletonInstanceAsync` / `createLilypadSingletonAbleAsync`: check a release after a failed creation, a release called twice, a release racing a new instance under the same key, and whether `checkSignature`'s stored signature is ever cleared (a singleton recreated with new options after `close()` would warn forever).
  - `LilypadSerializer`: the bijection is checked at the type level (`IsBijective`). Check runtime behavior for missing or extra keys, `__proto__`/`constructor` keys, and values that are not plain objects.
  - `runInBackground` / `runAfterResponse`: check a platform function that throws synchronously vs a task that rejects, and that `onPlatformError` never receives task errors. `toTtlSeconds`: rounding of small, zero or negative TTLs.
  - `LilypadBackoff`: overflow of the exponential delay, reset on `succeed()`.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run src/internal src/flow src/platform src/singleton src/serializer` (runs the `unit` and `edge` projects), `npx eslint src/internal src/flow src/platform src/singleton src/serializer --max-warnings 0`, `npm run typecheck`.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption, vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior). Flow control tests use fake timers (`withFakeTimers`).
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `FND-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this unit, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 010-foundations` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
