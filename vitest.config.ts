import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'json', 'html'],
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
            'src/flow/**/*.test.ts',
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
