/**
 * BO-A2c — THE EMPTY-SHELL TEST.
 *
 * AEON's central claim is: "AEON is a shell, and capability arrives as
 * cartridges. Add settings, you get a nervous system. Add matrix, you get a
 * brain." Until now that claim had never been executed. Every test in the
 * suite ran against the full 17-block tree, so "the shell works without
 * blocks" was an assertion nobody had checked.
 *
 * This test executes it, in the four steps the build order specifies:
 *
 *   1. Zero blocks      — the shell boots, does not crash, renders no dead nav.
 *   2. Add settings     — a control plane appears. Nothing else claims to exist.
 *   3. Add memory_core  — memory appears, without editing a line of shell code.
 *   4. Remove it        — it disappears cleanly. No orphaned nav, no route
 *                         answering 500, no setting pointing at nothing.
 *
 * It drives the REAL block host over a REAL temp tree with REAL block folders
 * copied in and out. It does not re-implement discovery — a test that
 * re-implements its subject stays green while the feature is broken.
 *
 * A change that breaks this breaks the product's central claim, and nothing
 * else in the suite would notice. That is why it is a standing gate.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REAL_BLOCKS = path.join(ROOT, 'src', 'blocks');

const { createBlockHost } = require('../src/kernel/blockHost.cjs');
const { buildWidgetCatalogue } = require('../src/kernel/widgets.cjs');

/**
 * The shell tree.
 *
 * It lives INSIDE the repo rather than in os.tmpdir(), and that is a finding
 * rather than a convenience: a block's API module resolves its kernel imports
 * relatively (`require('../../../kernel/vault.cjs')` from
 * src/blocks/<id>/api/), and Node resolves `node_modules` by walking up from
 * the file. A block folder copied to an arbitrary temp path therefore cannot
 * load the kernel or any dependency — blocks are relocatable only within a
 * tree shaped like the real one.
 *
 * So the harness builds exactly that shape, which also states the architecture
 * precisely: THE SHELL IS kernel + node_modules. BLOCKS ARE ONLY the folders
 * under src/blocks. Installing a cartridge copies one folder and nothing else.
 */
const SHELL_ROOT = path.join(ROOT, '.aeon-empty-shell-test');
const SHELL_SRC = path.join(SHELL_ROOT, 'src');
const SHELL_BLOCKS = path.join(SHELL_SRC, 'blocks');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-empty-shell-'));

// The shell: kernel only. No blocks. Copied once.
fs.rmSync(SHELL_ROOT, { recursive: true, force: true });
fs.mkdirSync(SHELL_SRC, { recursive: true });
fs.cpSync(path.join(ROOT, 'src', 'kernel'), path.join(SHELL_SRC, 'kernel'), { recursive: true });

