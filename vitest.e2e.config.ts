import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests run the built CLI (dist/index.js) as a child process with a throwaway
 * HOME, so they exercise real argument parsing, storage and output. Run `npm run build`
 * first (`npm run verify` does).
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60000,
  },
});
