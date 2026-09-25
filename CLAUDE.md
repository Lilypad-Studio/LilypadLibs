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
- `npm run typecheck`: `tsc --noEmit` (with `noUncheckedIndexedAccess`). It also checks the `@ts-expect-error` type tests in `LilypadSerializer.test.ts`, which vitest does not.
- `npm run lint`: runs `eslint --fix`, so it **modifies files**. Use `npx eslint . --max-warnings 0` to check without changing anything, as the hook does.

**Pre-commit hook** (`.husky/pre-commit`): runs unit tests, typecheck, `eslint --max-warnings 0` and the build, then `git add dist`. So `dist/` is committed and rebuilt on every commit (the package is installed from git), while lint fixes are **not** staged automatically: run `npm run lint` before committing.

**CI** (`.github/workflows/ci.yml`): the same checks on Node.js 20 and 22, `git diff --exit-code -- dist` after the build, and the integration tests.

ESLint uses `recommended-type-checked`; the test files turn off `require-await`, `unbound-method` and the `no-unsafe-*` rules.

Commit messages use conventional prefixes (`feat:`, `fix:`, `refactor:`, `chore:`).

## Architecture

### Public surface
- Each module has an entry in `src/entries/` (`logger`, `cache`, `flow`, `serializer`, `singleton`, `platform`, `db`), published as a subpath (`@lilypad/libs/logger`, ...). `src/index.ts` re-exports every entry **except `db`**, so that the root entry never pulls in postgres.js. A new class or type must be exported from its entry, or it will not ship. An entry also needs its line in `tsup.config.ts` and in the `exports` of `package.json`.
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
- `LilypadCache` (`new LilypadCache({ ttl, ... })`), `LilypadFlowControl` and `LilypadSerializer` use plain `new`. `LilypadDbCache.create({ ttl, dbGate, ... })` takes the TTL in its options too.

### Platform capabilities
`src/platform/LilypadPlatform.ts` declares what the library can use from a hosting platform, without depending on any: `background` (keep the instance alive for a promise: `waitUntil`/`after`), `afterResponse` (run work after the response), `shared` (a `LilypadSharedStore`: `get`/`set` with `ttl` in **seconds**/`delete`, a subset of the Vercel Runtime Cache) and `onInvalidate`. Never import `next/*` or `@vercel/*` in the library: `docs/nextjs-vercel.md` shows the adapter the application writes.
- `runInBackground` and `runAfterResponse` always attach an error handler, and fall back to running the work at once if the platform function throws (e.g. `after` outside a request).
- `sharedStoreOperation` bounds every shared store call with a timeout; a failure resolves to a fallback. The shared store is never required to answer.

### Logger
- `LilypadLogger<T>` creates one async method per channel name in `components` at runtime (for example `logger.info(...)`). `T` defaults to `'error' | 'warn' | 'info' | 'debug'`.
- `LilypadLoggerType<T>` is the class type intersected with those channel methods. Use it as the type for logger instances; do not use `LilypadLogger<T>` for this.
- Channel names that clash with a property of the logger (`components`, `register`, `__name`, `_name`, `constructor`, ...) are rejected.
- Output sinks extend `LilypadLoggerComponent` and implement `send()`. See `logger/components/`.
- Every other module takes an optional logger typed `LilypadLibLogger` (`src/logger/LilypadLibLogger.ts`): any object with some of the methods `error`, `warn`, `info`, `debug` (a `LilypadLogger`, `console`, pino). Modules log only through `libLog(this.logger, 'error', this.name, ...)`, which skips missing levels and swallows throws and rejections. The first argument is the `name` of the instance.
- Messages are formatted by `formatLogValue` (edge-compatible, close to `util.inspect`: errors keep stack, own properties and `cause`; it never throws). Components receive a `LilypadLogRecord` (`sendRecord`); the default `sendRecord` formats it and calls `send`. `LilypadJsonConsoleLogger` overrides `sendRecord`.
- `platform.background` receives every message being sent; `flush()` awaits the pending ones. `context()` is read synchronously when the message is logged.
- Channel methods return promises and are called fire-and-forget. `@typescript-eslint/no-floating-promises` is an error, because an unhandled rejection terminates the Node.js process. For the same reason, channel methods must never reject: component errors (collected with `allSettled`) go to `errorLogging`, and if `errorLogging` fails the logger falls back to `console.error`.
- `LilypadDiscordLogger` queues messages and batches them (`minRequestInterval`). It retries a 429 response after `retry-after`. The queue holds at most `maxQueueSize` messages: the oldest are dropped (resolved, not rejected) and announced in the next batch.

