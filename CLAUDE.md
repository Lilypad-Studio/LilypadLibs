# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@lilypad/libs` is a TypeScript utility library (cache, Postgres gateway, logger, flow control, serializer, singleton helpers). It is published from `dist/`. Its only runtime dependency is `postgres` (porsager/postgres).

## Commands

- `npm run build`: tsup bundles the entries (`src/index.ts` and `src/entries/*.ts`) into `dist/`, as CJS and ESM, with `.d.ts`/`.d.mts` and sourcemaps.
- `npm test`: vitest projects `unit` and `edge`. `edge` runs the tests of the edge-compatible modules again in the `edge-runtime` environment. Watch mode in a TTY, so use `npm test -- --run` for a single pass.
- `npm run test:integration`: `*.integration.test.ts` files (vitest project `integration`). They start a PostgreSQL container with testcontainers, so **Docker must be running**. They are not part of `npm test` or of the pre-commit hook.
- Single file: `npx vitest run src/cache/LilypadCache.test.ts`
- Single test by name: `npx vitest run --project unit -t "should store and retrieve a value"`
- `npm run typecheck`: `tsc --noEmit`. It also checks the `@ts-expect-error` type tests in `LilypadSerializer.test.ts`, which vitest does not.
- `npm run lint`: runs `eslint --fix`, so it **modifies files**. Use `npx eslint . --max-warnings 0` to check without changing anything, as the hook does.

**Pre-commit hook** (`.husky/pre-commit`): runs unit tests, typecheck, `eslint --max-warnings 0` and the build, then `git add dist`. So `dist/` is committed and rebuilt on every commit, while lint fixes are **not** staged automatically: run `npm run lint` before committing.

Commit messages use conventional prefixes (`feat:`, `fix:`, `refactor:`, `chore:`).

## Architecture

### Public surface
- Each module has an entry in `src/entries/` (`logger`, `cache`, `flow`, `serializer`, `singleton`, `platform`, `db`), published as a subpath (`@lilypad/libs/logger`, ...). `src/index.ts` re-exports every entry. A new class or type must be exported from its entry, or it will not ship. An entry also needs its line in `tsup.config.ts` and in the `exports` of `package.json`.
- Exported classes keep the `Lilypad` prefix.
- **Edge compatibility**: every entry except `db` must not reach Node.js APIs (`node:*`) or `postgres`. `src/entries/entries.test.ts` follows the value imports of each entry and fails otherwise, and the `edge` vitest project runs their tests in an edge runtime. Use `globalThis.crypto` rather than `node:crypto`; `LilypadDbCache` lives in `db`, since it imports the gate.

### Path aliases
The only alias is `@/*` → `src/*`. It is defined in **two places that must stay in sync**: `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`.

### Construction and singleton pattern
`LilypadLogger`, `LilypadDbGate` and `LilypadDbCache` have **private constructors**. You create them through a static `create()`:
- It takes `LilypadSingletonAble` options: `{ singleton: true, singletonIdentifier }` or `{ singleton?: false }`.
- Singletons are stored in a map on `globalThis.__lilypadSingletonMap` (`src/singleton/LilypadSingleton.ts`), so they survive module reloads and duplicate bundles.
- The `create()` methods namespace the registry key with the class name (`LilypadDbGate:<id>`). They pass a signature (a hash of the relevant options), so that a later call with different options logs a warning. Signatures live in a separate map, `__lilypadSingletonSignatureMap`, so that older bundles sharing the registry can still read it.
- The async `create()` methods go through `createLilypadSingletonAbleAsync`, which passes the registry key to the factory. The instance stores that key, to remove itself from the registry on close/dispose.
- `LilypadDbGate.create` and `LilypadDbCache.create` are async (when they have listeners, with an eager `listen` strategy, they register their LISTEN before resolving) and use `getLilypadSingletonInstanceAsync`. Without listeners they open no connection, which keeps `next build` from reaching the database. That function caches the in-flight promise so concurrent callers share one initialization, and it evicts the promise if initialization fails.
- `LilypadDbGate.close()` and `LilypadDbCache.dispose()` remove the instance from the registry with `removeLilypadSingletonInstance`.
- `LilypadCache`, `LilypadFlowControl` and `LilypadSerializer` use plain `new`.

### Platform capabilities
`src/platform/LilypadPlatform.ts` declares what the library can use from a hosting platform, without depending on any: `background` (keep the instance alive for a promise: `waitUntil`/`after`), `afterResponse` (run work after the response), `shared` (a `LilypadSharedStore`: `get`/`set` with `ttl` in **seconds**/`delete`, a subset of the Vercel Runtime Cache) and `onInvalidate`. Never import `next/*` or `@vercel/*` in the library: `docs/nextjs-vercel.md` shows the adapter the application writes.
- `runInBackground` and `runAfterResponse` always attach an error handler, and fall back to running the work at once if the platform function throws (e.g. `after` outside a request).
- `sharedStoreOperation` bounds every shared store call with a timeout; a failure resolves to a fallback. The shared store is never required to answer.

