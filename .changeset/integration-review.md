---
'@lilypad-studio/libs': patch
---

#### Changed

- A `LilypadDbCache` with the `listen` strategy (`@lilypad-studio/libs/db`) sends a `notification` event with `keys: []` and the tag of the cache to `platform.onInvalidate` when `LISTEN` is re-established, since the notifications sent while it was down are lost.

#### Fixed

- A `LilypadDbCache` with the `changelog` strategy and a shared level keeps a row in the shared level for at most its `lookback` after reading it (with `lookback: 0`, not at all), whatever the `ttl` or `staleWhileRevalidate` given to `getOrFetch`. When no instance read the changelog for a while (e.g. every serverless instance idle or new), the first read applies only the changes of the `lookback`: a shared copy kept longer, read before an older change, was served as up to date for the rest of its TTL.
- When `LISTEN` is re-established, a `LilypadDbCache` with the `listen` strategy no longer takes from the shared level the rows copied there before, which may predate a lost notification (every instance loses it when the database fails over), and the next `getAll` loads the whole table again. It used to expire only its own entries, so `getAll` on a table that was empty missed the rows inserted while `LISTEN` was down, for up to `bulkSync.ttl`. With the `changelog` strategy, `getAll` likewise loads the whole table again after a broken chain of reads (the first read, or none for `maxGap`), even within `bulkSync.ttl`.
- `LilypadDbCache.getAll` and `getManyOrFetch` no longer cache as missing (`null`) the rows that a `select` hook (`bindLilypadDbHooks`) returns with another primary key, nor load every row without a primary key under one key: those rows are left out, and the keys they may belong to are expired, with a warning naming the hook. `getOrFetch` then returned `null` for rows that exist.
- A `cache_events` notification whose `id` holds a lone surrogate (`"\ud800"`, which no row can have) is ignored as malformed. It used to make the cache log an error (or a shared level warning) at each one, without the once-a-minute limit of the malformed notifications.
