/**
 * Memory policy — what gets recalled, in whose voice, and what may be claimed.
 *
 * BO-D2a. Four defects shared one root: memory decisions were made inline, in
 * two different files, with no shared statement of what memory is FOR.
 *
 *   chat-stream.cjs:66            character budget, silent `break`
 *   memory_core/api/memory.cjs:148  character budget, silent `break`
 *
 * Two copies of the same policy drift independently, and neither could be
 * tested without standing up an HTTP route. This module is the single
 * statement; both callers consume it.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS (§26)
 * Operator-owned state that survives model churn is the moat. A memory that
 * lies fails in the one direction the operator cannot detect: they believe
 * their data is kept, and act on that belief. "User data saved" — a sentence
 * that appears nowhere in this codebase, because the model invented it to
 * fill a silence — is the whole defect in four words.
 *
 * PRINCIPLE 03, deliberate memory: recall is a choice, not an accidental
 * side effect. A choice has to be visible to be a choice, which is why
 * eviction returns a count and the state is stated rather than implied.
 */

const tokens = require('./tokens.cjs');

/** How the operator is referred to in stored facts. Third person, always. */
const SUBJECT = 'The operator';

/**
 * Rewrite a fact into third person.
 *
 * A memory block is injected into a SYSTEM prompt, where "you" addresses the
 * model. So "your name is Cristian" told the model that its own name was
 * Cristian — and "[fact] I am Nanaki" sitting beside it is very likely the
 * same confusion coming back out. Person is not a style question here; it
 * decides who the sentence is about.
 *
 * Deliberately conservative. It rewrites the pronoun forms that actually
 * appeared and leaves anything it does not recognise untouched, because
 * silently mangling an operator's own words would be its own §08 defect.
 * Word boundaries throughout — "the Yourdon method" is not second person.
 *
 * @returns {{text: string, changed: boolean}}
 */
