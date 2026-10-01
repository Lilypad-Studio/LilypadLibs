// The module folders of src/, by runtime. The edge folders are those of the edge-compatible
// entries (every entry except `db`; the command is Node.js-only too): eslint.config.mjs forbids Node.js and
// database imports in them, vitest.config.ts runs their tests again in an edge runtime, and
// src/entries/entries.test.ts checks that every folder of src/ is in one of the two lists
// (src/entries/ excepted: its files are checked one by one)

/** The folders of src/ whose modules must run in edge runtimes. */
export const edgeFolders: readonly string[] = [
  'cache',
  'dbConfig',
  'flow',
  'internal',
  'logger',
  'platform',
  'serializer',
  'singleton',
];

/** The folders of src/ whose modules may use Node.js APIs and postgres.js. */
export const nodeOnlyFolders: readonly string[] = ['cli', 'dbCache', 'dbGate'];
