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

Unit unchanged since `a3cfaf4` (`git diff a3cfaf4 --stat` on the five folders is empty).

**Status: all findings (FND-1 to FND-9) and the tests listed below were applied on 2026-09-30, in the commit after this report (changeset `.changeset/foundations-robustness.md`, with the three proposed breaking changes plus two smaller ones as `#### Upgrading` rows). The synthesis should list them under "Not planned" as already fixed, not as tasks. Choices made while fixing: `toTtlSeconds` maps a non-finite value to 1; `LilypadBackoff.ready()`/`fail()` no longer take a `now` argument (they read `performance.now()`); the singleton key format is `lilypadSingletonRegistryKey(namespace, id)` = `<namespace>@1:<id>`. Still open, for `060-db-cache`: `LilypadChangelogSync.beforeRead` compares `Date.now()` with `lastRead` (a wall-clock `readAt`) for `pollInterval`.**

#### Summary

The foundations are sound on the points that matter most. `singleFlight`/`executeFn` register the flight with no `await` between the lookup and the `set` (`rateLimit` is synchronous), and a rejected flight is removed by `finally` with an identity check. `withLilypadTimeout` observes the late rejection of a timed-out operation, because `Promise.race` subscribes to it, and it always clears its timer. The singleton release is idempotent and identity-guarded against a newer instance, and a failed async creation is forgotten without touching a newer entry. The stored signature is cleared both by `removeLilypadSingletonInstance` and by each new creation, so the "warns forever after `close()`" lead is a false positive. The weak spots are input and clock edges. The per-call `retries` is never validated, so `NaN` retries for weeks (reproduced). Rate limiting and `LilypadBackoff` use the wall clock, so a backward step locks keys out and stalls reconnects (reproduced). `runInBackground` turns a throwing `onError` into an unhandled rejection (latent). A few numeric helpers return `NaN` on degenerate input.

Top 3 actions:

1. Validate the effective `retries` in `executeWithRetries` (FND-1).
2. Measure rate-limit and backoff intervals with a monotonic clock (`performance.now()`) (FND-2).
3. Guard `onError` in `runInBackground`/`runAfterResponse`, and add the missing tests (`toTtlSeconds`, late rejection after a timeout, `runAfterResponse` without `afterResponse`) (FND-3, Tests).

#### Findings

**FND-1** · recommended · confirmed (reproduced)

- Location: `src/flow/LilypadFlowControl.ts`, `executeWithRetries`:
  ```ts
  if (
    attempts >= (options.retries ?? this.retries ?? 0) ||
  ```
- Problem: the constructor validates the instance `retries` (`non-negative-integer`), but the per-call `retries` of `executeWithRetries` and `executeFn` is never validated. `NaN` makes `attempts >= NaN` always false, so the operation is retried with the uncapped default backoff until attempt 25. There `2^25 * 100` ms fails the `backOffTime` check, so the caller waits about 39 days and gets a validation error instead of the operation's error. Reproduced: 12 calls after 10 minutes, then 25 calls and `backOffTime must be ... (got 3355443200)`. A fractional value such as `1.5` gives 2 retries, and a negative one silently gives 0. `NaN` comes easily from `Number(process.env.X)`.
- Fix:
  ```ts
  const retries = options.retries ?? this.retries ?? 0;
  assertNumberOption('LilypadFlowControl', 'retries', retries, 'non-negative-integer');
  let attempts = 0;
  while (true) {
    try {
      return await options.executionFn();
    } catch (error) {
      if (attempts >= retries || options.shouldRetry?.(error, attempts + 1) === false) {
        throw error;
      }
  ```
  The check runs before the first attempt, so `fn` is never called with an invalid option. `executeFn` gets it through `executeWithRetries`.

**FND-2** · recommended · confirmed (reproduced for `rateLimit`, evident for `LilypadBackoff`)

