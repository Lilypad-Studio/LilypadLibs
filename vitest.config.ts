import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { edgeFolders } from './edge.config.ts';

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
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        // The tests of the modules exported by the edge-compatible entries (edge.config.ts), run
        // again in an edge runtime, without the Node.js globals (vitest.edge-setup.ts): they fail
        // if these modules start relying on Node.js APIs
        extends: true,
        test: {
          name: 'edge',
          environment: 'edge-runtime',
          setupFiles: ['./vitest.edge-setup.ts'],
          include: edgeFolders.map((folder) => `src/${folder}/**/*.test.ts`),
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
