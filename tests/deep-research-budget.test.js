/**
 * Deep Research — the stuck loop.
 *
 * Reported symptom: "it got stuck on a loop (even with an api model) and
 * never actually gave me the answer I needed." It was not hung. Two defects
 * combined to make a failing run look like a running one:
 *
 *   Every LLM call inherited services/ai.js's 240s default while the run's
 *   whole budget was 300s, and the deadline was only tested at the top of a
 *   round — so one stalled provider consumed the budget and the loop only
 *   noticed on an iteration that never came in time to matter.
 *
 *   An empty search was `continue` with no message. DuckDuckGo, the unkeyed
 *   default, blocks after roughly three rapid scrapes, so rounds 4-8 returned
 *   nothing while the progress counter kept climbing. Eight rounds of
 *   "searching…", zero findings, and finally a report written from nothing.
 *
 * These tests drive the real router with stub search and LLM functions, so
 * they exercise the actual loop rather than a description of it. No network,
 * no provider, no vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let scratch, server, base, calls;

/**
 * @param {object} stubs
 *   search — (query) => string | throws
 *   llm    — (prompt, opts) => string | throws
 */
async function mount(stubs = {}) {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-research-'));
  calls = { search: 0, llm: 0, llmTimeouts: [] };

  const factory = require_(path.join(ROOT, 'src', 'blocks', 'deep_research', 'api', 'index.cjs'));
  // Search results must clear the 50-character floor the real loop uses to
  // tell a usable page from an empty or blocked one — a stub under it is
  // correctly treated as a failed search, which is not what these cases mean
  // to exercise.
  const searchResult = (n, q) =>
    `- **Result ${n} for ${q}**\n  A paragraph of body text long enough to look like a real search snippet about ${q}.\n  Source: [ref](https://example.com/${n})`;

  const search = async (q) => {
    calls.search++;
    if (stubs.search) return stubs.search(q, calls.search);
    return searchResult(calls.search, q);
  };

  const router = factory({
    getDataFile: () => { fs.mkdirSync(scratch, { recursive: true }); return scratch; },
    kernelLLM: async (prompt, opts = {}) => {
      calls.llm++;
      calls.llmTimeouts.push(opts.timeout_ms);
      if (stubs.llm) return stubs.llm(prompt, opts, calls.llm);
      // Planning asks for JSON; everything else takes prose.
      return prompt.includes('JSON array of strings') ? '["a","b","c"]' : `finding ${calls.llm}`;
    },
    fetchDuckDuckGo: search,
    fetchWebSearch: search,
    writeOSAudit: () => {},
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Poll the on-disk record until the run stops running. */
async function settle(sessionId, timeoutMs = 15000) {
  const file = path.join(scratch, `${sessionId}.json`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.status && d.status !== 'running') return d;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('run did not settle in time');
}

beforeEach(() => { /* per-test mount */ });
afterEach(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  server = null;
});

describe('deep research — a failing search stops, and says why', () => {
  it('stops after consecutive search failures instead of burning every round', async () => {
    // Every search returns nothing — the rate-limited DuckDuckGo case.
    await mount({ search: () => '' });

    const { session_id } = await (await post('/research/start', { query: 'anything', max_rounds: 8, max_time: 60 })).json();
    const done = await settle(session_id);

    expect(done.status).toBe('error');
    // It must NOT have run all eight rounds against a dead engine.
    expect(calls.search).toBeLessThan(8);
    // And it must name the cause and the remedy, not just fail.
    expect(done.error).toMatch(/no sources could be gathered/i);
    expect(done.error).toMatch(/search|key/i);
  });

  it('recommends a search key when the install has none', async () => {
    await mount({ search: () => '' });
    const { session_id } = await (await post('/research/start', { query: 'anything', max_time: 60 })).json();
    const done = await settle(session_id);
    // With no Brave/Serper/Tavily key present, the remedy is to add one.
    expect(done.error).toMatch(/Brave, Serper, or Tavily/i);
  });

  it('recovers when search starts working again', async () => {
    // Fails twice, then succeeds — must not have given up at the first miss.
    await mount({ search: (q, n) => (n <= 2 ? '' : `- **Hit ${n}**\n  A body paragraph with enough text to clear the usable-result floor.\n  Source: [ref](https://example.com/${n})`) });
    const { session_id } = await (await post('/research/start', { query: 'recovery', max_rounds: 5, max_time: 60 })).json();
    const done = await settle(session_id);
    expect(done.status).toMatch(/done|partial/);
    expect(done.raw_findings.length).toBeGreaterThan(0);
  });
});

describe('deep research — no findings is never a finished report', () => {
  it('refuses to write a report from nothing rather than inventing one', async () => {
    await mount({ search: () => '' });
    const { session_id } = await (await post('/research/start', { query: 'ghost topic', max_time: 60 })).json();
    const done = await settle(session_id);

    expect(done.status).toBe('error');
    // The old code sent an empty FINDINGS block to the model and filed
    // whatever came back as 'done'.
    expect(done.status).not.toBe('done');
    expect(done.raw_findings).toEqual([]);
  });
});

describe('deep research — the time budget is enforced per call', () => {
  it('caps every LLM call so one stalled provider cannot eat the run', async () => {
    await mount();
    const { session_id } = await (await post('/research/start', { query: 'budget', max_rounds: 2, max_time: 60 })).json();
    await settle(session_id);

    // Every call carried an explicit ceiling, and none exceeded the run's own
    // 60s budget — the defect was a 240s default inside a 300s run.
    expect(calls.llmTimeouts.length).toBeGreaterThan(0);
    for (const t of calls.llmTimeouts) {
      expect(t, 'every LLM call must carry a timeout').toBeTypeOf('number');
      expect(t).toBeLessThanOrEqual(60000);
    }
  });

  it('leaves time to write the report rather than spending it all searching', async () => {
    // A slow search against a short budget: the write reserve must cut the
    // loop short while there is still time to produce a report.
    //
    // What is NOT asserted here, deliberately: that the loop stopped short of
    // its round cap. /research/start floors max_time at 60 seconds
    // (Math.max(max_time, 60)), so a budget small enough to make the write
    // reserve bite within a test cannot be requested through the route — the
    // reserve at 60s is 21s, and starving it would mean a 40-second test.
    // An earlier version asserted it anyway against a wall clock and failed
    // about one full-suite run in two, which is worse than not testing it:
    // a gate that fails randomly is one people learn to re-run. The reserve's
    // arithmetic is covered by the per-call timeout case above; what this one
    // pins is that a slow search still ends in a written report.
    await mount({
      search: async (q, n) => {
        await new Promise(r => setTimeout(r, 400));
        return `- **Round ${n}**\n  A body paragraph with enough text to clear the usable-result floor.\n  Source: [ref](https://example.com/${n})`;
      },
    });
    const { session_id } = await (await post('/research/start', { query: 'slow', max_rounds: 6, max_time: 60 })).json();
    const done = await settle(session_id, 25000);

    // It produced a report rather than spending the budget searching and
    // arriving at the write phase with nothing left.
    expect(done.status).toMatch(/done|partial/);
    expect(done.result).toBeTruthy();
    expect(done.result.length).toBeGreaterThan(20);
  });
});

describe('deep research — a failed run is still recorded', () => {
  it('writes the failure to disk so the library can show what happened', async () => {
    await mount({ search: () => '' });
    const { session_id } = await (await post('/research/start', { query: 'doomed', max_time: 60 })).json();
    const done = await settle(session_id);

    // Previously a failure lived only in memory and vanished on restart, so
    // a run the operator had watched left no trace at all.
    expect(fs.existsSync(path.join(scratch, `${session_id}.json`))).toBe(true);
    expect(done.query).toBe('doomed');
    expect(done.error).toBeTruthy();
  });
});
