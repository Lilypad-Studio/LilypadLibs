# Changelog

## Unreleased

### Added

- **Changelog pruning without an application job**: `lilypadChangelogPruneScheduleSql({ olderThan })` returns the SQL that schedules a pg_cron job deleting the old changelog rows, and `lilypadChangelogSql({ prune: { olderThan } })` makes the trigger delete a batch of old rows as it records changes. `lilypadChangelogSql()` without `prune` also drops the prune function, and the schema check keeps the prune options of an installed changelog in the SQL it suggests. The changelog stays at version 4: nothing to run again.

## 0.4.0

### Upgrading from 0.3.0

| Change | What to do |
| --- | --- |
| Node.js 22 or later is required (Node.js 20 reached its end of life in April 2026). | Upgrade Node.js. |
| `LilypadCache`: `bulkGet({ keys })` is `getMany(keys)`, `bulkGet()` is `entries()`, and `bulkAsyncGet({ doSync })` is `getAll({ sync })`, which returns every entry (it no longer takes `keys`). | Rename the calls; for keys after a sync, `await cache.bulkSync(); cache.getMany(keys)`. |
| `LilypadFlowControl`: `executeFn` and `executeWithRetries` no longer take `errorFn`: a failed or rate-limited execution rejects, and each caller of a shared execution handles the error with its own `.catch`. `rateLimit(consumer, fn)` is `rateLimit(key)` (`executeFn` uses `consumer#function`). `consumerIdentifier` is optional (the rate limit then applies to the function). The `logger` option is removed (it was unused). The constructor throws for an invalid `rate`, `timeout` or `retries`. | Replace `errorFn: f` with `.catch(f)` on the returned promise; `rateLimit(c, f)` → `rateLimit(`${c}#${f}`)`. |
| Logger components implement `write(record)`, their only extension point, instead of `send(text, type)` / `sendRecord(record)`; `output()` and `LilypadLoggerComponentOptions` are removed. | Replace `protected async send(message, type)` with `async write(record)`, and use `this.formatRecord(record)` for the text line and `record.type` for the channel. Call `component.write(record)` where you called `output()`. |
| The logger replaces with `[Redacted]` the values of `LILYPAD_DEFAULT_REDACTED_KEYS` (authorization, cookie, password, secret, token, API keys...) in the messages and the context. | Nothing, unless you log those keys on purpose: pass `redact: false`, or your own list. |
| `logger.__name` is `logger.name`; a channel can no longer be named `name`. | Rename the property. |
| `LilypadDiscordLogger`: a failed batch reports one error (counting the lost messages, with the original error as `cause`) instead of one per message, and a `retry-after` longer than 30 s fails the batch instead of being waited for. | None. |
| `LilypadDbSchema.primaryKeyShouldAutoDetermine` is renamed `generatedPrimaryKey`. | Rename the option. |
| `LilypadDbGate` sets `statement_timeout` to 30 s by default. | Pass `statementTimeout: false` to keep the setting of the database, or a longer duration for long queries. |
| `LilypadDbGate.close()` waits at most 5 s (`close({ timeout })`) for the running queries, returns the same promise when called again, and the gate then rejects queries and `addListener`. | Do not use a gate after `close()`. |
| `LilypadDbCache.sqlDelete` resolves to `true` if a row was deleted, `false` otherwise. | None, unless you relied on `void`. |
| With the `changelog` strategy, a `DELETE` of a key the cache does not hold creates no `null` entry (and writes nothing to the shared level): mass deletes no longer evict the rows the cache holds. | None. |
| With the `listen` strategy, the keys notified together are re-read with one `selectFromTableByPrimaryKeys` query, instead of one `selectFromTableByPrimaryKey` query per key. | Only a mock of the gate is affected. |
| `LilypadDbCache.peek` renews the entries kept up to date by the sync, as `get` does. | None. |
| The changelog is at version 4: statement triggers (`<table>_lilypad_insert`, `_update`, `_delete`) with transition tables record all the rows of a statement in one query, and read only the primary key column. `lilypadChangelogTriggerSql` drops the row trigger `<table>_lilypad_changes`. The new function still serves the row triggers of version 3. | Run `lilypadChangelogSql()`, then `lilypadChangelogTriggerSql()` for each table, in one transaction. Until then, the schema check reports `outdated-changelog`. Transition tables are not allowed on partitions: attach the triggers to the partitioned table. |
| The schema check counts `ENABLE REPLICA` triggers as not firing (`missing-changelog-trigger`), and accepts statement triggers split by event. | Enable the triggers with `ENABLE TRIGGER`. |
| Types renamed: `ListenerCallbackIdentifier` → `LilypadDbListener`, `LilypadDbCacheDefaultNotificationPayload` → `LilypadDbNotification`. No longer exported: `LilypadCacheEntry`, `LilypadCacheRead`, `lilypadCursorCovers`, `readLilypadChangesBatch` (internals). | Rename the imports; use `readLilypadChanges` for one table. |

