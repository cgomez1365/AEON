/**
 * Deep Research does not list a refused search key as Active (sweep C24).
 *
 * The search service now remembers a provider refusing a key (401/403) and a
 * key that cannot be sent (spaces, non-ASCII), and Settings shows it. Deep
 * Research read only `!!process.env[k]`: a refused Tavily key stayed "Active"
 * in its provider list and was tried first on every round, only to fall to
 * DuckDuckGo. The server now hands it searchKeyStatus through deps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const factory = require('../src/blocks/deep_research/api/index.cjs');
const NAMES = ['TAVILY_API_KEY', 'SERPER_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY_2', 'SERPER_API_KEY_2', 'BRAVE_API_KEY_2'];

let saved, scratch, server;
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
  for (const k of NAMES) delete process.env[k];
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-dr-keys-'));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { server?.close(); } catch {}
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function providers(searchKeyStatus) {
  const stub = async () => null;
  const router = factory({
    getDataFile: () => scratch, kernelLLM: async () => '', writeOSAudit: () => {},
    fetchDuckDuckGo: stub, fetchBraveSearch: stub, fetchSerperSearch: stub, fetchTavilySearch: stub, fetchWebSearch: stub,
    ...(searchKeyStatus ? { searchKeyStatus } : {}),
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const list = await (await fetch(`http://127.0.0.1:${server.address().port}/api/research/search/providers`)).json();
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

describe('GET /research/search/providers', () => {
  it('a key the provider refused is not available, and says why', async () => {
    process.env.TAVILY_API_KEY = 'tvly-refused';
    process.env.SERPER_API_KEY = 'serper-fine';
    const status = (name) => (name === 'TAVILY_API_KEY'
      ? { state: 'rejected', status: 401, reason: 'Tavily refused this key (HTTP 401). Re-enter it in Settings → Keys.' }
      : { state: process.env[name] ? 'ok' : 'unset' });
    const p = await providers(status);
    expect(p.tavily).toMatchObject({ available: false, note: expect.stringMatching(/Tavily refused this key \(HTTP 401\)/) });
    expect(p.serper).toMatchObject({ available: true, note: 'Active' });
    expect(p.brave).toMatchObject({ available: false, note: expect.stringMatching(/Add a Brave key/) });
  });

  it('a key that cannot be sent is not available either', async () => {
    process.env.BRAVE_API_KEY = 'BSA with spaces';
    const p = await providers((name) => (name === 'BRAVE_API_KEY'
      ? { state: 'malformed', reason: 'BRAVE_API_KEY is set but is not a usable key (spaces or non-ASCII). Re-enter it in Settings → Keys.' }
      : { state: 'unset' }));
    expect(p.brave).toMatchObject({ available: false, note: expect.stringMatching(/not a usable key/) });
  });

  it('with no status reader (an older host), a set key still counts, as before', async () => {
    process.env.TAVILY_API_KEY = 'tvly-set';
    expect((await providers(null)).tavily.available).toBe(true);
  });

  it('the server passes the search service\'s reader to blocks', () => {
    const src = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');
    expect(src).toMatch(/searchKeyStatus: search\.searchKeyStatus,/);
  });
});