function normalizeFactPerson(input) {
  const original = String(input == null ? '' : input).trim();
  if (!original) return { text: '', changed: false };

  let s = original;

  // First person: "I am X" / "I'm X" / "my X" / "I <verb>".
  s = s.replace(/^I\s+am\b/i, `${SUBJECT} is`);
  s = s.replace(/^I'm\b/i, `${SUBJECT} is`);
  s = s.replace(/^my\b/i, `${SUBJECT}'s`);
  s = s.replace(/^I\s+(?=[a-z])/i, `${SUBJECT} `);

  // Second person: "your X" / "you are X" / "you're X".
  s = s.replace(/^you\s+are\b/i, `${SUBJECT} is`);
  s = s.replace(/^you're\b/i, `${SUBJECT} is`);
  s = s.replace(/^your\b/i, `${SUBJECT}'s`);

  // Mid-sentence possessives, word-bounded.
  s = s.replace(/\byour\b/gi, `${SUBJECT.toLowerCase()}'s`);
  s = s.replace(/\byou\s+are\b/gi, `${SUBJECT.toLowerCase()} is`);

  s = s.replace(/\s+/g, ' ').trim();

  // Residual first/second person that CANNOT be rewritten mechanically.
  //
  // Found live: "I am Nanaki and I run Broken Gear" becomes "The operator is
  // Nanaki and I run Broken Gear" — the leading clause is fixed and the
  // second is not. Rewriting it would produce "the operator run", because
  // changing the subject changes verb agreement, and a rewriter that mangles
  // grammar to satisfy a rule is worse than one that admits its limit.
  //
  // So the limit is reported rather than hidden. The extractor is separately
  // instructed to write third person, which is where this should be solved;
  // this flag exists so a fact that slipped through is visible instead of
  // quietly wrong in the operator's own store (§08).
  // "I" and "my" are matched case-sensitively — lowercase "i" is far more
  // often a typo or an initial than a pronoun, and "My" mid-sentence is rare.
  // The second-person forms are case-insensitive because they arrive from a
  // model, which capitalises inconsistently.
  const residualPerson = /\b(I|me|My|mine)\b/.test(s) || /\b(you|your|yours)\b/i.test(s);

  return { text: s, changed: s !== original, residualPerson };
}

/** Continuity outranks recency — operator-authored and settled decisions first. */
const TYPE_WEIGHT = { decision: 400, algorithm: 300, outline: 300, milestone: 50 };
function continuityRank(m) {
  const typeKey = m.type !== undefined ? m.type : m.category;
  const typeScore = TYPE_WEIGHT[typeKey] !== undefined ? TYPE_WEIGHT[typeKey] : 150;
  return (m.source === 'operator' ? 500 : 0) + typeScore;
}

/**
 * The clause that makes injection mean something.
 *
 * The vault held "final fantasy 7" and the model answered "Final Fantasy V".
 * The fact was stored, and injected, and then overridden by the model's own
 * priors — which is worse than having no memory at all, because it looks
 * like it works. Injected text with no stated precedence is a suggestion.
 * This says which source wins, and it is the §03 ownership principle
 * expressed as a sentence: the operator's record beats the model's training.
 */
const PRECEDENCE = 'These are ground truth about the operator and this system, '
  + 'recorded by the operator. They are authoritative and override anything you '
  + 'believe from training. If a stored fact contradicts your own knowledge, the '
  + 'stored fact is correct — use it and do not correct it.';

/**
 * Choose what to inject, within a TOKEN budget, and report what was dropped.
 *
 * @param {object} opts
 * @param {Array}  opts.memories
 * @param {number} opts.budgetTokens
 * @param {boolean} [opts.wake]
 * @param {string} [opts.query]  bias toward relevance to this message
 * @param {number} [opts.maxCount]  hard cap on entries considered, after ranking
 * @returns {{text, lines, injected, considered, dropped, tokensUsed}}
 */
function selectForInjection({ memories, budgetTokens, wake = false, query = '', maxCount = 0 } = {}) {
  const all = Array.isArray(memories) ? memories.filter(m => m && m.text) : [];
  const considered = all.length;
  if (!considered || !(budgetTokens > 0)) {
    return { text: '', lines: [], injected: 0, considered, dropped: considered, tokensUsed: 0 };
  }

  const words = String(query || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 3);

  const scored = all.map((m) => {
    let score = (m.pinned ? 100000 : 0) + continuityRank(m);
    if (words.length) {
      const hay = `${m.text} ${m.title || ''}`.toLowerCase();
      for (const w of words) score += (hay.split(w).length - 1) * 10;
    }
    // Recency only ever breaks ties.
    score += Math.max(0, 5 - (Date.now() - (m.timestamp || 0)) / 86400000 / 30);
    return { m, score };
  }).sort((a, b) => b.score - a.score);

  // The header carries a fixed cost of roughly 65 tokens, and it is charged
  // against the budget rather than hidden outside it — a budget that does not
  // count everything it spends is the character-vs-token defect wearing a new
  // hat. It is also not optional: facts injected with no stated precedence
  // are what produced #9. So a budget too small for the header yields no
  // injection at all, rather than facts the model is free to overrule.
  const header = `\n\n## MEMORY\n${PRECEDENCE}\n`;
  const headerCost = tokens.estimateTokens(header);

  // A count cap applied AFTER ranking, so it keeps the best rather than the
  // first N off disk. Anything it excludes is still counted as dropped —
  // a cap is a reason a memory did not appear, not a reason to forget it did
  // not appear.
  const ranked = maxCount > 0 ? scored.slice(0, maxCount) : scored;
  let dropped = scored.length - ranked.length;

  const lines = [];
  let tokensUsed = 0;

  for (const { m } of ranked) {
    const line = `- [${m.type || m.category || 'fact'}] ${m.text}`;
    const cost = tokens.estimateTokens(line);
    // `continue`, not `break` — a long memory must not evict every shorter
    // one behind it. The old bare `break` discarded the rest of the list on
    // the first item that did not fit, and said nothing.
    if (tokensUsed + cost + headerCost > budgetTokens) { dropped++; continue; }
    lines.push(line);
    tokensUsed += cost;
  }

  if (!lines.length) {
    // An empty MEMORY header is its own small lie — it implies a store that
    // was consulted and had nothing, when the truth may be that nothing fit.
    return { text: '', lines: [], injected: 0, considered, dropped, tokensUsed: 0 };
  }

  return {
    text: `${header}${lines.join('\n')}`,
    lines,
    injected: lines.length,
    considered,
    dropped,
    tokensUsed: tokensUsed + headerCost,
  };
}

/**
 * State what the memory system will and will not do this turn.
 *
 * #8 is the most damaging finding in BO-D because it is the one the operator
 * cannot check. The model said "User data saved" and Memory Core read
 * 0 MEMORIES. Nothing in the product had lied deliberately — the extractor
 * was gated off by an undefined preference, so nothing wrote, and the model
 * filled the silence with what a helpful assistant would say.
 *
 * The fix is not to make the model quieter. It is to tell it the truth about
 * its own capabilities, so the honest answer is also the easy one.
 */
function describeMemoryState({ autoMemoryEnabled, injected = 0, dropped = 0 } = {}) {
  const parts = [];

  parts.push(autoMemoryEnabled
    ? 'Automatic memory capture is ON: facts from this conversation may be extracted and stored after the turn ends.'
    : 'Automatic memory capture is OFF. Nothing from this conversation will be saved unless the operator saves it themselves.');

  // The specific behaviour observed, named directly.
  parts.push('You cannot write to memory yourself. Do not claim to have saved, '
    + 'remembered, updated or stored anything — not even to be reassuring. If the '
    + 'operator asks you to remember something, tell them plainly whether capture '
    + 'is on or off, and point them at Memory Core to save it deliberately.');

  if (injected) {
    parts.push(`${injected} stored ${injected === 1 ? 'memory is' : 'memories are'} included above.`);
  }
  if (dropped) {
    // §08 and R-05: the operator is told what did not make it in.
    parts.push(`${dropped} further stored ${dropped === 1 ? 'memory was' : 'memories were'} left out for space — say so if the operator asks whether you have everything.`);
  }

  return parts.join(' ');
}

module.exports = {
  normalizeFactPerson,
  selectForInjection,
  describeMemoryState,
  continuityRank,
  SUBJECT,
  PRECEDENCE,
};
