# Changelog

## Unreleased

### Upgrading

| Change | What to do |
| --- | --- |
| The changelog is at version 3: it records `TRUNCATE` (with `row_id` `NULL`), and its notifications carry the transaction id (`xid`). | Run `lilypadChangelogSql()` and `lilypadChangelogTriggerSql()` again for each table. Until then, the schema check reports `outdated-changelog` and `missing-truncate-trigger`, and `TRUNCATE` is not seen. |
| `LilypadChange` is a union: a `TRUNCATE` change has `rowId: null`. | Code that reads the changelog with `readLilypadChanges` must handle `op: 'TRUNCATE'`. |
| With `listen` or `changelog`, a row that reaches its TTL is kept without a query while the sync is trusted, until `maxAge` (default: 1 hour). | Set `sync.maxAge: 0` to query the rows again at each TTL, as before. |
| `getAll()` no longer reloads the whole table after each change or at each TTL: it queries the changed rows by primary key. `getAll(keys)` queries only these keys, instead of loading the whole table. `defaultBulkSyncTtl` applies to `getAll` only with the `none` strategy. | None, unless you relied on `getAll` to reload the table. `bulkSync()` still loads it. |
| `LilypadDbCache` reads rows with `selectFromTableByPrimaryKeys`, and writes with `insertToTableDetailed`, `updateToTableDetailed` and `deleteFromTableDetailed`. | Only a custom gate, or a mock of it, must implement them. |
| A row written by `sqlCreate`/`sqlUpdate`/`sqlDelete` is not cached if its entry changed while the write was running; the next read fetches it. | None. |
| The bulk sync of `LilypadCache` never stays fresh longer than the TTL, and `clear()` and `maxEntries` evictions force the next one. | Set the TTL, not only `defaultBulkSyncTtl`, if you want loads to last longer. |
| `@lilypad/libs` no longer exports the database modules (`LilypadDbGate`, `LilypadDbCache`, the changelog and schema helpers): the root entry never pulls in postgres.js, and runs in edge runtimes. | Import them from `@lilypad/libs/db`. |
| `new LilypadCache(ttl, options)` becomes `new LilypadCache({ ttl, ...options })`, and `LilypadDbCache.create(ttl, options)` becomes `LilypadDbCache.create({ ttl, ...options })`. A `ttl` that is not a positive finite number throws. | Move the TTL into the options. |
| `get(key, true)` becomes `get(key, { removeExpired: true })`. | Replace the boolean. |
| `delete` and `clear` no longer take `setNull` (`clear({ setNull: true })` could loop forever with `maxEntries`). | Use `set(key, null)` to cache a key as "does not exist". |
| `bulkSync` and `bulkAsyncGet` no longer take a `syncFn`: concurrent calls share one load, so a per-call function could be ignored or mark as fresh a load made by another. `bulkSync(syncFn, options)` becomes `bulkSync(options)`. | Pass the function as the `bulkSyncFn` option of the cache. |
| `dispose()` returns a promise for every cache, not only `LilypadDbCache`. | `await` it (the lint rule `no-floating-promises` points at the calls). |
| `getOrSet` (and `getOrFetch`, `getAll`) on a disposed cache throws, instead of querying the source at each call without caching. | Do not use a cache after `dispose()`. |
| `LilypadDbCache.invalidate(key)` is synchronous and sends no query, as in `LilypadCache`: it expires the key, and the next read fetches it. `update(key)` is renamed `refresh(key)`, which queries the row, shares the query with concurrent calls, and times out after `flowControlTimeout`. | Replace `await cache.invalidate(key)` with `await cache.refresh(key)` where you need the row at once, and `update` with `refresh`. |
| `LilypadDbCache.getOrFetch` rejects when the query fails, instead of resolving to `undefined` (which also means "not cached"). | Catch the error, or pass `errorFn`/`returnOldOnError`. `getOrFetchDetailed` also returns `status` and `refreshFailed`. |
| `useDefaultDbListener` and `defaultListenerOptions` are removed, and `sync.listenerOptions` is replaced by `sync.onNotification` and `sync.applyChanges`. The cache applies the notifications by default even with a callback. | `useDefaultDbListener: false` becomes `sync: { strategy: 'none' }`. `listenerOptions: { callback, automaticallyInvalidateDataBeforeCallback: true }` becomes `{ strategy: 'listen', onNotification: callback }`; without `automaticallyInvalidateDataBeforeCallback`, add `applyChanges: false`. |
| `LilypadLibLogger` is any object with some of the methods `error`, `warn`, `info`, `debug` (`console` and pino work). The modules log with the name of the instance as first argument, instead of its random id. `LilypadLogger.create` defaults to the channels `'error' \| 'warn' \| 'info' \| 'debug'` (it was `'log' \| 'error' \| 'warn'`), and `createLogger` is removed. | Code that reads `logger.x` of a `LilypadLibLogger` must use `logger.x?.()`. Replace `createLogger` with `LilypadLogger.create`; pass the type argument if you relied on the `log` channel. |
| `insertSanitizationFn` is renamed `writeSanitizationFn` (it applies to updates too). The `cols` metadata is optional, and `nullable: true` no longer requires `default`. | Rename the option. |
| With a `number` primary key column, `LilypadDbCache` converts the ids of notifications and of the changelog to numbers for keys it does not know yet (they were kept as strings). | None. Declare `bigint` keys as `'string'`: postgres.js returns them as strings. |
| `LilypadDbGate.sql` is read-only. | Do not reassign it. |
| `FlowControlOptions` and `ExecuteFnOptions` are renamed `LilypadFlowControlOptions` and `LilypadExecuteFnOptions`. A timeout fails with a `LilypadTimeoutError` (`Operation timed out after <n>ms`), and the rate limit with a `LilypadRateLimitError`, which now goes to `errorFn` like any failure. | Rename the types. Code that matched the whole message `Operation timed out` exactly must match its start, or use `instanceof`. |
| `LilypadSerializer.deserialize` keeps a `null` returned by `deserialize`, instead of replacing it with the default. | Return `undefined` to get the default. |
| A write to the shared level no longer reads the shared entry first. | Set `shared.checkBeforeWrite: true` to keep the former soft check. |
| While a fallback chosen after an error is cached, `getOrSetDetailed` reports `refreshFailed: true` (it reported `false`), and with `failureCooldown` the key is refreshed in the background once the cooldown is over. | None. |
| `LilypadDiscordLogger` keeps at most `maxQueueSize` messages (default: 100) waiting to be sent, and drops the oldest beyond it. | Raise `maxQueueSize` if you log bursts larger than that on Discord. |
| Subclasses of `LilypadCache` store the results of their reads through `beginRead()`: `setIfNewer` and `storeFetched` are private. | Replace `nextTicket()` + `setIfNewer(...)` with `const read = this.beginRead(); ...; read.store(key, value)`. |

