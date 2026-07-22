import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native SQLite adapter qualification intentionally exercises multiple
    // connections and busy-timeout behavior. Run files serially so independent
    // fixture databases do not turn global experimental-driver contention into
    // timing-dependent failures.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
