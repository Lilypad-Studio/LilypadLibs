import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  resolve: {
    // The `@/*` alias comes from the `paths` of tsconfig.json
    tsconfigPaths: true,
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/lilypad-doctor.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        // The tests of the modules exported by the edge-compatible entries, run again in an edge
        // runtime (no Node.js globals): they fail if these modules start relying on Node.js APIs
        extends: true,
        test: {
          name: 'edge',
          environment: 'edge-runtime',
          include: [
            'src/cache/LilypadCache*.test.ts',
            'src/cache/LilypadReadFlights.test.ts',
            'src/dbConfig/LilypadDbConfig*.test.ts',
            'src/dbConfig/LilypadDbHooks.test.ts',
            'src/dbConfig/LilypadPgTypes.test.ts',
            'src/flow/**/*.test.ts',
            'src/internal/**/*.test.ts',
            'src/logger/**/*.test.ts',
            'src/platform/**/*.test.ts',
            'src/serializer/**/*.test.ts',
            'src/singleton/**/*.test.ts',
          ],
        },
      },
      {
        // Requires Docker: each suite starts its own PostgreSQL container
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 30000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});

export default config;
