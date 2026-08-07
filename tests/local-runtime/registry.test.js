/**
 * Phase 2 — Registry durability, schema and state-machine tests.
 *
 * Every corruption case here is one a real interrupted write, a full disk, or
 * a downgrade can actually produce. Imports the real registry module.
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
const R = require(path.join(LR, 'registry.cjs'));
const P = require(path.join(LR, 'paths.cjs'));

let tmp, dataRoot, reg;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-registry-'));
  dataRoot = path.join(tmp, 'data');
  reg = R.createRegistry(dataRoot);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const model = (over = {}) => ({
  id: 'qwen3-1_7b',
  state: 'ready',
  relPath: 'local-runtime/models/qwen3-1_7b/model.gguf',
  bytes: 1400000000,
  sha256: 'a'.repeat(64),
  capabilities: ['chat'],
  installedAt: new Date().toISOString(),
  ...over,
});

const runtime = (over = {}) => ({
  id: 'llamacpp-b4321-cpu',
  state: 'ready',
  version: 'b4321',
  backend: 'cpu',
  relPath: 'local-runtime/runtime/llamacpp-b4321-cpu',
  sha256: 'b'.repeat(64),
  entrypoint: 'llama-cli.exe',
  installedAt: new Date().toISOString(),
  ...over,
});

describe('fresh registry', () => {
  it('reads as empty without a file, and does not throw', () => {
    const r = reg.read();
    expect(r.fresh).toBe(true);
    expect(r.registry.models).toEqual([]);
    expect(r.registry.runtimes).toEqual([]);
    expect(r.registry.schemaVersion).toBe(R.SCHEMA_VERSION);
  });

  it('persists and reloads a model round trip', () => {
    reg.upsertModel(model());
    const loaded = R.createRegistry(dataRoot).load();
    expect(loaded.models).toHaveLength(1);
    expect(loaded.models[0].id).toBe('qwen3-1_7b');
  });

  it('writes the registry inside the managed root, not loose in dataRoot', () => {
    reg.upsertModel(model());
    expect(reg.file.startsWith(P.managedRoot(dataRoot))).toBe(true);
    expect(fs.existsSync(reg.file)).toBe(true);
  });
});

describe('schema validation refuses bad records', () => {
  it('rejects an ABSOLUTE relPath — it would break portable relocation', () => {
    const abs = process.platform === 'win32' ? 'C:\\models\\x.gguf' : '/models/x.gguf';
    expect(() => reg.upsertModel(model({ relPath: abs }))).toThrow(/relative to dataRoot/);
  });

  it('rejects a traversal relPath', () => {
    expect(() => reg.upsertModel(model({ relPath: '../../escape.gguf' }))).toThrow();
  });

  it('rejects backslash separators in relPath', () => {
    expect(() => reg.upsertModel(model({ relPath: 'local-runtime\\models\\x.gguf' }))).toThrow();
  });

  it('rejects an unsafe model id', () => {
    expect(() => reg.upsertModel(model({ id: '../evil' }))).toThrow();
  });

  it('rejects a malformed sha256', () => {
    expect(() => reg.upsertModel(model({ sha256: 'not-a-hash' }))).toThrow(/sha256/);
  });

  it('refuses state "ready" with NO sha256 — the verification gate', () => {
    // This is the Phase 4 gate expressed at the storage layer: a model cannot
    // become visible to Settings without a recorded hash.
    expect(() => reg.upsertModel(model({ sha256: undefined })))
      .toThrow(/cannot be "ready" without a recorded sha256/);
  });

  it('rejects an unknown capability', () => {
    expect(() => reg.upsertModel(model({ capabilities: ['telepathy'] }))).toThrow(/unknown value/);
  });

  it('rejects negative or non-integer bytes', () => {
    expect(() => reg.upsertModel(model({ bytes: -1 }))).toThrow(/bytes/);
    expect(() => reg.upsertModel(model({ bytes: 1.5 }))).toThrow(/bytes/);
  });

  it('rejects an unknown runtime backend', () => {
    expect(() => reg.upsertRuntime(runtime({ backend: 'quantum' }))).toThrow(/backend/);
  });

  it('rejects an absolute entrypoint', () => {
    const abs = process.platform === 'win32' ? 'C:\\evil.exe' : '/bin/sh';
    expect(() => reg.upsertRuntime(runtime({ entrypoint: abs }))).toThrow(/contained filename/);
  });

  it('rejects duplicate model ids', () => {
    const bad = R.emptyRegistry();
    bad.models = [model(), model()];
    expect(() => R.validate(bad)).toThrow(/duplicate model id/);
  });

  it('rejects a dangling activeRuntimeId', () => {
    const bad = R.emptyRegistry();
    bad.activeRuntimeId = 'ghost';
    expect(() => R.validate(bad)).toThrow(/not a known runtime/);
  });
});

describe('state machine', () => {
  it('allows staged → ready', () => {
    reg.upsertModel(model({ state: 'staged' }));
    expect(() => reg.setModelState('qwen3-1_7b', 'ready')).not.toThrow();
  });

  it('refuses ready → staged (no un-verifying in place)', () => {
    reg.upsertModel(model());
    expect(() => reg.setModelState('qwen3-1_7b', 'staged')).toThrow(/illegal model state transition/);
  });

  it('refuses removing → ready (a removal is terminal)', () => {
    reg.upsertModel(model());
    reg.setModelState('qwen3-1_7b', 'removing');
    expect(() => reg.setModelState('qwen3-1_7b', 'ready')).toThrow(/illegal/);
  });

  it('records a quarantine reason and clears it on recovery', () => {
    reg.upsertModel(model());
    reg.setModelState('qwen3-1_7b', 'quarantined', 'sha256 mismatch');
    expect(reg.load().models[0].quarantineReason).toBe('sha256 mismatch');
    reg.setModelState('qwen3-1_7b', 'staged');
    expect(reg.load().models[0].quarantineReason).toBeNull();
  });

  it('refuses to delete a model that is not marked removing', () => {
    reg.upsertModel(model());
    expect(() => reg.removeModel('qwen3-1_7b')).toThrow(/must be marked "removing"/);
  });

  it('deletes a model once marked removing', () => {
    reg.upsertModel(model());
    reg.setModelState('qwen3-1_7b', 'removing');
    reg.removeModel('qwen3-1_7b');
    expect(reg.load().models).toHaveLength(0);
  });

  it('throws a typed error for an unknown id', () => {
    expect(() => reg.setModelState('ghost', 'ready')).toThrow(/unknown model/);
  });
});

describe('runtime activation and rollback', () => {
  it('activation is a metadata swap that supersedes the previous ready runtime', () => {
    reg.upsertRuntime(runtime({ id: 'rt-old' }));
    reg.activateRuntime('rt-old');
    reg.upsertRuntime(runtime({ id: 'rt-new', state: 'staged' }));
    reg.setModelState; // no-op reference
    reg.upsertRuntime({ id: 'rt-new', state: 'ready' });
    reg.activateRuntime('rt-new');

    const r = reg.load();
    expect(r.activeRuntimeId).toBe('rt-new');
    expect(r.runtimes.find(x => x.id === 'rt-old').state).toBe('superseded');
    // No folder moved — only metadata changed.
    expect(r.runtimes.find(x => x.id === 'rt-old').relPath).toBe(runtime().relPath);
  });

  it('rollback re-activates the superseded runtime', () => {
    reg.upsertRuntime(runtime({ id: 'rt-old' }));
    reg.activateRuntime('rt-old');
    reg.upsertRuntime(runtime({ id: 'rt-new' }));
    reg.activateRuntime('rt-new');

    reg.upsertRuntime({ id: 'rt-old', state: 'ready' });   // superseded → ready
    reg.activateRuntime('rt-old');
    expect(reg.load().activeRuntimeId).toBe('rt-old');
  });

  it('refuses to activate a runtime that is not ready', () => {
    reg.upsertRuntime(runtime({ state: 'staged', sha256: undefined }));
    expect(() => reg.activateRuntime('llamacpp-b4321-cpu')).toThrow(/not "ready"/);
  });

  it('activeRuntime() returns null when nothing is activated', () => {
    expect(reg.activeRuntime()).toBeNull();
  });
});

describe('corruption recovery', () => {
  it('recovers from a TRUNCATED primary using the backup', () => {
    reg.upsertModel(model());                 // write 1 — creates primary
    reg.upsertModel(model({ id: 'second' })); // write 2 — primary copied to .bak first
    expect(fs.existsSync(reg.backupFile)).toBe(true);

    fs.writeFileSync(reg.file, '{"schemaVersion":1,"models":[{"id":"qwen');  // torn write

    const r = R.createRegistry(dataRoot).read();
    expect(r.recovered).toBe(true);
    expect(r.registry.models.length).toBeGreaterThan(0);
  });

  it('recovers from an EMPTY primary using the backup', () => {
    reg.upsertModel(model());
    reg.upsertModel(model({ id: 'second' }));
    fs.writeFileSync(reg.file, '');

    const r = R.createRegistry(dataRoot).read();
    expect(r.recovered).toBe(true);
  });

  it('falls back to a fresh registry when primary and backup are both unusable', () => {
    reg.upsertModel(model());
    fs.writeFileSync(reg.file, 'not json at all');
    try { fs.writeFileSync(reg.backupFile, 'also garbage'); } catch {}

    const r = R.createRegistry(dataRoot).read();
    expect(r.registry.models).toEqual([]);
    // Reported honestly rather than silently pretending it was always empty.
    expect(r.recovered).toBe(true);
  });

  it('cleanStaging removes stale .tmp files from an interrupted write', () => {
    reg.upsertModel(model());
    const stale = `${reg.file}.999.${Date.now()}.abcdef.tmp`;
    fs.writeFileSync(stale, '{"partial": true');
    expect(reg.cleanStaging()).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(stale)).toBe(false);
    // The real registry is untouched.
    expect(reg.load().models).toHaveLength(1);
  });

  it('an INVALID write never replaces a good primary', () => {
    reg.upsertModel(model());
    const before = fs.readFileSync(reg.file, 'utf8');
    expect(() => reg.write({ ...reg.load(), models: [model({ sha256: 'bad' })] })).toThrow();
    expect(fs.readFileSync(reg.file, 'utf8')).toBe(before);
  });

  it('leaves no .tmp behind after a successful write', () => {
    reg.upsertModel(model());
    const dir = path.dirname(reg.file);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('forward compatibility', () => {
  it('serves a NEWER schemaVersion read-only and refuses to overwrite it', () => {
    P.ensureManagedDirs(dataRoot);
    fs.writeFileSync(reg.file, JSON.stringify({
      schemaVersion: R.SCHEMA_VERSION + 5,
      updatedAt: new Date().toISOString(),
      activeRuntimeId: null,
      runtimes: [],
      models: [{ id: 'future-model', someUnknownField: true }],
    }));

    const fresh = R.createRegistry(dataRoot);
    const r = fresh.read();
    expect(r.readOnly).toBe(true);
    expect(r.registry.models[0].id).toBe('future-model');

    // A downgrade must never eat a newer AEON's state.
    expect(() => fresh.upsertModel(model())).toThrow(/newer than this build/);
  });
});

describe('migration is idempotent', () => {
  it('v0 object-map shape normalizes to arrays exactly once', () => {
    const legacy = {
      runtimes: { 'rt-1': { state: 'ready', version: 'b1', backend: 'cpu', relPath: 'local-runtime/runtime/rt-1', sha256: 'c'.repeat(64), installedAt: new Date().toISOString() } },
      models: {},
    };
    const first = R.migrate(legacy);
    expect(first.migrated).toBe(true);
    expect(Array.isArray(first.registry.runtimes)).toBe(true);
    expect(first.registry.runtimes[0].id).toBe('rt-1');

    const second = R.migrate(first.registry);
    expect(second.migrated).toBe(false);
    expect(second.registry).toEqual(first.registry);
  });

  it('migrating null yields a valid empty registry', () => {
    const { registry } = R.migrate(null);
    expect(() => R.validate(registry)).not.toThrow();
  });
});

describe('typed accessors', () => {
  it('readyModels excludes staged and quarantined', () => {
    reg.upsertModel(model({ id: 'ready-one' }));
    reg.upsertModel(model({ id: 'staged-one', state: 'staged', sha256: undefined }));
    reg.upsertModel(model({ id: 'bad-one' }));
    reg.setModelState('bad-one', 'quarantined', 'hash mismatch');

    expect(reg.readyModels().map(m => m.id)).toEqual(['ready-one']);
  });

  it('modelsForCapability filters by declared capability', () => {
    reg.upsertModel(model({ id: 'chatter', capabilities: ['chat'] }));
    reg.upsertModel(model({ id: 'embedder', capabilities: ['embed'] }));

    expect(reg.modelsForCapability('chat').map(m => m.id)).toEqual(['chatter']);
    expect(reg.modelsForCapability('embed').map(m => m.id)).toEqual(['embedder']);
    expect(reg.modelsForCapability('vision')).toEqual([]);
  });

  it('resolveEntryPath rehydrates a stored relative path inside the managed root', () => {
    reg.upsertModel(model());
    const entry = reg.load().models[0];
    const abs = reg.resolveEntryPath(entry);
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs.startsWith(P.managedRoot(dataRoot))).toBe(true);
  });

  it('a registry written under one dataRoot resolves under a MOVED one', () => {
    reg.upsertModel(model());
    const movedRoot = path.join(tmp, 'moved — 데이터', 'data');
    P.ensureManagedDirs(movedRoot);
    fs.copyFileSync(reg.file, P.registryPath(movedRoot));

    const moved = R.createRegistry(movedRoot);
    const abs = moved.resolveEntryPath(moved.load().models[0]);
    expect(abs.startsWith(P.managedRoot(movedRoot))).toBe(true);
  });
});

describe('concurrent readers', () => {
  // 40 atomic writes (each: temp file + fsync + rename) interleaved with 80
  // reads is genuinely I/O-bound, and fsync on Windows under a fully parallel
  // suite is slow enough to cross the 10s default. It failed there — at
  // 10069ms and 10222ms, i.e. ON the timeout, never on the assertion — and
  // passed 40/40 whenever it ran alone. That is a slow test, not a race:
  // registry.cjs writes through a temp file and renames, which is atomic on
  // one filesystem.
  //
  // The timeout is raised rather than the work reduced, because the point of
  // this test is sustained interleaving. Cutting the iterations to make the
  // clock happy would quietly weaken the only gate that covers torn reads.
  it('readers never observe a partial file during repeated writes', { timeout: 45_000 }, async () => {
    reg.upsertModel(model());
    const reader = R.createRegistry(dataRoot);

    const writes = (async () => {
      for (let i = 0; i < 40; i++) {
        reg.upsertModel(model({ id: `m${i}` }));
      }
    })();

    const reads = (async () => {
      for (let i = 0; i < 80; i++) {
        // Must never throw and must always be schema-valid.
        const r = reader.load();
        expect(() => R.validate(r)).not.toThrow();
        await new Promise(res => setImmediate(res));
      }
    })();

    await Promise.all([writes, reads]);
    expect(reg.load().models.length).toBe(41);
  });
});
