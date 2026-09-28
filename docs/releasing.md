# Releasing @lilypad-studio/libs

Versions and the changelog are driven by [changesets](https://github.com/changesets/changesets), and the package is published to GitHub Packages by the release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)). Nothing is published from a workstation, and `dist/` is never committed.

## Day to day

1. In the pull request of a change that the users of the library should know about, run `npx changeset`: pick the bump and write the entry of the changelog (see [.changeset/README.md](../.changeset/README.md) for its sections). Before 1.0, a breaking change is a `minor` bump. Refactors, tests and tooling need no changeset.
2. When changesets reach `main`, the release workflow opens (or updates) the pull request **chore: version packages**: it bumps `version` in `package.json`, writes the section of `CHANGELOG.md`, and deletes the changesets.
3. Merging that pull request publishes the version: the workflow builds the package (`prepack`, with publint and arethetypeswrong), publishes it to GitHub Packages, and pushes the tag `v<version>` with its GitHub release.

The pull requests opened by the workflow's own token do not trigger other workflows, so CI does not run on the version pull request: close and reopen it to run CI, or give the workflow the token of a GitHub App (the `github-token` input of `changesets/action`).

## First release: the setup to complete on GitHub

These steps need an owner of the Lilypad-Studio organization; they cannot be done from the repository.

1. **Make the repository private** (Settings → General → Danger Zone → Change visibility). It is public today: the source of an internal library, and its packages, should not be. Private repositories use the Actions minutes and the Packages storage of the organization's plan: check its limits (Settings → Billing and plans).
2. **Let the workflow open pull requests**: Settings → Actions → General → Workflow permissions → check **Allow GitHub Actions to create and approve pull requests** (at the organization level first, if it is disabled there).
3. **Keep a way back for the git installs.** Before merging the commit that removes `dist/`, tag the last commit that has it, so that the applications still installed from git can pin it:

   ```bash
   git tag v0.6.0 <last commit with dist/> && git push origin v0.6.0
   # the applications: npm install github:Lilypad-Studio/LilypadLibs#v0.6.0
   ```

4. **Merge to `main`.** A changeset is pending, so the workflow opens **chore: version packages** for 0.7.0. Review the `CHANGELOG.md` it writes, then merge it: the workflow publishes `@lilypad-studio/libs@0.7.0`.
5. **Restrict the package** (Lilypad-Studio → Packages → libs → Package settings):
   - **Danger Zone → Change visibility**: check that it is **Private** (or **Internal** on GitHub Enterprise).
   - **Manage access**: add the teams or people who install it (role `Read`), and the maintainers (`Write`/`Admin`). With **Inherit access from source repository**, whoever can read the repository can install the package.
   - **Manage Actions access**: add each repository whose workflows install it (role `Read`).
6. **Migrate the applications** with [installing.md](installing.md).
7. Recommended: protect `main` (Settings → Rules → Rulesets) so that pull requests need the `check`, `smoke-test` and `integration` jobs of CI to pass.

## If a release fails

- The workflow runs again on the next push to `main`. `changeset publish` skips a version that is already on the registry, so it is safe to re-run the job (Actions → Release → Re-run jobs).
- A version cannot be published twice. To withdraw a broken version, publish a fixed one; deleting a version (Package settings → Manage versions) is possible for a private package but breaks the lockfiles that point to it.
