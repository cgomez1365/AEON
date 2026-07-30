/**
 * AEON CITATION DOCTRINE — kernel gate, NOT a prompt instruction. No block
 * opts out. (Ship Plan v2, Month 4 — Non-Negotiable III.)
 *
 * Three systems, not a prompt:
 *   1. classify(query, {domain}) — DETERMINISTIC class 1–4. No LLM call:
 *      asking a model to classify would make the gate exploitable (same
 *      principle as the B2 complexity gate) and costs tokens.
 *   2. Class 3/4 → retrieval fires BEFORE kernelLLM — not after, not optionally.
 *      Empty retrieval = hardcoded "not indexed" answer; the LLM is NEVER
 *      called, so it physically cannot fill the gap from training recall.
 *   3. Response formatter attaches source refs before returning — a Class 3/4
 *      response cannot leave this module without citations.
 *
 * Classes:
 *   1 GENERATIVE          produce something new — no citation required
 *   2 GENERAL KNOWLEDGE   answerable from training — cited only if corpus contradicts
 *   3 RETRIEVAL-REQUIRED  references the user's own data — retrieve FIRST, cite ALWAYS
 *   4 KNOWLEDGE GAP       not reliably in training or corpus — scraper fires, full citation
 *
 * DOMAIN ESCALATION: medical/hr/legal/financial + a named person/case/account
 * → Class 3 ALWAYS, regardless of phrasing. "Just draft a note about John's
 * case" is Class 3 in an HR block even though it's phrased as Class 1.
 *
 * AUDIT: every Class 3/4 answer logs a retrieval receipt (query, index hits,
 * chunks returned, citations used, correlation id) to db/retrieval/receipts.jsonl.
 * This is how an HR department or medical practice defends AEON usage.
 *
 * There is deliberately NO option to skip citations or force a lower class —
 * "gate cannot be bypassed by user request" is a Month 4 exit criterion.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const retrieval = require('./retrieval.cjs');

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db');
const RECEIPTS_FILE = path.join(DB_DIR, 'retrieval', 'receipts.jsonl');

const SENSITIVE_DOMAINS = ['medical', 'hr', 'legal', 'financial'];

// ── Deterministic classifier ─────────────────────────────────────────────────
// Corpus tells — references to the user's OWN data (Class 3).
const CORPUS_TELLS = [
  /\b(my|our)\s+(notes?|docs?|files?|records?|polic(y|ies)|history|data|vault|library)\b/i,
  /\b(employee|patient|client|candidate|claimant|defendant)\s+[A-Z]/,
  /\bthe\s+\w+\s+(investigation|case|incident|audit|filing|claim)\b/i,
  /\b(on file|indexed|in (the|my|our) (vault|index|second brain|knowledge base))\b/i,
  /\b(pull|find|search|retrieve|look up|recall)\b.*\b(notes?|docs?|files?|records?|history)\b/i,
  /\b(what (did|do) (i|we) (say|know|write|record))\b/i,
];
// Knowledge-gap tells — recency the training data can't cover (Class 4).
const GAP_TELLS = [
  /\b(latest|current|recent|breaking|today'?s?|this (week|month|year))\b.*\b(news|price|law|ruling|release|version|events?)\b/i,
  /\bnewly (approved|released|passed|published)\b/i,
  /\b(case law|regulation|ruling)s?\b.*\b20(2[5-9]|[3-9]\d)\b/,
  /\bwhat('?s| is) happening\b/i,
];
// General-knowledge question forms (Class 2) — only when no corpus tell fires.
const GENERAL_FORMS = /^(what (is|are)|how (does|do)|explain|define|describe|why (does|do|is|are)|who (invented|discovered|wrote))\b/i;

// Named person heuristic: capitalized token that is not sentence-initial, or a
// possessive proper name ("John's"). Deterministic, intentionally over-broad in
// sensitive domains — a false Class 3 costs one retrieval; a false Class 1
// against a patient record is a doctrine violation.
function hasPersonName(query) {
  if (/\b[A-Z][a-z]+'s\b/.test(query)) return true;
  const tokens = query.split(/\s+/);
  return tokens.some((t, i) => i > 0 && /^[A-Z][a-z]{2,}$/.test(t.replace(/[.,;:!?]$/, '')) && !/^(I|The|A|An|What|How|Why|Who|When|Where|Is|Are|Do|Does)$/.test(t));
}

function classify(query, { domain = 'general' } = {}) {
  const reasons = [];
  const sensitive = SENSITIVE_DOMAINS.includes(String(domain).toLowerCase());

  if (GAP_TELLS.some(re => re.test(query))) {
    reasons.push('recency/knowledge-gap tell');
    return { class: 4, label: 'KNOWLEDGE GAP', reasons };
  }
  if (CORPUS_TELLS.some(re => re.test(query))) {
    reasons.push('references user corpus');
    return { class: 3, label: 'RETRIEVAL-REQUIRED', reasons };
  }
  if (sensitive && hasPersonName(query)) {
    // DOMAIN ESCALATION — named person in a sensitive domain, regardless of phrasing.
    reasons.push(`named person in sensitive domain "${domain}" — escalated`);
    return { class: 3, label: 'RETRIEVAL-REQUIRED', reasons };
  }
  // DOMAIN ESCALATION — specific reference ID in any sensitive domain.
  // A person name is not required: a chart number, case ID, transaction ref, or filing
  // number is sufficient to demand retrieval. Same doctrine as the person-name rule —
  // a false Class 3 costs one retrieval; a false Class 1 against a patient record is a
  // doctrine violation. Intentionally over-broad in sensitive domains.
  const REFERENCE_TELLS = {
    medical:   /\b(chart|mrn|patient\s*(id|#|no\.?)|record\s*(id|#)|case\s*#|study\s*id)\s*[\w\-]{2,}\b/i,
    hr:        /\b(case|employee\s*(id|#)|eid|position\s*(id|#)|file\s*(id|#)|ticket\s*(id|#)|req\s*#)\s*[\w\-]{2,}\b/i,
    legal:     /\b(filing|case|docket|matter|claim|suit|action)\s*(#|no\.?)?\s*[\w\-]{2,}\b/i,
    financial: /\b(transaction|account|invoice|filing|payment|order|receipt|ledger)\s*#?\s*[\w\-]{2,}\b/i,
  };
  const refTell = REFERENCE_TELLS[String(domain).toLowerCase()];
  if (sensitive && refTell && refTell.test(query)) {
    reasons.push(`specific ${domain} reference ID — escalated (no person name required)`);
    return { class: 3, label: 'RETRIEVAL-REQUIRED', reasons };
  }
  if (GENERAL_FORMS.test(query.trim())) {
    reasons.push('general-knowledge question form');
    return { class: 2, label: 'GENERAL KNOWLEDGE', reasons };
  }
  reasons.push('default: generative');
  return { class: 1, label: 'GENERATIVE', reasons };
}

// ── Receipts (audit rule) ────────────────────────────────────────────────────
function writeReceipt(receipt) {
  fs.mkdirSync(path.dirname(RECEIPTS_FILE), { recursive: true });
  fs.appendFileSync(RECEIPTS_FILE, JSON.stringify(receipt) + '\n', 'utf8');
  return receipt;
}
function readReceipts(n = 50) {
  try { return fs.readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').slice(-n).map(l => JSON.parse(l)); } catch { return []; }
}

// ── The gated answer path (three systems wired) ─────────────────────────────
/**
 * answerQuery({ query, scope, domain, caller, llm, embed, scrape, k })
 *   llm(prompt)   — async → string (kernelLLM bound to a role by the caller)
 *   embed(text)   — optional async → vector (local embed model); absent = BM25 floor
 *   scrape(query) — optional async → [{ title, url, snippet }] for Class 4
 *
 * Returns { class, answer, citations, receiptId } — Class 3/4 answers ALWAYS
 * carry citations or are the hardcoded "not indexed" refusal.
 */
