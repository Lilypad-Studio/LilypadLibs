---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                          | What to do                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **The database modules need PostgreSQL 16 or later** (`@lilypad-studio/libs/db`). `lilypad-doctor` (and `runLilypadDoctor`, `checkLilypadSchema`) reports `unsupported-version`, an error, below 16; it was 13. | Upgrade the database to PostgreSQL 16 or later.                                                |
| **The `postgres` peer dependency is `^3.4.9`** (it was `^3.4.7`).                                                                                                                                               | `npm install postgres@^3.4.9` in the applications that use `@lilypad-studio/libs/db`.          |
| **A changelog installed by any older version of the library is now an error** of the schema check (`outdated-changelog`). Versions 4 to 8 were only a warning.                                                  | Run the SQL that `lilypad-doctor --sql` prints, in a migration: it upgrades any older install. |

#### Changed

- The message of `outdated-changelog` no longer lists what each older version lacks: it gives the installed version and the expected one. A changelog table whose `table_schema` column was dropped is reported as such, instead of as an older version.
