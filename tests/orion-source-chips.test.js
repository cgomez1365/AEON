/**
 * Orion's WEB chip switched off means no web search at all.
 *
 * Found filming 2026-10-29 (3.5.1, Local only): with WEB off before
 * searching, the page still read "16 shown · web 8 · brain 6 · blocks 2" and
 * took about 95 s. The chip only hid web rows after the search; the web leg
 * ran, three pages were fetched, and the answer was written from them.
 *
 * Drives the REAL router against a fake kernel that counts every web call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const orionFactory = require('../src/blocks/orion_search/api/orion.cjs');

let servers, savedPort, llm, hits;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })); });

beforeEach(async () => {
  servers = []; hits = { web: 0, page: 0, brain: 0 };
  llm = vi.fn(async () => 'Answer [1].');
  const fake = express(); fake.use(express.json());
  fake.get('/api/search-web', (req, res) => { hits.web++; res.json({ results: `- **Web page**\nweb excerpt\nSource: [x](http://127.0.0.1:${fake.port}/page1)` }); });
  fake.get('/page1', (req, res) => { hits.page++; res.type('html').send('<p>WEB PAGE BODY</p>'); });
  fake.post('/api/crn/second-brain/retrieve', (req, res) => { hits.brain++; res.json({ documents: [{ id: 'Saved_Artifacts/welcome.md', content: 'VAULT PASSAGE', metadata: { source: 'welcome.md' } }] }); });
  const f = await listen(fake); servers.push(f.server); fake.port = f.port;
  savedPort = process.env.PORT; process.env.PORT = String(f.port);
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

async function search(body) {
  const app = express(); app.use(express.json()); app.use('/api', orionFactory({ isVercel: false, kernelLLM: llm }));
  const h = await listen(app); servers.push(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port}/api/orion/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
}

describe('the source chips decide what is searched', () => {
  it('WEB off: the web route is never called, no page is fetched, and the answer is made from the Vault only', async () => {
    const { d } = await search({ query: 'spring welcome', sources: { web: false, brain: true, block: true } });
    expect(hits.web).toBe(0);
    expect(hits.page).toBe(0);
    expect(hits.brain).toBe(1);
    expect(d.legs).toEqual({ web: false, brain: true, block: true });
    expect(d.counts.web).toBe(0);
    expect(d.results.some((r) => r.source === 'web')).toBe(false);
    expect(d.sources.every((s) => s.kind === 'vault')).toBe(true);
    const prompt = llm.mock.calls[0][0];
    expect(prompt).toContain('VAULT PASSAGE');
    expect(prompt).not.toContain('WEB PAGE BODY');
    expect(prompt).not.toContain('web excerpt');
  });

  it('BRAIN off: the Second Brain is never asked', async () => {
    const { d } = await search({ query: 'spring welcome', sources: { brain: false } });
    expect(hits.brain).toBe(0);
    expect(hits.web).toBe(1);
    expect(d.results.some((r) => r.source === 'brain')).toBe(false);
  });

  it('no sources given (the terminal\'s /orion, VP\'s tool): every leg runs, as before', async () => {
    const { d } = await search({ query: 'spring welcome' });
    expect(hits.web).toBe(1);
    expect(hits.brain).toBe(1);
    expect(d.legs).toEqual({ web: true, brain: true, block: true });
  });

  it('every source off: a 400 that says so, and nothing runs', async () => {
    const { status, d } = await search({ query: 'x', sources: { web: false, brain: false, block: false } });
    expect(status).toBe(400);
    expect(d.error).toMatch(/Every source is switched off/);
    expect(hits).toEqual({ web: 0, page: 0, brain: 0 });
    expect(llm).not.toHaveBeenCalled();
  });

  it('the page sends its chips with the search', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/orion_search/index.jsx'), 'utf8');
    expect(src).toMatch(/JSON\.stringify\(\{ query: q, k, sources \}\)/);
  });
});