### Logger
- `LilypadLogger<T>` creates one async method per channel name in `components` at runtime (for example `logger.info(...)`).
- `LilypadLoggerType<T>` is the class type intersected with those channel methods. Use it as the type for logger instances; do not use `LilypadLogger<T>` for this.
- Channel names that clash with a property of the logger (`components`, `register`, `__name`, `_name`, `constructor`, ...) are rejected.
- Non-string message parts are formatted with `util.inspect`, not `JSON.stringify`, so errors keep message and stack.
- Output sinks extend `LilypadLoggerComponent` and implement `send()`. See `logger/components/`.
- Every other module takes an optional logger typed `LilypadLibLogger` (= `LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>`).
- Messages are formatted by `formatLogValue` (edge-compatible, close to `util.inspect`). Components receive a `LilypadLogRecord` (`sendRecord`); the default `sendRecord` formats it and calls `send`. `LilypadJsonConsoleLogger` overrides `sendRecord`.
- `platform.background` receives every message being sent; `flush()` awaits the pending ones. `context()` is read synchronously when the message is logged.
- Channel methods return promises and are called fire-and-forget: write `void this.logger?.error(...)`. `@typescript-eslint/no-floating-promises` is an error, because an unhandled rejection terminates the Node.js process. For the same reason, channel methods must never reject: component errors (collected with `allSettled`) go to `errorLogging`, and if `errorLogging` fails the logger falls back to `console.error`.
- `LilypadDiscordLogger` queues messages and batches them (`minRequestInterval`). It retries a 429 response after `retry-after`.

### How the modules depend on each other
```
LilypadDbCache ──extends──> LilypadCache ──uses──> LilypadFlowControl
      │                                             (single-flight + timeout)
      └──uses──> LilypadDbGate (postgres.js, LISTEN/NOTIFY)
```
- **LilypadCache** is an in-memory, TTL-based cache with `string | number` keys (`LilypadCacheKey`).
  - Return values: `undefined` means not cached (or expired), and `null` means cached as "does not exist". Keep this distinction.
  - `getOrSet` deduplicates concurrent fetches with a `LilypadFlowControl` single-flight keyed per cache key. Only the fetch is shared: the error fallback (`errorReturn`) runs for each caller, outside the flight. A value resolved after the flow control timeout is not cached.
  - **Write ordering**: every entry carries a `ticket`. An async read takes `nextTicket()` when it starts, and stores its result with `setIfNewer`, which discards the result if a write that started later has already been stored. A plain `set` takes a new ticket. A completed bulk sync raises `ticketFloor`, so that older reads of missing keys are discarded too. Every new async write path must follow this pattern.
  - `bulkSync` has its own flow control (`bulkSyncTimeout`) and TTL (`bulkSyncExpirationTime`). It resolves to a boolean. Its errors are logged and swallowed, unless `throwOnError` is set. To force a sync, call `invalidateBulkSync()` instead of writing `bulkSyncExpirationTime`: it also stops a sync that is already running from marking itself fresh.
  - `get()` does not remove expired entries by default: the expired value is the fallback for `returnOldOnError`.
  - The store and the protected keys are keyed by `normalizeKey(key)`, the string form of the key. Each entry keeps the original key, which `bulkGet({})` returns. Internal iterations work on normalized keys (`deleteNormalized`, `expireNormalized`).
  - A disposed cache ignores every write (`disposed` flag), so that fetches still in flight cannot fill it again.
  - `getOrSet` is a wrapper of `getOrSetDetailed`, which returns `{ value, status, refreshFailed }`. Lookup order: L1 (memory) → L2 (`shared`, with `name` required) → stale value within `staleWhileRevalidate` (refreshed via `runAfterResponse`, one per key; a refresh that never starts stops blocking after 60 s) → fetch. During `failureCooldown`, the fetch is skipped and `errorReturn` runs with a `LilypadCacheCooldownError`.
  - Entries carry `fetchedAt` (age for L2 adoption) and `expirationTime`. `expire` sets `expirationTime` to `0`: an invalidated entry is never served stale, but stays a fallback for `returnOldOnError`.
  - L2 writes: public `set`/`bulkSet` and `storeFetched` (fetches) write L2; `setLocal` (fallbacks, `setNull`) and bulk syncs do not. `delete` and `invalidate` (via `markInvalid`) remove from L2; `clear`/`dispose` do not. L2 keys are `lilypad:<name>:<normalizedKey>` (`:failedAt`, `:lock` suffixes), values an envelope `{ lilypad: 1, value, fetchedAt, expiresAt }`.
  - `emitInvalidation(source, keys)` calls `platform.onInvalidate` in the background; the base class emits `manual` from `invalidate`.
  - Protected keys are not removed by `delete`/`clear` unless you pass `force`.
  - `expire(key)` is the synchronous part of `invalidate`. Base-class code must call `expire`, never `invalidate`, because `LilypadDbCache` overrides `invalidate` with an async method that queries the database.
