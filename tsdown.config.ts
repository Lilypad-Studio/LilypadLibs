import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cache: 'src/entries/cache.ts',
    db: 'src/entries/db.ts',
    flow: 'src/entries/flow.ts',
    logger: 'src/entries/logger.ts',
    platform: 'src/entries/platform.ts',
    schema: 'src/entries/schema.ts',
    serializer: 'src/entries/serializer.ts',
    singleton: 'src/entries/singleton.ts',
    // The `lilypad-doctor` command (package.json `bin`)
    'lilypad-doctor': 'src/cli/lilypad-doctor.ts',
  },
  // ES modules only (.mjs/.d.mts): Node.js 22.12+ also loads them with require(). One format means
  // one copy of each class, so `instanceof` works whatever the importer. The modules shared by
  // several entries go to common chunks: every entry uses the same copy of each module
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outputOptions(options) {
    // Shared chunks go to a subfolder, so that dist/ lists only the entries
    const chunkFileNames = options.chunkFileNames;
    options.chunkFileNames =
      typeof chunkFileNames === 'function'
        ? (chunk) => `chunks/${chunkFileNames(chunk)}`
        : `chunks/${chunkFileNames}`;
    return options;
  },
});
