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

// ── A role the server refused goes back ─────────────────────────────────────
//
// updateRole shows the new pair at once (page settings + the patch Save posts)
// and only then asks POST /api/connections/assign-role to accept it. A 400 used
// to leave the pair in both, and the Save button wrote it. These three are the
// pure part: take what the role was, put it back, say so. Pure for the same
// reason as the matcher above — the suite has no DOM.

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** What `role` is in the page settings and in the unsaved patch, before a change. */
export function snapshotRole(patch, models, role) {
  return { value: copy(models?.[role]), pending: copy(patch?.models?.[role]) };
}

/**
 * Put `role` back to `snap` after the server refused `refused`.
 *
 * Only while the role still holds the refused pair: if the operator has since
 * picked something else, that newer choice is theirs and is left alone.
 * Returns new objects (`reverted` says whether anything moved).
 */
export function revertRefusedRole(patch, models, role, refused, snap) {
  const now = models?.[role];
  if (!now || now.provider !== refused?.provider || now.model !== refused?.model) {
    return { patch, models, reverted: false };
  }
  const nextModels = { ...models };
  if (snap.value === undefined) delete nextModels[role]; else nextModels[role] = copy(snap.value);
  const nextPatch = { ...patch };
  const pending = { ...(patch?.models || {}) };
  if (snap.pending === undefined) delete pending[role]; else pending[role] = copy(snap.pending);
  if (Object.keys(pending).length) nextPatch.models = pending; else delete nextPatch.models;
  return { patch: nextPatch, models: nextModels, reverted: true };
}

/** The toast: the server's sentence (it names the remedy) plus where the role went. */
export function refusedRoleNotice(role, previous, serverError) {
  const said = String(serverError || '').trim()
    || 'That model is not one this provider offers. Pick another in Settings → Model Assignment, or re-scan the provider\'s model list.';
  const back = previous && previous.model
    ? `${role} is back on ${previous.provider} / ${previous.model}.`
    : `${role} was put back as it was.`;
  return `${said} ${back}`;
}
