/**
 * What a provider's model catalogue says about price — the server's half.
 *
 * Two routes read a provider's /models and hand the result to a picker:
 * /api/settings/test-provider (Settings -> Model Assignment) and
 * /api/connections/discover (the "Get model list" button on the connection
 * form). Both need the same two answers — how much of the catalogue survives,
 * and which rows the provider priced at zero — so both ask this file.
 *
 * This module is CommonJS because its callers are: src/blocks/settings/api/
 * settings.js and src/kernel/endpoints.cjs both run under the node server. The
 * picker's own search predicate cannot live here — Vite only applies its
 * CommonJS transform inside node_modules, so a browser module cannot import a
 * .cjs source file. That half is src/kernel/modelQuery.js, in ESM.
 */

/**
 * A provider's catalogue arrives WHOLE.
 *
 * Every branch of /api/settings/test-provider used to end in `.slice(0, 20|30|40)`.
 * Nothing downstream needed that: the picker at src/blocks/settings/index.jsx
 * has no cap of its own, and the provider card slices for display separately.
 * What the cap actually did was cut the list before the operator's search ran —
 * filter the picker for "free" against OpenRouter and you saw five models,
 * because only five of the first 40 rows of a 445-row catalogue are free.
 *
 * MAX_MODELS is a guard against a malformed or hostile response, NOT a display
 * limit. The largest catalogue any of these providers publishes is OpenRouter's,
 * at roughly 450 rows; 5000 sits an order of magnitude clear of that, so it can
 * never silently truncate a real list. A response that trips it is broken.
 */
const MAX_MODELS = 5000;

/**
 * A price the provider actually stated, or NaN.
 *
 * OpenRouter sends decimal STRINGS ("0", "0.0000005"). Number() alone is too
 * generous with everything else it might send: Number(null), Number(""),
 * Number([]) and Number(false) are all 0, and all finite — so a row shaped
 * `{ pricing: { prompt: null, completion: null } }` would read as zero-priced
 * and be labelled free. That is the precise failure mode isFreeModelRow
 * exists to avoid, and its doc comment already promised it did not have.
 *
 * Only a real number, or a non-blank string that parses, counts as a statement
 * of price. Everything else is silence, and silence is NaN.
 */
function statedPrice(v) {
  if (typeof v === 'number') return v;                       // NaN and Infinity fall out below
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/**
 * Did the provider state a price of zero for this model?
 *
 * OpenRouter defined this shape and is the only provider in AEON's registry
 * that publishes it: `pricing: { prompt: "0", completion: "0", ... }`, decimal
 * strings in USD per token. Free means prompt AND completion are both zero — a
 * fact stated by the provider, not a guess read off the model's name.
 *
 * The predicate is asked of any OpenAI-shaped row, not only OpenRouter's,
 * because the gate is the DATA and not the provider id: a row that carries no
 * `pricing` answers false, which is every row from Groq, OpenAI, xAI and
 * LM Studio. An OpenAI-compatible proxy that does speak this dialect — a
 * LiteLLM in front of OpenRouter, say — is believed, for the same reason
 * OpenRouter is: it stated the price itself.
 *
 * This is strictly better than matching the ":free" id suffix. In today's
 * catalogue 21 ids end in ":free" but 25 models are zero-priced, so the suffix
 * match misses four real free models (among them `openrouter/free` and the
 * Lyria previews). It also cannot be fooled the other way, by a paid model with
 * the word "free" somewhere in its name.
 *
 * Absent or unparseable pricing answers false: unknown is not free.
 */
function isFreeModelRow(m) {
  const p = m && m.pricing;
  if (!p || typeof p !== 'object') return false;
  const prompt = statedPrice(p.prompt);
  const completion = statedPrice(p.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion)
    && prompt === 0 && completion === 0;
}

/**
 * Free models first, everything else in the order the provider sent.
 *
 * Array.prototype.sort is stable (ES2019), so this only lifts the free rows to
 * the front — it does not otherwise reshuffle a catalogue the provider has
 * already ranked.
 */
function freeFirst(rows, isFree) {
  return [...rows].sort((a, b) => (isFree(b) ? 1 : 0) - (isFree(a) ? 1 : 0));
}

module.exports = { MAX_MODELS, statedPrice, isFreeModelRow, freeFirst };
