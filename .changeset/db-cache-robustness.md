---
'@lilypad-studio/libs': patch
---

#### Fixed

- `LilypadDbCache` with the `changelog` strategy (`@lilypad-studio/libs/db`) keeps a row past its TTL only while a read of the changelog was applied within `pollInterval` (two intervals with `poll: 'background'`). It used to trust the changelog for up to `maxGap` (1 hour by default) after its last read, so `get` and `peek`, which never read the changelog, and reads made while the changelog could not be read, kept serving rows changed since. `getAll` likewise no longer trusts its list of rows then. An application that reads such a cache with `get` alone now sees rows expire at their TTL whenever no `getOrFetch` or `getAll` read the changelog within `pollInterval`: read with `getOrFetch` to keep them without a query.
- A change applied while `LilypadDbCache` loads its table (`getAll`, the first call especially) no longer loses to the load: the row read before the change was cached as up to date, and kept past its TTL, and a row inserted during the first load was missing from every later `getAll`.
- A change made elsewhere while `sqlCreate`, `sqlUpdate` or `sqlDelete` runs no longer loses to the write when the cache did not hold the key: the cache kept the row of its own write, older than the change.
- `LilypadDbCache` bounds its bookkeeping: at most 32 remembered transactions per key written by the instance (none with `listen` and `applyChanges: false`, which applies no notification), and a bounded number of rows noted from notifications (anyone can send one): beyond a quarter of the table, the next `getAll` loads the table again.
- A `refresh` queued behind a running one rejects with a `LilypadDisposedError` if the cache was disposed meanwhile, instead of querying the database.
- `getManyOrFetch(keys)` (formerly `getAll(keys)`, see the `getAll` row of Upgrading) returns a key given twice (e.g. `7` and `'7'`) under its first spelling; a key notified again before its re-read is sent no longer uses the budget of 1000 re-reads per second; `getAll` no longer loads the whole table twice in one call when rows changed during its load.