### Added

- **LilypadDbGate**: `selectFromTableByPrimaryKeys`, and `insertToTableDetailed`, `updateToTableDetailed`, `deleteFromTableDetailed`, which also return the id of the transaction (`LilypadDbWriteResult`).
- **LilypadDbCache**: `sync.maxAge`. `TRUNCATE` is applied without a query, from the changelog and from notifications.
- **Schema check**: the `missing-truncate-trigger` problem.
- **Changelog**: the caches of a gate read the changelog together, in one query per poll (`readLilypadChangesBatch`). A failed read, or a failed lazy `LISTEN`, is retried after an exponential backoff instead of at every read.
- **LilypadDbCache**: `refresh(key)` and `getOrFetchDetailed`. Notifications for a key being refreshed are coalesced into one more query.
- **LilypadCache**: `shared.checkBeforeWrite`; `beginRead()` for subclasses. Exported types `LilypadCacheEntry`, `LilypadCacheRead`, `LilypadCacheSyncFn`, `LilypadCacheValueRetrieval`.
- **LilypadFlowControl**: `LilypadTimeoutError`, `LilypadRateLimitError`; `executeWithTimeout` is typed per call.
- **Logger**: `formatLogValue` prints the own properties of errors (e.g. the `code` and `detail` of a database error). `LilypadDiscordLogger` option `maxQueueSize`.
- **CI**: GitHub Actions run the unit tests (Node.js 20 and 22), the typecheck, the lint, the build (checking that `dist/` is up to date) and the integration tests.

### Fixed

- `getAll()` left out, for up to the TTL, the rows changed elsewhere (with `changelog`), the rows whose refresh after a notification failed, the rows cached with a shorter TTL, and the rows changed while the table was loading.
- `getAll()` could return an empty list just before the bulk sync expired, or until it expired after `clear()`.
- A change applied between the end of a write and the caching of its result could be overwritten by the older row of the write.
- A `TRUNCATE` of a cached table was never seen: the caches kept the removed rows until their TTL.
- `getAll()` with `maxEntries` smaller than the table returned only part of it, without error.
- Concurrent `getAll(keys)` calls whose keys joined to the same string (e.g. `['a,b']` and `['a', 'b']`) shared one query, and one of them returned the wrong rows.
- With the `changelog` strategy, each change of a key being fetched ran a query, one after the other, while every read of the instance waited.
- A fetch of a key that was not cached yet could cache a value read before the key was invalidated or changed.
- An invalidated key could adopt a copy from the shared level produced before the invalidation, if its removal had failed.
- `bulkGet({})` left out an entry written with a TTL shorter than the bulk sync while the sync still counted as fresh.
- A row inserted again elsewhere after being cached as `null` was left out of `getAll()` until the next full load.
- Background refreshes that never started stayed tracked forever; they are now removed by `purgeExpired`.
- `selectFromTableByPrimaryKeys` failed with more than 65 535 keys: it now sends one query per 1 000 keys.
- `formatLogValue` threw on a getter that throws, and the message was lost.
- `LilypadDiscordLogger` did not read the response bodies, which kept connections busy.

## 0.2.0

### Upgrading from 0.0.1

These changes can break existing code. Check each item that applies to you.