### Added

- **LilypadDbColumnType**: `'bigint'`, for `bigint`/`bigserial` primary keys, which postgres.js returns as strings.
- **LilypadFlowControl**: `singleFlight(key, fn)`.
- **Logger**: the `redact` option and `LILYPAD_DEFAULT_REDACTED_KEYS`.
- **LilypadDbGate**: the `closed` getter.

### Fixed

- A shared-level codec that throws no longer fails the read, nor turns a successful fetch into a failure (with a cooldown): the entry is ignored or not shared, with a warning.
- The LISTEN heartbeat no longer keeps pinging the database when the last listener is removed while it starts, and a heartbeat that could not start is retried.
- The value fetched with a longer `staleWhileRevalidate` than the cache's is kept in the shared level through that window.
- `maxEntries` evictions no longer scan the protected keys.
- The release function of a singleton no longer removes an instance registered under the same key after a manual removal.
- A changelog read whose changes could not be applied is retried after a backoff, not at every read.
- `LilypadDbCache.sqlCreate` no longer throws after a successful insert when the `selectSanitizationFn` drops the primary key: the row is returned, uncached.

## 0.3.0

### Upgrading from 0.2.0

| Change | What to do |
| --- | --- |
| `LilypadDbCache.create` takes `gate` and `schema` as options, instead of `dbGate: { gate, schema }`, and infers the row type and the key type from `schema`: the class is `LilypadDbCache<V, PK>` (it was `<K, V, PK>`). | Replace `LilypadDbCache.create<number, User, 'id'>({ dbGate: { gate, schema }, ... })` with `LilypadDbCache.create({ gate, schema, ... })`, and type variables as `LilypadDbCache<User, 'id'>`. |
| `LilypadDbCache` no longer exposes the writes of `LilypadCache`: `set`, `bulkSet`, `getOrSet`, `getOrSetDetailed`, `bulkSync`, `bulkGet` and `bulkAsyncGet` are internal. A value written with `set` was renewed past its TTL, and shared, as if the table had returned it. | Read with `getOrFetch`, `getOrFetchDetailed` and `getAll`; write with `sqlCreate`, `sqlUpdate` and `sqlDelete`; use `refresh` or `invalidate` to reload a key. |
| The options of `LilypadCache` are renamed: `defaultErrorTtl` → `errorTtl`, `flowControlTimeout` → `fetchTimeout`, and `bulkSyncFn`, `defaultBulkSyncTtl`, `bulkSyncTimeout` → `bulkSync: { fn, ttl, timeout }`. `LilypadDbCache` takes `bulkSync: { ttl, timeout }`. | Rename the options. |
| The read options `returnOldOnError`, `errorFn`, `errorTtl` and `data` are replaced by `onError: { fallback, ttl }`. `fallback` is `'stale'` (the former `returnOldOnError: true`) or a function of `{ key, error, stale }` that returns the fallback, or `undefined` to rethrow. The fallback that is the stale value keeps its age. | `returnOldOnError: true` → `onError: { fallback: 'stale' }`; `errorFn: fn` → `onError: { fallback: fn }` (return `context.stale?.value` where you relied on both); `errorTtl` → `onError.ttl`. Capture in a closure what you passed in `data`. |
| `getComprehensive(key)` is renamed `peek(key)`, and its type `LilypadCacheValueRetrieval` is renamed `LilypadCachePeek`. `bulkGet` takes no argument to return every entry (`bulkGet({})` still works). | Rename the calls. |
| Every public method of a disposed cache throws, except `dispose`, which can be called again (only `getOrSet`, `getOrFetch` and `getAll` threw). | Do not use a cache after `dispose()`. |
| The constructors check their numeric options: a duration that is not a finite number, a negative one (or `0` where a positive value is needed), or a `maxEntries` that is not a positive integer throws. | Fix the option the error names. |
| The keys of the shared level are `lilypad:2:<name>:<kind>:<key>` (`v` value, `f` last failure, `l` refresh lock), with the name and the key URI-encoded, and the envelope is `{ lilypad: 2, ... }`. The tags of the entries and of the invalidation events encode the name and the key too (`lilypad:<name>:<key>` with `encodeURIComponent`). A key containing `:` could collide with the lock or failure marker of another key. | The entries written by the previous version are ignored (refetched once). If you expire tags yourself, encode the name and the key. |
| `insertToTable` and `updateToTable` return `{ row, xid }`, and `deleteFromTable` returns `{ deleted, xid }`; the `...Detailed` methods are removed. An update of a missing row throws a `LilypadDbNotFoundError` (same message). | Replace `const row = await gate.insertToTable(...)` with `const { row } = ...`, and `...Detailed` with the plain methods. |
| The changelog cursor is `{ xmax, xip }` (the transactions a read could not see), not a transaction id: each change is returned by one read only, even while a long transaction runs. | Code that calls `readLilypadChanges` passes the cursor back as it is; it no longer needs to skip ids already processed. |
| With `listen`, notifications are hints: a `DELETE` of a cached key re-reads the row (instead of caching `null` at once), and a `TRUNCATE` makes the next `getAll()` load the table (instead of returning no row). Any role connected to the database can send them. A notification with an unknown `op` or malformed fields is ignored, with a warning. | None: a real `DELETE` or `TRUNCATE` gives the same result, with one query. |
| While channels are listened to, the gate sends itself a notification every 15 s (`listenHeartbeat`), and the caches trust `LISTEN` only while these come back. | Set `listenHeartbeat: false` to disable it. |
| `LilypadFlowControl` is no longer generic: each execution is typed by its `fn`. | Remove the type argument: `new LilypadFlowControl<T>(...)` → `new LilypadFlowControl(...)`. |
| The source modules export their classes by name only (no default exports). | Only deep imports of source files are affected: import from the entries (`@lilypad/libs/cache`, ...). |
| `postgres` is an optional peer dependency, instead of a dependency. | Install it in the application if it uses `@lilypad/libs/db` (`npm install postgres`). |
| The changelog is at version 3: it records `TRUNCATE` (with `row_id` `NULL`), and its notifications carry the transaction id (`xid`). | Run `lilypadChangelogSql()` and `lilypadChangelogTriggerSql()` again for each table. Until then, the schema check reports `outdated-changelog` and `missing-truncate-trigger`, and `TRUNCATE` is not seen. |
| `LilypadChange` is a union: a `TRUNCATE` change has `rowId: null`. | Code that reads the changelog with `readLilypadChanges` must handle `op: 'TRUNCATE'`. |
| With `listen` or `changelog`, a row that reaches its TTL is kept without a query while the sync is trusted, until `maxAge` (default: 1 hour). | Set `sync.maxAge: 0` to query the rows again at each TTL, as before. |
| `getAll()` no longer reloads the whole table after each change or at each TTL: it queries the changed rows by primary key. `getAll(keys)` queries only these keys, instead of loading the whole table. `bulkSync.ttl` applies to `getAll` only with the `none` strategy. | None, unless you relied on `getAll` to reload the table. `bulkSync()` still loads it. |
| `LilypadDbCache` reads rows with `selectFromTableByPrimaryKeys`, and uses the transaction ids returned by `insertToTable`, `updateToTable` and `deleteFromTable`. | Only a custom gate, or a mock of it, must implement them. |
| A row written by `sqlCreate`/`sqlUpdate`/`sqlDelete` is not cached if its entry changed while the write was running; the next read fetches it. | None. |
| The bulk sync of `LilypadCache` never stays fresh longer than the TTL, and `clear()` and `maxEntries` evictions force the next one. | Set the TTL, not only `bulkSync.ttl`, if you want loads to last longer. |
| `@lilypad/libs` no longer exports the database modules (`LilypadDbGate`, `LilypadDbCache`, the changelog and schema helpers): the root entry never pulls in postgres.js, and runs in edge runtimes. | Import them from `@lilypad/libs/db`. |
| `new LilypadCache(ttl, options)` becomes `new LilypadCache({ ttl, ...options })`, and `LilypadDbCache.create(ttl, options)` becomes `LilypadDbCache.create({ ttl, ...options })`. A `ttl` that is not a positive finite number throws. | Move the TTL into the options. |
| `get(key, true)` becomes `get(key, { removeExpired: true })`. | Replace the boolean. |
| `delete` and `clear` no longer take `setNull` (`clear({ setNull: true })` could loop forever with `maxEntries`). | Use `set(key, null)` to cache a key as "does not exist". |
| `bulkSync` and `bulkAsyncGet` no longer take a `syncFn`: concurrent calls share one load, so a per-call function could be ignored or mark as fresh a load made by another. `bulkSync(syncFn, options)` becomes `bulkSync(options)`. | Pass the function as the `bulkSync.fn` option of the cache. |
| `dispose()` returns a promise for every cache, not only `LilypadDbCache`. | `await` it (the lint rule `no-floating-promises` points at the calls). |
| `getOrSet` (and `getOrFetch`, `getAll`) on a disposed cache throws, instead of querying the source at each call without caching. | Do not use a cache after `dispose()`. |
| `LilypadDbCache.invalidate(key)` is synchronous and sends no query, as in `LilypadCache`: it expires the key, and the next read fetches it. `update(key)` is renamed `refresh(key)`, which queries the row, shares the query with concurrent calls, and times out after `fetchTimeout`. | Replace `await cache.invalidate(key)` with `await cache.refresh(key)` where you need the row at once, and `update` with `refresh`. |
| `LilypadDbCache.getOrFetch` rejects when the query fails, instead of resolving to `undefined` (which also means "not cached"). | Catch the error, or pass an `onError` fallback. `getOrFetchDetailed` also returns `status` and `refreshFailed`. |
| `useDefaultDbListener` and `defaultListenerOptions` are removed, and `sync.listenerOptions` is replaced by `sync.onNotification` and `sync.applyChanges`. The cache applies the notifications by default even with a callback. | `useDefaultDbListener: false` becomes `sync: { strategy: 'none' }`. `listenerOptions: { callback, automaticallyInvalidateDataBeforeCallback: true }` becomes `{ strategy: 'listen', onNotification: callback }`; without `automaticallyInvalidateDataBeforeCallback`, add `applyChanges: false`. |
| `LilypadLibLogger` is any object with some of the methods `error`, `warn`, `info`, `debug` (`console` and pino work). The modules log with the name of the instance as first argument, instead of its random id. `LilypadLogger.create` defaults to the channels `'error' \| 'warn' \| 'info' \| 'debug'` (it was `'log' \| 'error' \| 'warn'`), and `createLogger` is removed. | Code that reads `logger.x` of a `LilypadLibLogger` must use `logger.x?.()`. Replace `createLogger` with `LilypadLogger.create`; pass the type argument if you relied on the `log` channel. |
| `insertSanitizationFn` is renamed `writeSanitizationFn` (it applies to updates too). The `cols` metadata is optional, and `nullable: true` no longer requires `default`. | Rename the option. |
| With a `number` primary key column, `LilypadDbCache` converts the ids of notifications and of the changelog to numbers for keys it does not know yet (they were kept as strings). | None. Declare `bigint` keys as `'string'`: postgres.js returns them as strings. |
| `LilypadDbGate.sql` is read-only. | Do not reassign it. |
| `FlowControlOptions` and `ExecuteFnOptions` are renamed `LilypadFlowControlOptions` and `LilypadExecuteFnOptions`. A timeout fails with a `LilypadTimeoutError` (`Operation timed out after <n>ms`), and the rate limit with a `LilypadRateLimitError`, which now goes to `errorFn` like any failure. | Rename the types. Code that matched the whole message `Operation timed out` exactly must match its start, or use `instanceof`. |
| `LilypadSerializer.deserialize` keeps a `null` returned by `deserialize`, instead of replacing it with the default. | Return `undefined` to get the default. |
| A write to the shared level no longer reads the shared entry first. | Set `shared.checkBeforeWrite: true` to keep the former soft check. |
| While a fallback chosen after an error (`onError`) is cached, `getOrSetDetailed` reports `refreshFailed: true` (it reported `false`), and with `failureCooldown` the key is refreshed in the background once the cooldown is over. | None. |
| `LilypadDiscordLogger` keeps at most `maxQueueSize` messages (default: 100) waiting to be sent, and drops the oldest beyond it. | Raise `maxQueueSize` if you log bursts larger than that on Discord. |
| Subclasses of `LilypadCache` store the results of their reads through `beginRead()`: `setIfNewer` and `storeFetched` are private. | Replace `nextTicket()` + `setIfNewer(...)` with `const read = this.beginRead(); ...; read.store(key, value)`. |

