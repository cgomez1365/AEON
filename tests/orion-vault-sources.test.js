/**
 * /orion's Second Brain sources — what the model reads, and what the operator
 * can do with the citation.
 *
 * Audit 2026-09-23. Retrieval hands Orion the passage that MATCHED (up to
 * ~2,600 characters, retrieve.cjs MAX_DOC_CHARS). Orion cut every Vault source
 * to its first 300 characters before the model saw it — the display excerpt
 * doubled as the evidence — so a fact 400 characters into the matching passage
 * could not be cited, while each web page got 6,000 characters. And the Sources
 * list printed "Fuel card CSV notes — Second Brain" with no path, so the
 * operator had nothing to hand /doc or /ask-doc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const orionFactory = require('../src/blocks/orion_search/api/orion.cjs');

const PASSAGE = `# Fuel card CSV notes\n\n${'Northwind exports the fuel-card file every Monday for the dispatch team. '.repeat(6)}`
  + 'DATE-FORMAT FACT: January rows use MM/DD/YY and rows after the March vendor switch use DD-MM-YYYY.';

let servers, savedPort, llm;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })); });

beforeEach(async () => {
  servers = [];
  llm = vi.fn(async () => 'January rows use MM/DD/YY [1].');
  const fake = express(); fake.use(express.json());
  fake.get('/api/search-web', (req, res) => res.json({ results: '' }));   // no web hits: nothing leaves the machine
  fake.post('/api/crn/second-brain/retrieve', (req, res) => res.json({
    ok: true,
    documents: [{ id: 'Projects/Northwind/fuel-card-notes.md', content: PASSAGE, similarity: 0.61, metadata: { source: 'Fuel card CSV notes' } }],
  }));
  const f = await listen(fake); servers.push(f.server);
  savedPort = process.env.PORT; process.env.PORT = String(f.port);
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

async function search(query) {
  const app = express(); app.use(express.json()); app.use('/api', orionFactory({ isVercel: false, kernelLLM: llm }));
  const h = await listen(app); servers.push(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port}/api/orion/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}

describe('/orion — Second Brain sources', () => {
  it('the model reads the whole matching passage, not its first 300 characters', async () => {
    expect(PASSAGE.indexOf('DATE-FORMAT FACT')).toBeGreaterThan(300);   // precondition
    await search('which date formats does the fuel card export use');
    const prompt = llm.mock.calls[0][0];
    expect(prompt).toMatch(/DATE-FORMAT FACT/);
  });

  it('the result list still carries a short excerpt', async () => {
    const d = await search('fuel card dates');
    const brain = d.results.find((r) => r.source === 'brain');
    expect(brain.excerpt.length).toBeLessThanOrEqual(300);
  });

  it('each Second Brain source prints its Vault path', async () => {
    const d = await search('fuel card dates');
    expect(d.text).toMatch(/Fuel card CSV notes — Second Brain \(Projects\/Northwind\/fuel-card-notes\.md\)/);
    expect(d.sources.find((s) => s.kind === 'vault').path).toBe('Projects/Northwind/fuel-card-notes.md');
  });
});
