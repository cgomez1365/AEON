'use strict';

/**
 * Command narration — the payload, read back as a sentence.
 *
 * BO-SHIP P7. CEO request, 2026-08-12: "after any slash command executes, the
 * chat model reads it back as text, not a code window."
 *
 * The terminal renders every result as raw JSON. That is the right rendering
 * for an operator debugging a route and the wrong one for the product's own
 * promise — one person with the operating leverage of a team. `/docs` returning
 * an array of {id, tags, updated, size} is strictly less useful than "One
 * document: 'get piggy with it', 14 words, saved a minute ago."
 *
 * ── Why this file is mostly rules ────────────────────────────────────────
 *
 * A narrator is one bad prompt away from being a false-green generator, which
 * is the exact defect this whole build order exists to remove. §22 records the
 * cost: a false green ends an investigation, a visible error invites one. So:
 *
 *   1. The narration is derived from the ACTUAL payload. Nothing else is sent.
 *   2. A FAILURE is narrated as a failure. The model is told the outcome as a
 *      fact it may not contradict, and a failed command keeps its error text
 *      verbatim alongside the prose.
 *   3. The raw payload is never discarded — it travels with the narration for
 *      the UI to reveal. R-05: the payload remains the source of truth.
 *   4. If the model is unavailable, rate-limited, or returns nothing usable,
 *      we fall back to a deterministic summary. We do NOT drop to silence and
 *      we do NOT invent. An unnarrated result is a rendering gap; a wrong
 *      narration is a lie.
 *
 * Deterministic-first: many commands already return a human `text` (the /set
 * handler answers "chat → gemini / gemini-2.0-flash"). When one does, that IS
 * the narration and no tokens are spent. The model is for the payloads nobody
 * wrote a sentence for.
 */

const MAX_PAYLOAD_CHARS = 4000;

/** Compact a payload for the prompt without hiding its shape. */
function summarizeForPrompt(data) {
  if (data == null) return 'null';
  let json;
  try { json = JSON.stringify(data, null, 1); } catch { return String(data).slice(0, MAX_PAYLOAD_CHARS); }
  if (json.length <= MAX_PAYLOAD_CHARS) return json;

  // Arrays are the common overflow: keep the shape, say how much was cut.
  if (Array.isArray(data)) {
    const head = JSON.stringify(data.slice(0, 5), null, 1);
    return `${head}\n… ${data.length - 5} more items (${data.length} total)`;
  }
  return `${json.slice(0, MAX_PAYLOAD_CHARS)}\n… truncated`;
}

/**
 * A summary derived from the payload alone, with no model involved.
 * Always available, never wrong, occasionally dull — which is the right
 * failure mode for a fallback.
 */
function deterministicNarration({ cmd, ok, text, data, error }) {
  if (!ok) {
    const reason = error || text || 'no reason given';
    return `${cmd} did not run: ${String(reason).slice(0, 300)}`;
  }
  if (typeof text === 'string' && text.trim()) {
    const t = text.trim();
    return t.length > 400 ? `${t.slice(0, 400)}…` : t;
  }
  if (Array.isArray(data)) {
    return `${cmd} returned ${data.length} ${data.length === 1 ? 'item' : 'items'}.`;
  }
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    return `${cmd} succeeded${keys.length ? ` — fields: ${keys.slice(0, 8).join(', ')}` : ''}.`;
  }
  return `${cmd} succeeded.`;
}

/**
 * The prompt. The outcome is stated as a fact the model may not contradict —
 * that single line is what stops a narrator from turning a failure into a
 * cheerful summary.
 */
function buildPrompt({ cmd, ok, title, text, data, error }) {
  return [
    'You are describing the result of a command an operator just ran in a terminal.',
    'Write 1–3 plain sentences. No preamble, no markdown, no bullet points, no JSON.',
    '',
    `Command: ${cmd}${title ? ` (${title})` : ''}`,
    `Outcome: ${ok ? 'SUCCEEDED' : 'FAILED'}`,
    '',
    'RULES — these are absolute:',
    `- The command ${ok ? 'SUCCEEDED' : 'FAILED'}. Say so. Never describe a failure as a success or a success as a failure.`,
    '- Use ONLY the data below. Never invent a number, name, file, or status that is not present.',
    '- If the data is empty, say the command returned nothing rather than guessing why.',
    ok
      ? '- Lead with what the operator got.'
      : '- Lead with what went wrong, then the remedy if the data names one.',
    '',
    error ? `Error: ${String(error).slice(0, 500)}` : '',
    text ? `Message: ${String(text).slice(0, 1000)}` : '',
    'Data:',
    summarizeForPrompt(data),
  ].filter(Boolean).join('\n');
}

/** Does the prose contradict the outcome we know to be true? */
function contradictsOutcome(prose, ok) {
  if (ok) return false;
  const s = String(prose).toLowerCase();
  // A failure narrated with success language is the one unrecoverable error.
  return /\b(succeeded|successfully|completed successfully|worked fine|all good)\b/.test(s)
    && !/\b(did not|failed|could not|unable|error)\b/.test(s);
}

/**
 * Narrate one command result.
 *
 * @param {object} result   the dispatch envelope { cmd, ok, text, data, error }
 * @param {function} [llm]  kernelLLM-shaped (prompt, opts) => string
 * @returns {Promise<{narration, source, raw}>}
 *   source: 'handler' | 'model' | 'deterministic'
 */
async function narrate(result, llm) {
  const { cmd = '/command', ok = false, text = null, data = null, error = null, title = null } = result || {};
  const raw = { ok, text, data, error };

  // A handler that already wrote a sentence has said it better than a model
  // will, and for free.
  if (ok && typeof text === 'string' && text.trim() && text.trim().length <= 400) {
    return { narration: text.trim(), source: 'handler', raw };
  }

  const fallback = deterministicNarration({ cmd, ok, text, data, error });

  if (typeof llm !== 'function') {
    return { narration: fallback, source: 'deterministic', raw };
  }

  try {
    const out = await llm(buildPrompt({ cmd, ok, title, text, data, error }), { role: 'chat' });
    const prose = (typeof out === 'string' ? out : out?.text || '').trim();

    if (!prose) return { narration: fallback, source: 'deterministic', raw };
    if (contradictsOutcome(prose, ok)) {
      // The model narrated a failure as a success. Discard it — this is the
      // exact defect the feature could introduce, so it fails closed.
      return { narration: fallback, source: 'deterministic', raw, discarded: 'contradicted-outcome' };
    }
    return { narration: prose, source: 'model', raw };
  } catch (e) {
    // Rate limits and outages are expected. An unnarrated result is a
    // rendering gap; a fabricated one is a lie.
    return { narration: fallback, source: 'deterministic', raw, llmError: e.message };
  }
}

module.exports = { narrate, buildPrompt, deterministicNarration, contradictsOutcome, summarizeForPrompt };