- **LilypadDbCache** is a `LilypadCache` backed by one table described by a `LilypadDbSchema<V>`.
  - Its `bulkSyncFn` loads the whole table.
  - `invalidate` is overridden to re-fetch the row. It is async here, unlike the base class.
  - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database, then cache the row returned by the database (`RETURNING *`), so generated primary keys work. Deletions are cached with `set(key, null)`, not with `delete(..., { setNull })`, so that they also apply to protected keys.
  - The `sync` option chooses how external changes arrive: `listen` (default; `connect: 'lazy'` defers LISTEN to the first read), `changelog` or `none`. The deprecated `useDefaultDbListener`/`defaultListenerOptions` map to it. `syncBeforeRead()` runs before `getOrSetDetailed`/`getAll`; it returns `undefined` when there is nothing to wait for, so that reads stay synchronous up to the fetch registration.
  - **Changelog** (`src/dbGate/LilypadChangelog.ts`): a trigger writes `(xid, table_name, row_id, op)` rows; `readLilypadChanges` returns the rows with `xid >= cursor`, where the cursor is `pg_snapshot_xmin` of the previous read, so out-of-order commits are never missed. Rows can come back again: `appliedChanges` skips ids already applied. Without a trusted cursor (first read, or more than `maxGap` since the last one) it reads a time `lookback` and expires every entry. Changelog changes are applied lazily (`markInvalid`), notifications eagerly (`refreshKey`). The trigger records `TG_TABLE_SCHEMA` too (`table_schema`, `schema` in the payload), and the reader resolves the table with `to_regclass`; rows without a schema (version 1) match any schema. The trigger function carries its version in its comment (`LILYPAD_CHANGELOG_VERSION`): bump it when the generated SQL changes.
  - **Schema check** (`src/dbGate/LilypadSchemaCheck.ts`): `checkLilypadSchema` reads the catalogs only. The cache runs it once per instance (`sync.verify`): `warn` before LISTEN (it resolves the schema used to filter notifications) or in the background with the first changelog read; `throw` in `create`. The unit tests mock it, as they mock `readLilypadChanges`.
  - With the `listen` strategy, it registers a listener on the Postgres channel **`cache_events`**, with a `callbackId` that includes the instance id. The listener expects JSON payloads `{ table, id, op: 'INSERT'|'UPDATE'|'DELETE' }`, where `id` is a string or a number. INSERT and UPDATE re-fetch only the keys that are cached or being fetched; for any other key they only invalidate the bulk sync. On `onReconnect`, every entry is expired. The database-side trigger that sends these payloads is not part of the library; `LilypadDbGate.integration.test.ts` contains a reference implementation.
- **LilypadDbGate** wraps postgres.js.
  - The main `sql` client uses `prepare: false`. Keep it that way; it was deliberately removed in a recent commit. The `statementTimeout` option sets Postgres `statement_timeout` on this client.
  - Do not cancel queries with the postgres.js `.cancel()`: in 3.4.x it drops the promise of the cancel request, so a failed cancel connection becomes an unhandled rejection.
  - LISTEN uses a separate single dedicated connection (`listenerConnectionString`, which defaults to `connectionString`).
  - Callbacks are grouped by channel and keyed by `callbackId`, so re-adding the same id replaces the old callback. Callbacks may be async: their errors are caught and logged. `removeListener` UNLISTENs the channel when its last callback is removed.
  - postgres.js calls `onlisten` on the first LISTEN and again after every reconnection. From the second call on, the gate runs the optional `onReconnect` of each callback.
  - The CRUD helpers are generic over `LilypadDbSchema<T, PK>` (`PK` defaults to `keyof T`). Rows are mapped to `T` with `selectSanitizationFn`, or by copying the `cols` keys. Writes go through `insertSanitizationFn`, whose result **replaces** the data, so it can remove properties.
  - Only the `cols` keys are selected (unless there is a `selectSanitizationFn`) and written: extra properties of the data are dropped on purpose, to prevent mass assignment. `undefined` values are not written.
  - `selectAllFromTable` reads through a cursor, in batches of 1000 rows.

### Tests
Tests live next to the sources as `*.test.ts`.
- `LilypadDbCache.test.ts` uses an in-memory fake of `LilypadDbGate`, and mocks `readLilypadChanges`.
- `LilypadCache.shared.test.ts` covers L2, stale-while-revalidate and the cooldown with an in-memory fake store that clones values.
- `LilypadDbGate` is covered by the integration tests, which run against a real PostgreSQL (including the changelog and its out-of-order commit test), and by `LilypadDbGate.test.ts` for what needs no database (pool options, no connection on create).
- The flow control tests use fake timers (`withFakeTimers` helper). The cache tests all run on fake timers (`vi.advanceTimersByTimeAsync`).
