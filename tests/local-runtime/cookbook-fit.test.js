/**
 * BO-B1 — Cookbook only offers what this machine can actually run.
 *
 * THE INCIDENT THIS SUITE EXISTS FOR (2026-08-04): an operator installed
 * `Qwen/Qwen2.5-3B` through Cookbook. The download reported success — exit 0,
 * "DOWNLOAD_OK", 5.8 GB on disk. It could never be served, because llama.cpp
 * reads GGUF and that repo is safetensors. The serve log is zero bytes:
 * llama-server never started, because there was nothing it could open.
 *
 * Two failures, and this file covers both:
 *
 *   1. The catalogue offered a model the runtime cannot open.
 *   2. A registry recorded `gguf: false` and `ready: true` in the same object.
 *      AEON HAD the fact and discarded it on the way to the screen — the exact
 *      defect class BO-F3 exists to remove.
 *
 * These drive the real modules. Nothing is re-implemented inline.
 */
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const capabilities = require('../../services/local-runtime/capabilities.cjs');
const fit = require('../../services/local-runtime/fit.cjs');
const converter = require('../../services/local-runtime/model-converter.cjs');
const R = require('../../services/local-runtime/registry.cjs');

const GB = 1024 * 1024 * 1024;
const tmps = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// A machine shaped like the operator's: 32 GB RAM, 3 GB card, CPU-built runtime.
const capsCpu = {
  ram: { totalBytes: 32 * GB, freeBytes: 18 * GB },
  gpu: { present: true, vramTotalBytes: 3 * GB },
  disk: { known: true, freeBytes: 90 * GB },
  runtime: { backend: 'cpu', usesGpu: false },
  budget: { bytes: 32 * GB, basis: 'ram', why: 'cpu build' },
};
const capsGpu = {
  ...capsCpu,
  runtime: { backend: 'cuda', usesGpu: true },
  budget: { bytes: 3 * GB, basis: 'vram', why: 'cuda build' },
};

const model = (o) => ({ id: 'm', bytes: 2 * GB, contextCeiling: 8192, format: 'gguf', ...o });

describe('capability probe reports unknowns as unknown', () => {
  it('detects this machine without throwing', async () => {
    const caps = await capabilities.detect({ dataRoot: mkTmp('caps-') });
    expect(caps.cpu.cores).toBeGreaterThan(0);
    expect(caps.ram.totalBytes).toBeGreaterThan(0);
    expect(caps.budget.bytes).toBeGreaterThan(0);
    // The budget must always explain itself — a number with no reason cannot
    // be argued with by the operator.
    expect(typeof caps.budget.why).toBe('string');
    expect(caps.budget.why.length).toBeGreaterThan(10);
  });

  it('an absent GPU is reported as absent WITH a reason, never as 0 VRAM', async () => {
    const caps = await capabilities.detect({ dataRoot: mkTmp('caps-') });
    if (!caps.gpu.present) {
      expect(caps.gpu.vramTotalBytes).toBeNull();   // null = unknown, not zero
      expect(typeof caps.gpu.reason).toBe('string');
    } else {
      expect(caps.gpu.vramTotalBytes).toBeGreaterThan(0);
    }
  });

  it('the budget follows the RUNTIME, not the hardware', async () => {
    const root = mkTmp('caps-');
    const cpuBuild = await capabilities.detect({ dataRoot: root, activeRuntime: { id: 'r', backend: 'cpu', version: 'b1' } });
    // A CPU build never touches the GPU, so RAM is the ceiling even on a
    // machine with a card. Getting this backwards is what made everyone
    // believe a 3 GB card was the constraint.
    expect(cpuBuild.budget.basis).toBe('ram');
    expect(cpuBuild.runtime.usesGpu).toBe(false);
  });
});