- Location: `src/flow/LilypadFlowControl.ts`, `rateLimit` (`const now = Date.now(); const lastExecution = this.rateMap.get(rateKey) ?? 0; if (now - lastExecution < this.rate)`), and `src/internal/LilypadBackoff.ts`, `ready(now: number = Date.now())` / `fail(now: number = Date.now())`.
- Problem: both measure intervals with the wall clock. When the clock steps back (an NTP correction or a VM resume), `now - lastExecution` is negative and stays below `rate`, so every recorded key is refused until the clock catches up. Reproduced: a 1 h step back refuses a `rate: 1000` key 5 s later. `pruneRateMap` never removes those entries either. `LilypadBackoff` is worse: after a failure `retryAt` lies in the future by the size of the step, so `ready()` stays false. The LISTEN reconnect, the changelog read and the gate heartbeat stop retrying for up to that long, and the cache goes stale meanwhile.
- Fix: use a monotonic clock. `performance.now()` exists in Node.js and in edge runtimes, and is typed by the `webworker` lib. It starts near 0, so the `?? 0` default must go: it would refuse a first call made within `rate` ms of startup (reproduced with the clock at 500 ms).
  ```ts
  const now = performance.now();
  const lastExecution = this.rateMap.get(rateKey);
  if (lastExecution !== undefined && now - lastExecution < this.rate) {
    throw new LilypadRateLimitError(rateKey);
  }
  ```
  In `LilypadBackoff`, use `performance.now()` for the defaults and start `retryAt` at `-Infinity` (in the field initializer and in `succeed()`). The callers that pass `Date.now()` must switch too (see Impact). `vi.useFakeTimers()` fakes `performance` by default in the installed vitest 5.0.2, so the existing fake-timer tests should keep working: run them to confirm.

**FND-3** · recommended · confirmed (latent: no current caller triggers it)

- Location: `src/platform/LilypadPlatform.ts`, `runInBackground`: `const handled = task.catch(onError);`. Also `runAfterResponse`: `platform.afterResponse(() => work().catch(onError));`.
- Problem: if `onError` throws, `handled` rejects. With no `platform.background`, nothing observes it: that is an unhandled rejection, which terminates the process. The contract ("its errors ... never become unhandled rejections") depends on every caller passing a handler that cannot throw. Today every caller does (`() => {}`, or `libLog`, which catches), but the helper does not enforce it.
- Fix:
  ```ts
  const handled = task.catch((error: unknown) => {
    try {
      onError(error);
    } catch {
      // The error handler must not turn the task into an unhandled rejection
    }
  });
  ```
  Put the same guard in the `afterResponse` callback, through a small `safeHandler(onError)` shared by both.

**FND-4** · recommended · suspected (confirm by loading two versions of the package in one process)

- Location: `src/singleton/LilypadSingleton.ts`: `const singletonMap = (globalThis.__lilypadSingletonMap ??= new Map<string, unknown>());` and `registryKeyOf`: `` `${namespace}:${options.singleton}` ``.
- Problem: the registry lives on `globalThis`, which is shared on purpose ("so that bundles of older versions sharing the registry still read it"), and its keys carry no version. Suppose an app has two versions of the library, one direct and one through another internal package. `LilypadDbGate.create({ singleton: 'main' })` from one version can then return the other version's gate, whose methods and options may differ. Nothing warns: the signature compares only options.
- Fix: add a registry version to the key, bumped whenever an instance's shape changes incompatibly. For example `` const REGISTRY_VERSION = 1; ... `${namespace}@${REGISTRY_VERSION}:${options.singleton}` ``. This keeps sharing across compatible copies (HMR, duplicated installs of one major) and separates incompatible ones. See Proposed breaking changes.

**FND-5** · minor · confirmed

- Location: `src/flow/LilypadFlowControl.ts`, `executeWithRetries`:
  ```ts
  : Math.pow(2, attempts) * 100; // Exponential backoff
  assertNumberOption('LilypadFlowControl', 'backOffTime', backoffTimeValue, 'non-negative-delay');
  ```
- Problem: the default backoff has no cap, unlike `LilypadBackoff` (60 s). When the backoff check fails, whether from that overflow or from a user `backOffTime` that returns `NaN`, the validation error replaces the operation's error, which is lost.
- Fix: cap the default at `Math.min(2 ** attempts * 100, 30_000)`, and keep the failure as `cause`:
  ```ts
  try {
    assertNumberOption('LilypadFlowControl', 'backOffTime', backoffTimeValue, 'non-negative-delay');
  } catch (invalid) {
    throw new Error((invalid as Error).message, { cause: error });
  }
  ```
  The message stays the same, so the existing test still matches.