### Added

- **LilypadDbGate**: `selectFromTableByPrimaryKeys`; the writes return the id of the transaction (`LilypadDbWriteResult`, `LilypadDbDeleteResult`); `LilypadDbNotFoundError`; `isListenHealthy()` and the `listenHeartbeat` option; `selectAllFromTable(schema, { signal })`.
- **LilypadDbCache**: `sync.maxAge`. `TRUNCATE` is applied without a query, from the changelog and from notifications.
- **Schema check**: the `missing-truncate-trigger` problem.
- **Changelog**: the caches of a gate read the changelog together, in one query per poll (`readLilypadChangesBatch`). A failed read, or a failed lazy `LISTEN`, is retried after an exponential backoff instead of at every read.
- **LilypadDbCache**: `refresh(key)` and `getOrFetchDetailed`. Notifications for a key being refreshed are coalesced into one more query. The row type and the key type are inferred from `schema` (`LilypadDbKey`).
- **LilypadCache**: `peek(key)`, `invalidateBulkSync()`, the `onError` read option (`LilypadCacheErrorOptions`, `LilypadCacheErrorContext`). `bulkSet` accepts any iterable of pairs, including `null` values.
- **Changelog**: `lilypadCursorCovers`, and the `LilypadChangelogCursor` type.
- **LilypadCache**: `shared.checkBeforeWrite`; `beginRead()` for subclasses. Exported types `LilypadCacheEntry`, `LilypadCacheRead`, `LilypadCacheSyncFn`, `LilypadCacheValueRetrieval`.
- **LilypadFlowControl**: `LilypadTimeoutError`, `LilypadRateLimitError`; `executeWithTimeout` is typed per call.
- **Logger**: `formatLogValue` prints the own properties of errors (e.g. the `code` and `detail` of a database error). `LilypadDiscordLogger` option `maxQueueSize`.
- **CI**: GitHub Actions run the unit tests (Node.js 20 and 22), the typecheck, the lint, the build (checking that `dist/` is up to date) and the integration tests.

