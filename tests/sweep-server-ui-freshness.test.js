/**
 * An interface older than its source is detected and said, never refused (C31).
 *
 * 2026-09-28: the server served whatever dist/ was last built. dist/ is
 * gitignored and the drive's launchers never build, so after 1cee797 made
 * /api/settings/export-credentials POST-only, the live bundle still offered a
 * GET download link nothing served, and the operator's only credential backup
 * failed silently. The server now compares dist/index.html with the newest
 * file the bundle is built from, logs it at boot, and sends X-AEON-UI-Stale
 * on every response while it holds.
 *
 * Every app root here is a mkdtemp folder with fixed file times.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const { uiFreshness, watchUiFreshness } = require('../src/kernel/runtime.cjs');

const HOUR = 3600 * 1000;
const BUILT = Date.parse('2026-09-27T22:07:00Z');
let app;

function put(rel, atMs, text = 'x') {
  const f = path.join(app, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(atMs);
  fs.utimesSync(f, t, t);
}

beforeEach(() => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ui-fresh-'));
  put('dist/index.html', BUILT);
  put('index.html', BUILT - HOUR);
  put('src/main.jsx', BUILT - HOUR);
  put('src/blocks/settings/index.jsx', BUILT - HOUR);
});
afterEach(() => { fs.rmSync(app, { recursive: true, force: true }); });

describe('uiFreshness (C31)', () => {
  it('a build newer than every source is fresh', () => {
    const f = uiFreshness({ appRoot: app });
    expect(f.stale).toBe(false);
    expect(f.builtAt).toBe(new Date(BUILT).toISOString());
  });

  it('a UI source changed after the build (a pull) makes it stale, naming the file', () => {
    put('src/blocks/settings/index.jsx', BUILT + 14 * HOUR);
    const f = uiFreshness({ appRoot: app });
    expect(f.stale).toBe(true);
    expect(f.newest.file).toBe('src/blocks/settings/index.jsx');
    expect(f.newest.changedAt).toBe(new Date(BUILT + 14 * HOUR).toISOString());
  });

  it.each([
    ['src/aurora.css'],
    ['src/kernel/blockRegistry.js'],
    ['index.html'],
  ])('%s counts as interface source', (rel) => {
    put(rel, BUILT + HOUR);
    expect(uiFreshness({ appRoot: app }).stale).toBe(true);
  });

  it.each([
    ['src/kernel/routers/console.cjs', 'server code'],
    ['src/blocks/settings/api/settings.js', 'a block API'],
    ['src/blocks/writer/data/drafts.json', 'block data'],
    ['src/blocks/writer/db/store.js', 'block db'],
    ['src/blocks/writer/.aeon.runtime.json', 'written on every boot'],
    ['src/blocks/._index.jsx', 'an AppleDouble file on exFAT'],
    ['src/blocks/aeon_matrix/public/vendor/graph-bundle.mjs', 'served as-is, not bundled'],
    ['src/blocks/writer/README.md', 'docs'],
    ['src/blocks/aeon_matrix/block.manifest.json', 'rewritten by syncAllBlocks on every boot'],
  ])('%s (%s) never makes the interface stale', (rel) => {
    put(rel, BUILT + 5 * HOUR);
    expect(uiFreshness({ appRoot: app }).stale).toBe(false);
  });

  it('a copy that did not keep file times (seconds apart) is not stale', () => {
    put('src/main.jsx', BUILT + 30 * 1000);
    expect(uiFreshness({ appRoot: app }).stale).toBe(false);
  });

  it('no dist/ is nothing to be stale', () => {
    fs.rmSync(path.join(app, 'dist'), { recursive: true });
    put('src/main.jsx', BUILT + HOUR);
    expect(uiFreshness({ appRoot: app })).toEqual({ stale: false, builtAt: null, newest: null });
  });
});

describe('watchUiFreshness (C31)', () => {
  it('re-reads after its ttl, so a rebuild clears the header without a restart', () => {
    let now = 0;
    const check = watchUiFreshness({ appRoot: app, ttlMs: 1000, clock: () => now });
    put('src/main.jsx', BUILT + HOUR);
    const stale = check();
    expect(stale.stale).toBe(true);
    // ASCII only — a header with anything else throws in setHeader.
    expect(stale.header).toMatch(/^[\x20-\x7e]+$/);
    expect(stale.header).toBe(`built=${new Date(BUILT).toISOString()}; source=${new Date(BUILT + HOUR).toISOString()}`);

    put('dist/index.html', BUILT + 2 * HOUR); // npm run build
    now = 500;
    expect(check().stale).toBe(true); // cached
    now = 1500;
    expect(check()).toMatchObject({ stale: false, header: null });
  });
});

describe('server.js says so (C31)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

  it('sends X-AEON-UI-Stale ahead of every router', () => {
    const at = src.indexOf("res.setHeader('X-AEON-UI-Stale'");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf("app.use('/api', security.tunnelGate)"));
    expect(src).toMatch(/watchUiFreshness\(\{ appRoot: ROOT \}\)/);
  });

  it('logs it where the bundle is served, and still serves it', () => {
    const block = src.slice(src.indexOf("const DIST = path.join(ROOT, 'dist')"), src.indexOf('// ── Global error handler'));
    expect(block).toMatch(/npm run build/);
    expect(block).toMatch(/app\.use\(express\.static\(DIST\)\)/);
  });
});
