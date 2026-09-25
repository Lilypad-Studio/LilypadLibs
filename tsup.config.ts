import { defineConfig } from 'tsup';

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
  format: ['cjs', 'esm'],
  dts: true,
  // Shared chunks: every entry uses the same copy of each module (e.g. of the logger classes)
  splitting: true,
  sourcemap: true,
  clean: true,
  // Shared chunks go to a subfolder, so that dist/ lists only the entries
  esbuildOptions(options) {
    options.chunkNames = 'chunks/[name]-[hash]';
  },
});
