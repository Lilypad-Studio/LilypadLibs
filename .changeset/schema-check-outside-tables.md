---
'@lilypad-studio/libs': patch
---

#### Fixed

- `lilypad-doctor` (and `checkLilypadSchema`, `runLilypadDoctor` in `@lilypad-studio/libs/db`) no longer installs version 9 of the changelog where it fails the writes of a table outside the checked config. The check withheld the changelog fixes only for the tables of the config whose key the version 9 triggers refuse, but every table whose changelog triggers record into the same changelog goes through that trigger function: a table of another config or service sharing the changelog, or a table removed from the config. On an older install, the fix of `outdated-changelog` (or of a notify, trigger or pruning problem) installed version 9, and every write of such a table then failed. The check now reads the other tables whose enabled changelog triggers record a missing key column or a key of a type the triggers refuse, reports each one (`unsupported-key-type` or `missing-column`, an error, with its `schema.table` as `table`), and withholds the fixes of the changelog, its triggers and its privileges until they are changed, as for a table of the config. If you upgraded to version 9 already, run `lilypad-doctor` again: a table it now reports fails its writes; change its key, or reinstall its triggers with its primary key (`lilypadChangelogTriggerSql`), or drop them.
