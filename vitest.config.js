import { defineConfig } from 'vitest/config';
import os from 'os';

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
    // BO-SHIP P10 — bound the worker pool.
    //
    // The suite failed roughly 1 run in 4 on an 8-core machine, and it was not
    // a test failing:
    //
    //   Error: [vitest-pool]: Worker forks emitted error.
    //   Caused by: Error: Worker exited unexpectedly
    //
    // Unbounded forks spawn one worker per core, and several of this suite's
    // files load the kernel, the block host and the local-runtime registry —
    // each of which opens files and spawns probes. Under that load a worker
    // process dies and takes the whole run with it, regardless of which tests
    // it was carrying. That is why the failure appeared to move between files
    // and why it was long blamed on storage-contract.test.js.
    //
    // Half the cores, floor of 2. The suite takes a few seconds longer and
    // stops dying. §19 — a gate that fails randomly is a gate people learn to
    // re-run, which is the same as not having one.
    poolOptions: {
      forks: { maxForks: Math.max(2, Math.floor((os.cpus().length || 4) / 2)) },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/kernel/**/*.cjs'],
    },
  },
});
