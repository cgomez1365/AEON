import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,cjs,mjs}'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/kernel/**/*.cjs'],
    },
  },
});
