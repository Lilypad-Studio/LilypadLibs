---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | What to do                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`statementTimeout` of `LilypadDbGate.create` (`@lilypad-studio/libs/db`) no longer defaults to 30 s.** The gate sends it as a startup parameter of each connection, which PgBouncer and most poolers in transaction mode refuse: with the default, every query of a gate behind such a pooler failed with `unsupported startup parameter: statement_timeout`, and so did `lilypad-doctor`. Without the option, the gate now sends nothing and the setting of the database applies. | On a direct connection, pass the bound you relied on: `LilypadDbGate.create({ connectionString, statementTimeout: 30_000 })`. Behind a pooler, do not pass `statementTimeout`; set the timeout on the role of the application instead, once: `ALTER ROLE app_user SET statement_timeout = '30s';`. |

#### Fixed

- `LilypadDbGate` (`@lilypad-studio/libs/db`) works behind PgBouncer with its default options: it no longer sends the `statement_timeout` startup parameter unless `statementTimeout` is given (see Upgrading).