### How the modules depend on each other
```
LilypadDbCache ──extends──> LilypadCache ──uses──> LilypadFlowControl
      │                                             (single-flight + timeout)
      └──uses──> LilypadDbGate (postgres.js, LISTEN/NOTIFY)
```
- **LilypadCache** is an in-memory, TTL-based cache with `string | number` keys (`LilypadCacheKey`).
  - Return values: `undefined` means not cached (or expired), and `null` means cached as "does not exist". Keep this distinction.
  - `getOrSet` deduplicates concurrent fetches with a `LilypadFlowControl` single-flight keyed per cache key. Only the fetch is shared: the error fallback (`errorReturn`) runs for each caller, outside the flight. A value resolved after the flow control timeout is not cached.
  - **Write ordering**: every entry carries a `ticket`. An async read calls `beginRead()` when it starts, and stores its result with `read.store` (`setIfNewer`, this instance only) or `read.storeFetched` (also L2, ends the cooldown), which discard the result if a write that started later has already been stored. `setIfNewer` and `storeFetched` are private: every new async read path must go through `beginRead()`. A plain `set` takes a new ticket. A completed bulk sync raises `ticketFloor`, so that older reads of missing keys are discarded too. Expiring a key with no entry while a read of it is in flight (`hasReadInFlight`, extended by subclasses) sets a per-key fence (`fences`) that plays the same role.
  - `bulkSync` has its own flow control (`bulkSyncTimeout`) and TTL (`bulkSyncExpirationTime`), and always uses the `bulkSyncFn` option. It resolves to a boolean. Its errors are logged and swallowed, unless `throwOnError` is set. To force a sync, call `invalidateBulkSync()` instead of writing `bulkSyncExpirationTime`: it also stops a sync that is already running from marking itself fresh. `bulkGet({})` leaves out expired or removed entries, so anything that expires or removes a synced entry while the bulk sync is fresh must invalidate it (`clear`, `maxEntries` evictions, and `writeEntry` of a value that expires before the bulk sync do). The bulk sync never stays fresh longer than `ttl`, the lifetime of its entries.
  - `get()` does not remove expired entries by default: the expired value is the fallback for `returnOldOnError`.
  - The store and the protected keys are keyed by `normalizeKey(key)`, the string form of the key. Each entry keeps the original key, which `bulkGet({})` returns. Internal iterations work on normalized keys (`deleteNormalized`, `expireNormalized`), over a **copy** of the store: with `maxEntries`, `writeEntry` re-inserts the key at the end of the Map, so iterating the live Map while writing can loop forever.
  - A disposed cache ignores every write (`disposed` flag), so that fetches still in flight cannot fill it again, and its reads throw (`assertNotDisposed`). `dispose()` returns a promise in every class.
  - `getOrSet` is a wrapper of `getOrSetDetailed`, which returns `{ value, status, refreshFailed }`. A fresh `fallback` entry is returned with `refreshFailed: true`, and with `failureCooldown` it is refreshed in the background once the cooldown is over (`freshHit`). Lookup order: L1 (memory) → L2 (`shared`, with `name` required) → stale value within `staleWhileRevalidate` (refreshed via `runAfterResponse`, one per key; a refresh that never starts stops blocking after 60 s) → fetch. During `failureCooldown`, the fetch is skipped and `errorReturn` runs with a `LilypadCacheCooldownError`.
  - Entries carry `fetchedAt` (age for L2 adoption), `expirationTime` and `origin` (`source`: a fetch or a write; `fallback`: `errorReturn`; `shared`: adopted from L2). `expire` sets `expirationTime` to `0` and `invalidatedAt`: an invalidated entry is never served stale, but stays a fallback for `returnOldOnError`, and `adoptShared` refuses L2 copies fetched before `invalidatedAt`.
  - `writeEntry` calls the protected hook `onValueStored(entry)` for each new value (not for `expire`). `expireEverything()` expires every entry and raises `ticketFloor`, discarding the reads in flight; `rejectSharedBefore(time)` stops adopting older L2 values.
  - L2 writes: public `set`/`bulkSet` and `storeFetched` (fetches) write L2; `setLocal` (fallbacks) and bulk syncs do not. A write does not read L2 first unless `shared.checkBeforeWrite`. `delete` and `invalidate` (via `markInvalid`) remove from L2; `clear`/`dispose` do not. L2 keys are `lilypad:<name>:<normalizedKey>` (`:failedAt`, `:lock` suffixes), values an envelope `{ lilypad: 1, value, fetchedAt, expiresAt }`.
  - `emitInvalidation(source, keys)` calls `platform.onInvalidate` in the background; the base class emits `manual` from `invalidate`.
  - Protected keys are not removed by `delete`/`clear` unless you pass `force`.
  - `expire(key)` is the data part of `invalidate` (without the L2 removal, the bulk sync and the event). `invalidate` is synchronous in every class: `LilypadDbCache` does not override it (its query is `refresh`).
