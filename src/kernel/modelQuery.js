/**
 * What the operator's typing in the model picker matches — the browser's half.
 *
 * The server's half is src/kernel/modelCatalogue.cjs: it decides which rows the
 * provider priced at zero and sorts those to the front. This file decides what
 * the search box does with that answer. The two are separate modules only
 * because they run in separate places — Vite applies its CommonJS transform
 * inside node_modules only, so a browser module cannot import a .cjs source
 * file, and the server cannot synchronously require an ESM one.
 *
 * Pure and dependency-free on purpose: ModelPicker calls it, and
 * tests/model-catalogue.test.js calls it directly, with no DOM in between.
 * vitest.config.js sets environment:'node' and the suite has neither jsdom nor
 * testing-library, so a predicate that stayed inside the component would be a
 * predicate nothing could test — and the operator's literal ask was to type
 * "free" and see free models.
 */

/**
 * Does `id` match what the operator typed?
 *
 * Two ways to match:
 *
 *   1. The id contains the query, case-insensitively. This is what the picker
 *      always did.
 *
 *   2. The query is a prefix of the word "free" AND the provider priced this
 *      model at zero. This is the new half, and it is why filtering for "free"
 *      now finds `google/gemma-3-27b-it` — a model whose id never says free —
 *      while still not matching `vendor/free-tier-trial`, which says free and
 *      is not.
 *
 * `freeSet` carries ONLY ids the provider itself priced at zero (see
 * modelCatalogue.cjs). A provider that publishes no prices sends no set, every
 * model falls through to rule 1, and "free" matches nothing — which is the
 * truth for that provider, not a gap.
 *
 * A blank query matches everything.
 */
export function matchesModelQuery(id, query, freeSet) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  if (String(id ?? '').toLowerCase().includes(q)) return true;
  // startsWith, not includes: "fre" should find free models, "ee" should not.
  return !!freeSet && freeSet.has(id) && 'free'.startsWith(q);
}