async function answerQuery({ query, scope, domain = 'general', caller = 'kernel', llm, embed = null, scrape = null, k = 5 }) {
  if (!query) return { ok: false, error: 'query required' };
  const cls = classify(query, { domain });
  const correlationId = crypto.randomUUID();

  // Classes 1–2: model answers from capability. No retrieval, no receipt.
  if (cls.class <= 2) {
    const answer = llm ? await llm(query) : null;
    return { ok: true, class: cls.class, label: cls.label, reasons: cls.reasons, answer, citations: [], retrieved: false };
  }

  // Class 4 — scraper fires first; model may NOT answer from training.
  if (cls.class === 4) {
    const hits = scrape ? await scrape(query).catch(() => []) : [];
    if (!hits.length) {
      const answer = 'I could not reach a live source for this, and answering from training would risk stale or confabulated information (Class 4). Please retry with the scraper available.';
      writeReceipt({ correlationId, at: new Date().toISOString(), class: 4, query, scope: null, hits: 0, chunks: 0, citations: [], outcome: 'no-source-refusal' });
      return { ok: true, class: 4, label: cls.label, reasons: cls.reasons, answer, citations: [], retrieved: false, receiptId: correlationId };
    }
    const ctx = hits.slice(0, k).map((h, i) => `[web:${i + 1}] ${h.title} (${h.url})\n${h.snippet}`).join('\n\n');
    const answer = llm ? await llm(`Answer ONLY from these sources. Cite each claim with its [web:n] ref. If they don't answer it, say so.\n\nSOURCES:\n${ctx}\n\nQUESTION: ${query}`) : null;
    const citations = hits.slice(0, k).map((h, i) => ({ ref: `web:${i + 1}`, title: h.title, url: h.url }));
    writeReceipt({ correlationId, at: new Date().toISOString(), class: 4, query, scope: null, hits: hits.length, chunks: 0, citations: citations.map(c => c.ref), outcome: 'answered' });
    return { ok: true, class: 4, label: cls.label, reasons: cls.reasons, answer: formatCited(answer, citations), citations, retrieved: true, receiptId: correlationId };
  }

  // Class 3 — retrieval fires BEFORE the model, from the SCOPED index only.
  if (!scope) return { ok: false, class: 3, error: 'Class 3 query requires a scope — retrieval-required queries cannot run unscoped' };
  let queryEmbedding = null;
  if (embed) { try { queryEmbedding = await embed(query); } catch { /* BM25 floor */ } }
  const result = retrieval.search(scope, query, { k, caller, queryEmbedding });
  if (!result.ok) {
    writeReceipt({ correlationId, at: new Date().toISOString(), class: 3, query, scope, hits: 0, chunks: 0, citations: [], outcome: `denied: ${result.error}` });
    return { ok: false, class: 3, denied: result.denied, error: result.error, receiptId: correlationId };
  }
  if (result.empty) {
    // HARD PATH: the LLM is never invoked. "I don't have that" is a correct answer.
    const answer = `I don't have that document indexed in the "${scope}" scope. A confident answer from memory would risk confabulation, so I won't produce one.`;
    writeReceipt({ correlationId, at: new Date().toISOString(), class: 3, query, scope, hits: 0, chunks: 0, citations: [], outcome: 'empty-index-refusal' });
    return { ok: true, class: 3, label: cls.label, reasons: cls.reasons, answer, citations: [], retrieved: true, empty: true, receiptId: correlationId };
  }

  const ctx = result.passages.map(p => `[${p.ref}] "${p.title}" chunk ${p.chunkN}:\n${p.text}`).join('\n\n');
  const prompt = `You are answering from the user's own indexed documents. Answer ONLY from the passages below. Cite every specific factual claim with its [doc#chunk] ref. If the passages do not contain the answer, say exactly that — do not fill gaps from memory.\n\nPASSAGES:\n${ctx}\n\nQUESTION: ${query}`;
  const raw = llm ? await llm(prompt) : null;
  const citations = result.passages.map(p => ({ ref: p.ref, title: p.title, chunk: p.chunkN, score: p.score }));
  writeReceipt({ correlationId, at: new Date().toISOString(), class: 3, query, scope, method: result.method, hits: result.passages.length, chunks: result.passages.length, citations: citations.map(c => c.ref), outcome: 'answered' });
  return { ok: true, class: 3, label: cls.label, reasons: cls.reasons, answer: formatCited(raw, citations), citations, retrieved: true, method: result.method, receiptId: correlationId };
}

// System 3 — the formatter guarantees sources are attached to the text itself,
// so even a model response that ignored the citation instruction leaves this
// module carrying its refs.
function formatCited(answer, citations) {
  if (answer == null) return null;
  const hasInline = citations.some(c => answer.includes(`[${c.ref}]`));
  const sources = '\n\nSOURCES:\n' + citations.map(c => `  [${c.ref}] ${c.title}${c.url ? ` — ${c.url}` : ''}`).join('\n');
  return (hasInline ? answer : `${answer}\n\n(Citations were attached by the kernel gate — the model response did not inline them.)`) + sources;
}

module.exports = { classify, answerQuery, writeReceipt, readReceipts, formatCited, SENSITIVE_DOMAINS, RECEIPTS_FILE };
