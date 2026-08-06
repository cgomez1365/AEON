/**
 * BO-D1e — the catalogue's KV specs must be plausible.
 *
 * D1e replaced a coefficient with arithmetic, and arithmetic is only as good
 * as its inputs. The `kv` block on each catalogue entry was entered by hand
 * from published model configs. Exactly one of the twelve is verified against
 * a MEASUREMENT — llama3-8b, whose 16.00 GB at 131,072 was observed on the
 * operator's machine and is asserted in kv-arithmetic.test.js.
 *
 * The other eleven are asserted from documentation, and a typo there is
 * invisible: a missing zero in `layers` silently under-estimates the cache
 * and hands back the exact failure mode D1e exists to remove — a model that
 * is promised to fit and then exhausts RAM.
 *
 * This file cannot confirm the specs are RIGHT. It confirms they are in the
 * band a transformer of that size can occupy, so a fat-fingered entry fails
 * here rather than on the operator's machine.
 *
 * The durable fix is to read block_count / attention.head_count_kv /
 * attention.key_length out of the GGUF header at install time —
 * model-installer.cjs already parses that header for magic, version and
 * architecture. Until then, this is the guard.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fit = require('../../services/local-runtime/fit.cjs');
const raw = require('../../services/local-runtime/model-catalog.json');

const catalog = Array.isArray(raw) ? raw : raw.models;
const GB = 1024 * 1024 * 1024;

describe('catalogue KV specs', () => {
  it('every entry carries one', () => {
    const missing = catalog.filter(m => !m.kv).map(m => m.id);
    expect(missing).toEqual([]);
  });

  it('every spec is structurally sane', () => {
    for (const m of catalog) {
      const { layers, kvHeads, headDim } = m.kv;
      // Bands wide enough for anything in circulation, tight enough that a
      // dropped or duplicated digit fails.
      expect(layers, `${m.id} layers`).toBeGreaterThanOrEqual(8);
      expect(layers, `${m.id} layers`).toBeLessThanOrEqual(126);
      expect(kvHeads, `${m.id} kvHeads`).toBeGreaterThanOrEqual(1);
      expect(kvHeads, `${m.id} kvHeads`).toBeLessThanOrEqual(64);
      expect(headDim, `${m.id} headDim`).toBeGreaterThanOrEqual(48);
      expect(headDim, `${m.id} headDim`).toBeLessThanOrEqual(256);
      // Powers-of-two-ish: every published head_dim and kv_head count is even.
      expect(headDim % 8, `${m.id} headDim not a multiple of 8`).toBe(0);
    }
  });

  it('implied cost per token is in the band a transformer can occupy', () => {
    // The first draft of this test asserted `KV at 8k < model bytes`. It
    // failed on phi35-mini-q4 — correctly, and the test was wrong, not the
    // spec. Phi-3.5-mini is true multi-head (32 heads, 32 KV heads), so its
    // cache is genuinely larger than its heavily-quantised weights file.
    //
    // Tying the cache to file size is precisely the assumption D1e deleted:
    // quantisation shrinks the weights and leaves the KV element width
    // alone. Writing that assumption back into the gate would have re-armed
    // the original defect from the test side.
    //
    // So the band is absolute, per token, which is architecture-honest.
    // Reference points: qwen25-coder-1.5b (2 KV heads) is 28 KB/token;
    // llama3-8b (GQA, 8 KV heads) is 128 KB/token; phi35-mini (MHA, 32 KV
    // heads) is 384 KB/token. All real, fourteen-fold apart end to end, all
    // inside this band.
    for (const m of catalog) {
      const perToken = fit.estimateKvBytes(m.kv, 1024, { bytesPerElement: 2 }) / 1024;
      expect(perToken / 1024, `${m.id} KB/token implausibly small`).toBeGreaterThan(4);
      expect(perToken / 1024, `${m.id} KB/token implausibly large`).toBeLessThan(1024);
    }
  });

  it('every entry can actually be served at some context on a 16 GB machine', () => {
    // If a spec is wrong by an order of magnitude this is where it shows:
    // the fit engine would refuse a model the catalogue recommends.
    const caps = { budget: { bytes: 16 * GB, basis: 'ram' } };
    for (const m of catalog) {
      const sized = fit.largestFittingContext(m, caps);
      expect(sized.contextTokens, `${m.id} cannot be served at all`).toBeGreaterThanOrEqual(2048);
      expect(sized.contextTokens).toBeLessThanOrEqual(m.contextCeiling);
    }
  });

  it('the one measured spec still matches the measurement', () => {
    // Llama-3.1-8B at 131,072 was observed at 16.00 GB. This is the anchor
    // the other eleven are only reasoned against.
    const m = catalog.find(x => x.id === 'llama3-8b-q4');
    expect(m).toBeTruthy();
    const kv = fit.estimateKvBytes(m.kv, 131072, { bytesPerElement: 2 });
    expect(kv / GB).toBeCloseTo(16.0, 2);
  });
});
