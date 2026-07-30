/**
 * Phase 1 — Path authority containment + relocatability.
 *
 * Imports the real resolver. Every hostile case here is one a malicious or
 * corrupt catalog/registry entry could actually produce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P = require(path.join(__dirname, '..', '..', 'services', 'local-runtime', 'paths.cjs'));

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-paths-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('resolveDataRoot', () => {
  it('requires an absolute appRoot', () => {
    expect(() => P.resolveDataRoot({ appRoot: 'relative/app' })).toThrow(/absolute/);
    expect(() => P.resolveDataRoot({})).toThrow(/absolute/);
  });

  it('defaults to <appRoot>/data', () => {
    expect(P.resolveDataRoot({ appRoot: tmp, env: {} })).toBe(path.join(tmp, 'data'));
  });

  it('honours an explicit setting over the environment', () => {
    const got = P.resolveDataRoot({
      appRoot: tmp,
      dataRootSetting: path.join(tmp, 'chosen'),
      env: { DATA_PATH: path.join(tmp, 'from-env') },
    });
    expect(got).toBe(path.join(tmp, 'chosen'));
  });

  it('resolves a RELATIVE override against appRoot, never cwd', () => {
    // The launcher may start from anywhere; the data root must not follow cwd.
    const got = P.resolveDataRoot({ appRoot: tmp, dataRootSetting: './aeon-data', env: {} });
    expect(got).toBe(path.join(tmp, 'aeon-data'));
    expect(got.startsWith(tmp)).toBe(true);
  });

  it('survives spaces and Unicode in the root', () => {
    const weird = path.join(tmp, 'My AEON — 数据 🚀');
    fs.mkdirSync(weird, { recursive: true });
    const dr = P.resolveDataRoot({ appRoot: weird, env: {} });
    expect(dr).toBe(path.join(weird, 'data'));
    // And a managed path under it still resolves and contains.
    expect(() => P.modelPath(dr, 'qwen3-1_7b')).not.toThrow();
  });
});

describe('containment — hostile inputs cannot escape', () => {
  let dataRoot;
  beforeEach(() => { dataRoot = path.join(tmp, 'data'); P.ensureManagedDirs(dataRoot); });

  it.each([
    ['parent traversal', '../../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32'],
    ['embedded traversal', 'models/../../../outside'],
    ['bare dotdot', '..'],
  ])('rejects %s', (_label, evil) => {
    expect(() => P.resolveManagedPath(dataRoot, evil)).toThrow();
  });

  it('rejects an absolute segment', () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(() => P.resolveManagedPath(dataRoot, abs)).toThrow();
  });

  it('rejects a drive-qualified segment', () => {
    expect(() => P.resolveManagedPath(dataRoot, 'D:evil')).toThrow(/drive-qualified|absolute/);
  });

  it('rejects an empty segment', () => {
    expect(() => P.resolveManagedPath(dataRoot, '')).toThrow(/empty/);
  });

  it('assertManagedTarget rejects a sibling of the managed root', () => {
    const outside = path.join(dataRoot, 'not-managed', 'x.bin');
    expect(() => P.assertManagedTarget(dataRoot, outside)).toThrow(/escapes managed root/);
  });

  it('assertManagedTarget rejects a fully external absolute path', () => {
    expect(() => P.assertManagedTarget(dataRoot, path.join(tmp, 'elsewhere.bin')))
      .toThrow(/escapes managed root/);
  });

  it('accepts a legitimate managed target', () => {
    const ok = P.modelPath(dataRoot, 'my-model', 'weights.gguf');
    expect(() => P.assertManagedTarget(dataRoot, ok)).not.toThrow();
    expect(ok.startsWith(P.managedRoot(dataRoot))).toBe(true);
  });

  it('resolves a symlink/junction escape planted on an existing directory', () => {
    // A model dir replaced by a link pointing outside the data root must not
    // become a legal write target. Lexical checks alone would let this pass.
    const escapeTarget = path.join(tmp, 'escape-target');
    fs.mkdirSync(escapeTarget, { recursive: true });
    const linkAt = P.resolveManagedPath(dataRoot, P.SUBDIRS.models, 'linked');

    let linked = false;
    try {
      fs.symlinkSync(escapeTarget, linkAt, 'junction');
      linked = true;
    } catch {
      // Unprivileged Windows without Developer Mode cannot create links.
    }
    if (!linked) return;

    expect(() => P.assertManagedTarget(dataRoot, path.join(linkAt, 'weights.gguf')))
      .toThrow(/escapes managed root/);
  });
});

describe('id validation', () => {
  it.each([
    ['traversal id', '../evil'],
    ['separator id', 'a/b'],
    ['backslash id', 'a\\b'],
    ['empty id', ''],
    ['dot', '.'],
    ['dotdot', '..'],
    ['leading dot', '.hidden'],
    ['windows device', 'con'],
    ['windows device with ext', 'NUL.gguf'],
  ])('rejects %s', (_label, id) => {
    expect(() => P.assertSafeId(id, 'model id')).toThrow();
  });

  it.each(['qwen3-1_7b', 'llama.cpp-b4321', 'Model123'])('accepts %s', (id) => {
    expect(P.assertSafeId(id)).toBe(id);
  });

  it('rejects an over-long id', () => {
    expect(() => P.assertSafeId('a'.repeat(200))).toThrow();
  });
});

describe('registry-relative round trip — portable relocation', () => {
  it('stores POSIX-relative paths and never an absolute one', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    const abs = P.modelPath(dataRoot, 'qwen3', 'model.gguf');
    const rel = P.toRegistryRelative(dataRoot, abs);

    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).not.toMatch(/\\/);          // POSIX separators only
    expect(rel).not.toMatch(/^[a-zA-Z]:/);  // no drive letter
    expect(rel).toBe('local-runtime/models/qwen3/model.gguf');
  });

  it('a registry written under one root rehydrates under a MOVED root', () => {
    // The whole point: E:\AEON\data → F:\Portable\data must keep working.
    const rootA = path.join(tmp, 'driveA', 'data');
    const rootB = path.join(tmp, 'driveB — 移動', 'data');
    P.ensureManagedDirs(rootA);
    P.ensureManagedDirs(rootB);

    const stored = P.toRegistryRelative(rootA, P.modelPath(rootA, 'qwen3', 'model.gguf'));
    const rehydrated = P.fromRegistryRelative(rootB, stored);

    expect(rehydrated).toBe(P.modelPath(rootB, 'qwen3', 'model.gguf'));
    expect(rehydrated.startsWith(rootB)).toBe(true);
  });

  it('refuses to rehydrate a stored ABSOLUTE path', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    const abs = process.platform === 'win32' ? 'C:\\Windows\\evil.gguf' : '/etc/evil.gguf';
    expect(() => P.fromRegistryRelative(dataRoot, abs)).toThrow(/must be relative/);
  });

  it('refuses to rehydrate a stored traversal path', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    expect(() => P.fromRegistryRelative(dataRoot, '../../outside.gguf')).toThrow();
  });

  it('refuses to relativize a path outside dataRoot', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    expect(() => P.toRegistryRelative(dataRoot, path.join(tmp, 'outside.gguf'))).toThrow();
  });
});

describe('managed skeleton + helpers', () => {
  it('ensureManagedDirs is idempotent and creates every subdir', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    P.ensureManagedDirs(dataRoot); // twice — must not throw
    for (const sub of Object.values(P.SUBDIRS)) {
      expect(fs.existsSync(path.join(dataRoot, P.MANAGED_DIR, sub))).toBe(true);
    }
  });

  it('every helper lands inside the managed root', () => {
    const dataRoot = path.join(tmp, 'data');
    P.ensureManagedDirs(dataRoot);
    const root = P.managedRoot(dataRoot);
    const all = [
      P.runtimePath(dataRoot, 'llamacpp-b4321-cpu'),
      P.modelPath(dataRoot, 'qwen3'),
      P.stagingPath(dataRoot, 'a1b2c3d4'),
      P.registryPath(dataRoot),
      P.logPath(dataRoot, 'worker.log'),
    ];
    for (const p of all) expect(p.startsWith(root)).toBe(true);
  });

  it('registryPath is stable and named', () => {
    const dataRoot = path.join(tmp, 'data');
    expect(path.basename(P.registryPath(dataRoot))).toBe(P.REGISTRY_FILE);
  });

  it('managedRoot demands an absolute dataRoot', () => {
    expect(() => P.managedRoot('data')).toThrow(/absolute/);
  });
});

describe('long paths', () => {
  it('handles a deep nested model id chain near the legacy MAX_PATH', () => {
    const deep = path.join(tmp, 'd'.repeat(60), 'e'.repeat(60));
    const dataRoot = path.join(deep, 'data');
    // Creating may fail on a system without long-path support; the resolver
    // itself must still produce a contained path without throwing.
    const p = P.modelPath(dataRoot, 'a'.repeat(100), 'weights.gguf');
    expect(p.startsWith(P.managedRoot(dataRoot))).toBe(true);
  });
});
