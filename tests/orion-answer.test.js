/**
 * /orion reads the pages it finds and answers with numbered, linked sources.
 *
 * It used to stop at the search and hand the terminal raw JSON — titles and
 * 300-character excerpts, nothing read, nothing answered, no links (CEO,
 * 2026-09-07). The model does not browse; the block fetches, the kernel
 * extracts, the model cites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const orionFactory = require('../src/blocks/orion_search/api/orion.cjs');

let servers, savedPort, llm;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })); });

beforeEach(async () => {
  servers = []; llm = vi.fn(async (prompt) => `The keyslot bridge ships first [1]. Prompt saw page: ${/PAGE BODY MARKER/.test(prompt)}`);
  // One fake server plays the kernel's search-web, the Second Brain, and the web pages.
  const fake = express(); fake.use(express.json());
  fake.get('/api/search-web', (req, res) => res.json({ results: `- **AEON keyslot notes**\nSome excerpt\nSource: [x](http://127.0.0.1:${fake.port}/page1)\n\n- **Unreadable one**\nexcerpt\nSource: [y](http://127.0.0.1:${fake.port}/missing)` }));
  fake.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [{ id: 'notes.md', content: 'vault says: move both or neither', metadata: { source: 'notes.md' } }] }));
  fake.get('/page1', (req, res) => res.type('html').send('<html><body><h1>Keyslots</h1><p>PAGE BODY MARKER — the keyslot bridge ships first.</p></body></html>'));
  const f = await listen(fake); servers.push(f.server); fake.port = f.port;
  savedPort = process.env.PORT; process.env.PORT = String(f.port);
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

async function search(query) {
  const router = orionFactory({ isVercel: false, kernelLLM: llm });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const h = await listen(app); servers.push(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port}/api/orion/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}

describe('/orion', () => {
  it('fetches the page, hands its text to the model, and returns an answer with linked sources', async () => {
    const d = await search('what ships first');
    expect(d.answer).toMatch(/keyslot bridge ships first \[1\]/);
    expect(d.answer).toMatch(/Prompt saw page: true/);          // the page body reached the model
    expect(d.text).toMatch(/\*\*Sources\*\*/);
    expect(d.text).toMatch(/1\. \[AEON keyslot notes\]\(http:\/\/127\.0\.0\.1:\d+\/page1\)/);
    expect(d.text).toMatch(/could not be read; excerpt only/);   // the 404 page is marked honestly
    expect(d.text).toMatch(/notes\.md — Second Brain/);
    expect(d.sources.find(s => s.kind === 'vault')).toBeTruthy();
  });

  it('without a model, says so and still lists the linked sources', async () => {
    const router = orionFactory({ isVercel: false, kernelLLM: null });
    const app = express(); app.use(express.json()); app.use('/api', router);
    const h = await listen(app); servers.push(h.server);
    const d = await (await fetch(`http://127.0.0.1:${h.port}/api/orion/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x' }) })).json();
    expect(d.answer).toBeNull();
    expect(d.text).toMatch(/No synthesized answer — no model is assigned/);
    expect(d.text).toMatch(/\]\(http/);
  });
});