- **LilypadDbCache** is a `LilypadCache` backed by one table described by a `LilypadDbSchema<V>`.
  - Its `bulkSyncFn` loads the whole table, and replaces `members`: the keys of the rows of the table, each with a ticket. After the first load, `onValueStored` (non-fallback values: row → member, `null` → removed), `addMember` (INSERT/UPDATE of a key not cached) and `applyTruncate` keep them up to date; `purge`, eviction and `clear` do not touch them.
  - `getAll()` loads the table when `isTableLoaded()` is false (never loaded, loaded before the sync became trusted, or with `none` after `defaultBulkSyncTtl`), then fetches the stale or missing members with `selectFromTableByPrimaryKeys` (`fetchRows`, L1 only), or reloads if they exceed 25% of the members. It never relies on the freshness of the base bulk sync. `getAll(keys)` fetches only those keys. The result is built from the store **and** from the rows the load (`loadTable` returns them through `tableLoadWaiters`) and `fetchRows` just read, since `maxEntries` may have evicted them. `fetchRows` is single-flight per key (`rowFetches`).
  - **Trust and renewal**: `syncTrustedSince()` is when `LISTEN` became active (reset on reconnect; undefined if a callback replaces the default handling) or when the changelog chain started (undefined beyond `maxGap`). `renew()` extends an entry past its TTL, without a query, if its `origin` is `source`, it is not invalidated (`expirationTime > 0`), `fetchedAt >= syncTrustedSince()` and it is younger than `sync.maxAge`. `get`, `getOrSetDetailed` and `getAll` renew before reading. L2 lifetimes are never extended.
  - `refresh(key)` re-fetches the row (`fetchRow`, with `flowControlTimeout`). Calls are coalesced per key (`refreshes`): one running query, plus at most one queued after it for the calls made meanwhile.
  - `sqlCreate`/`sqlUpdate`/`sqlDelete` write through to the database with the gate's `...Detailed` methods, then cache the row returned by the database (`RETURNING *`), so generated primary keys work. `storeWritten` takes a ticket before the write: if the entry changed during the write, it expires it instead of caching the row. Otherwise it caches with `set` (a new ticket, so reads started before lose) and records the write's `xid` in `ownWrites`; a change with that `xid` is skipped while the entry still holds the last own write. Deletions are cached with `set(key, null)`, which also applies to protected keys.
  - The `sync` option chooses how external changes arrive: `listen` (default; `connect: 'lazy'` defers LISTEN to the first read; `onNotification` is called after the change is applied, `applyChanges: false` leaves the cache to it), `changelog` or `none`. `syncBeforeRead()` runs before `getOrSetDetailed`/`getAll`; it returns `undefined` when there is nothing to wait for, so that reads stay synchronous up to the fetch registration. A failed changelog read or lazy LISTEN sets a retry time with exponential backoff (`retryDelay`), so reads do not retry it each time.
  - **Changelog** (`src/dbGate/LilypadChangelog.ts`): a trigger writes `(xid, table_name, row_id, op)` rows; `readLilypadChangesBatch` returns, for each request, the rows with `xid >= cursor`, where the cursor is `pg_snapshot_xmin` of the previous read, so out-of-order commits are never missed (`readLilypadChanges` is its one-table wrapper). The caches of a gate subscribe to one `LilypadChangelogReader` per changelog table (`src/dbGate/LilypadChangelogReader.ts`, a `WeakMap` keyed by gate), which reads every subscribed table in one query and calls each cache's `apply` with its own request (cursor or lookback). Rows can come back again: `appliedChanges` skips ids already applied. Without a trusted cursor (first read, or more than `maxGap` since the last one) it reads a time `lookback` and expires every entry. Changelog changes are applied lazily (`markInvalid`, whose fence discards a read in flight without a query), notifications eagerly (`refreshKey`). Every INSERT/UPDATE calls `addMember`. `TRUNCATE` (statement trigger, `row_id` NULL, version 3) is applied by `applyTruncate` with no query. Notifications of version 3 carry `xid`. The trigger records `TG_TABLE_SCHEMA` too (`table_schema`, `schema` in the payload), and the reader resolves the table with `to_regclass`; rows without a schema (version 1) match any schema. The trigger function carries its version in its comment (`LILYPAD_CHANGELOG_VERSION`): bump it when the generated SQL changes.
  - **Schema check** (`src/dbGate/LilypadSchemaCheck.ts`): `checkLilypadSchema` reads the catalogs only. The cache runs it once per instance (`sync.verify`): `warn` before LISTEN (it resolves the schema used to filter notifications) or in the background with the first changelog read; `throw` in `create`. The unit tests mock it, as they mock `readLilypadChanges`.
  - With the `listen` strategy, it registers a listener on the Postgres channel **`cache_events`**, with a `callbackId` that includes the instance id. The listener expects JSON payloads `{ table, id, op: 'INSERT'|'UPDATE'|'DELETE'|'TRUNCATE', schema?, xid? }`, where `id` is a string or a number (absent for TRUNCATE). `resolveNotifiedKey` keeps the type of a known key, or converts a string id to a number when `cols[primaryKey].type` is `'number'`. INSERT and UPDATE re-fetch only the keys that are cached or being fetched; any other key is only added to `members`. On `onReconnect`, every entry is expired. The database-side trigger that sends these payloads is not part of the library; `LilypadDbGate.integration.test.ts` contains a reference implementation.
