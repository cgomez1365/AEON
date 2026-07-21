/**
 * /api/retrieval — R1/R2/R3 + citation doctrine (Month 4).
 *
 *   GET  /api/retrieval/scopes
 *   POST /api/retrieval/scopes                 { scope, domain, label }
 *   POST /api/retrieval/:scope/ingest          { docs: [{ id, title, text, tags? }] }
 *   POST /api/retrieval/:scope/search          { query, k? }          — raw scoped search (gated)
 *   POST /api/retrieval/query                  { query, scope?, domain?, k? } — the FULL gated path
 *   POST /api/retrieval/classify               { query, domain? }     — inspect the classifier
 *   GET  /api/retrieval/receipts[?n=50]        — audit trail
 *
 * The caller identity for R3 checks comes from x-aeon-block (blocks proxying
 * a user query) or defaults to 'operator' (the human at the terminal).
 */
const express = require('express');
const citationGate = require('../citationGate.cjs');
const retrieval = require('../retrieval.cjs');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
async function embedOllama(text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
  return (await res.json()).embeddings[0];
}

module.exports = function createRetrievalRouter(deps) {
  const router = express.Router();
  const { kernelLLM, fetchDuckDuckGo } = deps;
  const caller = (req) => req.headers['x-aeon-block'] || 'operator';

  router.get('/scopes', (_req, res) => res.json({ scopes: retrieval.listScopes() }));

  router.post('/scopes', (req, res) => {
    const { scope, domain, label } = req.body || {};
    if (!scope) return res.status(400).json({ error: 'scope required' });
    const r = retrieval.registerScope(scope, { domain, label, ownerBlock: caller(req) });
    res.status(r.ok ? 200 : 400).json(r);
  });

  router.post('/:scope/ingest', async (req, res) => {
    const { docs } = req.body || {};
    if (!Array.isArray(docs) || !docs.length) return res.status(400).json({ error: 'docs[] required' });
    // Embeddings are best-effort (Ollama may be down); BM25 floor always lands.
    let embed = embedOllama;
    try { await embedOllama('ping'); } catch { embed = null; }
    const r = await retrieval.ingest(req.params.scope, docs, { caller: caller(req), embed });
    res.status(r.ok ? 200 : r.error?.includes('crossBlockRead') ? 403 : 400).json(r);
  });

  router.post('/:scope/search', async (req, res) => {
    const { query, k } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    let queryEmbedding = null;
    try { queryEmbedding = await embedOllama(query); } catch {}
    const r = retrieval.search(req.params.scope, query, { k: k || 5, caller: caller(req), queryEmbedding });
    res.status(r.ok ? 200 : r.denied ? 403 : 400).json(r);
  });

  // R2 — the full doctrine path: classify → (retrieve|scrape) → synthesize → cite → receipt.
  router.post('/query', async (req, res) => {
    const { query, scope, domain, k } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    const result = await citationGate.answerQuery({
      query, scope, domain, k: k || 5,
      caller: caller(req),
      llm: kernelLLM ? (p) => kernelLLM(p, { role: 'research' }) : null,
      embed: embedOllama,
      scrape: fetchDuckDuckGo ? async (q) => {
        const hits = await fetchDuckDuckGo(q, 'citation-gate');
        return (Array.isArray(hits) ? hits : []).map(h => ({ title: h.title || h.url, url: h.url, snippet: h.snippet || h.title || '' }));
      } : null,
    });
    res.status(result.ok ? 200 : result.denied ? 403 : 400).json(result);
  });

  router.post('/classify', (req, res) => {
    const { query, domain } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    res.json(citationGate.classify(query, { domain }));
  });

  router.get('/receipts', (req, res) => res.json({ receipts: citationGate.readReceipts(Number(req.query.n) || 50) }));

  return router;
};
