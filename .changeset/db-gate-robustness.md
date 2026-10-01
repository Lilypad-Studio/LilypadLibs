---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                                                        | What to do                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **`readLilypadChanges`, `readLilypadChangesBatch` and `pruneLilypadChangelog` reject with `LilypadDisposedError` on a closed gate** (`@lilypad-studio/libs/db`), like the table helpers, instead of the postgres.js `CONNECTION_ENDED` error. | If you matched the postgres.js error, catch `LilypadDisposedError` instead. |

#### Fixed

- `lilypadChangelogTriggerSql` (changelog SQL version 8, see Upgrading) no longer loses the INSERT, UPDATE and DELETE triggers of a table whose name is long (from about 54 characters, schema included). PostgreSQL truncated the four trigger names to the same 63 bytes, so each trigger replaced the previous one and only `TRUNCATE` was recorded, even after the fix SQL of `lilypad-doctor`. A name that PostgreSQL would truncate is now shortened with a hash, and the SQL drops the truncated triggers of earlier versions.
- With the `prune` option of `lilypadChangelogSql`, the `SECURITY DEFINER` function `<changelog>_prune()` no longer searches `pg_temp` first: any role that could connect could create a temporary table of the changelog's name, call the function, and run its own trigger code with the privileges of the function's owner. Reinstall the changelog SQL (see Upgrading, version 8) now if you use `prune`.
- The changelog SQL works with table and channel names that contain `$` (for example `$$`): the function bodies are now quoted with a tag the names do not contain. Such a name used to make the migration fail with a syntax error.
- `LilypadDbTable.selectAll` (and so the full loads of `LilypadDbCache`) no longer fails with `canceling statement due to statement timeout` when reading the whole table takes longer than the gate's `statementTimeout` (30 s by default). The timeout now bounds each batch of 1000 rows, not the whole read: `selectAll` reads through an SQL cursor (`DECLARE`, then `FETCH`) in one transaction, so a pooler in statement mode is no longer supported for it, and the time a `select` hook spends between batches counts toward `idle_in_transaction_session_timeout`.
- `LilypadDbGate` no longer repeats notifications and `onReconnect` calls after a `LISTEN` that failed, for example during a database outage. postgres.js kept the listener of each failed attempt and listened to it again on every reconnection. Each notification then ran the callbacks once more per failed attempt, and each reconnection resynchronized the caches as many times, including the callbacks removed since.
- `isListenHealthy()` no longer reports a dead `LISTEN` connection as healthy after the system clock steps back: the heartbeat now measures time on the monotonic clock. Without a heartbeat (`listenHeartbeat: false`), it is `true` only once `LISTEN` is active on a channel, not while it is still starting.
- `LilypadDbGate.create` with an existing `singleton` now logs its warning when the `listen` option differs (by `channel` or `callbackId`). The listeners of that call were ignored without a word: add them with `addListener`.
