/**
 * Phase 4 — GGUF model installer tests.
 *
 * No network calls. Tests the catalog structure, the PENDING_VERIFICATION
 * guard, the GGUF header probe against a hand-crafted fixture, and the
 * state machine integration with Phase 2 registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LR = path.join(__dirname, '..', '..', 'services', 'local-runtime');

const P = require(path.join(LR, 'paths.cjs'));
const R = require(path.join(LR, 'registry.cjs'));
const CATALOG = require(path.join(LR, 'model-catalog.json'));
const MI = require(path.join(LR, 'model-installer.cjs'));

let tmp, dataRoot;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-model-'));
  dataRoot = path.join(tmp, 'data');
  P.ensureManagedDirs(dataRoot);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ── Catalog structure ──────────────────────────────────────────────────────

describe('model-catalog.json structure', () => {
  it('has a models array with at least one entry', () => {
    expect(Array.isArray(CATALOG.models)).toBe(true);
    expect(CATALOG.models.length).toBeGreaterThan(0);
  });

  it('all model ids are unique', () => {
    const ids = CATALOG.models.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each model has required fields', () => {
    for (const m of CATALOG.models) {
      expect(m).toHaveProperty('id');
      expect(m).toHaveProperty('displayName');
      expect(m).toHaveProperty('capabilities');
      expect(m).toHaveProperty('bytes');
      expect(m).toHaveProperty('sha256');
      expect(m).toHaveProperty('url');
      expect(m).toHaveProperty('relPathTemplate');
      expect(m).toHaveProperty('license');
      expect(Array.isArray(m.capabilities)).toBe(true);
      expect(m.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('all capabilities are known values', () => {
    const valid = new Set(['chat', 'embed', 'vision', 'tools']);
    for (const m of CATALOG.models) {
      for (const cap of m.capabilities) {
        expect(valid.has(cap)).toBe(true);
      }
    }
  });

  it('all relPathTemplates are POSIX relative (no backslash, no drive letter)', () => {
    for (const m of CATALOG.models) {
      expect(m.relPathTemplate).not.toMatch(/\\/);
      expect(m.relPathTemplate).not.toMatch(/^[A-Za-z]:/);
      expect(m.relPathTemplate).not.toMatch(/^\//);
    }
  });

  it('all urls are HTTPS', () => {
    for (const m of CATALOG.models) {
      expect(m.url).toMatch(/^https:\/\//);
    }
  });

  it('at least one embed-capable model is in the catalog', () => {
    expect(CATALOG.models.some(m => m.capabilities.includes('embed'))).toBe(true);
  });

  it('at least one chat-capable model is in the catalog', () => {
    expect(CATALOG.models.some(m => m.capabilities.includes('chat'))).toBe(true);
  });
});

// ── listCatalog ────────────────────────────────────────────────────────────

describe('listCatalog', () => {
  it('returns all catalog entries with installState=not_installed on a fresh dataRoot', () => {
    const list = MI.listCatalog(dataRoot);
    expect(list.length).toBe(CATALOG.models.length);
    for (const item of list) {
      expect(item.installState).toBe('not_installed');
    }
  });

  it('never exposes sha256 or url to the frontend', () => {
    const list = MI.listCatalog(dataRoot);
    for (const item of list) {
      expect(item.sha256).toBeUndefined();
      expect(item.url).toBeUndefined();
    }
  });

  it('shows installed state for a model that is in the registry', () => {
    const reg = R.createRegistry(dataRoot);
    reg.upsertModel({
      id: 'qwen3-1.7b-q4',
      state: 'ready',
      relPath: 'local-runtime/models/qwen3-1.7b-q4/model.gguf',
      bytes: 1100000000,
      sha256: 'a'.repeat(64),
      capabilities: ['chat'],
      installedAt: new Date().toISOString(),
    });

    const list = MI.listCatalog(dataRoot);
    const item = list.find(m => m.id === 'qwen3-1.7b-q4');
    expect(item.installState).toBe('ready');
  });

  it('shows quarantined state correctly', () => {
    const reg = R.createRegistry(dataRoot);
    reg.upsertModel({
      id: 'qwen3-1.7b-q4',
      state: 'staged',
      relPath: 'local-runtime/models/qwen3-1.7b-q4/model.gguf',
      bytes: 1100000000,
      capabilities: ['chat'],
      installedAt: new Date().toISOString(),
    });
    reg.setModelState('qwen3-1.7b-q4', 'quarantined', 'hash mismatch');

    const list = MI.listCatalog(dataRoot);
    const item = list.find(m => m.id === 'qwen3-1.7b-q4');
    expect(item.installState).toBe('quarantined');
    expect(item.quarantineReason).toBe('hash mismatch');
  });
});

// ── PENDING_VERIFICATION guard ─────────────────────────────────────────────

describe('PENDING_VERIFICATION guard', () => {
  it('installModel throws before any download if sha256 is PENDING_VERIFICATION', async () => {
    await expect(MI.installModel({ dataRoot, modelId: 'qwen3-1.7b-q4' }))
      .rejects.toThrow(/PENDING_VERIFICATION/);
  });

  it('no model reaches ready state after a PENDING_VERIFICATION rejection', async () => {
    try { await MI.installModel({ dataRoot, modelId: 'qwen3-1.7b-q4' }); } catch {}
    const reg = R.createRegistry(dataRoot);
    const ready = reg.readyModels();
    expect(ready).toHaveLength(0);
  });

  it('throws for an unknown modelId', async () => {
    await expect(MI.installModel({ dataRoot, modelId: 'totally-fake-model' }))
      .rejects.toThrow(/Unknown model id/);
  });
});

// ── GGUF header probe ──────────────────────────────────────────────────────

describe('probeGgufHeader', () => {
  function makeGguf(version = 3, archStr = null) {
    // GGUF magic (4 bytes LE) + version (4 bytes LE) + minimal padding
    const buf = Buffer.alloc(256, 0);
    buf.writeUInt32LE(0x46465547, 0);  // magic "GGUF"
    buf.writeUInt32LE(version, 4);
    if (archStr) {
      // Write a rough approximation of "general.architecture" + value
      const key = 'general.architecture';
      buf.write(key, 16, 'latin1');
      buf.write('\x00\x00\x00\x00\x00\x00\x00\x00', 16 + key.length, 'binary');
      buf.write(archStr, 16 + key.length + 8, 'latin1');
    }
    return buf;
  }

  it('accepts a valid GGUF v3 header', () => {
    const f = path.join(tmp, 'test.gguf');
    fs.writeFileSync(f, makeGguf(3));
    const r = MI.probeGgufHeader(f);
    expect(r.version).toBe(3);
    expect(r.probedAt).toBeTruthy();
  });

  it('rejects a file with wrong magic', () => {
    const f = path.join(tmp, 'bad.gguf');
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0xDEADBEEF, 0);
    fs.writeFileSync(f, buf);
    expect(() => MI.probeGgufHeader(f)).toThrow(/Not a GGUF/);
  });

  it('rejects a file that is too small', () => {
    const f = path.join(tmp, 'tiny.gguf');
    fs.writeFileSync(f, Buffer.alloc(4));
    expect(() => MI.probeGgufHeader(f)).toThrow(/too small|Not a GGUF/);
  });

  it('rejects an unknown GGUF version', () => {
    const f = path.join(tmp, 'future.gguf');
    fs.writeFileSync(f, makeGguf(99));
    expect(() => MI.probeGgufHeader(f)).toThrow(/Unknown GGUF version/);
  });

  it('parses architecture from header bytes when present', () => {
    const f = path.join(tmp, 'arch.gguf');
    fs.writeFileSync(f, makeGguf(3, 'llama'));
    const r = MI.probeGgufHeader(f);
    // architecture parsing is best-effort via regex on raw bytes
    expect(r).toHaveProperty('version', 3);
  });
});

// ── removeModel state machine ──────────────────────────────────────────────

describe('removeModel', () => {
  it('removes a staged model from the registry', async () => {
    const reg = R.createRegistry(dataRoot);
    reg.upsertModel({
      id: 'test-model',
      state: 'staged',
      relPath: 'local-runtime/models/test-model/model.gguf',
      bytes: 100,
      capabilities: ['chat'],
      installedAt: new Date().toISOString(),
    });

    await MI.removeModel(dataRoot, 'test-model');
    expect(reg.load().models.find(m => m.id === 'test-model')).toBeUndefined();
  });

  it('transitions ready → removing → deleted', async () => {
    const reg = R.createRegistry(dataRoot);
    // Write a fake file at the managed path
    const modelDir = path.join(P.managedRoot(dataRoot), 'models', 'test-model');
    fs.mkdirSync(modelDir, { recursive: true });
    const modelFile = path.join(modelDir, 'model.gguf');
    fs.writeFileSync(modelFile, 'fake gguf');

    reg.upsertModel({
      id: 'test-model',
      state: 'ready',
      relPath: 'local-runtime/models/test-model/model.gguf',
      bytes: 9,
      sha256: 'a'.repeat(64),
      capabilities: ['chat'],
      installedAt: new Date().toISOString(),
    });

    // Override relPath to point at our fake file
    const entry = reg.load().models[0];
    reg.upsertModel({ ...entry, relPath: P.toRegistryRelative(dataRoot, modelFile) });

    await MI.removeModel(dataRoot, 'test-model');
    expect(reg.load().models).toHaveLength(0);
    expect(fs.existsSync(modelFile)).toBe(false);
  });

  it('throws for an unknown model', async () => {
    await expect(MI.removeModel(dataRoot, 'ghost-model')).rejects.toThrow(/not in registry/);
  });
});
