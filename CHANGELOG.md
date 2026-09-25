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

### Added

- **LilypadDbGate**: `selectFromTableByPrimaryKeys`, and `insertToTableDetailed`, `updateToTableDetailed`, `deleteFromTableDetailed`, which also return the id of the transaction (`LilypadDbWriteResult`).
- **LilypadDbCache**: `sync.maxAge`. `TRUNCATE` is applied without a query, from the changelog and from notifications.
- **Schema check**: the `missing-truncate-trigger` problem.

### Fixed

- `getAll()` left out, for up to the TTL, the rows changed elsewhere (with `changelog`), the rows whose refresh after a notification failed, the rows cached with a shorter TTL, and the rows changed while the table was loading.
- `getAll()` could return an empty list just before the bulk sync expired, or until it expired after `clear()`.
- A change applied between the end of a write and the caching of its result could be overwritten by the older row of the write.
- A `TRUNCATE` of a cached table was never seen: the caches kept the removed rows until their TTL.

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
