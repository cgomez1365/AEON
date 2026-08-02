/**
const { isInside } = require('../../../kernel/pathContainment.cjs');
 * Second Brain — Retrieval API
 * Embeds the query (native local runtime) → cosine similarity against each document's
 * cached summary embedding in vault_index.json → reads the full text of the
 * top matches → returns them with citations. No LLM reasoning calls at
 * search time — just one embed call plus in-process vector math, so it's
 * fast and doesn't compete with chat generation for API quota.
 *
 * Route:
 *   POST /crn/second-brain/retrieve  { query, k? }  — block-namespaced, no gate.
 *   POST /api/search  { query, k? }  — what NeuralTerminal.jsx actually calls for
 *     its semantic search step. Used to collide with outreach/api/search.js (now
 *     archived — see archive/legacy-second-brain-cortex/README.md); this is the
 *     real, reachable path today. A leading "/matrix " in query bypasses the
 *     recall gate (explicit ask) and gets stripped before search runs.
 *
 * Citation doctrine: model ONLY sees returned documents. If nothing clears
 * the similarity threshold, returns empty — terminal shows "not in index".
 *
 * Requires native local runtime (same as ingest.cjs's embedding step) — documents
 * indexed without an embedder running have no embedding and are never matched.
 * Vault data lives under services/storage.js's VAULT_ROOT (physically
 * src/blocks/aeon_matrix/data/Vault today), gitignored and not deployed to
 * Vercel, so this doesn't function there either way.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { loadExtractors, extractText, embed, cosineSimilarity, EMBED_MODEL } = require('./_lib.cjs');

const DEFAULT_K        = 5;
const MATCH_THRESHOLD   = 0.35; // cosine similarity floor
const MAX_DOC_CHARS     = 2000; // cap per-document content injected into context

// Lightweight intent classifier — no LLM needed, zero tokens
const RECALL_PATTERNS = [
  /\b(remember|told|said|mentioned|last time|earlier|before|yesterday|history|historical|conversation|we discussed|i asked)\b/i,
  /\b(my notes?|my docs?|my files?|second brain|brain|knowledge base|what do i know)\b/i,
  /\b(find|search|look up|retrieve|recall|pull up)\b/i,
  /\b(aeon )?matrix\b/i,
  /\b(vault|reading library)\b/i,
  /\b(collected|on file|our (data|records|knowledge)|existing (data|notes|documentation))\b/i,
];

function isRecallQuery(query) {
  return RECALL_PATTERNS.some(p => p.test(query));
}

module.exports = function retrieveFactory(deps) {
  const router = express.Router();

  const DATA_ROOT  = deps?.DATA_ROOT || path.join(__dirname, '..', 'data');
  const INDEX_FILE = path.join(DATA_ROOT, 'vault_index.json');
  const VAULT_ROOT = deps?.VAULT_ROOT || path.join(DATA_ROOT, 'Vault');

  // Stored index paths are Vault-relative — resolve against the shared root so
  // a configured Vault relocation changes neither citations nor retrieval.
  function resolveIndexedPath(relPath) {
    const rel = relPath.startsWith('Vault/') ? relPath.slice('Vault/'.length) : relPath;
    const full = path.resolve(VAULT_ROOT, rel);
    return isInside(VAULT_ROOT, full, { allowRoot: true }) ? full : null;
  }

  function readIndex() {
    if (!fs.existsSync(INDEX_FILE)) return { documents: {} };
    try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return { documents: {} }; }
  }

  async function retrieve(query, k = DEFAULT_K) {
    const index = readIndex();
    const docs = Object.values(index.documents || {}).filter(d => Array.isArray(d.embedding));
    if (!docs.length) return [];

    let queryEmbedding, queryModel;
    try {
      ({ vector: queryEmbedding, model: queryModel } = await embed(query));
    } catch (e) {
      console.warn('[RETRIEVE] query embed failed (native runtime not ready and no Gemini keys):', e.message);
      return [];
    }

    // Vectors from different embedding models aren't comparable — only score
    // docs embedded in the same space. Legacy untagged entries predate the
    // Gemini fallback and were embedded by the native local runtime.
    const comparable = docs.filter(d => (d.embeddingModel || EMBED_MODEL) === queryModel);
    const ranked = comparable
      .map(d => ({ d, score: cosineSimilarity(queryEmbedding, d.embedding) }))
      .filter(r => r.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    loadExtractors();
    const results = [];
    for (const { d: meta, score } of ranked) {
      const full = resolveIndexedPath(meta.path);
      if (!full || !fs.existsSync(full)) continue;
      try {
        const text = await extractText(full);
        if (!text) continue;
        results.push({
          id: meta.path,
          content: text.slice(0, MAX_DOC_CHARS),
          similarity: score,
          metadata: { source: meta.title, source_type: 'document', source_id: meta.path, tags: meta.tags },
        });
      } catch { /* skip unreadable file, don't fail the whole request */ }
    }
    return results;
  }

  // POST /api/search — see file header. This is what NeuralTerminal.jsx calls
  // on every submitted message, so the recall gate does the token-conservation
  // work here; a leading "/matrix " bypasses it (explicit ask) and is stripped.
  router.post('/search', async (req, res) => {
    let { query, k } = req.body || {};
    if (!query) return res.status(400).json({ documents: [] });

    if (query.trim() === 'health-check-test') return res.status(200).json({ documents: [], message: 'Link Stable' });

    const isMatrixCommand = /^\/matrix\s+/i.test(query.trim());
    if (isMatrixCommand) {
      query = query.trim().replace(/^\/matrix\s+/i, '').replace(/^"(.*)"$/, '$1');
    } else if (!isRecallQuery(query)) {
      return res.json({ documents: [], skipped: true });
    }

    try {
      const docs = await retrieve(query, k || DEFAULT_K);
      res.json({ documents: docs });
    } catch (err) {
      console.warn('[RETRIEVE] error:', err.message);
      res.json({ documents: [], error: err.message });
    }
  });

  // POST /crn/second-brain/retrieve — block-namespaced, same logic, no intent filter
  // (caller is expected to gate on isRecallQuery/explicit trigger before calling)
  router.post('/crn/second-brain/retrieve', async (req, res) => {
    const { query, k } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });

    try {
      const docs = await retrieve(query, k || DEFAULT_K);
      res.json({ documents: docs, count: docs.length });
    } catch (err) {
      console.error('[RETRIEVE] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
