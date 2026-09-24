# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@lilypad/libs` is a TypeScript utility library (cache, Postgres gateway, logger, flow control, serializer, singleton helpers). It is published from `dist/`. Its only runtime dependency is `postgres` (porsager/postgres).

## Commands

- `npm run build`: tsup bundles `src/index.ts` into `dist/` (CJS + `.d.ts` + sourcemaps).
- `npm test`: unit tests (vitest project `unit`). Watch mode in a TTY, so use `npm test -- --run` for a single pass.
- `npm run test:integration`: `*.integration.test.ts` files (vitest project `integration`). They start a PostgreSQL container with testcontainers, so **Docker must be running**. They are not part of `npm test` or of the pre-commit hook.
- Single file: `npx vitest run src/cache/LilypadCache.test.ts`
- Single test by name: `npx vitest run --project unit -t "should store and retrieve a value"`
- `npm run typecheck`: `tsc --noEmit`. It also checks the `@ts-expect-error` type tests in `LilypadSerializer.test.ts`, which vitest does not.
- `npm run lint`: runs `eslint --fix`, so it **modifies files**. Use `npx eslint . --max-warnings 0` to check without changing anything, as the hook does.

**Pre-commit hook** (`.husky/pre-commit`): runs unit tests, typecheck, `eslint --max-warnings 0` and the build, then `git add dist`. So `dist/` is committed and rebuilt on every commit, while lint fixes are **not** staged automatically: run `npm run lint` before committing.

Commit messages use conventional prefixes (`feat:`, `fix:`, `refactor:`, `chore:`).

## Architecture

### Public surface
`src/index.ts` is the only tsup entry point. A new class or type must be exported there, or it will not ship. Exported classes keep the `Lilypad` prefix.

### Path aliases
The only alias is `@/*` → `src/*`. It is defined in **two places that must stay in sync**: `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`.

### Construction and singleton pattern
`LilypadLogger`, `LilypadDbGate` and `LilypadDbCache` have **private constructors**. You create them through a static `create()`:
- It takes `LilypadSingletonAble` options: `{ singleton: true, singletonIdentifier }` or `{ singleton?: false }`.
- Singletons are stored in a map on `globalThis.__lilypadSingletonMap` (`src/singleton/LilypadSingleton.ts`), so they survive module reloads and duplicate bundles.
- `LilypadDbGate.create` and `LilypadDbCache.create` are async (they register their LISTEN before resolving) and use `getLilypadSingletonInstanceAsync`. That function caches the in-flight promise so concurrent callers share one initialization, and it evicts the promise if initialization fails.
- `LilypadDbGate.close()` and `LilypadDbCache.dispose()` remove the instance from the registry with `removeLilypadSingletonInstance`.
- `LilypadCache`, `LilypadFlowControl` and `LilypadSerializer` use plain `new`.

### Logger
- `LilypadLogger<T>` creates one async method per channel name in `components` at runtime (for example `logger.info(...)`).
- `LilypadLoggerType<T>` is the class type intersected with those channel methods. Use it as the type for logger instances; do not use `LilypadLogger<T>` for this.
- Channel names that clash with a property of the logger (`components`, `register`, `__name`, `_name`, `constructor`, ...) are rejected.
- Non-string message parts are formatted with `util.inspect`, not `JSON.stringify`, so errors keep message and stack.
- Output sinks extend `LilypadLoggerComponent` and implement `send()`. See `logger/components/`.
- Every other module takes an optional logger typed `LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>`.
- Channel methods return promises and are called fire-and-forget: write `void this.logger?.error(...)`. `@typescript-eslint/no-floating-promises` is an error, because an unhandled rejection terminates the Node.js process.

### How the modules depend on each other
```
LilypadDbCache ──extends──> LilypadCache ──uses──> LilypadFlowControl
      │                                             (single-flight + timeout)
      └──uses──> LilypadDbGate (postgres.js, LISTEN/NOTIFY)
```
- **LilypadCache** is an in-memory, TTL-based cache keyed by strings.
  - Return values: `undefined` means not cached (or expired), and `null` means cached as "does not exist". Keep this distinction.
  - `getOrSet` deduplicates concurrent fetches with a `LilypadFlowControl` single-flight keyed per cache key. A value resolved after the flow control timeout is not cached.
  - `bulkSync` has its own flow control and TTL (`bulkSyncExpirationTime`). Its errors are logged and swallowed.
  - `get()` does not remove expired entries by default: the expired value is the fallback for `returnOldOnError`.
  - Keys can be non-strings at runtime (numeric primary keys): every access to the store or to the protected keys goes through `normalizeKey`.
  - Protected keys are not removed by `delete`/`clear` unless you pass `force`.
  - `expire(key)` is the synchronous part of `invalidate`. Base-class code must call `expire`, never `invalidate`, because `LilypadDbCache` overrides `invalidate` with an async method that queries the database.
- **LilypadDbCache** is a `LilypadCache` backed by one table described by a `LilypadDbSchema<V>`.
  - Its `bulkSyncFn` loads the whole table.
  - `invalidate` is overridden to re-fetch the row. It is async here, unlike the base class.
  - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the row returned by the database (`RETURNING *`), so generated primary keys work.
  - By default it registers a listener on the Postgres channel **`cache_events`**, with a `callbackId` that includes the instance id. The listener expects JSON payloads `{ table, id, op: 'INSERT'|'UPDATE'|'DELETE' }`. The database-side trigger that sends these payloads is not part of the library; `LilypadDbGate.integration.test.ts` contains a reference implementation.
- **LilypadDbGate** wraps postgres.js.
  - The main `sql` client uses `prepare: false`. Keep it that way; it was deliberately removed in a recent commit.
  - LISTEN uses a separate single dedicated connection (`listenerConnectionString`, which defaults to `connectionString`).
  - Callbacks are grouped by channel and keyed by `callbackId`, so re-adding the same id replaces the old callback. Callbacks may be async: their errors are caught and logged. `removeListener` UNLISTENs the channel when its last callback is removed.
  - The CRUD helpers are generic over `LilypadDbSchema<T>`. Rows are mapped to `T` with `selectSanitizationFn`, or by copying the `cols` keys. Writes go through `insertSanitizationFn`.
  - Only the `cols` keys are selected (unless there is a `selectSanitizationFn`) and written: extra properties of the data are dropped on purpose, to prevent mass assignment.

### Tests
Tests live next to the sources as `*.test.ts`.
- `LilypadDbCache.test.ts` uses an in-memory fake of `LilypadDbGate`.
- `LilypadDbGate` is covered only by the integration tests, which run against a real PostgreSQL.
- The flow control tests use fake timers (`withFakeTimers` helper). Many cache tests still wait on real `setTimeout`.