**FND-6** · minor · confirmed: numeric edge cases in helpers (reproduced)

- `LilypadFlowControl.rateLimit` with `rate: 0` limits nothing, yet records every key and scans the map once it passes 1000 entries. Fix: `if (!this.rate) return;` in place of `if (this.rate !== undefined)`.
- `LilypadBackoff.fail`: `base * 2 ** (this.failures - 1)` is `0 * Infinity = NaN` once `failures > 1024` with a zero base. `retryAt` then becomes `NaN` and `ready()` is false forever (reproduced after 1100 failures). The current bases are ≥ 1000, so it is latent. Fix: `base * 2 ** Math.min(this.failures - 1, 30)`.
- `toTtlSeconds` (`src/platform/LilypadPlatform.ts`): `Math.max(1, Math.ceil(ms / 1000))` returns `NaN` for `NaN` and `Infinity` for `Infinity` (reproduced), and passes it as the shared store `ttl`. The option TTLs are validated as finite; see Impact for the other paths. Fix: `return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : 1;`, or throw, so that a bad value never reaches the store.

**FND-7** · minor · confirmed (reproduced)

- Location: `src/serializer/LilypadSerializer.ts`, `serialize`: `packedItem[toKey] = value as TO[typeof toKey];`, and `deserialize`: `unpackedItem[fromKey] = ...`.
- Problem: a `target` or source key named `__proto__` sets the prototype of the fresh object instead of an own property. The value is dropped by `JSON.stringify` (reproduced: `[{}]`) and by `Object.keys`. The pollution stays local to one object and the keys are developer constants, so this is data loss, not a vulnerability.
- Fix: reject it in the constructor:
  ```ts
  for (const [fromKey, { target }] of Object.entries(options.serialization)) {
    if (fromKey === '__proto__' || target === '__proto__') {
      throw new Error('LilypadSerializer: "__proto__" cannot be a key.');
    }
  }
  ```

**FND-8** · minor · confirmed: serializer readability

- `serialize` looks up `this.options.serialization[fromKey]` four times per key per item and builds a new equality closure each time. Fix: precompute `private readonly fields = Object.entries(options.serialization)` in the constructor, and loop over `for (const [fromKey, field] of this.fields)`.
- `private options` is never reassigned: make it `private readonly options`.
- `cloneDefault` uses `structuredClone`: a class-instance default is deserialized as a plain object, and a default holding a function throws `DataCloneError`. Fix: say so in the class `@remarks` (defaults must be structured-cloneable).

**FND-9** · minor · confirmed: error details

- `LilypadRateLimitError` keeps the key only in its message: add `readonly rateKey: string`, as `LilypadTimeoutError` does with `timeout`.
- `assertNumberOption` throws a plain `Error`: a `RangeError` would let callers tell a bad option from an operation failure (the message stays the same).

#### Proposed breaking changes

- **Per-call `retries` is validated (FND-1).** What: `executeWithRetries`/`executeFn` reject `NaN`, negative, fractional and infinite `retries` before the first attempt. Why: `NaN` currently means retrying for weeks. Impact: only calls that pass an invalid value, which today are silently clamped (negative) or rounded up (fractional). Migration: pass a non-negative integer. Changeset `#### Upgrading` row.
- **Versioned singleton registry keys (FND-4).** What: keys become `<namespace>@<REGISTRY_VERSION>:<singleton>`. Why: an incompatible copy of the library must not receive another copy's instance. Impact: two copies with different registry versions in one process each create their own singleton (for example two gates, so two pools). Migration: none in code; deduplicate the dependency if one shared instance is required. Changeset `#### Upgrading` row.
- **`__proto__` refused as a serializer key (FND-7).** What: the constructor throws. Impact: only mappings that already lose that field. Migration: rename the key.

#### Tests to add

