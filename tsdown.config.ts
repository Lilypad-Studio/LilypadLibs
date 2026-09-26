import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cache: 'src/entries/cache.ts',
    db: 'src/entries/db.ts',
    flow: 'src/entries/flow.ts',
    logger: 'src/entries/logger.ts',
    platform: 'src/entries/platform.ts',
    serializer: 'src/entries/serializer.ts',
    singleton: 'src/entries/singleton.ts',
  },
  // .cjs/.d.cts and .mjs/.d.mts; the modules shared by several entries go to common chunks, in both
  // formats: every entry uses the same copy of each module (e.g. of the logger classes)
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  outputOptions(options) {
    // The sources are ES modules, so strict: the CJS output must be too ("use strict" is not
    // emitted by default, as no source file contains it)
    options.strict = true;
    // Shared chunks go to a subfolder, so that dist/ lists only the entries
    const chunkFileNames = options.chunkFileNames;
    options.chunkFileNames =
      typeof chunkFileNames === 'function'
        ? (chunk) => `chunks/${chunkFileNames(chunk)}`
        : `chunks/${chunkFileNames}`;
    return options;
  },
});
