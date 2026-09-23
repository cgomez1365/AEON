/**
 * Hardware fit ranks against the RAM it says it ranks against.
 *
 * detectRam() names `ranking_basis_gb` = total RAM, and its comment (operator
 * finding F-03) says the recommender ranks against total because macOS
 * os.freemem() reads a fraction of a gigabyte on a healthy machine. But
 * fitModel() used `system.available_ram_gb || system.total_ram_gb` —
 * available_ram_gb IS os.freemem(). So the answer flipped with whatever the
 * cache happened to hold:
 *
 *   measured 2026-09-23, same 8 GB iMac, minutes apart (agent C3):
 *     free rounded to 0.0 GB → falls back to total → Qwen3-8B "CPU/RAM Only"
 *     free read 0.5 GB       → ranks on 0.5 GB  → 35 of 37 "Does Not Fit",
 *                              only Qwen3-0.6B and Qwen2.5-0.5B fit
 *   while both responses said ranking_basis_gb: 8.
 *
 * Cookbook shows these labels where the operator picks a model to install,
 * and Fleet Control's "This machine" panel summarises them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createHwfit = require('../src/blocks/fleet_control/api/hwfit.cjs');

function call(router, url) {
  return new Promise((resolve) => {
    let done = false;
    const [p, q = ''] = url.split('?');
    const query = Object.fromEntries(q.split('&').filter(Boolean).map(kv => kv.split('=')));
    const req = { method: 'GET', url, path: p, headers: {}, query, body: {} };
    const res = {
      statusCode: 200, setHeader() {}, getHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { if (!done) { done = true; resolve({ status: this.statusCode, body: b }); } return this; },
      end() { if (!done) { done = true; resolve({ status: this.statusCode, body: null }); } return this; },
    };
    router.handle(req, res, () => { if (!done) { done = true; resolve({ status: 404, body: null }); } });
  });
}

const GB = 1024 ** 3;
afterEach(() => vi.restoreAllMocks());

async function fitsWithFree(freeGb) {
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * GB);
  vi.spyOn(os, 'freemem').mockReturnValue(freeGb * GB);
  const r = await call(createHwfit({}), '/hwfit/models?fresh=true&ignore_detected_gpu=true');
  expect(r.status).toBe(200);
  return r.body;
}

describe('hardware fit is stable against instantaneous free memory', () => {
  it('the same machine gets the same fits whether 0.04 GB or 0.5 GB is free right now', async () => {
    const a = await fitsWithFree(0.04);
    const b = await fitsWithFree(0.5);
    const fitsA = a.models.map(m => `${m.name}:${m.fit}`);
    const fitsB = b.models.map(m => `${m.name}:${m.fit}`);
    expect(fitsB).toEqual(fitsA);
  });

  it('an 8B model at Q4 is judged against the stated 8 GB basis', async () => {
    const body = await fitsWithFree(0.5);
    expect(body.system.ranking_basis_gb).toBe(8);
    const qwen8 = body.models.find(m => m.name === 'Qwen/Qwen3-8B');
    expect(qwen8.fit).toBe('cpu');
    expect(qwen8.available_gb).toBe(8);
  });

  it('a manual RAM override still wins', async () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(8 * GB);
    vi.spyOn(os, 'freemem').mockReturnValue(0.5 * GB);
    const r = await call(createHwfit({}), '/hwfit/models?fresh=true&ignore_detected_gpu=true&manual_mode=ram&manual_ram_gb=64');
    const big = r.body.models.find(m => m.name === 'Qwen/Qwen2.5-32B' || m.params_b === 32);
    expect(big.fit).toBe('cpu');
  });
});
