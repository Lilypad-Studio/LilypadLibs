---
'@lilypad-studio/libs': patch
---

#### Fixed

- `LilypadDbCache.getAll()` (`@lilypad-studio/libs/db`) no longer resolves to an empty or partial table when a change of the whole table reaches the cache while it loads the table (a `BULK` or `TRUNCATE` notification, a `LISTEN` reconnection, a changelog read of more than 1000 rows): it loads the table again.
- `LilypadDbCache.getAll()` no longer rejects at every call after one notification carried an id that the primary key cannot hold (e.g. `"abc"` for an integer key: any role connected to the database can send one), which made the database reject its query by primary keys until the table was loaded again. When that query fails, `getAll()` now loads the whole table instead, once.
