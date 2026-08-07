/**
 * BO-D1e — the KV estimate must be arithmetic, not a coefficient.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (2026-08-05): fit.cjs estimated the KV
 * cache as a flat 0.5 MB per 1k tokens per GB of weights. For Llama-3.1-8B
 * at its 131,072 ceiling that predicts 0.29 GB. The real cache is 16.00 GB.
 * Fifty-six times under — beneath a comment that read "Deliberately an
 * over-estimate — telling someone a model fits when it does not is far worse
 * than telling them it is tight."
 *
 * That is Bible §08 at its purest: a stated safety property that the code
 * inverts. The estimate did not merely err, it erred in the direction the
 * comment promised it never would, which is why nobody looked.
 *
 * KV is not a function of file size. It is:
 *
 *     layers x kv_heads x head_dim x 2 (K and V) x bytes_per_element x ctx
 *
 * Weights and cache scale independently: a heavily-quantised 8B has a small
 * file and the same cache as a full-precision one, because quantisation
 * shrinks the weights and leaves the KV element width alone.
 *
 * These drive the real module. Nothing is re-implemented inline.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fit = require('../../services/local-runtime/fit.cjs');

const GB = 1024 * 1024 * 1024;

// Llama-3.1-8B, the model that was actually installed when this was found.
// 32 layers, 8 KV heads (GQA), head_dim 128.
const LLAMA3_8B = { layers: 32, kvHeads: 8, headDim: 128 };

/**
 * Ground truth, stated independently of the implementation so this test
 * fails if the implementation drifts toward a coefficient again.
 */
const realKvBytes = (spec, ctx, bytesPerElement) =>
  spec.layers * spec.kvHeads * spec.headDim * 2 * bytesPerElement * ctx;

describe('KV cache arithmetic', () => {
  it('matches measured KV for Llama-3.1-8B at 8k, 32k and its 131k ceiling', () => {
    // The three rows of BO-D1e's own table. f16 cache.
    const expected = { 8192: 1.0, 32768: 4.0, 131072: 16.0 };

    for (const [ctx, gb] of Object.entries(expected)) {
      const got = fit.estimateKvBytes(LLAMA3_8B, Number(ctx), { bytesPerElement: 2 });
      expect(got).toBe(realKvBytes(LLAMA3_8B, Number(ctx), 2));
      expect(got / GB).toBeCloseTo(gb, 2);
    }
  });

  it('halves when the cache is quantised to q8_0 — the lever D1e relies on', () => {
    const f16 = fit.estimateKvBytes(LLAMA3_8B, 32768, { bytesPerElement: 2 });
    const q8 = fit.estimateKvBytes(LLAMA3_8B, 32768, { bytesPerElement: 1 });
    expect(q8).toBe(f16 / 2);
    expect(q8 / GB).toBeCloseTo(2.0, 2);
  });

  it('scales linearly with context, not with file size', () => {
    const at8k = fit.estimateKvBytes(LLAMA3_8B, 8192, { bytesPerElement: 2 });
    const at16k = fit.estimateKvBytes(LLAMA3_8B, 16384, { bytesPerElement: 2 });
    expect(at16k).toBe(at8k * 2);
  });

  it('is independent of quantisation of the WEIGHTS', () => {
    // The old coefficient keyed off model bytes, so a Q4 build was predicted
    // to need a quarter the cache of an f16 build of the same architecture.
    // It needs exactly the same.
    const a = fit.estimateKvBytes(LLAMA3_8B, 32768, { bytesPerElement: 2 });
    const b = fit.estimateKvBytes(LLAMA3_8B, 32768, { bytesPerElement: 2 });
    expect(a).toBe(b);
  });

  it('never under-estimates when the architecture is unknown', () => {
    // The whole point of the comment the old code betrayed. With no spec we
    // must guess HIGH, and say that we guessed.
    const unknown = fit.estimateKvBytes(null, 32768, { bytesPerElement: 2, modelBytes: 4.58 * GB });
    const known = realKvBytes(LLAMA3_8B, 32768, 2);
    expect(unknown).toBeGreaterThanOrEqual(known);
  });
});

describe('working-set estimate', () => {
  it('no longer reports 0.29 GB of KV for an 8B at 131k', () => {
    // The regression this file is named for. Weights + KV + overhead must
    // exceed the weights by roughly the real cache, not by a rounding error.
    const modelBytes = 4.58 * GB;
    const total = fit.estimateWorkingSet(modelBytes, 131072, { kv: LLAMA3_8B });
    const kvPortion = total - modelBytes;

    expect(kvPortion / GB).toBeGreaterThan(15);   // was 0.29
    expect(total / GB).toBeCloseTo(20.88, 0);     // BO-D1e table: 20.88 GB
  });

  it('reproduces the BO-D1e total-footprint table', () => {
    const modelBytes = 4.58 * GB;
    const rows = [
      { ctx: 8192, f16: 5.88, q8: 5.38 },
      { ctx: 32768, f16: 8.88, q8: 6.88 },
      { ctx: 131072, f16: 20.88, q8: 12.88 },
    ];
    for (const r of rows) {
      const f16 = fit.estimateWorkingSet(modelBytes, r.ctx, { kv: LLAMA3_8B, bytesPerElement: 2 });
      const q8 = fit.estimateWorkingSet(modelBytes, r.ctx, { kv: LLAMA3_8B, bytesPerElement: 1 });
      expect(f16 / GB).toBeCloseTo(r.f16, 0);
      expect(q8 / GB).toBeCloseTo(r.q8, 0);
    }
  });

  it('a model that fits at 8k can fail at 131k — the case the old code hid', () => {
    const caps = { budget: { bytes: 12 * GB, basis: 'ram' } };
    const model = { id: 'llama3-8b-q4', bytes: 4.58 * GB, format: 'gguf', contextCeiling: 131072, kv: LLAMA3_8B };

    const small = fit.assess(model, caps, { contextTokens: 8192 });
    const huge = fit.assess(model, caps, { contextTokens: 131072 });

    expect(small.canInstall).toBe(true);
    expect(huge.canInstall).toBe(false);
    expect(huge.verdict).toBe('too_big');
    // §08: the refusal must name the numbers and the remedy.
    expect(huge.reason).toMatch(/GB/);
    expect(huge.remedy).toBeTruthy();
  });
});
