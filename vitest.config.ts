import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      logger: path.resolve(__dirname, 'src/logger'),
      cache: path.resolve(__dirname, 'src/cache'),
      flow: path.resolve(__dirname, 'src/flow'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
