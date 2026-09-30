---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                                                                                                                                                                                                                                                                        | What to do                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **`lilypadChangelogSql` names the changelog table `changelogTable`** (`@lilypad-studio/libs/db`), as `lilypadChangelogTriggerSql`, `lilypadChangelogPruneScheduleSql`, `pruneLilypadChangelog` and `readLilypadChanges` do. Its `table` option was easy to mistake for the cached table, which `lilypadChangelogTriggerSql({ table })` takes: `lilypadChangelogSql({ table: 'accounts' })` altered the `accounts` table. It now throws when `table` is given. | `lilypadChangelogSql({ table: 'my_changes' })` → `lilypadChangelogSql({ changelogTable: 'my_changes' })`. |
| **`LilypadDbCache.getAll` takes no argument** (`@lilypad-studio/libs/db`): the rows of some keys come from the new `getManyOrFetch(keys)`, which behaves as `getAll(keys)` did (only the keys the cache does not hold up to date are queried, the keys without a row are left out).                                                                                                                                                                           | `cache.getAll([1, 2])` → `cache.getManyOrFetch([1, 2])`. `cache.getAll()` is unchanged.                   |
| **The type `LilypadCacheEntryOrigin` is no longer exported** (`@lilypad-studio/libs/cache` and `@lilypad-studio/libs`): no public signature used it.                                                                                                                                                                                                                                                                                                          | Remove the import; declare `'source' \| 'fallback' \| 'shared'` locally if you need it.                   |

#### Added

- `LilypadTimeoutError` is exported by `@lilypad-studio/libs/cache` and `@lilypad-studio/libs/db` too (the same class as in `/flow`), and `LilypadCacheCooldownError` by `@lilypad-studio/libs/db`: `getOrSet`, `getOrFetch`, `refresh` and `getAll` throw them, and they can now be tested with `instanceof` from the entry of the cache, e.g. `import { LilypadTimeoutError } from '@lilypad-studio/libs/db'`.
- `normalizeLilypadPgType` and `LILYPAD_DEFAULT_CHANGELOG_TABLE` are exported by `@lilypad-studio/libs/schema` (and so by `@lilypad-studio/libs`), next to `lilypadColumnTypesOfPgType` and `LILYPAD_DEFAULT_DB_CONFIG_NAME`. `@lilypad-studio/libs/db` still exports them.

#### Fixed

- `new LilypadDbTable(gate, definition)` (`@lilypad-studio/libs/db`) checks the definition and applies the hooks bound to its table on the config of the gate (`bindLilypadDbHooks`), as `gate.table(definition)` does. It used to accept any object, and to skip those hooks, so a `write` hook that sanitizes the data was silently not applied.
- The declarations of the package no longer add `__lilypadSingletonMap` and `__lilypadSingletonSignatureMap` to the global types of the application.
- `LilypadDbGate.assertOpen()` is marked internal, and no longer listed in the API reference: use `gate.closed`.
- The API reference lists the config functions and types (`defineLilypadDb`, `LilypadDbSchema`...) under `@lilypad-studio/libs/schema`, the entry a config file imports, instead of `@lilypad-studio/libs/db`.
- README: `LilypadDbGate.create` and `LilypadDbCache.create` open a connection only with `listen` channels or an eager `listen` sync; the channel methods of a logger return nothing; the name of the instance is the `source` of the meta given to the logger of the other modules; `LilypadFlowControl` takes no `logger`.