### Fixed

- A read that started before a key was written or invalidated could store its older value once the entry was removed by `purgeExpired`, `cleanupOnAccessEvery`, `autoCleanupInterval`, `delete`, `clear` or a `maxEntries` eviction. In a `LilypadDbCache` with `changelog` and `cleanupOnAccessEvery`, a pre-change row could then be renewed until `maxAge`. The removed entry now leaves its ticket as a fence while a read of the key runs.
- `dispose()` during a lazy `LISTEN` left the cache's listener registered on the gate, and the disposed cache kept applying notifications.
- `set` and `bulkSet` on a disposed cache still wrote to the shared level.
- A stale value used as a fallback after an error was dated from now, and hid fresher copies of the shared level once it expired.
- While the `LISTEN` connection was down, and before postgres.js re-established it, the caches kept trusting it and kept rows past their TTL.
- A transaction held open for a long time made every read of the changelog return again all the changes made since it started.
- A table load that timed out kept reading the table until its end.
- `bulkSync()` without a bulk sync function logged a warning at each call.
- `removeListener` rejected when `LISTEN` had failed, and so did `LilypadDbCache.dispose()`.
- `LilypadJsonConsoleLogger` printed an object referenced twice (not circularly) as `[Circular]`.
- The warnings about a singleton created again with other options were logged without the name of the class.
- The writes of the gate transferred every column of the row (`RETURNING *`), not only those of the schema.
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
