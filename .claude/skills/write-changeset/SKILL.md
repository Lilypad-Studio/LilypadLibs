---
name: write-changeset
description: Write the changeset of a user-facing change (bump + CHANGELOG.md entry in the house sections) as a .changeset/*.md file. Use when a change to the public API, behavior, config format or CLI of @lilypad-studio/libs is ready.
argument-hint: '[what changed]'
---

Write the changeset for: $ARGUMENTS (if empty, the uncommitted changes and the commits of the branch that are not on `main`).

`npx changeset` is interactive: write the file directly instead. `.changeset/changelog.mjs` copies the summary into CHANGELOG.md as it is, so the file body **is** the changelog entry.

1. Find what changed for the users of the library: `git diff main...HEAD` and `git diff`, restricted to what the entries of `src/entries/` export, the behavior, the config (`defineLilypadDb`/`defineLilypadTable`), the `lilypad-doctor` CLI, `package.json` (`engines`, `exports`, `peerDependencies`). Refactors, tests and tooling need no changeset: stop and say so.
2. Pick the bump: `patch` for a fix, `minor` for a feature or, before 1.0, a breaking change (`major` only after 1.0).
3. Write `.changeset/<kebab-summary>.md` (LF line endings):

   ```markdown
   ---
   '@lilypad-studio/libs': minor
   ---

   #### Upgrading

   | Change                                                          | What to do                                |
   | --------------------------------------------------------------- | ----------------------------------------- |
   | **The breaking change, in bold first.** What it breaks and why. | The exact migration: old code → new code. |

   #### Added

   - New API, with its entry (`@lilypad-studio/libs/schema`) and a short example of use.

   #### Changed

   - ...

   #### Fixed

   - ...
   ```

   - Omit the empty sections; keep the order Upgrading, Added, Changed, Fixed.
   - **Every breaking change gets its own `#### Upgrading` row**, even a small one (a renamed option, a stricter type, a changed default, an error message): breaking changes are accepted only when documented.
   - Name the exported symbols and the subpath that exports them, in backticks. Write for an application developer who did not follow the change.

4. Run `npx prettier --write .changeset/<file>.md` (it aligns the table), then `npx changeset status` to check that the file is valid.
