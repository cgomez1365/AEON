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
 *   POST /api/search  { query, k? }  — NO CALLER as of 2026-08-16. Its only caller
 *     was NeuralTerminal.jsx, deleted that day (§21); dashboard/api/chat.cjs uses
 *     the block-namespaced /crn/second-brain/retrieve and Terminal2 does not call
 *     this at all. Candidate for its own §21 deletion — prove it with a running
 *     probe first. Used to collide with outreach/api/search.js (now
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

  /**
   * Retrieve, and when nothing comes back, say WHY.
   *
   * Every failure below used to return a bare `[]`, which the caller could
   * only render as "no relevant documents found" — indistinguishable from a
   * healthy index that genuinely had no match. Three very different states
   * wore the same face: nothing indexed yet, no embedding model available at
   * all, and an index embedded in a vector space the query cannot be compared
   * against. Each has a different remedy and the operator could see none of
   * them (§08).
   *
   * @returns {{documents: Array, unavailable?: {reason, message, action}}}
   */
  async function retrieve(query, k = DEFAULT_K) {
    const index = readIndex();
    const all = Object.values(index.documents || {});
    const docs = all.filter(d => Array.isArray(d.embedding));
    if (!docs.length) {
      return {
        documents: [],
        unavailable: {
          reason: all.length ? 'index_not_embedded' : 'index_empty',
          message: all.length
            ? `${all.length} document${all.length === 1 ? '' : 's'} are in the Vault but none have been embedded yet, so they cannot be searched by meaning.`
            : 'Nothing has been indexed from the Vault yet.',
          action: 'Run /index-brain in the terminal, or open Aeon Matrix and rebuild the index.',
        },
      };
    }

    let queryEmbedding, queryModel;
    try {
      ({ vector: queryEmbedding, model: queryModel } = await embed(query));
    } catch (e) {
      console.warn('[RETRIEVE] query embed failed (native runtime not ready and no Gemini keys):', e.message);
      return {
        documents: [],
        unavailable: {
          reason: 'no_embedding_model',
          message: 'Searching your documents by meaning needs an embedding model, and none is available — the local runtime has no embedding model loaded and there is no Gemini key to fall back on.',
          action: 'Add an embedding model in Cookbook (nomic-embed-text is the small default), or add a Gemini key in Settings → Connections.',
        },
      };
    }

    // Vectors from different embedding models aren't comparable — only score
    // docs embedded in the same space. Legacy untagged entries predate the
    // Gemini fallback and were embedded by the native local runtime.
    const comparable = docs.filter(d => (d.embeddingModel || EMBED_MODEL) === queryModel);

    // Every document is in a different space from the query. This is the
    // silent-zero-results case: the index was built with one embedder (say
    // the local nomic model) and the query is being embedded with another
    // (Gemini, because the local runtime is not up this session). Scoring is
    // mathematically meaningless across spaces, so the filter above correctly
    // discards everything — but discarding everything and reporting "no
    // matches" told the operator their documents were irrelevant when in fact
    // they were unreachable, and re-indexing is the fix.
    if (!comparable.length) {
      const spaces = [...new Set(docs.map(d => d.embeddingModel || EMBED_MODEL))];
      return {
        documents: [],
        unavailable: {
          reason: 'embedding_model_mismatch',
          message: `Your documents were indexed with ${spaces.join(' and ')}, but this search is using ${queryModel}. Vectors from different embedding models cannot be compared, so none of the ${docs.length} indexed documents could be searched.`,
          action: `Re-index with /index-brain while ${queryModel} is the active embedder, or restore the model the index was built with (${spaces[0]}) in Cookbook.`,
        },
      };
    }

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
    // A genuine empty result — the index was searchable and nothing scored
    // above the threshold. No `unavailable`, because nothing is broken.
    return { documents: results };
  }

  // POST /api/search was mounted here until 2026-08-16 and is DELETED (§21).
  // Its only caller was src/components/NeuralTerminal.jsx, removed the same
  // day; dashboard/api/chat.cjs uses /crn/second-brain/retrieve and Terminal2
  // never called it. Verified live before removal — it answered HTTP 200
  // {"documents":[],"skipped":true} — so this removed a genuinely mounted
  // route, not a stale line. Gate: tests/no-api-search.test.js.
  //
  // The recall gate and the "/matrix " bypass it carried are NOT lost, but they
  // do NOT survive here: dashboard/api/chat.cjs:152-170 re-implements both
  // locally ("mirrors retrieve.cjs's isRecallQuery"), and that is the path a
  // terminal turn actually takes. Consequence worth knowing: isRecallQuery()
  // above now has no caller in this file either — see TASKS.md, deliberately
  // left for its own scoped commit rather than folded into this one.

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

    let docs, unavailable;
    try {
      ({ documents: docs, unavailable } = await retrieve(query, k || DEFAULT_K));
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'retrieval_failed', message: e.message });
    }

    // The index could not be searched at all — a different answer from "the
    // index was searched and had nothing", and the only one that comes with
    // something the operator can go and do.
    if (unavailable) {
      return res.json({
        ok: true, answered: false,
        reason: unavailable.reason,
        message: unavailable.message,
        remedy: unavailable.action,
        citations: [],
      });
    }

    // Answering costs a model call; searching does not. So /ask holds a higher
    // bar — but similarity ALONE cannot be that bar, and the measurement says
    // so plainly.
    //
    // Measured 2026-08-04, nomic-embed-text-q8 over a real report corpus:
    //   "asdfghjkl qwertyuiop"          (gibberish)  0.473
    //   "what must move together to
    //    avoid a vault lockout?"        (real)       0.471
    //   "zxqw plorbin frimble"          (gibberish)  0.423
    //   "what is the deletion protocol?"(real)       0.520
    //
    // The gibberish scored HIGHER than a genuine question. Any threshold that
    // rejects the first rejects the second — summary embeddings compress a
    // homogeneous corpus into a narrow band, so cosine distance is a ranking
    // signal, not a relevance one.
    //
    // So the floor stays low enough not to reject real questions, and a cheap
    // LEXICAL check does the work embeddings cannot: a question that shares no
    // meaningful word with any retrieved document is not a question about
    // those documents. Gibberish shares nothing; "vault lockout" shares
    // "vault" and "lockout". Zero tokens, no model, no provider.
    const ASK_MIN_SIMILARITY = 0.40;
    const STOPWORDS = new Set(['the','and','for','are','but','not','you','all','any','can','her','was','one','our','out','who','get','has','him','his','how','its','new','now','old','see','two','way','why','did','does','what','when','where','with','from','this','that','they','them','then','than','have','will','your','about','into','over','some','more','most','such','only','also','been','were','said','says','make','made','like','just','know','take','than']);

    const terms = (s) => new Set(
      String(s).toLowerCase().match(/[a-z][a-z0-9]{2,}/g)?.filter(w => !STOPWORDS.has(w)) || []
    );
    const queryTerms = terms(query);
    const lexicalHit = docs.some(d => {
      const docTerms = terms(`${d.metadata?.source || ''} ${d.content || ''}`);
      for (const t of queryTerms) if (docTerms.has(t)) return true;
      return false;
    });

    const best = docs.length ? Math.max(...docs.map(d => d.similarity || 0)) : 0;
    const tooWeak = docs.length && best < ASK_MIN_SIMILARITY;

    if (docs.length && (tooWeak || !lexicalHit)) {
      return res.json({
        ok: true, answered: false,
        reason: tooWeak ? 'weak_matches' : 'no_shared_terms',
        message: tooWeak
          ? `Nothing in the index is close enough to answer that (best match ${best.toFixed(2)}).`
          : 'Nothing in the index shares any meaningful word with that question.',
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
      const { documents, unavailable } = await retrieve(query, k || DEFAULT_K);
      // `unavailable` rides alongside the (empty) documents rather than
      // replacing them with an error status: retrieval is best-effort for its
      // callers — the terminal must not fail a chat turn because the index is
      // cold — but a caller that wants to tell the operator why they got
      // nothing now has something to tell them.
      res.json({ documents, count: documents.length, ...(unavailable ? { unavailable } : {}) });
    } catch (err) {
      console.error('[RETRIEVE] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
