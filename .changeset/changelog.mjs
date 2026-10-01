// Writes the summary of each changeset as it is, so that it can hold the sections of CHANGELOG.md
// (`#### Upgrading` with its table, `#### Added`, ...), instead of the one-line bullet of the
// default changelog. The blank line keeps two changesets apart; scripts/merge-changelog-sections.ts
// then merges their sections (`npm run changeset:version`)
const changelogFunctions = {
  getReleaseLine: (changeset) => Promise.resolve(`\n${changeset.summary.trim()}\n`),
  getDependencyReleaseLine: () => Promise.resolve(''),
};

export default changelogFunctions;