describe('fit engine — format is checked before size', () => {
  it('refuses safetensors however small it is', () => {
    const r = fit.assess(model({ bytes: 100 * 1024 * 1024, format: 'safetensors' }), capsCpu);
    expect(r.verdict).toBe('unsupported');
    expect(r.canInstall).toBe(false);
    expect(r.needsConversion).toBe(true);
    expect(r.remedy).toMatch(/convert/i);
  });

  it('the 5.8 GB safetensors repo would have been refused before download', () => {
    const r = fit.assess(model({ id: 'Qwen2.5-3B', bytes: 6 * GB, format: 'safetensors' }), capsCpu);
    expect(r.verdict).toBe('unsupported');
    expect(r.canInstall).toBe(false);
  });

  it('accepts GGUF that fits, and says what it needs', () => {
    const r = fit.assess(model({ bytes: 2 * GB }), capsCpu);
    expect(r.verdict).toBe('runnable');
    expect(r.canInstall).toBe(true);
    expect(r.reason).toMatch(/GB/);
  });
});

describe('fit engine — memory budget', () => {
  it('a 5 GB model runs on 32 GB RAM but not on a 3 GB card', () => {
    const m = model({ bytes: 5 * GB });
    expect(fit.assess(m, capsCpu).canInstall).toBe(true);
    const gpu = fit.assess(m, capsGpu);
    expect(gpu.verdict).toBe('too_big');
    expect(gpu.remedy).toMatch(/smaller model|quantis/i);
  });

  it('context length is counted — the same model can fit at 4k and not at 128k', () => {
    const m = model({ bytes: 2.4 * GB, contextCeiling: 131072 });
    const small = fit.assess(m, capsGpu, { contextTokens: 2048 });
    const huge = fit.assess(m, capsGpu, { contextTokens: 131072 });
    expect(huge.requiredBytes).toBeGreaterThan(small.requiredBytes);
  });

  it('refuses when the disk cannot hold it, before considering memory', () => {
    const caps = { ...capsCpu, disk: { known: true, freeBytes: 1 * GB } };
    const r = fit.assess(model({ bytes: 5 * GB }), caps);
    expect(r.verdict).toBe('no_disk');
    expect(r.reason).toMatch(/free/);
  });

  it('says UNKNOWN rather than guessing when no budget could be established', () => {
    const r = fit.assess(model({}), { disk: { known: false } });
    expect(r.verdict).toBe('unknown');
    expect(r.canInstall).toBe(false);
  });
});

describe('catalogue split — hidden entries always carry a reason', () => {
  const models = [
    model({ id: 'tiny', bytes: 0.5 * GB }),
    model({ id: 'mid', bytes: 2.5 * GB }),
    model({ id: 'huge', bytes: 40 * GB }),
    model({ id: 'wrong-format', bytes: 1 * GB, format: 'safetensors' }),
  ];

  it('shows only what can be installed', () => {
    const { shown, hidden } = fit.assessCatalog(models, capsCpu);
    expect(shown.every(m => m.fit.canInstall)).toBe(true);
    expect(hidden.map(m => m.id).sort()).toEqual(['huge', 'wrong-format']);
  });

  it('every hidden model explains itself — hiding without a reason is its own lie', () => {
    const { hidden } = fit.assessCatalog(models, capsCpu);
    for (const m of hidden) {
      expect(typeof m.fit.reason).toBe('string');
      expect(m.fit.reason.length).toBeGreaterThan(10);
    }
  });

  it('recommends the largest model that runs comfortably', () => {
    const rec = fit.recommend(models, capsCpu);
    expect(rec.id).toBe('mid');
  });

  it('the summary accounts for every entry', () => {
    const { summary } = fit.assessCatalog(models, capsCpu);
    const counted = summary.runnable + summary.tight + summary.tooBig
      + summary.unsupported + summary.noDisk + summary.unknown;
    expect(counted).toBe(summary.total);
    expect(summary.total).toBe(models.length);
  });
});

