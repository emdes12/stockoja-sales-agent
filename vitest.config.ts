import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Database tests share one test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15000,
    setupFiles: ['tests/setup.ts'],
  },
});
