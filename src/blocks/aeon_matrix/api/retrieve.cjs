/**
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
// Was pasted INSIDE the JSDoc block above, so it never executed: every call to
// resolveIndexedPath() threw "isInside is not defined" and retrieval returned
// nothing for anyone. Silent because the caller catches per-document errors and
// simply skipped every result — search looked empty rather than broken.
// Found 2026-08-04 by driving /ask against a real Vault.
const { isInside } = require('../../../kernel/pathContainment.cjs');
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

  // ── POST /crn/second-brain/ask — the last hop ─────────────────────────────
  //
  // Retrieval already scored the Table of Contents and read the matching files.
  // Everything up to here costs ZERO provider tokens: matching happens against
  // cached summaries and vectors, never against whole documents. What was
  // missing was the final step — hand those files to a model and get a written
  // answer back.
  //
  // The cost control IS the architecture. The index narrows the vault to a
  // handful of documents BEFORE any model is involved, so this is one call with
  // a few files rather than a rate-limit problem. That is why a local 4B
  // reading three relevant documents beats a frontier model guessing without
  // them.
  //
  // CITATION DOCTRINE, enforced rather than described: the model sees ONLY the
  // documents retrieval returned. Nothing clears the threshold → no model call
  // at all, and we say so. An answer with no source is the failure mode this
  // whole subsystem exists to avoid.
  router.post('/crn/second-brain/ask', async (req, res) => {
    const { query, k, model: modelOverride } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ ok: false, error: 'query required' });
    }

    const kernelLLM = deps?.kernelLLM;
    if (typeof kernelLLM !== 'function') {
      return res.status(503).json({
        ok: false, error: 'no_model',
        message: 'No AI service is available to this block.',
        remedy: 'Assign a model to the chat role in Settings → Model Assignment, or install a local model in Cookbook.',
      });
    }

    let docs;
    try {
      docs = await retrieve(query, k || DEFAULT_K);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'retrieval_failed', message: e.message });
    }

    // Answering costs a model call; searching does not. So /ask holds a HIGHER
    // bar than /recall, and that bar is measured rather than guessed.
    //
    // Measured 2026-08-04 with nomic-embed-text-q8 against a real Vault:
    //   real question, genuinely covered      top similarity 0.62
    //   nonsense ("quantum tarot flamingo")   top similarity 0.41
    // The browse threshold (0.35) admits that noise, so before this check a
    // meaningless question still reached the model. Cheap to answer badly is
    // still the thing this architecture exists to avoid.
    const ASK_MIN_SIMILARITY = 0.45;
    const best = docs.length ? Math.max(...docs.map(d => d.similarity || 0)) : 0;
    if (docs.length && best < ASK_MIN_SIMILARITY) {
      return res.json({
        ok: true, answered: false, reason: 'weak_matches',
        message: `Nothing in the index is close enough to answer that (best match ${best.toFixed(2)}, needs ${ASK_MIN_SIMILARITY}).`,
        remedy: 'Rephrase using words closer to how you wrote it, or run /index-brain if the Vault has changed. Use search to browse the near-misses.',
        bestSimilarity: Number(best.toFixed(3)),
        citations: docs.map((d, i) => ({
          n: i + 1, id: d.id, title: d.metadata?.source || d.id,
          similarity: Number((d.similarity || 0).toFixed(3)),
        })),
      });
    }

    // No sources → no answer, and no tokens spent finding that out.
    if (!docs.length) {
      return res.json({
        ok: true, answered: false, reason: 'no_matches',
        message: 'Nothing in the index clears the similarity threshold for that question.',
        remedy: 'Run /index-brain if the Vault has changed, or rephrase. Documents indexed without an embedding model are never matched.',
        citations: [],
      });
    }

    const sources = docs.map((d, i) => ({
      n: i + 1,
      id: d.id,
      title: d.metadata?.source || d.id,
      similarity: Number(d.similarity?.toFixed?.(3) ?? d.similarity),
    }));

    const context = docs
      .map((d, i) => `[${i + 1}] ${d.metadata?.source || d.id}\n${d.content}`)
      .join('\n\n---\n\n');

    const prompt = [
      'Answer the question using ONLY the numbered documents below.',
      'Cite the documents you used as [1], [2] and so on, inline.',
      'If the documents do not contain the answer, say exactly that — do not use outside knowledge.',
      '',
      `QUESTION: ${query}`,
      '',
      'DOCUMENTS:',
      context,
    ].join('\n');

    try {
      const out = await kernelLLM(prompt, { role: 'chat', ...(modelOverride ? { model: modelOverride } : {}) });
      const answer = typeof out === 'string' ? out : (out?.text || '');
      if (!answer.trim()) {
        return res.status(502).json({
          ok: false, error: 'empty_answer',
          message: 'The model returned nothing. Check the chat model in Settings.',
          citations: sources,
        });
      }
      res.json({
        ok: true, answered: true,
        answer: answer.trim(),
        citations: sources,
        documentsUsed: docs.length,
        // Roughly what this cost, so the operator can see the index doing its job.
        contextChars: context.length,
        provider: out?.provider || null,
        model: out?.model || null,
      });
    } catch (e) {
      res.status(502).json({
        ok: false, error: 'model_failed',
        message: e.message,
        remedy: 'Check the chat role in Settings → Model Assignment, or install a local model in Cookbook.',
        citations: sources,
      });
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
