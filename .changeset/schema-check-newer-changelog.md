---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                    | What to do                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **`LilypadSchemaProblemCode` has a new member, `newer-changelog`** (`@lilypad-studio/libs/db`). A `switch` over the codes that the compiler checks for exhaustiveness no longer compiles. | Add a `case 'newer-changelog':`. It is a warning: the caches of this version still read the changelog. |

#### Added

- The schema check (`lilypad-doctor`, `runLilypadDoctor`, `checkLilypadSchema` in `@lilypad-studio/libs/db`) reports `newer-changelog`, a warning, when the changelog trigger function was installed by a newer version of the library than the one running the check. The message says to upgrade `@lilypad-studio/libs`.

#### Fixed

- When several services share one database, the `lilypad-doctor --sql` of a service still on an older version no longer installs that version's changelog SQL over the newer one. Before, any problem whose fix included the changelog SQL (a missing notify trigger, a missing table with its triggers, the pruning) replaced the trigger function of the newer version with the older one, under every service of the newer version. While the installed changelog is newer, every fix of the changelog, its triggers and its privileges is withheld (as for an unsafe primary key), and the message of each such problem says why. A missing table keeps its `CREATE TABLE`, without its triggers.
