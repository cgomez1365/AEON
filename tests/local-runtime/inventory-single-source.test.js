/**
 * BO-C · One local model inventory — the gates.
 *
 * Written BEFORE the deletions they protect (§21 step 2), against the defect
 * found on 2026-08-04: `status()` returns `readyModels`, and three separate
 * consumers read `.models` off it. The key does not exist, so each got `[]` and
 * reported "no local models" while a verified 4.9 GB GGUF sat ready on disk.
 *
 * The expression was copy-pasted three times from a site where it was CORRECT
 * (it read the legacy flat store, which really does carry `.models`). That is
 * the whole failure: right field name, wrong object. A test asserting the shape
 * of one and the identity of the other is what stops it recurring.
 *
 * These import the real modules. A gate that re-implements its subject stays
 * green while the shipped contract breaks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

const { createRegistry } = require(path.join(APP_ROOT, 'services', 'local-runtime', 'registry.cjs'));
const P = require(path.join(APP_ROOT, 'services', 'local-runtime', 'paths.cjs'));

// ── An isolated dataRoot carrying one ready runtime and one ready model ──────
// §18: a test may observe a live instance, it may not provision one. Everything
// below lives in a temp dir and is removed afterwards.
let dataRoot;
let reg;

const SHA = 'a'.repeat(64);

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-inventory-'));
  P.ensureManagedDirs(dataRoot);
  fs.writeFileSync(P.registryPath(dataRoot), JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    activeRuntimeId: 'llamacpp-test-cpu',
    runtimes: [{
      installedAt: new Date().toISOString(),
      id: 'llamacpp-test-cpu',
      state: 'ready',
      version: 'test',
      backend: 'cpu',
      platform: process.platform,
      arch: process.arch,
      relPath: 'local-runtime/runtime/llamacpp-test-cpu',
      entrypoint: 'llama-cli.exe',
      sha256: SHA,
    }],
    models: [
      {
        installedAt: new Date().toISOString(),
        id: 'gate-chat-model',
        state: 'ready',
        displayName: 'Gate Chat Model (Q4_K_M)',
        relPath: 'local-runtime/models/gate-chat-model/model.gguf',
        bytes: 1234,
        capabilities: ['chat'],
        quantization: 'Q4_K_M',
        contextCeiling: 4096,
        sha256: SHA,
      },
      // A quarantined entry must never be offered. This is the safetensors
      // class from Bible §17 — a 5.8 GB download that llama.cpp could not open
      // was reported ready for as long as "ready" meant "the download finished".
      {
        installedAt: new Date().toISOString(),
        id: 'gate-broken-model',
        state: 'quarantined',
        displayName: 'Not GGUF',
        relPath: 'local-runtime/models/gate-broken-model/model.safetensors',
        bytes: 99,
        capabilities: ['chat'],
        sha256: SHA,
      },
    ],
  }, null, 2), 'utf8');
  reg = createRegistry(dataRoot);
});

afterAll(() => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
});

// ── G1 · The status contract is frozen ───────────────────────────────────────
describe('gate: local-runtime status() shape', () => {
  const lr = require(path.join(APP_ROOT, 'services', 'local-runtime', 'index.cjs'));

  it('exposes readyModels and has no `models` key', () => {
    const st = lr.status();
    // The exact defect. `.models` returning undefined is what every consumer
    // silently turned into []. If a future rename adds `.models` back, every
    // one of those consumers becomes wrong again in a different direction —
    // so the absence is asserted, not merely the presence.
    expect(st).toHaveProperty('readyModels');
    expect(st.models, 'status() must not grow a `models` key').toBeUndefined();
    expect(Array.isArray(st.readyModels)).toBe(true);
  });

  it('keeps the diagnostic key set stable', () => {
    const st = lr.status();
    if (st.error) return; // no runtime on this machine — shape below is moot
    expect(Object.keys(st).sort()).toEqual(
      ['available', 'readyModels', 'runtimeBackend', 'runtimeId', 'runtimeVersion'].sort()
    );
  });
});

// ── G2 · One named reader, used by every consumer ────────────────────────────
describe('gate: listReadyModels() is the single read path', () => {
  const lr = require(path.join(APP_ROOT, 'services', 'local-runtime', 'index.cjs'));

  it('is exported', () => {
    expect(typeof lr.listReadyModels).toBe('function');
  });

  it('returns ready models from a registry, and never quarantined ones', () => {
    const models = reg.readyModels();
    expect(models.map(m => m.id)).toEqual(['gate-chat-model']);
    expect(models.map(m => m.id)).not.toContain('gate-broken-model');
  });

  it('every entry carries the fields the pickers render', () => {
    for (const m of reg.readyModels()) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(Array.isArray(m.capabilities)).toBe(true);
    }
  });

  it('capability filtering is honoured — a chat picker never offers embed-only', () => {
    expect(reg.modelsForCapability('chat').map(m => m.id)).toEqual(['gate-chat-model']);
    expect(reg.modelsForCapability('embed')).toEqual([]);
  });
});

// ── G3 · No consumer re-derives the list by hand ─────────────────────────────
// A scanner, deliberately. The invariant is architectural — "there is one reader"
// is a statement about the whole tree, and no single behavioural test can see it.
describe('gate: no module re-implements the local model list', () => {
  const SUSPECT = /\.status\(\)[\s\S]{0,80}?\.models\b|status\(\)\.models\b/;

  // Scan CODE, not prose. The first run of this gate flagged the very comment
  // written to explain the defect — a scanner that reads commentary makes
  // documenting a fix impossible, and would train the next person to delete
  // the explanation rather than the offending line.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments, sparing "http://"
  }

  /** Every .js/.cjs/.jsx under src/ and services/, excluding the owner. */
  function sourceFiles() {
    const roots = [path.join(APP_ROOT, 'src'), path.join(APP_ROOT, 'services')];
    const owner = path.join(APP_ROOT, 'services', 'local-runtime');
    const out = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || full.startsWith(owner)) continue;
          walk(full);
        } else if (/\.(js|cjs|mjs|jsx)$/.test(e.name)) {
          out.push(full);
        }
      }
    };
    roots.forEach(walk);
    return out;
  }

  it('nothing outside services/local-runtime reads `.models` off a status object', () => {
    const offenders = sourceFiles()
      .filter(f => SUSPECT.test(stripComments(fs.readFileSync(f, 'utf8'))));
    expect(
      offenders.map(f => path.relative(APP_ROOT, f)),
      'use listReadyModels() instead of indexing status()'
    ).toEqual([]);
  });

  it('the legacy flat registry has no readers left', () => {
    const offenders = sourceFiles()
      .filter(f => /readLocalRuntime/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(APP_ROOT, f));
    expect(offenders, 'readLocalRuntime was retired with the legacy store').toEqual([]);
  });
});

