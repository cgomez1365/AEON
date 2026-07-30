/**
 * R1 + R3 (retrieval layer) — scoped index store. Ship Plan v2, Month 4.
 *
 * PRIVACY BOUNDARY: every index is its own file under db/retrieval/<scope>.json.
 * There is NO global index and NO cross-scope search primitive — a query bound
 * to scope "hr" physically cannot touch "medical" (different file, never read).
 * The scope name "global" (and "all"/"*") is rejected at registration.
 *
 * Search is deterministic-first: BM25 over per-chunk term maps always works
 * (zero tokens, zero external deps). Local embeddings (nomic-embed-text) are
 * layered on top when available — cosine scores replace BM25 for chunks that
 * have embeddings. The embed model being absent degrades quality, never availability.
 *
 * R3 retrieval-layer gate: search(scope, query, { caller }) — the caller block
 * must own the scope, or declare the owner in manifest crossBlockRead (Tier 1.5).
 * 'kernel' and 'operator' callers pass. Enforced HERE, not in the router, so no
 * alternate code path can skip it.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db');
const STORE_DIR = path.join(DB_DIR, 'retrieval');
const SCOPES_FILE = path.join(STORE_DIR, '_scopes.json');
const BLOCKS_DIR = path.join(ROOT, 'src', 'blocks');

const CHUNK_CHARS = 800;
const RESERVED_SCOPES = ['global', 'all', '*', '_scopes'];

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v), 'utf8'); };

const scopeFile = (scope) => path.join(STORE_DIR, `${scope}.json`);
const getScopes = () => readJson(SCOPES_FILE, {});

// ── Scope registry ───────────────────────────────────────────────────────────
function registerScope(scope, { domain = 'general', ownerBlock = 'operator', label = scope } = {}) {
  if (!/^[a-z0-9_]+$/.test(scope)) return { ok: false, error: 'scope must be lowercase [a-z0-9_]' };
  if (RESERVED_SCOPES.includes(scope)) return { ok: false, error: `"${scope}" is reserved — one index per domain, never a global one (R1)` };
  const scopes = getScopes();
  if (scopes[scope]) return { ok: true, scope: scopes[scope], existed: true };
  scopes[scope] = { scope, domain, ownerBlock, label, createdAt: new Date().toISOString() };
  writeJson(SCOPES_FILE, scopes);
  writeJson(scopeFile(scope), { scope, documents: {} });
  return { ok: true, scope: scopes[scope], existed: false };
}

function listScopes() {
  const scopes = getScopes();
  return Object.values(scopes).map(s => {
    const idx = readJson(scopeFile(s.scope), { documents: {} });
    const docs = Object.values(idx.documents);
    return { ...s, documents: docs.length, chunks: docs.reduce((n, d) => n + d.chunks.length, 0) };
  });
}

// ── R3 retrieval-layer access gate ──────────────────────────────────────────
function checkAccess(scope, caller = 'kernel') {
  const meta = getScopes()[scope];
  if (!meta) return { allowed: false, why: `scope "${scope}" is not registered` };
  if (caller === 'kernel' || caller === 'operator' || caller === meta.ownerBlock) return { allowed: true, meta };
  // Tier 1.5 — declared cross-block READ in the calling block's manifest.
  const m = readJson(path.join(BLOCKS_DIR, caller, 'block.manifest.json'), null);
  const declared = m?.contract?.permissions?.crossBlockRead || [];
  if (declared.includes(meta.ownerBlock) || declared.includes(scope)) return { allowed: true, meta, tier: '1.5' };
  return { allowed: false, why: `block "${caller}" has no declared crossBlockRead for "${meta.ownerBlock}" (Tier 1.5) — scope "${scope}" denied at the retrieval layer (R3)` };
}

// ── Tokenize + chunk ─────────────────────────────────────────────────────────
const STOP = new Set('a,an,the,is,are,was,were,be,been,of,in,on,at,to,for,and,or,not,with,as,by,it,its,this,that,from,but,if,then,so,do,does,did,has,have,had,i,you,he,she,we,they,my,your,our,their'.split(','));
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []).filter(t => !STOP.has(t) && t.length > 1);
}

function chunkText(text) {
  const chunks = [];
  const paras = text.split(/\n\s*\n/);
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length) > CHUNK_CHARS) { chunks.push(buf.trim()); buf = ''; }
    buf += (buf ? '\n\n' : '') + p;
    while (buf.length > CHUNK_CHARS * 1.5) { chunks.push(buf.slice(0, CHUNK_CHARS).trim()); buf = buf.slice(CHUNK_CHARS); }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// ── Ingest ───────────────────────────────────────────────────────────────────
/**
 * ingest(scope, docs, { caller, embed }) — docs: [{ id, title, text, tags? }].
 * embed (optional async fn) adds vector embeddings per chunk; ingest succeeds
 * without it (BM25 terms are always stored — the deterministic floor).
 */
