// BO-E1 — every block API module must actually mount.
//
// fleet_control/local-status.js shipped for months contributing zero routes:
// an arity-1 `(app) => { app.get(...) }` export receives blockDeps, calls .get
// on the sandbox proxy, is denied, and returns a bare handler. The host counted
// it as mounted anyway, so `35 API mounts` at boot was files processed, not
// routes served. The UI called /api/local-status and got Express's HTML 404.
//
// This drives the REAL block host over the REAL src/blocks tree. It does not
// re-implement the classification — that is the whole point (see the 2026-07-29
// finding on tests that cannot fail).
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BLOCKS_DIR = path.join(ROOT, 'src', 'blocks');

const { createBlockHost } = require('../src/kernel/blockHost.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-mount-test-'));

/**
 * Permissive stand-in for the sandbox proxy: never denies, so a module that
 * fails to mount fails for a STRUCTURAL reason, not a missing dependency.
 *
 * Path-shaped deps must answer with real strings — factories legitimately call
 * path.join() on them at construction time, and path.join type-checks rather
 * than coercing, so a blanket function stub would fail modules that are fine.
 */
function permissiveDeps() {
  const anything = () => permissiveDeps();
  return new Proxy(anything, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;                 // not a thenable
      if (prop === 'fs') return fs;
      if (prop === 'path') return path;
      if (/(ROOT|_FILE|_DIR|DIR|PATH|WORKSPACE)$/i.test(prop)) return TMP;
      if (/^get[A-Z]/.test(prop)) {
        return (...args) => path.join(TMP, ...args.filter(a => typeof a === 'string'));
      }
      return permissiveDeps();
    },
    apply() { return permissiveDeps(); },
  });
}

function mountAll() {
  const registry = [];
  const readiness = {};
  const silent = { log() {}, warn() {}, error() {} };
  const host = createBlockHost({
    blocksDir: BLOCKS_DIR,
    baseDeps: permissiveDeps(),
    createScopedDeps: () => permissiveDeps(),
    registry,
    readiness,
    getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
    log: silent,
  });
  return host.rescan('test');
}

describe('block API modules all mount', () => {
  const result = mountAll();

  it('mounts every discovered API module, or names the ones it cannot', () => {
    const names = (result.skipped || []).map(s => `${s.block}/${s.file} — ${s.why}`);
    expect(names, `unmounted API modules:\n  ${names.join('\n  ')}`).toEqual([]);
  });

  it('counts routes mounted, not files processed', () => {
    // The pre-fix counter incremented outside the success branch, so a dropped
    // module still added to the total. mounted must equal the modules that
    // genuinely produced routes.
    const apiFileCount = fs.readdirSync(BLOCKS_DIR)
      .filter(f => !f.startsWith('_'))
      .filter(f => { try { return fs.statSync(path.join(BLOCKS_DIR, f)).isDirectory(); } catch { return false; } })
      .reduce((n, folder) => {
        const dir = path.join(BLOCKS_DIR, folder, 'api');
        if (!fs.existsSync(dir)) return n;
        return n + fs.readdirSync(dir).filter(f => /\.(js|cjs)$/.test(f) && !f.startsWith('_')).length;
      }, 0);
    expect(result.mounted + (result.skipped || []).length).toBe(apiFileCount);
  });

  it('mounts the route that was silently dropped', () => {
    // Regression pin for the exact module. Named explicitly so a future
    // refactor that re-breaks this shape fails here with a readable reason.
    const dropped = (result.skipped || []).find(s => s.file === 'local-status.js');
    expect(dropped).toBeUndefined();
  });
});

describe('block API module shapes', () => {
  it('no API module is exported as arity-1 unless it returns a router', () => {
    // Complements the mount test: this one explains WHY when it breaks, since
    // the arity-1 ambiguity is the trap. Uses the host's own outcome, not a
    // parallel re-implementation.
    const result = mountAll();
    const ambiguous = (result.skipped || []).filter(s => /arity-1/.test(s.why));
    expect(ambiguous.map(s => `${s.block}/${s.file}`)).toEqual([]);
  });
});