describe('tier 3 preflight — cost stated before anything downloads', () => {
  it('discloses download, peak disk and result size without touching the network', async () => {
    const pf = await converter.preflight({ sourceBytes: 6 * GB, dataRoot: mkTmp('pf-') });
    expect(pf.cost.downloadBytes).toBe(6 * GB);
    // Peak is source + f16 + result — the number people are surprised by.
    expect(pf.cost.peakDiskBytes).toBeGreaterThan(pf.cost.downloadBytes);
    expect(pf.cost.resultBytes).toBeLessThan(pf.cost.downloadBytes);
    expect(pf.summary).toMatch(/GB/);
  });

  it('every blocker names a remedy', async () => {
    const pf = await converter.preflight({ sourceBytes: 1 * GB, dataRoot: mkTmp('pf-') });
    for (const b of pf.blockers) {
      expect(typeof b.message).toBe('string');
      expect(typeof b.remedy).toBe('string');
      expect(b.remedy.length).toBeGreaterThan(5);
    }
  });

  it('blocks on disk when the peak will not fit', async () => {
    // 900 GB source cannot fit anywhere on a normal machine.
    const pf = await converter.preflight({ sourceBytes: 900 * GB, dataRoot: mkTmp('pf-') });
    expect(pf.possible).toBe(false);
    expect(pf.blockers.some(b => b.code === 'no_disk')).toBe(true);
  });
});

describe('THE GATE — never mark ready what cannot serve', () => {
  const sha = crypto.createHash('sha256').update('x').digest('hex');
  const entry = (o) => ({ bytes: 1000, sha256: sha, installedAt: new Date().toISOString(), ...o });

  const fresh = () => R.createRegistry(mkTmp('reg-'));

  it('refuses the exact entry that shipped on 2026-08-04', () => {
    const reg = fresh();
    expect(() => reg.upsertModel(entry({
      id: 'qwen25-3b', state: 'ready', gguf: false,
      relPath: 'local-runtime/models/q/model.safetensors',
    }))).toThrow(/GGUF/i);
  });

  it('refuses a declared non-gguf format', () => {
    const reg = fresh();
    expect(() => reg.upsertModel(entry({
      id: 'x1', state: 'ready', format: 'safetensors',
      relPath: 'local-runtime/models/x1/m.bin',
    }))).toThrow(/GGUF/i);
  });

  it('refuses when the weights path is not a .gguf', () => {
    const reg = fresh();
    expect(() => reg.upsertModel(entry({
      id: 'x2', state: 'ready', relPath: 'local-runtime/models/x2/model.bin',
    }))).toThrow(/GGUF/i);
  });

  it('the refusal carries a code and names the remedy', () => {
    const reg = fresh();
    try {
      reg.upsertModel(entry({ id: 'x4', state: 'ready', gguf: false, relPath: 'local-runtime/models/x4/m.safetensors' }));
      throw new Error('should have refused');
    } catch (e) {
      expect(e.code).toBe('MODEL_NOT_SERVABLE');
      expect(e.message).toMatch(/Convert it to GGUF|GGUF build/i);
    }
  });

  it('accepts a real GGUF model', () => {
    const reg = fresh();
    reg.upsertModel(entry({
      id: 'ok1', state: 'ready', gguf: true, format: 'gguf',
      relPath: 'local-runtime/models/ok1/model-Q4_K_M.gguf',
    }));
    expect(reg.readyModels().map(m => m.id)).toEqual(['ok1']);
  });

  it('the gate is at the WRITE, so nothing unservable can reach readyModels()', () => {
    const reg = fresh();
    try { reg.upsertModel(entry({ id: 'bad', state: 'ready', gguf: false, relPath: 'local-runtime/models/bad/m.safetensors' })); } catch {}
    // A guard that only filtered on read would leave the wrong state on disk
    // for every other reader to trip over.
    expect(reg.load().models.find(m => m.id === 'bad')).toBeUndefined();
    expect(reg.readyModels()).toEqual([]);
  });
});