| Change | What to do |
| --- | --- |
| Node.js 20 or later is required. | Upgrade Node.js. |
| Singletons created by `create()` are registered under `<Class>:<identifier>` (e.g. `LilypadDbGate:main`). | Code that read them with `getLilypadSingletonInstance('main')` must call `create()` again instead. If two versions of the library run in the same process, each builds its own instances until both are upgraded. |
| `insertSanitizationFn`: its result now **replaces** the data, instead of being merged into it. | A function that returned only the changed fields must now return the whole object (`(data) => ({ ...data, title: data.title?.trim() })`). |
| `getAll()` rejects when the table cannot be loaded (it used to return an empty or partial list). | Catch its error where an empty list was acceptable. |
| `bulkSync()` resolves to a boolean (it resolved to `undefined`). | Only code that checked the result is affected. |
| `LilypadFlowControl.rateLimit()` is synchronous: it throws instead of rejecting. | Replace `await expect(...).rejects` / `.catch()` with `try/catch`. |
| `flowControlTimeout` no longer applies to `bulkSync`, which has its own `bulkSyncTimeout` (30 s). | Set `bulkSyncTimeout` if you relied on `flowControlTimeout` for bulk syncs. |
| `defaultErrorTtl` defaults to the TTL, at most 5 minutes (it was always 5 minutes). | Set it explicitly to keep the former value. |
| The logger no longer uses `util.inspect`: objects are formatted by an internal formatter, close to it (`[Circular]` instead of `[Circular *1]`). | Only code that parsed log messages is affected. |
| A channel named `then` or `flush` is rejected. | Rename the channel. |
| `LilypadDbCache` caches deleted rows as `null` even for protected keys. | None: protected keys were wrongly kept. |
| Notification triggers that the library installs send `id` as a string. | None: the cache accepts numbers and strings. |
| `useDefaultDbListener` and `defaultListenerOptions` are deprecated. | Use `sync: { strategy: 'none' }` or `sync: { strategy: 'listen', listenerOptions }`. They still work. |
| The changelog records the schema of each table (version 2). The changelog of a development build of 0.2.0 must be upgraded. | Run `lilypadChangelogSql()` again (it adds the `table_schema` column). Until then, reads of the changelog fail. |
| `LilypadDbCache` checks once that its triggers are installed (`verify: 'warn'`), and warns on `console.warn` when it has no logger. | Install what the warning lists, or set `sync.verify: 'off'` (for example if you send notifications in a way the check does not see). |

### Added

- **Next.js / Vercel support** without depending on either: see [docs/nextjs-vercel.md](docs/nextjs-vercel.md).
  - `LilypadPlatform` (`background`, `afterResponse`, `shared`, `onInvalidate`), accepted by the logger and the caches.
  - Subpath entries (`@lilypad/libs/logger`, `/cache`, `/flow`, `/serializer`, `/singleton`, `/platform`, `/db`), ESM builds, and edge-runtime compatibility for every module except `/db`.
- **LilypadCache**: a shared level between instances (`shared`, `name`, `codec`, soft refresh lock), `staleWhileRevalidate`, `failureCooldown` (shared between instances), `getOrSetDetailed` with the status of the value, `maxEntries` (LRU), `cleanupOnAccessEvery`, a per-call `timeout`, invalidation events.
- **LilypadDbCache**: the `sync` option, with the `changelog` strategy (a trigger writes every change to a table; each instance reads it at most once per `pollInterval`, missing no commit whatever its order), `listen` with `connect: 'lazy'`, and `none`. Helpers `lilypadChangelogSql`, `lilypadChangelogTriggerSql`, `pruneLilypadChangelog`, `readLilypadChanges`.
- **Schema check**: `checkLilypadSchema` reports what the database misses for the `changelog` and `listen` strategies, with the SQL that fixes it. `LilypadDbCache` runs it once (`sync.verify`: `warn`, `throw` or `off`).
- **LilypadDbGate**: `pool` options, the `lilypadServerlessPool` preset, `statementTimeout`, `onReconnect` on listeners, typed partial updates (`LilypadDbSchema<T, PK>`).
- **Logger**: `platform`, `flush()`, `context`, structured records for components (`sendRecord`), `LilypadJsonConsoleLogger`. `LilypadDiscordLogger` batches messages and retries rate-limited requests.
- **LilypadFlowControl**: per-execution `timeout`, `isInFlight`.
- Numeric cache keys keep their type (`LilypadCacheKey = string | number`).

### Fixed

- `LilypadDbCache` mixed up tables of the same name in different schemas: it applied the changes of `archive.users` to a cache of `users`, with both strategies.
- `insertSanitizationFn` could not remove properties from the written data.
- A failing `errorLogging` callback made the logger reject, which terminated the process.
- Out-of-order refreshes could leave an old row in a `LilypadDbCache`; writes are now ordered by when they started.
- Concurrent `getOrSet` calls shared the error options of the first caller.
- A bulk sync that timed out still overwrote the cache later.
- `LISTEN` subscriptions were not told about reconnections, which lose notifications.
- Properties set to `undefined` made inserts and updates fail.
- Several smaller issues: see the commit history.