async function ingest(scope, docs, { caller = 'kernel', embed = null } = {}) {
  const access = checkAccess(scope, caller);
  if (!access.allowed) return { ok: false, error: access.why };

  const idx = readJson(scopeFile(scope), { scope, documents: {} });
  let chunkCount = 0, embedded = 0;
  for (const doc of docs) {
    if (!doc.id || typeof doc.text !== 'string') return { ok: false, error: 'each doc needs { id, text }' };
    const chunks = chunkText(doc.text).map((text, i) => {
      const terms = {};
      for (const t of tokenize(text)) terms[t] = (terms[t] || 0) + 1;
      return { ref: `${doc.id}#${i + 1}`, n: i + 1, text, terms, embedding: null };
    });
    if (embed) {
      for (const c of chunks) {
        try { c.embedding = await embed(c.text); embedded++; } catch { c.embedding = null; }
      }
    }
    idx.documents[doc.id] = { id: doc.id, title: doc.title || doc.id, tags: doc.tags || [], chunks, indexedAt: new Date().toISOString() };
    chunkCount += chunks.length;
  }
  writeJson(scopeFile(scope), idx);
  return { ok: true, scope, documents: docs.length, chunks: chunkCount, embedded };
}

function removeDoc(scope, docId, { caller = 'kernel' } = {}) {
  const access = checkAccess(scope, caller);
  if (!access.allowed) return { ok: false, error: access.why };
  const idx = readJson(scopeFile(scope), { scope, documents: {} });
  if (!idx.documents[docId]) return { ok: false, error: `doc "${docId}" not in scope "${scope}"` };
  delete idx.documents[docId];
  writeJson(scopeFile(scope), idx);
  return { ok: true };
}

// ── Search: BM25 floor + cosine when embeddings exist ───────────────────────
function bm25Scores(queryTerms, allChunks) {
  const k1 = 1.5, b = 0.75, N = allChunks.length || 1;
  const avgLen = allChunks.reduce((n, c) => n + Object.values(c.terms).reduce((a, v) => a + v, 0), 0) / N || 1;
  const df = {};
  for (const t of queryTerms) df[t] = allChunks.filter(c => c.terms[t]).length;
  return allChunks.map(c => {
    const len = Object.values(c.terms).reduce((a, v) => a + v, 0);
    let score = 0;
    for (const t of queryTerms) {
      const tf = c.terms[t] || 0;
      if (!tf || !df[t]) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
    }
    return score;
  });
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

/**
 * search(scope, query, { k, caller, queryEmbedding }) → { ok, passages, method }
 * passages: [{ ref, docId, title, chunkN, text, score }] — ref is the citation unit.
 */
function search(scope, query, { k = 5, caller = 'kernel', queryEmbedding = null } = {}) {
  const access = checkAccess(scope, caller);
  if (!access.allowed) return { ok: false, denied: true, error: access.why };

  const idx = readJson(scopeFile(scope), { documents: {} });
  const all = [];
  for (const doc of Object.values(idx.documents)) {
    for (const c of doc.chunks) all.push({ ...c, docId: doc.id, title: doc.title });
  }
  if (!all.length) return { ok: true, scope, passages: [], method: 'none', empty: true };

  const qTerms = tokenize(query);
  const bm = bm25Scores(qTerms, all);
  const useCosine = queryEmbedding && all.some(c => c.embedding);
  const scored = all.map((c, i) => ({
    c,
    score: useCosine && c.embedding ? cosine(queryEmbedding, c.embedding) : bm[i],
    method: useCosine && c.embedding ? 'cosine' : 'bm25',
  }));
  const floor = useCosine ? 0.35 : 0.1;
  const top = scored.filter(s => s.score > floor).sort((a, b) => b.score - a.score).slice(0, k);
  return {
    ok: true, scope, method: useCosine ? 'cosine+bm25' : 'bm25',
    passages: top.map(s => ({ ref: s.c.ref, docId: s.c.docId, title: s.c.title, chunkN: s.c.n, text: s.c.text, score: Number(s.score.toFixed(4)) })),
    empty: top.length === 0,
  };
}

module.exports = { registerScope, listScopes, checkAccess, ingest, removeDoc, search, tokenize, chunkText, STORE_DIR };
