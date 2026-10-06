/**
 * Embedding draws on the SAME per-credential budget chat does.
 *
 * pacing.cjs says chat and embedding share one bucket per credential, so an
 * indexing run and a chat turn cannot each believe they have the operator's
 * whole requests-per-minute limit. embed.cjs paced by address alone, which is a
 * different key from chat's the moment a connection has a credential — two
 * buckets, so the operator's number was spent twice over.
 *
 * Drives the real kernelEmbed against a fake Gemini embedder on 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...s) => path.join(ROOT, ...s);
const MODS = [P('src', 'kernel', 'endpoints.cjs'), P('src', 'kernel', 'vault.cjs'), P('src', 'kernel', 'embed.cjs'), P('src', 'kernel', 'pacing.cjs')];

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-pace-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'embed-pace-suite-key';
const saved = {};
for (const m of MODS) { saved[m] = require.cache[m]; delete require.cache[m]; }

let server;
let hits = 0;
let base;

beforeAll(async () => {
  const fake = express();
  fake.use(express.json());
  fake.post(/:embedContent$/, (_req, res) => { hits++; res.json({ embedding: { values: [0.1, 0.2, 0.3] } }); });
  await new Promise((r) => { server = fake.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/v1beta`;
  await require(MODS[1]).setSecret('emb-k1', 'test-only-embed-key');
  fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
    endpoints: [{ id: 'emb', provider: 'gemini', base_url: base, auth_ref: 'emb-k1', auth_refs: ['emb-k1'], reachable_from: ['local'], models: ['text-embedding-test'], rpm_limit: 1 }],
    roles: { embed: { endpoint_id: 'emb', model: 'text-embedding-test' } },
  }));
});

afterAll(() => {
  try { server.close(); } catch {}
  for (const [m, mod] of Object.entries(saved)) { if (mod) require.cache[m] = mod; else delete require.cache[m]; }
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
});

describe('an embedding call spends the same budget a chat call on that key does', () => {
  it('leaves its stamp in the credential\'s bucket, the one chat paces against', async () => {
    const pacing = require(MODS[3]);
    pacing._reset();
    const { kernelEmbed } = require(MODS[2]);
    const r = await kernelEmbed('hello', { kind: 'document' });
    expect(r.vector).toEqual([0.1, 0.2, 0.3]);
    expect(hits).toBe(1);
    // The key chat uses for this connection's one credential (services/ai.js).
    const chatKey = pacing.paceKey(base, 'gemini', 'emb-k1');
    expect(pacing.waitEstimateMs(chatKey, 1), 'embedding took a slot in a bucket chat never reads').toBeGreaterThan(0);
    // And not in an address-only bucket of its own.
    expect(pacing.waitEstimateMs(pacing.paceKey(base, 'gemini'), 1)).toBe(0);
  });
});

describe('an embedding wait is not silent', () => {
  it('says in the log that indexing shares the limit, once for a run of calls, and still completes', async () => {
    const pacing = require(MODS[3]);
    pacing._reset();
    const { kernelEmbed } = require(MODS[2]);
    const lines = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { lines.push(a.join(' ')); });
    await kernelEmbed('one', { kind: 'document' });         // the one slot of this minute
    const hitsBefore = hits;
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const calls = [kernelEmbed('two', { kind: 'document' }), kernelEmbed('three', { kind: 'document' })];
      await vi.advanceTimersByTimeAsync(3_000);
      const said = lines.filter((l) => /pacing: waiting \d+s for gemini \(your limit: 1\/min/.test(l));
      expect(said, 'an embedding waited on the limit with no line anywhere').toHaveLength(1);
      expect(said[0]).toMatch(/indexing and chat share it/);
      expect(said[0]).toMatch(/Settings → Keys/);
      expect(hits).toBe(hitsBefore);
      // Let the first waiter through; the second is out of patience (it gives
      // up with the limit's own error rather than hanging).
      let done = false;
      const all = Promise.allSettled(calls).then((r) => { done = true; return r; });
      for (let i = 0; i < 80 && !done; i++) { await vi.advanceTimersByTimeAsync(1000); await new Promise((r) => realSetTimeout(r, 5)); }
      const settled = await all;
      expect(settled.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
