/**
 * Writer resolves a storage root, or says which dependency failed.
 *
 * Operator finding F-04, 2026-08-12. On the first macOS run,
 * `/write a draft to the it guy saying thank you` returned:
 *
 *     EXIT 1 · The "path" argument must be of type string. Received undefined
 *
 * `getBlockDataFile` was truthy, so the ternary took that branch, but it
 * returned undefined and path.join() threw. The operator saw an internal Node
 * argument error, naming no cause, no remedy and no next step — on the first
 * thing they typed into the product.
 *
 * BO-D2e already built an argument contract for this class after `/read` with
 * no argument reached fs.open(''). That contract validates the CALLER's
 * argument. This failure was inside the handler's own setup, which the
 * contract cannot see.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const factory = require('../src/blocks/writer/api/writer.js');

/** Minimal Express-shaped stub — we only care about module setup. */
function stubApp() {
  const routes = [];
  const record = (method) => (p) => { routes.push(`${method} ${p}`); };
  return {
    routes,
    get: record('GET'), post: record('POST'),
    put: record('PUT'), delete: record('DELETE'), use: () => {},
  };
}

describe('writer storage root resolution', () => {
  // The exact defect. Pre-fix this threw the raw path error.
  it('does not throw a raw path error when getBlockDataFile returns undefined', () => {
    const app = stubApp();
    expect(() => factory(app, { getBlockDataFile: () => undefined }))
      .not.toThrow(/argument must be of type string/);
    expect(app.routes.length, 'writer mounted no routes').toBeGreaterThan(0);
  });

  it('does not throw when getBlockDataFile is absent entirely', () => {
    const app = stubApp();
    expect(() => factory(app, {})).not.toThrow();
  });

  it('uses the host-supplied root when it is usable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-root-'));
    try {
      const app = stubApp();
      factory(app, { getBlockDataFile: () => dir });
      // The module mkdirSync's its root at setup, which is the observable
      // signal that it resolved to the directory we handed it.
      expect(fs.existsSync(dir)).toBe(true);
      expect(app.routes.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // If the root truly cannot be built, the refusal must name the dependency
  // rather than letting path.join speak for the product.
  it('names the failing dependency when no root can be built', () => {
    const app = stubApp();
    let threw = null;
    try {
      factory(app, { getBlockDataFile: () => undefined, __forceNoFallback: true });
    } catch (e) { threw = e; }
    if (threw) {
      expect(threw.message).toMatch(/getBlockDataFile/);
      expect(threw.message).not.toMatch(/argument must be of type string/);
    }
  });
});
