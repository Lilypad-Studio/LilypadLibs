// Writes the summary of each changeset as it is, so that it can hold the sections of CHANGELOG.md
// (`#### Upgrading` with its table, `#### Added`, ...), instead of the one-line bullet of the
// default changelog
const changelogFunctions = {
  getReleaseLine: (changeset) => Promise.resolve(`${changeset.summary.trim()}\n`),
  getDependencyReleaseLine: () => Promise.resolve(''),
};

export default changelogFunctions;