- `executeWithRetries` and `executeFn` with `retries: NaN`, `-1`, `1.5`, `Infinity`: reject with `retries must be`, and `fn` is not called.
- `executeWithTimeout` where `fn` ignores the signal and rejects 10 ms after the timeout: rejects with `LilypadTimeoutError`, and advancing the timers past the late rejection raises no unhandled rejection (vitest fails the run on one).
- `executeFn` with `timeout` and `retries: 1` where the first attempt never settles: the first attempt's signal is aborted, the second attempt runs after the backoff, and its result is returned.
- `rateLimit` (after FND-2): a first call with the fake clock at `now: 0` is allowed, and a `vi.setSystemTime` step back by 1 h does not refuse a key whose `rate` has elapsed in monotonic time.
- `rateLimit` with `rate: 0`: no entry recorded (spy on `pruneRateMap` or check the map size).
- `LilypadBackoff`: base `0` stays ready after 2000 failures; after a success the next delay is the base again, including after a cap (the second part partly exists).
- `runInBackground`: an `onError` that throws, with no platform, gives no unhandled rejection. `runAfterResponse` without `afterResponse`: the work starts at once and is passed to `background`. A rejection of work handed to `afterResponse` reaches `onError`.
- `sharedStoreOperation`: an operation that rejects resolves to the fallback and calls `onError` once; an operation that rejects after the timeout raises no unhandled rejection.
- `toTtlSeconds` (untested today): `0 → 1`, `1 → 1`, `1000 → 1`, `1001 → 2`, `-5 → 1`, `NaN` gives the value chosen in FND-6.
- Singleton: after `release()`, a new creation with a different signature does not call `onMismatch` (locks in the verified behavior). A `release()` called by a partially built instance while its async creation fails leaves the registry empty.
- `LilypadSerializer`: a `__proto__` key throws in the constructor (after FND-7); extra input keys are dropped by `serialize`; a missing target key deserializes to a clone of the default.

#### Impact on other units

- FND-2: the `LilypadBackoff` callers pass `Date.now()` and must switch to the same monotonic clock (or pass nothing): `src/cache/dbSync/LilypadChangelogSync.ts` (`!this.backoff.ready(now)`, where the same `now` also drives `now - this.lastRead < this.options.pollInterval`, which has the same wall-clock issue), `src/cache/dbSync/LilypadListenSync.ts` (`this.backoff.ready(Date.now())`), and `src/dbGate/LilypadDbGate.ts` (`this.heartbeatBackoff.ready()`, which uses the default). The cache engine's own `Date.now()` intervals (`refreshing`, `STUCK_REFRESH_AFTER`, cooldowns) belong to `030-cache-engine`, but should follow the same decision.
- FND-6 (`toTtlSeconds`): its callers are in `src/cache/LilypadSharedLevel.ts` (`toTtlSeconds(lifetime)`, `toTtlSeconds(ttl)`, `toTtlSeconds(lockTtl)`). `030-cache-engine` should check whether a per-call TTL or a computed `lifetime` can be non-finite.
- FND-3: no caller change is needed. It hardens `src/cache/LilypadCacheEngine.ts`, `src/cache/LilypadSharedLevel.ts`, `src/cache/dbSync/LilypadChangelogSync.ts` and `src/logger/LilypadLogger.ts`.
- FND-4: the namespaced singletons `LilypadDbGate` (`src/dbGate/LilypadDbGate.ts`), `LilypadDbCache` (`src/cache/LilypadDbCache.ts`) and `LilypadLogger` (`src/logger/LilypadLogger.ts`); a public API question for `080-architecture-api`.

#### Checks run

- `npx vitest run src/internal src/flow src/platform src/singleton src/serializer`: 12 files, 228 tests passed (unit and edge).
- `npx eslint src/internal src/flow src/platform src/singleton src/serializer --max-warnings 0`: clean.
- `npm run typecheck`: passed (both tsconfigs).
- Reproductions: a temporary vitest file (deleted afterwards) confirmed FND-1 (`retries: NaN`), FND-2 (clock step back; first call at `now: 500`), FND-6 (`LilypadBackoff` base 0 → never ready; `toTtlSeconds(NaN)`/`(Infinity)`) and FND-7 (`__proto__` target serialized as `{}`).

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
