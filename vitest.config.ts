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
