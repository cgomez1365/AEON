/**
 * Auto-extract guards — what may become a memory without the operator asking.
 *
 * 2026-10-21, first Claude Sonnet 5.5 session. After every reply, chat-stream
 * asks a model for up to three facts and saves them as `source: 'auto-extract'`.
 * In the operator's store 123 of 152 memories (81%) came from it: 44 in two
 * hours on 10-09, 27 in one 36-minute session — some drawn from a pasted web
 * page, one an unverified claim about which model was answering. Each
 * extraction is also an extra call on the same (now paid) model.
 *
 * Three rules, all numbers named here so a reader can see and tune them:
 *   1. skipReason(): no extraction for a pasted document or a reply that is
 *      mostly tool output — neither is the operator saying something about
 *      themselves.
 *   2. isNearDuplicate(): a candidate whose content is already in a memory of
 *      the same store is dropped (the add route had exact-match dedupe only).
 *   3. createBudget(): at most MAX_PER_HOUR auto-extracted memories per store
 *      per rolling hour.
 * The 3-facts-per-reply cap, the third-person rule and R-05 logging stay where
 * they were (chat-stream.cjs, memory-policy.cjs).
 */

/** Facts taken from one reply. (Unchanged: it was a literal in chat-stream.) */
const MAX_FACTS_PER_REPLY = 3;

/**
 * A user message longer than this is a paste (a web page, a log, a document),
 * not the operator talking. The extractor reads only its first 500 characters,
 * so what it would "remember" is whatever the paste begins with.
 */
const PASTE_MAX_CHARS = 1500;

/** Tool output below this is a lookup, not a document the reply is built from. */
const TOOL_OUTPUT_MIN_CHARS = 1000;
/** Tool output above this share of (tool output + reply) = a reply that is mostly tool output. */
const TOOL_OUTPUT_SHARE = 0.5;

/**
 * Share of the CANDIDATE's content words that one existing memory already has.
 * Directional on purpose: a candidate that adds words to an old memory is new
 * information, one that only repeats it is not.
 *
 * Precision over recall. A wrongly dropped fact is lost; a wrongly kept one is
 * one extra memory, which is what happens today. One new word in five is
 * enough to change a fact ("nightly" vs "weekly"), so the bar is one in ten.
 * Measured on the labelled pairs in tests/auto-extract-guards.test.js
 * (2026-10-21): the lowest repeat scores 0.900 (ten content words, one
 * reworded), the highest fact kept scores 0.857 (a seven-word paraphrase that
 * differs in its verb: not caught, by choice). A test fails if the constant
 * leaves that gap. It reads words, not meaning: most rephrasings are kept.
 */
const NEAR_DUPLICATE_AT = 0.9;

/** Auto-extracted memories saved per store per rolling hour. */
const MAX_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;

/**
 * null when extraction may run, else the reason it was skipped (logged, R-05).
 * `toolChars`: characters of tool results this reply was built from.
 */
function skipReason({ message = '', reply = '', toolChars = 0 } = {}) {
  const asked = String(message).length;
  if (asked > PASTE_MAX_CHARS) {
    return `the message is ${asked.toLocaleString('en-US')} characters (over ${PASTE_MAX_CHARS.toLocaleString('en-US')}): a pasted document, not the operator speaking`;
  }
  const tool = Math.max(0, Number(toolChars) || 0);
  const said = String(reply).length;
  if (tool >= TOOL_OUTPUT_MIN_CHARS && tool / (tool + said) > TOOL_OUTPUT_SHARE) {
    return `the reply is built from ${tool.toLocaleString('en-US')} characters of tool output (it says ${said.toLocaleString('en-US')})`;
  }
  return null;
}

/** Characters the tools of this reply returned (the ones that worked; a refusal is not material). */
function toolOutputChars(outcomes) {
  let n = 0;
  for (const o of Array.isArray(outcomes) ? outcomes : []) if (o && o.ok === true && typeof o.text === 'string') n += o.text.length;
  return n;
}

// ── Near-duplicates ─────────────────────────────────────────────────────

