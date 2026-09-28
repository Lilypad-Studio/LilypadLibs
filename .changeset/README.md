# Changesets

Each change that users of the library should know about comes with a changeset: run
`npx changeset`, pick the bump (`patch` for a fix, `minor` for a feature or, before 1.0, a breaking
change), and write the entry of CHANGELOG.md in Markdown. The release workflow turns them into a
version and its CHANGELOG.md section: see [docs/releasing.md](../docs/releasing.md).

An entry holds a section per kind of change, as in CHANGELOG.md:

- `#### Upgrading`: a table `| Change | What to do |` for what breaks existing code;
- `#### Added`, `#### Changed`, `#### Fixed`: bullets.
