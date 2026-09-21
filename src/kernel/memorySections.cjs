'use strict';

/**
 * Memory sections — a category word is a SECTION, not a search term.
 *
 * Reported live, 2026-09-20: seven memories carried category "preference" and
 * `/memory preference` returned 0, because the argument was only ever a text
 * substring. `/recall preferences` ran a whole-index vector search and printed
 * "Found 7, showing 5" — ranked by similarity, so numbered items came back in
 * arbitrary order and two never appeared.
 *
 * A section is a property the memory store already records (`category`), so
 * asking for one is a lookup, not a ranking problem. This module is the one
 * place that decides (a) whether a word names a section, (b) the order its
 * entries read in, and (c) how they render — /memory and /recall both call it
 * so the two commands cannot disagree about what "preferences" means.
 */

// The legacy taxonomy memory.cjs documents. A store can hold categories beyond
// this list; those are discovered from the store itself.
const LEGACY_CATEGORIES = ['fact', 'identity', 'preference', 'contact', 'project', 'goal'];

const FILLER = new Set(['and', 'or', 'the', 'my', 'all', 'of', 'no', 'num', 'number', 'numbers', 'nos', 'show', 'list', 'me', 'only', 'entry', 'entries', '&', ',']);

/** preferences → preference, identities → identity, "Contacts" → contact. */
function singular(word) {
  const w = String(word || '').trim().toLowerCase();
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Categories that exist: the store's own, plus the documented taxonomy. */
function knownCategories(memories) {
  const set = new Set(LEGACY_CATEGORIES);
  for (const m of memories || []) if (m && m.category) set.add(String(m.category).toLowerCase());
  return set;
}

/** Resolve a word to a category name, or null. Case-insensitive, plural-tolerant. */
function matchCategory(word, memories) {
  const s = singular(word);
  if (!s) return null;
  for (const c of knownCategories(memories)) if (singular(c) === s) return c;
  return null;
}

/** Leading number of an entry: "Preference 3. …", "3) …", "#3 …". null if none. */
function leadingNumber(text) {
  const m = /^\s*(?:[A-Za-z][A-Za-z ]{0,30}?\s+)?#?(\d+)\s*[.):\-]/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** Numbered entries by number; the rest after, by timestamp (oldest first). */
function orderMemories(list) {
  return [...list].sort((a, b) => {
    const na = leadingNumber(a.text), nb = leadingNumber(b.text);
    if (na != null && nb != null && na !== nb) return na - nb;
    if (na != null && nb == null) return -1;
    if (na == null && nb != null) return 1;
    return (a.timestamp || 0) - (b.timestamp || 0);
  });
}

/**
 * Is this query ONLY a section name (optionally with entry numbers)?
 *   "preferences"            → { category: 'preference', numbers: [] }
 *   "preferences 6 and 7"    → { category: 'preference', numbers: [6, 7] }
 *   "preference 6"           → { category: 'preference', numbers: [6] }
 *   "how do I like my tea"   → null  (anything else stays a search)
 */
function parseSectionQuery(query, memories) {
  const tokens = String(query || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return null;
  const category = matchCategory(tokens[0], memories);
  if (!category) return null;
  const numbers = [];
  for (const t of tokens.slice(1)) {
    const n = /^#?(\d+)$/.exec(t);
    if (n) numbers.push(Number(n[1]));
    else if (!FILLER.has(t)) return null;
  }
  return { category, numbers };
}

/** Section lookup: every entry of the category, ordered; optional number filter. */
function selectSection(memories, { category, numbers = [] }) {
  const inSection = orderMemories((memories || []).filter(m => String(m.category || '').toLowerCase() === category));
  if (!numbers.length) return { entries: inSection, missing: [] };
  const entries = [];
  const missing = [];
  for (const n of numbers) {
    const hits = inSection.filter(m => leadingNumber(m.text) === n);
    if (hits.length) entries.push(...hits); else missing.push(n);
  }
  return { entries, missing };
}

/** Full text, no truncation, no cap. Header states exactly what is shown. */
function renderSection({ category, entries, missing = [], total }) {
  const head = `${category} — ${entries.length}${total != null && total !== entries.length ? ` of ${total}` : ''} ${entries.length === 1 ? 'entry' : 'entries'}:`;
  const body = entries.map(m => `- ${String(m.text).trim()}`).join('\n');
  const gap = missing.length ? `\nNo ${category} entry numbered ${missing.join(', ')}.` : '';
  return `${head}\n${body}${gap}`;
}

/** Plain list for /memory with no section: category tag + full text. */
function renderList(memories) {
  if (!memories.length) return 'No memories matched.';
  return `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}:\n`
    + memories.map(m => `- [${m.category || 'fact'}] ${String(m.text).trim()}`).join('\n');
}

module.exports = {
  LEGACY_CATEGORIES, singular, knownCategories, matchCategory, leadingNumber,
  orderMemories, parseSectionQuery, selectSection, renderSection, renderList,
};
