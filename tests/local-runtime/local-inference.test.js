/**
 * Local inference — the parts that can regress silently.
 *
 * No network, no model load, no spawning. The live path (install → chat →
 * embed) is proven end to end against real binaries and recorded in the commit;
 * what is pinned here are the invariants that broke in ways nothing could see:
 * a catalog whose paths drift from its ids, a starter-model policy that would
 * hand a first-time user a 4.9 GB download, and a dataRoot resolver that was
 * off by one directory.
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
// fileURLToPath, not pathname.slice(1). On Windows the URL pathname is
// /C:/... so dropping one char happens to work; on Linux it is /home/... and
// slice(1) strips the ROOT slash, producing a relative path that resolves
// against cwd and fails. This passed on the dev box and only ever broke in CI.
const LR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'local-runtime');

const CATALOG = require(path.join(LR, 'model-catalog.json'));
const ASSETS = require(path.join(LR, 'runtime-assets.json'));
const { pickStarterModel, pickEmbedModel, planFor, humanBytes } = require(path.join(LR, 'provision.cjs'));
const { serverBinaryFor, reserveLoopbackPort } = require(path.join(LR, 'server-session.cjs'));

describe('catalog integrity', () => {
  it('every relPathTemplate directory matches the model id', () => {
    // Renaming qwen3-1.7b-q4 → -q8 updated the id but left relPathTemplate
    // pointing at the old directory. The model installed to one path while the
    // catalog described another, and llama-server failed to load a file that
    // was sitting right there.
    for (const m of CATALOG.models) {
      expect(m.relPathTemplate, `${m.id} relPathTemplate`)
        .toBe(`local-runtime/models/${m.id}/${m.filename}`);
    }
  });

  it('every model declares a RAM floor, so the picker can respect the machine', () => {
    for (const m of CATALOG.models) {
      expect(typeof m.minRAMMB, `${m.id} minRAMMB`).toBe('number');
      expect(m.minRAMMB).toBeGreaterThan(0);
    }
  });

  it('exactly one chat model is tagged recommended', () => {
    const rec = CATALOG.models.filter(m =>
      (m.capabilities || []).includes('chat') && (m.tags || []).includes('recommended'));
    expect(rec.length, 'the starter model must be unambiguous').toBe(1);
  });
});

describe('runtime assets integrity', () => {
  it('declares an archive kind and strip depth for every platform', () => {
    // llama.cpp ships Windows as flat .zip and macOS/Linux as .tar.gz nested
    // under a version directory. Getting either wrong yields an extracted tree
    // whose layout check fails with a confusing "missing required files".
    for (const p of ASSETS.platforms) {
      expect(['zip', 'tar.gz']).toContain(p.archive);
      expect(typeof p.stripComponents).toBe('number');
      expect(p.stripComponents).toBe(p.archive === 'tar.gz' ? 1 : 0);
    }
  });

  it('every platform requires llama-server — chat and embeddings both need it', () => {
    // b10216 removed the standalone llama-embedding binary; llama-server now
    // serves both. If it ever stops being required, both capabilities break.
    for (const key of Object.keys(ASSETS.requiredFiles)) {
      const files = ASSETS.requiredFiles[key];
      expect(files.some(f => f.startsWith('llama-server')), `${key} requiredFiles`).toBe(true);
    }
  });

  it('asset ids and urls carry the pinned runtime version', () => {
    for (const p of ASSETS.platforms) {
      expect(p.id).toContain(ASSETS.runtimeVersion);
      expect(p.url).toContain(ASSETS.releaseTag);
    }
  });
});

describe('starter model policy', () => {
  it('never hands a first-time user the largest model that happens to fit', () => {
    // The first version of this took the biggest affordable model, which on a
    // 32 GB machine meant a 4.9 GB download and slow CPU generation as the
    // product's first impression. Verified against the real catalog.
    const big = CATALOG.models
      .filter(m => (m.capabilities || []).includes('chat'))
      .sort((a, b) => b.bytes - a.bytes)[0];
    for (const ram of [4096, 8192, 16384, 32768, 65536, 131072]) {
      const picked = pickStarterModel(CATALOG, { totalRamMB: ram });
      expect(picked.id, `${ram}MB RAM`).not.toBe(big.id);
    }
  });

  it('picks the recommended model whenever it fits the budget', () => {
    // The budget is RAM x 0.5 (provision.cjs) — the OS and a browser need room.
    // The recommended model declares 3072 MB, so it fits from 8 GB upward.
    for (const ram of [8192, 16384, 32768, 65536]) {
      const picked = pickStarterModel(CATALOG, { totalRamMB: ram });
      expect((picked.tags || []).includes('recommended'), `${ram}MB RAM → ${picked.id}`).toBe(true);
    }
  });

  it('on a 4 GB machine takes the smallest model that fits, not the recommended one', () => {
    // This case previously asserted "recommended" and passed BY ACCIDENT.
    // At 4 GB the budget is 2048 MB and the recommended model needs 3072, so it
    // never fitted; with only five catalogue entries NOTHING fitted, `fits` was
    // empty, and the fallback ("smallest overall") happened to return the
    // recommended model. The assertion was right for the wrong reason.
    //
    // The catalogue now carries models that genuinely fit 2048 MB, so the
    // picker correctly prefers one. That is better product behaviour, and the
    // test says so rather than pinning the accident. (BO-B1 stress run,
    // 2026-08-04.)
    const picked = pickStarterModel(CATALOG, { totalRamMB: 4096 });
    expect(picked.minRAMMB).toBeLessThanOrEqual(2048);
    expect((picked.capabilities || []).includes('chat')).toBe(true);

    const smallestFitting = CATALOG.models
      .filter(m => (m.capabilities || []).includes('chat') && (m.minRAMMB || 0) <= 2048)
      .sort((a, b) => a.minRAMMB - b.minRAMMB)[0];
    expect(picked.id).toBe(smallestFitting.id);
  });

  it('still returns something on a machine too small for anything', () => {
    const picked = pickStarterModel(CATALOG, { totalRamMB: 512 });
    expect(picked).toBeTruthy();
    // The smallest we have — the caller decides whether to warn.
    const smallest = CATALOG.models
      .filter(m => (m.capabilities || []).includes('chat'))
      .sort((a, b) => a.minRAMMB - b.minRAMMB)[0];
    expect(picked.id).toBe(smallest.id);
  });

  it('picks an embed-capable model for retrieval', () => {
    const m = pickEmbedModel(CATALOG);
    expect(m).toBeTruthy();
    expect(m.capabilities).toContain('embed');
  });
});

describe('provisioning plan', () => {
  const emptyRegistry = { activeRuntime: () => null, modelsForCapability: () => [] };
  const fullRegistry = {
    activeRuntime: () => ({ id: 'rt' }),
    modelsForCapability: () => [{ id: 'already-here' }],
  };

  it('reports what is missing on a bare machine, with a size', () => {
    const plan = planFor('chat', { registry: emptyRegistry, catalog: CATALOG });
    expect(plan.ready).toBe(false);
    expect(plan.needsRuntime).toBe(true);
    expect(plan.needsModel).toBe(true);
    expect(plan.bytes).toBeGreaterThan(0);
  });

  it('reports ready when the runtime and a model are already installed', () => {
    const plan = planFor('chat', { registry: fullRegistry, catalog: CATALOG });
    expect(plan.ready).toBe(true);
    expect(plan.needsModel).toBe(false);
  });

  it('distinguishes the chat and embed capabilities', () => {
    const chatOnly = {
      activeRuntime: () => ({ id: 'rt' }),
      modelsForCapability: (cap) => (cap === 'chat' ? [{ id: 'c' }] : []),
    };
    expect(planFor('chat', { registry: chatOnly, catalog: CATALOG }).ready).toBe(true);
    const embedPlan = planFor('embed', { registry: chatOnly, catalog: CATALOG });
    expect(embedPlan.ready).toBe(false);
    expect(embedPlan.model.capabilities).toContain('embed');
  });
});

describe('humanBytes', () => {
  it('speaks in the units a person uses', () => {
    expect(humanBytes(1_834_426_016)).toBe('1.8 GB');
    expect(humanBytes(146_146_432)).toBe('146 MB');
    expect(humanBytes(0)).toBe('unknown size');
  });
});

describe('server session wiring', () => {
  it('resolves llama-server as a sibling of the runtime entrypoint', () => {
    const isWin = process.platform === 'win32';
    const entry = isWin ? 'C:\\rt\\b10216\\llama-cli.exe' : '/rt/b10216/llama-cli';
    const got = serverBinaryFor(entry);
    expect(path.dirname(got)).toBe(path.dirname(entry));
    expect(path.basename(got)).toBe(isWin ? 'llama-server.exe' : 'llama-server');
  });

  it('reserves a real, free loopback port', async () => {
    const a = await reserveLoopbackPort();
    const b = await reserveLoopbackPort();
    for (const p of [a, b]) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThan(1023);
      expect(p).toBeLessThan(65536);
    }
  });
});
