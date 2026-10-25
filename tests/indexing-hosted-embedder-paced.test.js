/**
 * BO-EMB T5(b): indexing over a hosted, rate-limited embedder.
 *
 * Before this, a scan against a hosted embedder had no idea how long it would
 * take until it was halfway through, and a 429 from the provider fell into
 * buildEntry's catch: the document was indexed WITHOUT a vector, the warning
 * blamed a missing model, and the run went on to the next file — a rate limit
 * reported as a failure, and the work lost until the next scan.
 *
 * The fake embedder below allows 40 requests per minute and answers the 41st
 * with the same structured error kernel/embed.cjs throws on HTTP 429. Time is
 * a fake clock: the scan's sleep advances it, so 500 documents at 40/min
 * (about twelve minutes of real pacing) runs in seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ingest = require('../src/blocks/aeon_matrix/api/ingest.cjs');

const RPM = 40;
const DOCS = 500;

function fakeHostedEmbedder(log) {
  const clock = { t: 0 };
  const stamps = [];
  let calls = 0;
  let refused = 0;
  const embed = async () => {
    calls++;
    log.push({ kind: 'embed', at: clock.t });
    while (stamps.length && stamps[0] <= clock.t - 60_000) stamps.shift();
    if (stamps.length >= RPM) {
      refused++;
      // The shape kernel/embed.cjs throws for an HTTP 429.
      const e = new Error('The embedding endpoint is rate limiting this run.');
      e.code = 'embed_rate_limited';
      e.embedFailure = true;
      e.rateLimited = true;
      throw e;
    }
    stamps.push(clock.t);
    return { vector: [1, 0, 0], model: 'fake-hosted-embed' };
  };
  const sleep = async (ms) => { clock.t += ms; };
  return { embed, sleep, clock, stats: () => ({ calls, refused }) };
}

let root, vault, data, warn;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-paced-'));
  vault = path.join(root, 'Vault');
  data = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  for (let i = 0; i < DOCS; i++) {
    fs.writeFileSync(path.join(vault, `note-${String(i).padStart(3, '0')}.md`), `# Note ${i}\n\nShift log entry ${i}: the dock doors were checked and logged.`);
  }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  ingest._resetStores();
});
afterEach(() => {
  warn.mockRestore();
  ingest._resetStores();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('indexing over a hosted embedder: estimate first, rate limits paced', () => {
  it('estimates before the first call, waits out a 429 and retries, and finishes with every document embedded', async () => {
    const log = [];
    const fake = fakeHostedEmbedder(log);
    const router = ingest({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data,
      embed: fake.embed,
      sleep: fake.sleep,
      embedPlan: async () => ({ ok: true, provider: 'fake-hosted', local: false, rpm: RPM, waitNowMs: 0 }),
    });
    const events = [];
    const result = await router.runSecondBrainScan((ev) => { events.push(ev); log.push({ kind: 'event', ev }); });

    // 1. The estimate arrives before any embedding call is made.
    const estIdx = log.findIndex((l) => l.kind === 'event' && l.ev.estimate);
    const firstEmbed = log.findIndex((l) => l.kind === 'embed');
    expect(estIdx, 'no estimate event before the scan').toBeGreaterThanOrEqual(0);
    expect(estIdx).toBeLessThan(firstEmbed);
    const est = log[estIdx].ev.estimate;
    expect(est.documents).toBe(DOCS);
    expect(est.calls).toBe(DOCS + 1);             // one per document, plus the space probe
    expect(est.rpm).toBe(RPM);
    expect(est.ms).toBe(Math.floor(DOCS / RPM) * 60_000); // 12 minutes at 40/min
    expect(log[estIdx].ev.message).toMatch(/about 12 min/);

    // 2. The provider did refuse mid-scan, and that was reported as paced, never failed.
    expect(fake.stats().refused).toBeGreaterThan(0);
    const paced = events.filter((e) => e.paced === true && !e.done);
    expect(paced.length).toBeGreaterThan(0);
    expect(paced[0].waitMs).toBeGreaterThan(0);
    expect(paced[0].message).toMatch(/paced/i);
    expect(events.filter((e) => e.error)).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.chunkFailed).toBe(0);
    expect(result.paced).toBe(paced.length);
    expect(result.pacedMs).toBeGreaterThan(0);
    // The waits were real waits on the scan's clock.
    expect(fake.clock.t).toBeGreaterThanOrEqual(Math.floor(DOCS / RPM) * 60_000);

    // 3. The scan finished: every document is in the index WITH a vector.
    expect(result.ingested).toBe(DOCS);
    expect(result.embedded).toBe(DOCS);
    const idx = JSON.parse(fs.readFileSync(path.join(data, 'vault_index.json'), 'utf8'));
    const docs = Object.values(idx.documents);
    expect(docs).toHaveLength(DOCS);
    expect(docs.every((d) => Array.isArray(d.embedding) && d.embedding.length === 3)).toBe(true);
    const status = JSON.parse(fs.readFileSync(path.join(data, 'index_status.json'), 'utf8'));
    expect(status.lastResult.paced).toBe(paced.length);
    expect(status.lastResult.estimate.calls).toBe(DOCS + 1);
  }, 120_000);

  it("a provider's Retry-After sets the wait, and the kernel reads it off the 429", async () => {
    const { retryAfterMs } = require('../src/kernel/embed.cjs');
    const res = (v) => ({ headers: { get: (k) => (k === 'retry-after' ? v : null) } });
    expect(retryAfterMs(res('7'))).toBe(7000);
    expect(retryAfterMs(res(null))).toBe(0);
    expect(retryAfterMs(res('soon'))).toBe(0);

    let refusedOnce = false;
    const waits = [];
    const router = ingest({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data,
      embed: async () => {
        if (!refusedOnce) {
          refusedOnce = true;
          const e = new Error('The embedding endpoint is rate limiting this run.');
          e.code = 'embed_rate_limited'; e.rateLimited = true; e.retryAfterMs = 7000;
          throw e;
        }
        return { vector: [1, 0, 0], model: 'fake-hosted-embed' };
      },
      sleep: async (ms) => { waits.push(ms); },
      embedPlan: async () => ({ ok: true, provider: 'fake-hosted', local: false, rpm: RPM, waitNowMs: 0 }),
    });
    const events = [];
    const result = await router.runSecondBrainScan((ev) => events.push(ev));
    expect(waits).toEqual([7000]);
    expect(events.find((e) => e.paced === true && !e.done).waitMs).toBe(7000);
    expect(result.embedded).toBe(DOCS);
  }, 120_000);

  it('a local embedder has no rate limit: the estimate counts the calls and claims no time', async () => {
    const router = ingest({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data,
      embed: async () => ({ vector: [1, 0, 0], model: 'local-embed' }),
      embedPlan: async () => ({ ok: true, provider: 'local', local: true, rpm: 0, waitNowMs: 0 }),
    });
    const events = [];
    const result = await router.runSecondBrainScan((ev) => events.push(ev));
    const est = events.find((e) => e.estimate);
    expect(est.estimate.calls).toBe(DOCS + 1);
    expect(est.estimate.ms).toBeNull();
    expect(events.some((e) => e.paced === true)).toBe(false);
    expect(result.paced).toBe(0);
    expect(result.embedded).toBe(DOCS);
  }, 120_000);
});
