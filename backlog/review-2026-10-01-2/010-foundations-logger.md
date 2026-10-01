# Lite review the foundation modules and the logger

## Goal

Check the foundation modules and the logger for severe problems only, as a guardrail that tells whether more review rounds are worth it, report them in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.8.0 (released; no pending changeset), Lilypad Studio's internal TypeScript library, published to GitHub Packages for the studio's own apps (audience: the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js ^3.4.9 (optional peer; PostgreSQL 16+), a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. This is a lite pass after two full reviews (`review-2026-09-30`, `review-2026-10-01`) whose fixes all landed. The code those fixes added (`git log --oneline 6f58e9b..157e3a2 -- <unit paths>`) and the features merged after them (`18ac82b`, `e1641fd`, `3c44669`) were never reviewed: start there. Repo rules: `CLAUDE.md`; per-module invariants: `docs/architecture.md`.
- Baseline: commit `157e3a2`. If the unit changed since (`git diff 157e3a2 --stat -- src/internal src/flow src/serializer src/singleton src/platform src/logger src/entries src/index.ts`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when the smallest fix of a blocker needs one, each recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (now 9, `src/dbGate/LilypadChangelog.ts`); an older install is then an `outdated-changelog` error of the schema check, fixed by the fix SQL of `lilypad-doctor` (say so in the migration). L2 entries (`lilypad:2:` keys): any change bumps `SHARED_FORMAT_VERSION` (`src/cache/LilypadSharedLevel.ts`). Singleton registry: an instance change another copy of the library could not use bumps `SINGLETON_REGISTRY_VERSION` (`src/singleton/LilypadSingleton.ts`). Every entry except `db` stays edge-compatible. Fixed rules: the main `sql` client keeps `prepare: false`; never cancel queries with the postgres.js `.cancel()`.
- Unit: `src/internal/`, `src/flow/`, `src/serializer/`, `src/singleton/`, `src/platform/`, `src/logger/` (with `components/`), `src/entries/`, `src/index.ts` (about 2,690 source lines), with their `*.test.ts` (including `src/internal/edgeEnvironment.test.ts` and `src/entries/entries.test.ts`).
- Interfaces: exposes the entries `flow` (`LilypadFlowControl`, `LilypadTimeoutError`, `LilypadRateLimitError`), `serializer` (`LilypadSerializer`), `singleton`, `platform` (types only), `logger` (`LilypadLogger`, `LilypadLoggerComponent`, `LilypadConsoleLogger`, `LilypadJsonConsoleLogger`, `LilypadDiscordLogger`, `lilypadPinoLogger`, `toLogJson`, `LILYPAD_DEFAULT_REDACTED_KEYS`), the root entry `src/index.ts` (every entry except `db`) and the re-export lists of `cache`, `schema` and `db`; internally `LilypadBackoff`, `withLilypadTimeout`, `assertNumberOption`, `LilypadDisposedError`, `createLilypadSingletonAble(Async)`, `runInBackground`, `runAfterResponse`, `sharedStoreOperation`, `toTtlSeconds`, `libLog`. Uses nothing outside these folders, except the entries, which re-export the other modules. Depended on by every other module: the cache engine (flow control, platform helpers), the gate and the database cache (singleton, backoff, `libLog`).
- Out of scope, covered by other tasks: how the cache engine uses these helpers (`review-2026-10-01-2/020-cache-engine`), secrets and redaction in logs as a trust boundary (`review-2026-10-01-2/070-security`: here, report local bugs), contracts between modules (`review-2026-10-01-2/900-integration`). The entries are only checked here as files: what each entry should export is not a blocker topic.
- Leads to verify (hints from a quick survey, not conclusions):
  - `LilypadLogger.flush()` (rewritten in `af9d517`) waits only for the messages logged before the call, and still for those `errorLogging` logs synchronously about a failure: check that no sequence (a component that fails during the flush, a log from a component, `flush()` called from a component, `dispose()` during a flush) makes it hang or never settle.
  - `LilypadLogger.dispose()` and `[Symbol.asyncDispose]` (`f25ca15`) release the singleton entry: a logger used after `dispose()`, and `LilypadLogger.create` with the same options while the disposed one is still flushing. Channel methods must never throw nor reject in the background (`CLAUDE.md`).
  - `formatLogValue.ts` (about 100 lines changed in `af9d517`): errors whose `name`, `message` or `stack` getters throw, Proxies, typed arrays printed by index, `cause` redaction. Check that no value can make a channel method throw, and that the output budget still bounds cyclic, deep or huge values.
  - `withLilypadTimeout` rejects before aborting (`79dde27`): the timer cleared on every path, an operation that settles synchronously.
  - `LilypadFlowControl.executeFn` now checks timeout and retries before the rate limit (`79dde27`): an invalid per-call option must reject without consuming a rate-limit slot or leaving a single-flight entry that later calls join.
  - `runAfterResponse` runs the work once when the platform's `afterResponse` throws (`79dde27`): check a function that throws after scheduling the work cannot run it twice.
  - `LilypadSerializer` rejects a key mapped to a union of targets (`79dde27`): check that a valid mapping is not rejected, and that a key such as `__proto__` cannot corrupt the maps.
  - `DiscordLogger`: its queue is bounded and a webhook failure (429, network error) cannot loop, throw out of a channel method or grow memory without limit.
- Fix tasks folder: `backlog/review-2026-10-01-2-fixes/010-foundations-logger/`. Task format: `backlog/README.md`.

## Instructions

Lite review: report only `blocker` findings. A blocker has a realistic trigger (an input, sequence or environment that can actually occur in this project's use) and a severe consequence: crash or hang, wrong results, data loss or corruption, an exploitable vulnerability, a build or release that breaks. Everything else is ignored, even when real: fragile design, duplication, performance short of a failure, missing tests, readability. Don't report it, count it or queue it.

- In doubt about the severity: leave it out. In doubt about whether it happens: report it `suspected`, with the trigger and what would confirm it.
- A fix is the smallest change that removes the problem, not a redesign.

Read every file of the unit in full. Read other units only as far as needed to understand an interface. Run the tests and linters that cover this unit if you can: `npx vitest run --project unit --project edge src/internal src/flow src/serializer src/singleton src/platform src/logger src/entries`, `npx eslint src/internal src/flow src/serializer src/singleton src/platform src/logger src/entries src/index.ts --max-warnings 0`, `npm run typecheck`. Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to in the code: file, function or class, line, relevant snippet. Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` (reproduced, or evident from the code) or `suspected` (say what would confirm it).
- A concrete fix for every finding: a minimal patch or snippet. Don't rewrite code that is fine.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Tests to add: for each finding, the test that reproduces it (input, expected behavior).
- If the unit is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `FND-<n>`:

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
- `depends-on: [review-2026-10-01-2/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a code location and a fix.
- Every finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the unit, its tests, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