// ── G4 · One writer, one file ────────────────────────────────────────────────
describe('gate: the registry has a single writer', () => {
  it('registry.cjs owns the managed registry path', () => {
    // paths.cjs is the only path authority; the registry file lives under the
    // managed subtree, never at <dataRoot>/local-runtime.json.
    const p = P.registryPath(dataRoot);
    expect(p).toBe(path.join(dataRoot, 'local-runtime', 'local-runtime.json'));
    expect(p).not.toBe(path.join(dataRoot, 'local-runtime.json'));
  });

  it('no module writes the retired flat registry', () => {
    const cookbook = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'blocks', 'cookbook', 'api', 'index.cjs'), 'utf8');
    expect(cookbook).not.toMatch(/function\s+writeLocalRuntime/);
    expect(cookbook).not.toMatch(/getDataFile\(\s*['"]local-runtime\.json['"]\s*\)/);
  });

  it('the architecture record names the real registry path', () => {
    const doc = fs.readFileSync(
      path.join(APP_ROOT, 'docs', 'architecture', 'native-local-runtime.md'), 'utf8');
    // The doc named `data/local-runtime.json` while that path held the LEGACY
    // file and the real registry sat one directory down — two writers where the
    // record specified one.
    expect(doc).toContain('data/local-runtime/local-runtime.json');
  });
});

// ── G5 · Absence renders as absence, with a remedy ───────────────────────────
describe('gate: an empty inventory is stated, not blank', () => {
  it('an empty registry yields an empty list rather than throwing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-inventory-empty-'));
    try {
      P.ensureManagedDirs(empty);
      const r = createRegistry(empty);
      expect(r.readyModels()).toEqual([]);
      expect(r.activeRuntime()).toBeNull();
    } finally {
      try { fs.rmSync(empty, { recursive: true, force: true }); } catch {}
    }
  });

  it('the model picker names the remedy when the list is empty', () => {
    // §08: an error must name every remedy, cheapest first. A blank <select>
    // tells the operator nothing they can act on.
    const src = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    expect(src).toMatch(/Cookbook/);
  });
});