// Words that carry no fact. "operator" is every stored fact's subject (the
// third-person rule), so counting it would make unrelated facts look alike.
const STOP = new Set((
  'a an the and or but of to in on at for from by with as is are was were be been being am it its this that these those '
  + 'has have had do does did will would can could should may might also just very so than then there their they them he she his her '
  + 'operator operators'
).split(' '));
// A fact and its opposite share every word but one of these.
const NEGATION = new Set(['not', 'no', 'never', 'without', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'cant', 'cannot', 'wont']);

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** The content words of a fact, lower-cased, de-pluralised; numbers kept whole ("16", "3.3"). */
function contentWords(text) {
  const words = String(text ?? '').toLowerCase()
    .replace(/['’]s\b/g, '')          // possessive
    .replace(/['’]/g, '')             // don't -> dont
    .replace(/(\d)[.,](?=\d)/g, '$1~') // keep 3.3 and 1,200 as one token
    .split(/[^a-z0-9~]+/)
    .filter(Boolean)
    .map((w) => w.replace(/~/g, '.'));
  return new Set(words.filter((w) => !STOP.has(w)).map(stem));
}

/**
 * Names and numbers in a fact: any word with a digit, and any capitalised word
 * that does not open the sentence ("Atlas", "March", "Q4X9", "16"). Two facts
 * that differ in one of these are different facts, whatever else they share.
 */
function entityWords(text) {
  const out = new Set();
  String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean).forEach((w, i) => {
    if (!(/\d/.test(w) || (i > 0 && w.length > 1 && /^[A-Z]/.test(w)))) return;
    const word = stem(w.toLowerCase());
    if (!STOP.has(word)) out.add(word);
  });
  return out;
}

/**
 * Is `candidate` already said by one of `existing` (texts, any order)?
 * → { duplicate, score, match } — `match` the existing text that scored highest.
 *
 * Score = share of the candidate's content words found in that memory. A
 * name or number the memory does not have ("Bravo" for "Alpha", "16 GB" for
 * "32 GB"), or a negation on only one side ("likes" vs "does not like"), means
 * a different fact, whatever the score. A memory that is merely MORE specific
 * still covers a candidate that is less so. A
 * candidate of fewer than two content words is a duplicate only if a memory
 * has exactly its words: one word says too little to call it covered.
 */
function isNearDuplicate(candidate, existing, threshold = NEAR_DUPLICATE_AT) {
  const cand = contentWords(candidate);
  const entities = entityWords(candidate);
  let best = { duplicate: false, score: 0, match: null };
  if (!cand.size) return best;
  for (const text of existing || []) {
    const have = contentWords(text);
    if (!have.size) continue;
    let shared = 0;
    for (const w of cand) if (have.has(w)) shared++;
    const score = shared / cand.size;
    if (score <= best.score) continue;
    const opposed = [...cand].some((w) => !have.has(w) && NEGATION.has(w))
      || [...have].some((w) => !cand.has(w) && NEGATION.has(w))
      || [...entities].some((w) => !have.has(w));
    const tooShort = cand.size < 2 && have.size !== cand.size;
    best = { duplicate: score >= threshold && !opposed && !tooShort, score, match: text };
    if (best.duplicate && score === 1) break;
  }
  return best;
}

// ── The hourly cap ──────────────────────────────────────────────────────

/**
 * Saves per store per rolling window, in memory. State is one process-wide map
 * keyed by whatever `key` the caller passes (data root + store): the block
 * factory is instantiated more than once, and a counter per instance would
 * give every instance its own allowance (the 2026-09 index-loss lesson). It
 * resets on restart, which makes the cap a brake, not a ledger.
 */
function createBudget({ max = MAX_PER_HOUR, windowMs = HOUR_MS, now = Date.now } = {}) {
  const saved = new Map();
  const live = (key) => {
    const t = now();
    const kept = (saved.get(key) || []).filter((at) => t - at < windowMs);
    saved.set(key, kept);
    return kept;
  };
  return {
    max,
    /** How many more may be saved now. */
    remaining: (key) => Math.max(0, max - live(key).length),
    /** Note `n` saves. */
    record(key, n = 1) { const kept = live(key); for (let i = 0; i < n; i++) kept.push(now()); },
    /** Minutes until one slot frees, for the log line; 0 when there is room. */
    minutesToRoom(key) {
      const kept = live(key);
      if (kept.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now() - kept[0])) / 60000));
    },
  };
}

/** The process-wide budget chat-stream spends from. */
const budget = createBudget();

module.exports = {
  skipReason, toolOutputChars, isNearDuplicate, contentWords, createBudget, budget,
  MAX_FACTS_PER_REPLY, PASTE_MAX_CHARS, TOOL_OUTPUT_MIN_CHARS, TOOL_OUTPUT_SHARE, NEAR_DUPLICATE_AT, MAX_PER_HOUR, HOUR_MS,
};
