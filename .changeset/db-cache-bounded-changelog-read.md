---
'@lilypad-studio/libs': patch
---

#### Fixed

- `LilypadDbCache` (`@lilypad-studio/libs/db`) with the `changelog` strategy and `poll: 'await'` waits for a read of the changelog at most its `fetchTimeout`. Nothing bounded that query (the gate sets no `statement_timeout` by default), so a changelog query stuck on a lock, a full pool or a dead connection held every `getOrFetch`, `getAll` and `getManyOrFetch` of the caches of the gate, rows already in memory included, ignoring their `timeout` and `onError`. A read that times out is logged as `Error reading the changelog:` (a `LilypadTimeoutError`) and goes on with the content of the cache, as after a failed read; the changelog read keeps running, and applies its changes if it completes.
