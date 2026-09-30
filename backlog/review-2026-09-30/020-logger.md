# Review the logger

## Goal

Review the logger as a senior reviewer/refactorer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 020-logger`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md` (section "Logger").
- Baseline: commit `a3cfaf4`. If the unit changed since (`git diff a3cfaf4 --stat -- src/logger`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible (no `node:*`, no `process`/`Buffer`).
- Unit: `src/logger/`, i.e. `LilypadLogger.ts`, `LilypadLibLogger.ts`, `LilypadLoggerComponent.ts`, `formatLogValue.ts`, `components/ConsoleLogger.ts`, `components/JsonConsoleLogger.ts`, `components/DiscordLogger.ts`, and their tests (`LilypadLogger.test.ts`, `LilypadLibLogger.test.ts`, `formatLogValue.test.ts`, `components/LoggerComponents.test.ts`).
- Interfaces:
  - Exposes (entry `logger`, see `src/entries/logger.ts`): `LilypadLogger`, `LilypadLoggerType`, `LilypadLoggerConstructorOptions`, `lilypadPinoLogger`, the `LilypadLibLogger` types, `LilypadLoggerComponent`, `LilypadLogRecord`, `LILYPAD_DEFAULT_REDACTED_KEYS`, `toLogJson`, `LilypadConsoleLogger`, `LilypadJsonConsoleLogger`, `LilypadDiscordLogger`. Internal: `libLog`, `formatLogValue`, `safeJson`.
  - Uses: `createLilypadSingletonAble` (`src/singleton/`), the platform `background` (`src/platform/`), `assertNumberOption` (`src/internal/`).
  - Depended on by: every other module, through `libLog(logger, level, source, message, detail?)` and the `LilypadLibLogger` type.
- Out of scope, covered by other tasks: singleton, platform and validation internals (`review-2026-09-30/010-foundations`), public API design as a whole (`review-2026-09-30/080-architecture-api`), secrets end-to-end (`review-2026-09-30/090-security`: here, only check that redaction does what it claims), tests/build/CI (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - `formatLogValue.ts` `walk`: cycles are detected through the ancestors only, so an object shared many times (a DAG) is walked each time. Check time and output size on wide DAGs, especially in `toLogJson` (depth 64).
  - "Neither ever throws": check throwing getters, Proxies, a `toJSON` that throws or returns cyclic data, objects with a null prototype, huge strings and arrays.
  - Redaction: keys compared ignoring case, `-` and `_`; `record.parts` stay raw. Check what escapes it: `Map` keys, arrays of pairs, error messages and URLs containing credentials.
  - `LilypadLogger`: the list of channel names that clash with a property (`then`, `constructor`, ...). Check it against every member of the class and of `Object.prototype`.
  - `flush()`: messages logged during a flush, an `errorLogging` that throws synchronously or rejects, and the `console.error` fallback.
  - `LilypadDiscordLogger`: `retry-after` parsing (seconds vs milliseconds, header vs body), the 30 s limit, `maxQueueSize` drops announced in the next batch, Discord's 2000-character message limit, and a `fetch` without a timeout that could block the queue forever.
  - `libLog` / `lilypadPinoLogger`: sync throws and async rejections of custom loggers, argument order for pino.

## Instructions

Objectives, in priority order:

1. Runtime robustness: bugs, edge cases, error handling, inconsistent state, race conditions.
2. Meaningful design improvement. Breaking changes to the API or architecture are welcome when they really simplify or improve the code without removing functionality, within the compatibility constraints above. "Stable" means the code doesn't break, not that the API stays frozen.

Categories: correctness, error handling, security, performance, API design and consistency, DRY, readability, missing tests.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run src/logger` (runs the `unit` and `edge` projects), `npx eslint src/logger --max-warnings 0`, `npm run typecheck`.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: real bugs, data loss or corruption, vulnerabilities, crashes (an unhandled rejection terminates the Node.js process: it counts as a crash)
  - `recommended`: fragile design, significant duplication, avoidable performance cost, critical tests missing
  - `minor`: readability, naming, style
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- DRY, but no abstraction for two similar occurrences or for code bound to diverge.
- Missing tests: name the specific cases (input, expected behavior).
- Group `minor` findings of the same kind into one entry.
- If the unit is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `LOG-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration.
4. Tests to add.
5. Impact on other units: findings or proposed changes that touch code outside this unit, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 020-logger` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
