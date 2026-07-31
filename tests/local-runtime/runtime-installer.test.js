/**
 * Phase 3 — Runtime installer + probe tests.
 *
 * No network calls, no binary execution. Every test uses real module imports
 * and either stubs at the OS boundary (fs/https) or exercises pure functions.
 * The critical invariant: a PENDING_VERIFICATION hash or a bad hash CANNOT
 * produce state="ready" in the registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const ASSETS = require(path.join(LR, 'runtime-assets.json'));
const { selectAsset, sha256File } = require(path.join(LR, 'runtime-installer.cjs'));
const { canExec, probe: probeFn, parseVersion, parseCpuFeatures, parseGpuBackend } = require(path.join(LR, 'runtime-probe.cjs'));

let tmp, dataRoot;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-installer-'));
  dataRoot = path.join(tmp, 'data');
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ── Asset selection ────────────────────────────────────────────────────────

describe('selectAsset', () => {
  it('returns a platform record matching current os.platform() and os.arch()', () => {
    // We're on win32/x64 in the AEON dev environment — but handle any platform.
    const asset = selectAsset();
    expect(asset.platform).toBe(os.platform());
    expect(asset.arch).toBe(os.arch());
    expect(['cpu', 'cuda', 'metal', 'vulkan', 'rocm']).toContain(asset.backend);
  });

  it('prefers cpu when preferBackend is cpu', () => {
    const asset = selectAsset({ preferBackend: 'cpu' });
    expect(asset.backend).toBe('cpu');
  });

  it('falls back to cpu when a preferred backend is unavailable', () => {
    // 'rocm' is only in the Linux assets; on win32 it should fall back.
    const asset = selectAsset({ preferBackend: 'rocm' });
    expect(['cpu', 'rocm']).toContain(asset.backend);
  });

  it('each platform record has required fields', () => {
    for (const a of ASSETS.platforms) {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('url');
      expect(a).toHaveProperty('sha256');
      expect(a).toHaveProperty('entrypoint');
      expect(a).toHaveProperty('filename');
      expect(a).toHaveProperty('bytes');
      expect(typeof a.bytes).toBe('number');
      expect(a.bytes).toBeGreaterThan(0);
    }
  });

  it('all asset ids are unique', () => {
    const ids = ASSETS.platforms.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('throws on an unsupported platform', () => {
    // Temporarily override os.platform to simulate an exotic platform.
    const orig = os.platform;
    os.platform = () => 'aix';
    try {
      expect(() => selectAsset()).toThrow(/No llama.cpp asset/);
    } finally {
      os.platform = orig;
    }
  });
});

// ── SHA-256 verification ───────────────────────────────────────────────────

describe('sha256File', () => {
  it('computes the correct sha256 for a known file', async () => {
    const f = path.join(tmp, 'test.bin');
    fs.writeFileSync(f, 'hello world');
    // echo -n 'hello world' | sha256sum → b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576f7e72b9dd5eed1bf
    // Node crypto gives: b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576f7e72b9dd5eed1bf
    // Using Buffer directly to be precise:
    const crypto = require('crypto');
    const expected = crypto.createHash('sha256').update('hello world').digest('hex');
    expect(await sha256File(f)).toBe(expected);
  });

  it('rejects a missing file', async () => {
    await expect(sha256File(path.join(tmp, 'nonexistent.bin'))).rejects.toThrow();
  });

  it('sha256 of empty file is deterministic', async () => {
    const f = path.join(tmp, 'empty.bin');
    fs.writeFileSync(f, '');
    const crypto = require('crypto');
    const expected = crypto.createHash('sha256').update('').digest('hex');
    expect(await sha256File(f)).toBe(expected);
  });
});

// ── PENDING_VERIFICATION guard ─────────────────────────────────────────────

describe('PENDING_VERIFICATION guard', () => {
  // This used to assert that the SHIPPED manifest still contained
  // PENDING_VERIFICATION, so filling in real hashes broke the test protecting
  // the invariant. The guard is now a pure function and is tested against
  // synthetic values — it must hold whether or not the catalog happens to
  // have something for it to catch.
  const { assertHashVerified } = require(path.join(LR, 'runtime-installer.cjs'));

  it('rejects a PENDING_VERIFICATION hash', () => {
    expect(() => assertHashVerified('Runtime asset', 'x', 'PENDING_VERIFICATION', 'runtime-assets.json'))
      .toThrow(/PENDING_VERIFICATION/);
  });

  it('rejects a malformed hash — wrong length, wrong alphabet, empty, missing', () => {
    for (const bad of ['abc', 'z'.repeat(64), 'A'.repeat(64), '', null, undefined, 'a'.repeat(63)]) {
      expect(() => assertHashVerified('Model', 'x', bad, 'model-catalog.json'))
        .toThrow(/malformed SHA-256/);
    }
  });

  it('accepts a well-formed lowercase hex digest', () => {
    expect(() => assertHashVerified('Model', 'x', 'a'.repeat(64), 'model-catalog.json')).not.toThrow();
  });

  it('every shipped runtime asset carries a verified hash', () => {
    // The shipping manifest's own state, asserted directly rather than through
    // the guard. Fails loudly if an asset is added without hashing it.
    const ASSETS = require(path.join(LR, 'runtime-assets.json'));
    for (const p of ASSETS.platforms) {
      expect(() => assertHashVerified('Runtime asset', p.id, p.sha256, 'runtime-assets.json')).not.toThrow();
    }
  });

  it('a rejected install leaves no ready runtime in the registry', async () => {
    const { installRuntime, selectAsset } = require(path.join(LR, 'runtime-installer.cjs'));
    const ASSETS = require(path.join(LR, 'runtime-assets.json'));
    // Force a deterministic failure by pointing this platform's asset at a
    // closed port. Once real hashes shipped, the PENDING guard no longer
    // short-circuits, and asserting on "a failed install" would otherwise have
    // pulled 18MB over the network from a unit test.
    const asset = ASSETS.platforms.find(a => a.id === selectAsset().id);
    const realUrl = asset.url;
    asset.url = 'http://127.0.0.1:1/unreachable.zip';
    try {
      await expect(installRuntime({ dataRoot })).rejects.toThrow();
      const reg = R.createRegistry(dataRoot);
      const { registry } = reg.read();
      expect(registry.runtimes.filter(r => r.state === 'ready')).toHaveLength(0);
    } finally {
      asset.url = realUrl;
    }
  });
});

// ── Probe: pure parsers ────────────────────────────────────────────────────

describe('probe parsers', () => {
  const sampleOutput = `
version: 5060 (abc1234)
built with gcc 13.2.0
AVX = 1 | AVX2 = 1 | AVX512 = 0 | FMA = 1 | NEON = 0 | F16C = 1 | SSE3 = 1
ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce RTX 4080
  `;

  it('parseVersion extracts "b5060" from "version: 5060"', () => {
    expect(parseVersion(sampleOutput)).toBe('b5060');
  });

  it('parseVersion handles "build: NNNN" format', () => {
    expect(parseVersion('build: 5060\nbuilt with clang')).toBe('b5060');
  });

  it('parseVersion returns fallback for unknown format', () => {
    const r = parseVersion('llama.cpp version 1.2.3 (release)');
    expect(r).toBeTruthy();
    expect(typeof r).toBe('string');
  });

  it('parseCpuFeatures detects AVX2 and FMA', () => {
    const features = parseCpuFeatures(sampleOutput);
    expect(features).toContain('AVX2');
    expect(features).toContain('FMA');
    expect(features).toContain('F16C');
    expect(features).not.toContain('NEON');
  });

  it('parseCpuFeatures returns empty array for unknown CPU', () => {
    expect(parseCpuFeatures('no features here')).toEqual([]);
  });

  it('parseGpuBackend detects CUDA from ggml_cuda_init line', () => {
    expect(parseGpuBackend(sampleOutput)).toBe('cuda');
  });

  it('parseGpuBackend detects Metal', () => {
    expect(parseGpuBackend('ggml_metal_init: allocating...')).toBe('metal');
  });

  it('parseGpuBackend returns null for CPU-only', () => {
    expect(parseGpuBackend('AVX2 = 1 | NEON = 0')).toBeNull();
  });

  it('parseGpuBackend detects Vulkan', () => {
    expect(parseGpuBackend('vulkan backend initialized')).toBe('vulkan');
  });
});

// ── canExec ───────────────────────────────────────────────────────────────

describe('canExec', () => {
  it('returns ok:false for a nonexistent path', () => {
    const r = canExec(path.join(tmp, 'no-such-binary'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it('returns ok:true for an existing file', () => {
    const f = path.join(tmp, 'fake-binary');
    fs.writeFileSync(f, '#!/bin/sh\necho hi');
    if (os.platform() !== 'win32') fs.chmodSync(f, 0o755);
    const r = canExec(f);
    expect(r.ok).toBe(true);
  });

  it('probe throws on a missing binary', () => {
    expect(() => probeFn(path.join(tmp, 'no-binary'), ['--version'])).toThrow(/not found/);
  });

  it('probe throws on a relative path', () => {
    expect(() => probeFn('relative/path/binary', ['--version'])).toThrow(/must be absolute/);
  });
});

// ── runtime-assets.json structure ─────────────────────────────────────────

describe('runtime-assets.json structure', () => {
  it('has a runtimeVersion string', () => {
    expect(typeof ASSETS.runtimeVersion).toBe('string');
    expect(ASSETS.runtimeVersion.length).toBeGreaterThan(0);
  });

  it('has a releaseBaseUrl pointing to GitHub', () => {
    expect(ASSETS.releaseBaseUrl).toMatch(/github\.com/);
  });

  it('requiredFiles keys match platform assets', () => {
    for (const a of ASSETS.platforms) {
      const key = `${a.platform}-${a.arch}-${a.backend}`;
      expect(ASSETS.requiredFiles).toHaveProperty(key);
      expect(ASSETS.requiredFiles[key].length).toBeGreaterThan(0);
    }
  });

  it('all entrypoints are bare filenames, not paths', () => {
    for (const a of ASSETS.platforms) {
      // Must be basename only — no directory separator
      expect(a.entrypoint).not.toContain('/');
      expect(a.entrypoint).not.toContain('\\');
    }
  });

  it('win32 entrypoints end in .exe', () => {
    const win = ASSETS.platforms.filter(a => a.platform === 'win32');
    for (const a of win) {
      expect(a.entrypoint).toMatch(/\.exe$/);
    }
  });

  it('POSIX entrypoints have no extension', () => {
    const posix = ASSETS.platforms.filter(a => a.platform !== 'win32');
    for (const a of posix) {
      expect(a.entrypoint).not.toMatch(/\.\w+$/);
    }
  });
});
