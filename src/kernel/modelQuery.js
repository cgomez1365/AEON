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

// Restated from NON_CHAT_MODEL_RE in src/kernel/endpoints.cjs, for the reason in
// this file's header: a browser module cannot import a .cjs source file.
// tests/model-after-provider-switch.test.js fails if the two ever differ.
export const NON_CHAT_MODEL_RE = /whisper|(^|[-_/])tts([-_]|$)|text-to-speech|orpheus|embed|guard|moderation|rerank|stable-diffusion|sdxl|flux|dall-?e/i;

/**
 * The model a role should hold after its provider is switched to one offering
 * `models`.
 *
 * The Provider <select> used to change the provider and leave the model, so the
 * previous provider's model was saved against the new provider's connection
 * (chat -> openrouter/gemini-flash-latest). The model survives only if the new
 * provider lists it. Otherwise the first listed model that can do the job: for
 * Embedding an embedding model (else none), for every other role the first that
 * is not a speech, guard or embedding model, because a provider's list can
 * start with one (Groq's starts with a speech model).
 *
 * An empty or unknown list returns `current` unchanged: not knowing what a
 * provider offers is not the same as it offering nothing, and the server
 * refuses on the same terms.
 */
export function modelAfterProviderSwitch(models, current, role) {
  const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m);
  if (!list.length || list.includes(current)) return current;
  if (role === 'embed') return list.find(m => /embed/i.test(m)) || '';
  return list.find(m => !NON_CHAT_MODEL_RE.test(m)) || list[0];
}