- **LilypadDbGate** wraps postgres.js.
  - The main `sql` client uses `prepare: false`. Keep it that way; it was deliberately removed in a recent commit. The `statementTimeout` option sets Postgres `statement_timeout` on this client.
  - Do not cancel queries with the postgres.js `.cancel()`: in 3.4.x it drops the promise of the cancel request, so a failed cancel connection becomes an unhandled rejection.
  - LISTEN uses a separate single dedicated connection (`listenerConnectionString`, which defaults to `connectionString`).
  - Callbacks are grouped by channel and keyed by `callbackId`, so re-adding the same id replaces the old callback. Callbacks may be async: their errors are caught and logged. `removeListener` UNLISTENs the channel when its last callback is removed.
  - postgres.js calls `onlisten` on the first LISTEN and again after every reconnection. From the second call on, the gate runs the optional `onReconnect` of each callback.
  - The CRUD helpers are generic over `LilypadDbSchema<T, PK>` (`PK` defaults to `keyof T`). Rows are mapped to `T` with `selectSanitizationFn`, or by copying the `cols` keys. Writes go through `writeSanitizationFn`, whose result **replaces** the data, so it can remove properties. The `cols` metadata is optional; only the `type` of the primary key is read (by `LilypadDbCache`). `sql` is `readonly`.
  - Only the `cols` keys are selected (unless there is a `selectSanitizationFn`) and written: extra properties of the data are dropped on purpose, to prevent mass assignment. `undefined` values are not written.
  - `selectAllFromTable` reads through a cursor, in batches of 1000 rows. `selectFromTableByPrimaryKeys` reads several keys with `IN`, one query per 1000 keys.
  - `insertToTableDetailed`/`updateToTableDetailed`/`deleteFromTableDetailed` add `txid_current()::text AS __lilypad_xid` to `RETURNING` and strip it before `mapRow`; the plain methods wrap them.

### Tests
Tests live next to the sources as `*.test.ts`.
- `LilypadDbCache.test.ts` uses an in-memory fake of `LilypadDbGate`, and mocks `readLilypadChangesBatch` (`changelog.batch`, which delegates each request to `changelog.read`).
- `LilypadCache.shared.test.ts` covers L2, stale-while-revalidate and the cooldown with an in-memory fake store that clones values.
- `LilypadDbGate` is covered by the integration tests, which run against a real PostgreSQL (including the changelog and its out-of-order commit test), and by `LilypadDbGate.test.ts` for what needs no database (pool options, no connection on create).
- The flow control tests use fake timers (`withFakeTimers` helper). The cache tests all run on fake timers (`vi.advanceTimersByTimeAsync`).
- `LilypadPlatform.test.ts` covers the fallbacks of `runInBackground`/`runAfterResponse`. The platform tests run in the `edge` project too.
