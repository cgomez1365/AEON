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
// Only for its exported chunkText — /ask-doc's FULL mode needs windows for a
// document that has no chunk sidecar yet (indexed before BO-CHUNK, or never
// scanned at all, only ever fetched by exact path). No cycle: ingest.cjs
// requires _lib.cjs and nothing else in this block.
const { chunkText } = require('./ingest.cjs');
const memorySections = require('../../../kernel/memorySections.cjs');

const DEFAULT_K        = 5;
const MATCH_THRESHOLD   = 0.35; // cosine similarity floor
const MAX_DOC_CHARS     = 2600; // cap per-document content injected into context (room for two windows)
const RELATIVE_MARGIN   = 0.06; // "matched" = within this of the best score, not above the absolute floor
// Hybrid window scoring. Measured live: for "what does Principle 06 say an
// engine is", the window that literally contains "Principle 06 An engine is a
// block" ranked BELOW a table from another section on cosine alone. Summary
// embeddings compress a homogeneous corpus into a narrow band (see the
// measurement in /ask below), so a cheap lexical signal does the work cosine
// cannot: the fraction of the query's meaningful terms that appear in the
// window. Zero tokens, no model, deterministic.
const CANDIDATES        = 20;   // docs re-scored lexically, from the top of the cosine ranking
const LEX_WEIGHT        = 0.15; // full lexical overlap is worth this much cosine
const WINDOWS_PER_DOC   = 2;    // passages handed over per document, when racing the whole Vault
// /ask-doc FAST mode — nothing else is competing for the content budget, so
// one document gets far more of it than it would racing the rest of the Vault.
const DOC_WINDOWS       = 6;
const DOC_MAX_CHARS     = 9000;
// /ask-doc FULL mode — one map call per window, this many at a time. Bounded
// by ingest's own CHUNK_CAP (a document has at most 64 windows), so the
// worst case is ~22 batches, not unbounded.
const FULL_CONCURRENCY  = 3;
const STOP = new Set(['the','and','for','are','but','not','you','all','any','can','her','was','one','our','out','who','get','has','him','his','how','its','new','now','old','see','two','way','why','did','does','what','when','where','with','from','this','that','they','them','then','than','have','will','your','about','into','over','some','more','most','such','only','also','been','were','said','says','make','made','like','just','know','take','according','say','does','did']);
const terms = (t) => new Set((String(t).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter(w => !STOP.has(w)));
function lexicalOverlap(queryTerms, text) {
  if (!queryTerms.size) return 0;
  const have = terms(text);
  let n = 0; for (const q of queryTerms) if (have.has(q)) n++;
  return n / queryTerms.size;
}

// The recall gate used to live here too — a third, uncalled copy. It is
// src/kernel/context.cjs now (Doctrine R05: one policy, one place); this block
// serves retrieval and does not decide whether a turn warrants it.

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

  // Chunk sidecar, cached by mtime — it is read on every recall and can be
  // tens of MB on a real corpus.
  const CHUNKS_FILE = path.join(DATA_ROOT, 'vault_chunks.json');
  let chunkCache = { mtime: -1, data: {} };
  function readChunks() {
    try {
      if (!fs.existsSync(CHUNKS_FILE)) return {};
      const mtime = fs.statSync(CHUNKS_FILE).mtimeMs;
      if (mtime !== chunkCache.mtime) {
        chunkCache = { mtime, data: JSON.parse(fs.readFileSync(CHUNKS_FILE, 'utf8')) || {} };
      }
      return chunkCache.data;
    } catch { return {}; }
  }

  function readIndex() {
    if (!fs.existsSync(INDEX_FILE)) return { documents: {} };
    try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return { documents: {} }; }
  }

  /**
   * Resolve an operator-typed document name to exactly one indexed document.
   *
   * Never guesses (§08). An exact path, or an exact filename, wins outright
   * over everything else — that is how an operator names a specific file.
   * Short of that, every document whose title or filename CONTAINS the typed
   * text is a candidate; one candidate resolves, two or more is reported as
   * ambiguous with the list, and the caller picks rather than the code.
   */
  function resolveDocument(index, nameOrPath) {
    const q = String(nameOrPath || '').trim();
    if (!q) return [];
    const all = Object.values(index.documents || {});
    const qLower = q.toLowerCase();
    const qBase = path.basename(qLower);

    const exact = all.filter((d) => d.path === q || d.path.toLowerCase() === qLower);
    if (exact.length) return exact;

    // A typed "/" is part of a path: "research/state.md" names the file whose
    // path ENDS that way. Reducing it to its basename made it ambiguous again
    // with every other state.md in the Vault — the list it had just printed.
    const qPath = qLower.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^vault\//, '');
    if (qPath.includes('/')) {
      const bySuffix = all.filter((d) => {
        const p = d.path.toLowerCase();
        return p === qPath || p.endsWith(`/${qPath}`);   // "Vault/<rel>" as the graph writes it, or a tail
      });
      if (bySuffix.length) return bySuffix;
    }

    const byName = all.filter((d) => path.basename(d.path).toLowerCase() === qBase);
    if (byName.length) return byName;

    // Space, hyphen and underscore are one separator: an operator types
    // "carrier handbook" for Carrier_Handbook-2026.pdf, whose title IS its
    // file name (a PDF has no "# heading"). Same rule as /doc and the graph.
    const loose = (t) => String(t || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    const qn = loose(qLower);
    return all.filter((d) =>
      loose(d.title).includes(qn) ||
      loose(path.basename(d.path)).includes(qn));
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
      // Injectable for the same reason ingest's is (BO-SHIP P10): a test of
      // ranking must not need a model, and query and index must share one
      // embedder or the comparison is meaningless.
      ({ vector: queryEmbedding, model: queryModel } = await (deps?.embed || embed)(query, { kind: 'query' }));
    } catch (e) {
      console.warn('[RETRIEVE] query embed failed:', e.code || 'error', e.message);
      // The kernel owns the remedy: it knows whether nothing is assigned, the
      // key was rejected, or the endpoint is pacing. Naming a vendor here would
      // be this block guessing at a decision it does not make (§14).
      return {
        documents: [],
        unavailable: {
          reason: e.code === 'no_embed_model' ? 'no_embedding_model' : (e.code || 'no_embedding_model'),
          message: e.embedFailure
            ? e.message
            : 'Searching your documents by meaning needs an embedding model, and none is available.',
          action: e.action
            || 'Install an embedding model in Cookbook — about 150 MB, runs on CPU — or assign one to the Embedding role in Settings → Model Assignment.',
        },
      };
    }

    // Vectors from different embedding models aren't comparable — only score
    // docs embedded in the same space. Legacy untagged entries predate
    // per-vector tagging and were embedded by the native local runtime.
    const comparable = docs.filter(d => (d.embeddingModel || EMBED_MODEL) === queryModel);

    // Every document is in a different space from the query. This is the
    // silent-zero-results case: the index was built with one embedder (say
    // the local nomic model) and the query is being embedded with another
    // (a hosted endpoint, because the local runtime is not up this session). Scoring is
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

    // BO-CHUNK — a document scores by its BEST window, not its header. The
    // summary vector still counts, so a short document (no windows) ranks as
    // before; a long one can now be found by a sentence 40 KB in.
    const chunkIdx = readChunks();
    const cosineScored = comparable.map(d => {
      let score = cosineSimilarity(queryEmbedding, d.embedding);
      const rec = chunkIdx[d.path];
      const windows = [];
      if (rec && rec.model === queryModel && Array.isArray(rec.chunks)) {
        for (const c of rec.chunks) {
          const cs = cosineSimilarity(queryEmbedding, c.v);
          windows.push({ s: c.s, e: c.e, cos: cs });
          if (cs > score) score = cs;
        }
      }
      return { d, score, windows };
    }).sort((a, b) => b.score - a.score);

    // Lexical re-score of the top of the cosine ranking. Reads each candidate
    // once; the extraction is reused for the passage below.
    loadExtractors();
    const qTerms = terms(query);
    const scored = [];
    for (const cand of cosineScored.slice(0, CANDIDATES)) {
      const full = resolveIndexedPath(cand.d.path);
      let text = null;
      try { text = (full && fs.existsSync(full)) ? await extractText(full) : null; } catch { text = null; }
      if (!text) { scored.push({ ...cand, text: null, passages: [], score: cand.score }); continue; }
      let best = cosineSimilarity(queryEmbedding, cand.d.embedding) + LEX_WEIGHT * lexicalOverlap(qTerms, cand.d.summary || text.slice(0, 400));
      const ranked = cand.windows
        .map(w => ({ ...w, score: w.cos + LEX_WEIGHT * lexicalOverlap(qTerms, text.slice(w.s, w.e)) }))
        .sort((a, b) => b.score - a.score);
      if (ranked.length && ranked[0].score > best) best = ranked[0].score;
      scored.push({ d: cand.d, score: best, text, passages: ranked.slice(0, WINDOWS_PER_DOC) });
    }
    for (const cand of cosineScored.slice(CANDIDATES)) scored.push({ ...cand, text: null, passages: [] });

    const above = scored.filter(r => r.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
    // How many are as good as what is being shown, before the cut to k. The
    // caller renders "showing k of N" and refuses a counting question over a
    // subset (R02). RELATIVE, not the absolute floor: summary embeddings sit
    // in a narrow band, so an absolute floor counts nearly the whole corpus —
    // measured live, 1,467 of 1,473 "matched" a single question, which is
    // true of the floor and meaningless to the operator.
    const best = above.length ? above[0].score : 0;
    const matched = above.filter(r => r.score >= best - RELATIVE_MARGIN).length;
    const ranked = above.slice(0, k);

    const results = [];
    for (const { d: meta, score, passages, text: pre } of ranked) {
      try {
        let text = pre;
        if (text == null) {
          const full = resolveIndexedPath(meta.path);
          if (!full || !fs.existsSync(full)) continue;
          text = await extractText(full);
        }
        if (!text) continue;
        // Hand the model the passages that matched — up to two, in document
        // order, each with room either side — rather than the file's head. A
        // second window is what stops the right file with the wrong window
        // from reading as "the document does not say".
        let content;
        const picks = (passages || []).filter(p => p && p.e > p.s).sort((a, b) => a.s - b.s);
        if (picks.length) {
          const per = Math.floor(MAX_DOC_CHARS / picks.length);
          content = picks.map(pg => {
            const pad = Math.max(0, Math.floor((per - (pg.e - pg.s)) / 2));
            const s0 = Math.max(0, pg.s - pad);
            const e0 = Math.min(text.length, pg.e + pad);
            return `${s0 > 0 ? '…' : ''}${text.slice(s0, e0)}${e0 < text.length ? '…' : ''}`;
          }).join('\n[…]\n');
        } else {
          content = text.slice(0, MAX_DOC_CHARS);
        }
        const passage = picks.length ? { s: picks[0].s, e: picks[0].e, windows: picks.map(pg => ({ s: pg.s, e: pg.e })) } : null;
        results.push({
          id: meta.path,
          content,
          similarity: score,
          metadata: { source: meta.title, source_type: 'document', source_id: meta.path, path: meta.path, tags: meta.tags, passage },
        });
      } catch { /* skip unreadable file, don't fail the whole request */ }
    }
    // A genuine empty result — the index was searchable and nothing scored
    // above the threshold. No `unavailable`, because nothing is broken.
    return { documents: results, matched, k };
  }

  // POST /api/search was mounted here until 2026-08-16 and is DELETED (§21).
  // Its only caller was src/components/NeuralTerminal.jsx, removed the same
  // day; dashboard/api/chat.cjs uses /crn/second-brain/retrieve and Terminal2
  // never called it. Verified live before removal — it answered HTTP 200
  // {"documents":[],"skipped":true} — so this removed a genuinely mounted
  // route, not a stale line. Gate: tests/no-api-search.test.js.
  //
  // The recall gate and the "/matrix " bypass now live in ONE place,
  // src/kernel/context.cjs, consumed by both dashboard chat paths. The copy
  // that used to sit at the top of this file had no caller and is gone.

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
        // Both names are sent. /ask has always called this `remedy` and
        // /retrieve calls it `action`, so a client consuming both had to
        // special-case them for one concept. Renaming either would break an
        // existing caller; emitting both costs nothing and lets consumers
        // settle on one. New code should read `action`.
        action: unavailable.action,
        remedy: unavailable.action,
        citations: [],
        // Terminal2 renders a dispatched command via `text` first
        // (describeCommandOutput); without it, a real "here's why" answer
        // fell through to a generic "no output" line and read as a crash.
        text: `${unavailable.message} ${unavailable.action || ''}`.trim(),
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
        text: `${tooWeak ? `Nothing in the index is close enough to answer that (best match ${best.toFixed(2)}).` : 'Nothing in the index shares any meaningful word with that question.'} Rephrase using words closer to how you wrote it, or run /index-brain if the Vault has changed.`,
      });
    }

    // No sources → no answer, and no tokens spent finding that out.
    if (!docs.length) {
      return res.json({
        ok: true, answered: false, reason: 'no_matches',
        message: 'Nothing in the index clears the similarity threshold for that question.',
        remedy: 'Run /index-brain if the Vault has changed, or rephrase. Documents indexed without an embedding model are never matched.',
        citations: [],
        text: 'Nothing in the index clears the similarity threshold for that question. Run /index-brain if the Vault has changed, or rephrase.',
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
        // Same reason as the branches above: the dispatched-command chip
        // reads `text`, not `answer` — without this the answer only ever
        // reached the operator through the separate, best-effort narrator
        // call, and never through the chip itself.
        text: `${answer.trim()}\n\n${sources.map((s) => `[${s.n}] ${s.title}`).join('  ')}`,
        // Already a model's cited answer — a second model call to "narrate"
        // it cost tokens and could drop the citations.
        verbatim: true,
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
  // (the caller gates the turn via src/kernel/context.cjs before calling)
  //
  // This response carried no `ok` and no `text` field, top-level `documents`
  // instead of nested `data`. Terminal2's dispatched-command chip reads
  // neither `body.ok` (missing → treated as a FAILED command) nor a
  // recognisable payload shape (describeCommandOutput found no `text`, no
  // `data.logs`, no `data` object — `documents` sat one level too high to be
  // seen at all) — so a typed /recall that found real matches rendered as
  // "The command returned no output and did not say why," in red. Titles only
  // ever reached the operator through the separate ordinary-chat citation
  // footer, never through /recall itself.
  router.post('/crn/second-brain/retrieve', async (req, res) => {
    const { query, k } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });

    // A query that is ONLY a memory section name ("preferences",
    // "preferences 6 and 7") is resolved from the memory store's category
    // field: deterministic, complete, in order, full text. It used to run a
    // whole-index vector search capped at k=5 and rank numbered entries by
    // similarity. Never reaches the embedder; anything else is unchanged.
    try {
      const memFile = path.join(VAULT_ROOT, 'Agents', 'Aeon', 'memory', 'memories.json');
      let mems = [];
      try { const raw = JSON.parse(fs.readFileSync(memFile, 'utf8')); if (Array.isArray(raw)) mems = raw; } catch { /* no store */ }
      const sec = memorySections.parseSectionQuery(query, mems);
      if (sec) {
        const { entries, missing } = memorySections.selectSection(mems, sec);
        const total = mems.filter(m => String(m.category || '').toLowerCase() === sec.category).length;
        // An empty section falls through to semantic search: "project" is also
        // an ordinary word, and no memory means no reason to intercept it.
        if (total) {
          return res.json({
            ok: true, section: sec.category, source: 'memory-store',
            memories: entries, documents: [], count: entries.length, matched: entries.length, total,
            text: memorySections.renderSection({ category: sec.category, entries, missing, total: sec.numbers.length ? total : undefined }),
            verbatim: true,
          });
        }
      }
    } catch (err) {
      console.error('[RETRIEVE] section lookup failed, using semantic search:', err.message);
    }

    try {
      const { documents, unavailable, matched, k: kUsed } = await retrieve(query, k || DEFAULT_K);
      // `unavailable` rides alongside the (empty) documents rather than
      // replacing them with an error status: retrieval is best-effort for its
      // callers — the terminal must not fail a chat turn because the index is
      // cold — but a caller that wants to tell the operator why they got
      // nothing now has something to tell them.
      // `matched` is how many cleared the floor before the cut to k — the
      // caller's only way to know it is looking at a sample (R02).
      // `matched` counts the hits as good as the best (RELATIVE_MARGIN); the
      // list is the top k above the absolute floor, which can be MORE. The
      // header used `matched` alone and printed "Found 1:" above two lines.
      const found = Math.max(matched ?? 0, documents.length);
      const text = unavailable
        ? `${unavailable.message} ${unavailable.action || ''}`.trim()
        : documents.length
          ? `Found ${found}${found > documents.length ? `, showing ${documents.length} (top ${documents.length} by similarity; the rest are not listed)` : ''}:\n`
            // The Vault path rides on every line: the title alone left the
            // operator nothing to hand /doc or /ask-doc (CEO, 2026-09-22 —
            // /recall pestle, then /doc state.md, then "Not found").
            + documents.map((d, i) => `${i + 1}. ${d.metadata?.source || d.id} — ${d.id} (${(d.similarity || 0).toFixed(2)}) — ${String(d.content || '').replace(/\s+/g, ' ').trim().slice(0, 160)}${String(d.content || '').length > 160 ? '…' : ''}`).join('\n')
          : 'Nothing in the index scored above the match threshold for that search.';
      res.json({
        ok: true,
        documents, count: documents.length, matched: matched ?? documents.length, k: kUsed ?? (k || DEFAULT_K),
        ...(unavailable ? { unavailable } : {}),
        text,
        // The list is the answer: relayed as written, never paraphrased by
        // the terminal's narrator (which dropped and invented items).
        verbatim: true,
      });
    } catch (err) {
      console.error('[RETRIEVE] error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /crn/second-brain/ask-doc — answer from ONE document ─────────────
  //
  // /ask races the whole Vault for the top k documents and spends its content
  // budget across all of them — two windows each (WINDOWS_PER_DOC). That is
  // right for "what does my corpus say about X" and wrong for "what does THIS
  // book say about X": a 400,000-character PDF gets the same two 1,200-char
  // windows as a two-page note, and a question about its last chapter loses to
  // whatever else in the Vault scored higher. This route takes the document as
  // a GIVEN instead of a candidate, so it never competes for budget with the
  // rest of the Vault (DOC_WINDOWS/DOC_MAX_CHARS vs WINDOWS_PER_DOC/MAX_DOC_CHARS
  // above).
  //
  // Two modes, chosen by the operator, not guessed from the phrasing (§08):
  //   FAST (default)   — same window scoring /ask uses, scoped to this file.
  //                       One embed call. Can still miss something outside the
  //                       best-scoring passages.
  //   FULL ("full: " prefix on the question) — map/reduce over every window
  //       the document has: one small model call per window asking "is
  //       anything here relevant", then one call combining what came back.
  //       Slower and far more tokens, but it is the only mode that can find
  //       something in the last pages of a long book — which is the gap this
  //       route exists to close. Bounded by ingest's own CHUNK_CAP (64
  //       windows/document), so worst case is ~22 batches at FULL_CONCURRENCY
  //       3, not unbounded.
  router.post('/crn/second-brain/ask-doc', async (req, res) => {
    const { path: docQuery, query: rawQuery, model: modelOverride } = req.body || {};
    if (!docQuery || typeof docQuery !== 'string') {
      return res.status(400).json({ ok: false, error: 'path required', message: 'Which document? Pass its title or vault-relative path.' });
    }
    if (!rawQuery || typeof rawQuery !== 'string') {
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

    const FULL_PREFIX = /^\s*full:\s*/i;
    const full = FULL_PREFIX.test(rawQuery);
    const query = rawQuery.replace(FULL_PREFIX, '').trim();
    if (!query) {
      return res.status(400).json({ ok: false, error: 'query required', message: '"full:" needs a question after it.' });
    }

    const index = readIndex();
    const matches = resolveDocument(index, docQuery);

    if (!matches.length) {
      const titles = Object.values(index.documents || {}).slice(0, 8).map((d) => d.title || d.path);
      const text = `Nothing in the index matches "${docQuery}".`
        + (titles.length ? ` Some indexed documents: ${titles.join(', ')}.` : ' The index is empty — run /index-brain.');
      // ok:false — the operator named a document and it is not there. Same
      // answer /doc gives, and the terminal draws it as a failed chip. HTTP
      // stays 200: a non-2xx through the dispatcher raises the app-wide banner.
      return res.json({ ok: false, answered: false, reason: 'doc_not_found', error: text, message: text, text, candidates: [] });
    }
    if (matches.length > 1) {
      const candidates = matches.slice(0, 10).map((d) => ({ path: d.path, title: d.title }));
      const text = `"${docQuery}" matches ${matches.length} documents — say which one:\n`
        + candidates.map((c) => `- ${c.title} (${c.path})`).join('\n');
      return res.json({ ok: true, answered: false, reason: 'ambiguous_doc', message: `"${docQuery}" matches ${matches.length} documents.`, text, candidates, verbatim: true });
    }

    const meta = matches[0];
    const full_path = resolveIndexedPath(meta.path);
    if (!full_path || !fs.existsSync(full_path)) {
      return res.status(404).json({ ok: false, error: 'file_missing', message: `${meta.path} is indexed but no longer on disk. Run /index-brain to reconcile.` });
    }
    loadExtractors();
    let text;
    try { text = await extractText(full_path); }
    catch (e) { return res.status(500).json({ ok: false, error: 'extraction_failed', message: e.message }); }
    if (!text) return res.status(422).json({ ok: false, error: 'no_text', message: `${meta.title} has no extractable text.` });

    // ── FAST ──────────────────────────────────────────────────────────────
    if (!full) {
      let queryEmbedding, queryModel;
      try {
        ({ vector: queryEmbedding, model: queryModel } = await (deps?.embed || embed)(query, { kind: 'query' }));
      } catch (e) {
        const msg = 'Searching this document by meaning needs an embedding model, and none is available.';
        return res.json({
          ok: true, answered: false,
          reason: e.code === 'no_embed_model' ? 'no_embedding_model' : (e.code || 'no_embedding_model'),
          message: msg, text: `${msg} Install one in Cookbook, or assign one to the Embedding role in Settings → Model Assignment.`,
        });
      }
      const rec = readChunks()[meta.path];
      const windows = (rec && rec.model === queryModel && rec.chunks) || [];
      const qTerms = terms(query);
      const picks = windows
        .map((w) => ({ s: w.s, e: w.e, score: cosineSimilarity(queryEmbedding, w.v) + LEX_WEIGHT * lexicalOverlap(qTerms, text.slice(w.s, w.e)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, DOC_WINDOWS)
        .sort((a, b) => a.s - b.s);

      let content;
      if (picks.length) {
        const per = Math.floor(DOC_MAX_CHARS / picks.length);
        content = picks.map((pg) => {
          const pad = Math.max(0, Math.floor((per - (pg.e - pg.s)) / 2));
          const s0 = Math.max(0, pg.s - pad), e0 = Math.min(text.length, pg.e + pad);
          return `${s0 > 0 ? '…' : ''}${text.slice(s0, e0)}${e0 < text.length ? '…' : ''}`;
        }).join('\n[…]\n');
      } else {
        content = text.slice(0, DOC_MAX_CHARS);
      }

      const prompt = [
        `Answer the question using ONLY the passage below, from "${meta.title}".`,
        'If the passage does not contain the answer, say exactly that — do not use outside knowledge, and do not guess it might be elsewhere in the document.',
        '', `QUESTION: ${query}`, '', `PASSAGE FROM ${meta.title}:`, content,
      ].join('\n');

      try {
        const out = await kernelLLM(prompt, { role: 'chat', ...(modelOverride ? { model: modelOverride } : {}) });
        const answer = (typeof out === 'string' ? out : (out?.text || '')).trim();
        if (!answer) return res.status(502).json({ ok: false, error: 'empty_answer', message: 'The model returned nothing.' });
        return res.json({
          ok: true, answered: true, mode: 'fast',
          answer, text: `${answer}\n\n[1] ${meta.title}`, verbatim: true,
          citations: [{ n: 1, id: meta.path, title: meta.title }],
          documentsUsed: 1, windowsUsed: picks.length,
          provider: out?.provider || null, model: out?.model || null,
        });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'model_failed', message: e.message, remedy: 'Check the chat role in Settings → Model Assignment, or install a local model in Cookbook.' });
      }
    }

    // ── FULL — map every window, reduce what came back ─────────────────────
    const rec = readChunks()[meta.path];
    const windows = (rec && rec.chunks) || (text.length > 1200 ? chunkText(text) : [{ s: 0, e: text.length }]);
    if (!windows.length) {
      return res.json({ ok: true, answered: false, reason: 'no_windows', message: `${meta.title} could not be split into sections; try without "full:".` });
    }

    const NOTHING = 'NOTHING RELEVANT';
    const extracts = new Array(windows.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= windows.length) return;
        const w = windows[i];
        const passage = text.slice(w.s, w.e);
        const at = text.length ? Math.round((w.s / text.length) * 100) : 0;
        const p = [
          `This is one section of a longer document, "${meta.title}" (roughly ${at}% of the way through — AEON does not yet track real page numbers).`,
          `Extract anything relevant to the question below, quoting exact figures, names and dates. If nothing here is relevant, reply with exactly: ${NOTHING}`,
          '', `QUESTION: ${query}`, '', 'SECTION:', passage,
        ].join('\n');
        try {
          const out = await kernelLLM(p, { role: 'chat', ...(modelOverride ? { model: modelOverride } : {}) });
          const a = (typeof out === 'string' ? out : (out?.text || '')).trim();
          if (a && !a.toUpperCase().includes(NOTHING)) extracts[i] = { at, text: a };
        } catch { /* one bad window must not fail the whole read (R-05: nothing silent — it just isn't counted as relevant) */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FULL_CONCURRENCY, windows.length) }, worker));

    const found = extracts.filter(Boolean);
    if (!found.length) {
      const msg = `Read all ${windows.length} sections of ${meta.title}; none were relevant to that question.`;
      return res.json({ ok: true, answered: false, reason: 'no_matches', message: msg, text: msg, windowsRead: windows.length });
    }

    const combined = found.map((f) => `[section ~${f.at}% through]\n${f.text}`).join('\n\n---\n\n');
    const reducePrompt = [
      `These are the relevant extracts found by reading the whole of "${meta.title}", in document order.`,
      'Combine them into one answer to the question. Cite roughly where in the document each part came from (e.g. "early in the document", "~70% through"). If the extracts conflict, say so rather than picking one.',
      '', `QUESTION: ${query}`, '', 'EXTRACTS:', combined,
    ].join('\n');

    try {
      const out = await kernelLLM(reducePrompt, { role: 'chat', ...(modelOverride ? { model: modelOverride } : {}) });
      const answer = (typeof out === 'string' ? out : (out?.text || '')).trim();
      if (!answer) return res.status(502).json({ ok: false, error: 'empty_answer', message: 'The model returned nothing for the combined read.' });
      return res.json({
        ok: true, answered: true, mode: 'full',
        answer, text: `${answer}\n\n[1] ${meta.title} — read whole (${windows.length} sections, ${found.length} relevant)`, verbatim: true,
        citations: [{ n: 1, id: meta.path, title: meta.title }],
        documentsUsed: 1, windowsRead: windows.length, windowsRelevant: found.length,
        provider: out?.provider || null, model: out?.model || null,
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'model_failed', message: e.message, remedy: 'Check the chat role in Settings → Model Assignment, or install a local model in Cookbook.' });
    }
  });

  return router;
};
