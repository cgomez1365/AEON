import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,cjs,mjs}'],
    // Runs once per worker BEFORE any test module is imported. Redirects the
    // storage roots that kernel modules mkdirSync at module scope, so the suite
    // cannot create secrets/ or data/ inside the install it is testing.
    // See tests/setup-isolation.js for why this cannot be done per file.
    setupFiles: ['./tests/setup-isolation.js'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/kernel/**/*.cjs'],
    },
  },
});
