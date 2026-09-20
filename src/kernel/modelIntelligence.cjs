/**
 * A rough capability-tier guess and a free-or-not guess, read off a model's
 * NAME alone — for sorting the terminal's hotswap picker, nothing more.
 *
 * Why this exists: by the time a model id reaches the picker
 * (src/kernel/routers/console.cjs's /god/models, sourced from an endpoint's
 * registered `models` list), it is a bare string — no price, no benchmark
 * score, no provider metadata travels with it (that lived on the richer row
 * modelCatalogue.cjs's isFreeModelRow() reads at discovery time, and is gone
 * by registration). There is no live intelligence feed anywhere in AEON —
 * no MMLU/LMArena API, no provider that returns one. So both signals here
 * are pattern-matches against naming conventions every major lab mostly
 * follows: nano/mini/flash/lite = small and fast, pro/opus/ultra/thinking =
 * large and capable, an explicit parameter count if the id states one
 * (`70b`, `405b`) is the strongest signal because it is the one thing here
 * that is an actual fact rather than a guess.
 *
 * Honesty (§08): this WILL be wrong for a model whose name does not follow
 * the convention, or for a family this heuristic has never seen. It is a
 * best-effort sort, not a benchmark — the picker says so next to it.
 *
 * Free detection at this layer is `:free`-suffix matching only — weaker
 * than modelCatalogue.cjs's isFreeModelRow() (real provider-stated pricing),
 * because that pricing data does not survive to here. Good enough to rank
 * OpenRouter's own zero-priced rows first; for Groq/Gemini, "free" is a
 * property of the operator's key tier, not the model name, so nothing here
 * is marked free for those providers — the group itself is already scoped
 * to what that key can reach.
 */
'use strict';

// The chat-capability deny-list already built and tested for auto-pick
// (BO-A4): whisper/tts/embed/guard/moderation/image-gen families cannot
// serve a chat turn at all, size or naming aside. Reused rather than
// reinvented — a fresh regex here would drift from the one thing in AEON
// that already knows this. First real bite it took: without it, a live
// "HOTSWAP CHAT MODEL" sort ranked `whisper-large-v3` (a transcription
// model) #1, because "large" alone reads as a capable-model signal.
const { NON_CHAT_MODEL_RE } = require('./endpoints.cjs');

/**
 * OpenRouter states this in the id itself for most rows; every other
 * provider does not. `openrouter/free` (route-to-whatever's-free) is a
 * second, literal exception — the same one the 18c5cea commit message
 * already named as a suffix-match miss ("misses four real free models
 * today... among them openrouter/free"), kept honest here rather than
 * silently repeating the same gap at this layer.
 */
function looksFree(modelId) {
  const id = String(modelId || '');
  return /:free$/i.test(id) || id === 'openrouter/free';
}

// Ordered by presumed capability, low to high. A model id can match more
// than one (rare); the HIGHEST matching score wins, so "flash" alone never
// beats an explicit "pro" or "opus" elsewhere in the same id.
const TIER_KEYWORDS = [
  [20, /\b(nano|micro|tiny)\b/i],
  [40, /\b(mini|small|lite|haiku)\b/i],
  [55, /\b(flash|turbo|instant|fast|base)\b/i],
  [85, /\b(pro|plus|large|sonnet|opus-mini)\b/i],
  [100, /\b(ultra|opus|max|grand)\b/i],
];

// Reasoning/"thinking" variants trade speed for depth — a real, if partial,
// capability signal independent of the size tier above.
const REASONING_BONUS = 12;
const REASONING_RE = /\b(thinking|reasoning|deep.?research)\b|(?:^|[\/\-])(o1|o3|o4|r1)(?:[\-:]|$)/i;

// An explicit parameter count is the one OBJECTIVE signal available here —
// weighted to dominate the keyword guess when present. log scale: going
// from 8b to 70b matters much more than 400b to 405b.
function paramCountBoost(modelId) {
  const m = String(modelId || '').match(/(\d+(?:\.\d+)?)\s*b(?:$|[^a-z])/i);
  if (!m) return 0;
  const billions = parseFloat(m[1]);
  if (!Number.isFinite(billions) || billions <= 0) return 0;
  return Math.round(Math.log2(billions) * 8); // 1b≈0, 8b≈24, 70b≈50, 405b≈67
}

const NEUTRAL_TIER = 60; // no keyword matched — assume "standard", not bottom-tier

/**
 * Higher = presumed more capable. Not a benchmark — see file header.
 */
function intelligenceScore(modelId) {
  const id = String(modelId || '');
  let tier = null;
  for (const [score, re] of TIER_KEYWORDS) {
    if (re.test(id) && (tier === null || score > tier)) tier = score;
  }
  if (tier === null) tier = NEUTRAL_TIER;
  // Additive, not max()'d against the tier: a max() left an explicit size
  // (8b vs 70b, say) invisible whenever it scored below whatever tier the
  // model already landed in — found writing the test for exactly this,
  // 8b and 70b variants of the same family scored identically. Divided by 3
  // so a huge parameter count nudges the rank without letting size alone
  // outrun an explicit "nano"/"mini" keyword that says otherwise.
  const boost = Math.round(paramCountBoost(id) / 3);
  const reasoning = REASONING_RE.test(id) ? REASONING_BONUS : 0;
  return tier + boost + reasoning;
}

/**
 * Sort model ids for a CHAT picker: known non-chat families dropped
 * outright (a transcription or moderation model is not a wrong answer here,
 * it is not an answer at all), then free first, then presumed-more-capable
 * first. Stable within a tie — Array.prototype.sort is stable (ES2019), so
 * two models scoring equally keep the provider's own original relative
 * order.
 *
 * @param {string[]} ids
 * @returns {{id: string, free: boolean}[]}
 */
function sortModels(ids) {
  return [...(ids || [])]
    .filter((id) => !NON_CHAT_MODEL_RE.test(String(id || '')))
    .map((id) => ({ id, free: looksFree(id), score: intelligenceScore(id) }))
    .sort((a, b) => (b.free - a.free) || (b.score - a.score))
    .map(({ id, free }) => ({ id, free }));
}

module.exports = { looksFree, intelligenceScore, sortModels };