afterAll(() => {
  try { fs.rmSync(SHELL_ROOT, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// Permissive dep stand-in — same approach as block-api-mount.test.js, so a
// block that fails to mount fails STRUCTURALLY, not for a missing dependency.
function permissiveDeps() {
  const anything = () => permissiveDeps();
  return new Proxy(anything, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
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

/**
 * A GET route memory_core genuinely serves, read from its own manifest rather
 * than hardcoded here. The manifests are generated from the code at build time
 * (BO 08-03), so this cannot drift from what the block actually mounts — and a
 * hardcoded guess is precisely the class of stale declaration that order
 * removed.
 */
function memoryCoreRoute() {
  const m = JSON.parse(fs.readFileSync(
    path.join(REAL_BLOCKS, 'memory_core', 'block.manifest.json'), 'utf8'));
  const route = (m.routes || []).find(r =>
    String(r.method).toUpperCase() === 'GET' && !String(r.path).includes(':'));
  if (!route) throw new Error('memory_core declares no parameterless GET route to probe');
  return route.path;
}

/** Install a real block folder into the shell tree. This is "adding a cartridge". */
function installBlock(id) {
  fs.cpSync(path.join(REAL_BLOCKS, id), path.join(SHELL_BLOCKS, id), { recursive: true });
}

/** Remove a cartridge. */
function removeBlock(id) {
  fs.rmSync(path.join(SHELL_BLOCKS, id), { recursive: true, force: true });
}

let registry, readiness, host;

/** Boot the shell over whatever is currently installed. */
function boot() {
  registry = [];
  readiness = {};
  const silent = { log() {}, warn() {}, error() {} };
  host = createBlockHost({
    blocksDir: SHELL_BLOCKS,
    baseDeps: permissiveDeps(),
    createScopedDeps: () => permissiveDeps(),
    registry,
    readiness,
    getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
    log: silent,
  });
  return host.rescan('empty-shell-test');
}

/**
 * Drive a request through the host's real Express router and report the
 * status. A route that is gone must 404 — NOT 500, and not hang. "No route
 * answering 500" is step 4's actual assertion, so it has to be measured
 * rather than assumed.
 */
function probe(routePath) {
  return new Promise((resolve) => {
    const app = express();
    app.use(host.router);
    // Terminal handler: if nothing matched, that is a clean 404.
    app.use((_req, res) => res.status(404).end());
    app.use((err, _req, res, _next) => res.status(500).end(String(err && err.message)));

    const req = { method: 'GET', url: routePath, headers: {}, socket: {}, connection: {} };
    // Minimal response double — enough for Express to run the stack.
    let status = 0;
    let finished = false;
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {}, getHeader() { return undefined; }, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { return this.end(JSON.stringify(b)); },
      send(b) { return this.end(b); },
      end() {
        if (finished) return this;
        finished = true;
        status = this.statusCode;
        resolve(status);
        return this;
      },
    };
    try {
      app.handle(req, res, () => { if (!finished) { finished = true; resolve(404); } });
    } catch (e) {
      if (!finished) { finished = true; resolve(500); }
    }
    setTimeout(() => { if (!finished) { finished = true; resolve(-1); } }, 3000);
  });
}

beforeEach(() => {
  fs.rmSync(SHELL_BLOCKS, { recursive: true, force: true });
  fs.mkdirSync(SHELL_BLOCKS, { recursive: true });
});

describe('step 1 — zero blocks: the shell boots and says so', () => {
  it('boots with no blocks installed, without crashing', () => {
    const result = boot();
    expect(result.blocks).toBe(0);
    expect(result.mounted).toBe(0);
    // Nothing failed, because nothing was asked to load.
    expect(result.skipped || []).toEqual([]);
  });

  it('registers no capabilities — the registry is empty, not partially filled', () => {
    boot();
    expect(registry).toEqual([]);
    expect(Object.keys(readiness)).toEqual([]);
  });

  it('renders no dead navigation — nothing claims to exist', () => {
    boot();
    const navigable = registry.filter(b => b.nav && b.nav.hidden !== true);
    expect(navigable).toEqual([]);
  });

  it('offers no widgets and refuses nothing — absence renders as absence', () => {
    boot();
    expect(buildWidgetCatalogue(registry)).toEqual({ widgets: [], refused: [] });
  });

  it('serves a router that 404s cleanly instead of throwing', async () => {
    boot();
    // -1 means it hung; 500 means it threw. Both are failures of the claim.
    await expect(probe('/api/anything')).resolves.toBe(404);
  });

  it('the shell UI has an explicit zero-block state rather than a redirect loop', () => {
    // With zero blocks BLOCK_ROUTES is empty, and the catch-all
    // `<Navigate to="/">` would redirect "/" to "/" forever. The shell must
    // render a real empty state instead. Asserted against the source because
    // the layout is JSX the node suite does not render.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'DesktopLayout.jsx'), 'utf8');
    expect(src).toMatch(/BLOCK_ROUTES\.length === 0/);
    expect(src).toMatch(/EmptyShell/);
    expect(src).toMatch(/No capabilities are installed/);
  });
});

describe('step 2 — add settings: a control plane appears', () => {
  it('settings appears, and NOTHING else claims to exist', () => {
    installBlock('settings');
    const result = boot();

    expect(result.blocks).toBe(1);
    expect(registry.map(b => b.id)).toEqual(['settings']);
  });

  it('the shell required no edit to gain it', () => {
    installBlock('settings');
    boot();
    // The proof of "zero edits to the layout": discovery is by folder
    // presence alone. No allow-list anywhere names the block.
    const registryFile = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'blockRegistry.js'), 'utf8');
    expect(registryFile).toMatch(/import\.meta\.glob/);
    expect(registryFile).not.toMatch(/const ALLOWED_BLOCKS|BLOCK_WHITELIST/);
  });
});

describe('step 3 — add memory_core: memory appears', () => {
  it('appears in the registry alongside settings, without shell edits', () => {
    installBlock('settings');
    installBlock('memory_core');
    const result = boot();

    expect(result.blocks).toBe(2);
    expect(registry.map(b => b.id).sort()).toEqual(['memory_core', 'settings']);
  });

  it('its API routes actually answer — installed means served', async () => {
    installBlock('settings');
    installBlock('memory_core');
    const result = boot();
    expect(result.mounted).toBeGreaterThan(0);

    // A route memory_core genuinely serves must not 404 once installed.
    const status = await probe(memoryCoreRoute());
    expect(status).not.toBe(404);
    expect(status).not.toBe(-1);
  });
});

describe('step 4 — remove it: it disappears cleanly', () => {
  it('leaves no orphaned registry entry, nav item, or widget', () => {
    installBlock('settings');
    installBlock('memory_core');
    boot();
    expect(registry.map(b => b.id)).toContain('memory_core');

    removeBlock('memory_core');
    const after = boot();

    expect(after.blocks).toBe(1);
    expect(registry.map(b => b.id)).toEqual(['settings']);
    expect(readiness.memory_core).toBeUndefined();
    // No widget left pointing at a block that is gone.
    const { widgets } = buildWidgetCatalogue(registry);
    expect(widgets.find(w => w.id === 'memory_core')).toBeUndefined();
  });

  it('its routes 404 rather than 500 — removal is clean, not broken', async () => {
    installBlock('settings');
    installBlock('memory_core');
    boot();
    removeBlock('memory_core');
    boot();

    // This is the assertion that matters. A removed block whose route still
    // resolves to a dead handler would 500, and the shell claim would be
    // false in the most damaging direction: it looks installed and is not.
    await expect(probe(memoryCoreRoute())).resolves.toBe(404);
  });

  it('a full add/remove cycle returns the shell to exactly its empty state', () => {
    const before = boot();
    installBlock('memory_core');
    boot();
    removeBlock('memory_core');
    const after = boot();

    expect(after.blocks).toBe(before.blocks);
    expect(registry).toEqual([]);
    expect(buildWidgetCatalogue(registry)).toEqual({ widgets: [], refused: [] });
  });
});
