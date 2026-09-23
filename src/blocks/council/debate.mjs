/**
 * Council — the debate itself, as plain functions (no React), so the order of
 * a debate and what each voice is shown can be tested in node.
 *
 * Why this is not inside the component any more (found live, 2026-09-23, on a
 * throwaway install with a stub model): the chair's record and the saved Vault
 * transcript read each councilor's final position from React state captured
 * when CONVENE was clicked. setState never updates that captured value, so:
 *
 *   - on the first debate of a session the chair never saw a single revised
 *     position ("Final:" was the opening, repeated), and the transcript saved
 *     to Agents/council/debates/ recorded the same;
 *   - on every later debate the chair was handed the PREVIOUS question's final
 *     positions, and the Vault transcript saved them under the new question.
 *
 * Here every value the chair and the transcript use comes from this run.
 */

// Word budgets. A free OpenRouter model stops at 1024 output tokens, and a
// reasoning model spends part of that thinking — so every voice is asked for
// an answer that fits well inside it, and told why.
export const BUDGET = { opening: 150, final: 120, verdict: 250 };

const FIT = 'Keep inside the word limit: you may be running on a model with a small output budget, and an answer that runs past it is cut off mid-sentence.';

export function openingPrompt(member, question) {
  return `${member.persona ? member.persona + '\n\n' : ''}You are one voice on a small advisory council. Give your independent, honest position on the question below. Be concrete and take a stance. ${BUDGET.opening} words max. ${FIT}\n\nQUESTION: ${question}`;
}

export function finalPrompt(member, question, opening, others) {
  return `${member.persona ? member.persona + '\n\n' : ''}You are ${member.label} on an advisory council. The question was: ${question}\n\nYour opening position:\n${opening}\n\nThe other councilors said:\n${others || '(no other councilor could answer)'}\n\nGive your FINAL position. If the others changed your mind, say what changed; if not, defend your stance against their strongest point. ${BUDGET.final} words max. ${FIT}`;
}

export function verdictPrompt(question, record) {
  return `You chair an advisory council. Question: ${question}\n\nDeliberation record:\n${record}\n\nWrite the council's verdict:\n1. THE VERDICT — one clear, actionable recommendation (2-3 sentences).\n2. WHERE THE COUNCIL AGREED — bullets, name the councilors.\n3. WHERE IT SPLIT — the strongest dissent and who held it.\n4. CONFIDENCE — high/medium/low with one sentence why.\nThe whole verdict: ${BUDGET.verdict} words max. ${FIT}`;
}

/** What a voice produced, normalised: text plus whether it was cut off. */
function normalise(answer) {
  if (typeof answer === 'string') return { text: answer.trim(), truncated: false };
  return {
    text: String(answer?.text || '').trim(),
    truncated: !!answer?.truncated,
    truncationReason: answer?.truncationReason || null,
    servedBy: answer?.provider ? { provider: answer.provider, model: answer.model || null, fallback: !!answer.fallback } : null,
  };
}

/** A failed call that still streamed part of an answer keeps what arrived. */
function fromError(e) {
  if (e && typeof e.partialText === 'string' && e.partialText.trim()) {
    return { text: e.partialText.trim(), truncated: true, truncationReason: `stopped by an error: ${e.message}` };
  }
  return { text: '', error: e?.message || String(e) };
}

/**
 * Run one debate.
 *
 *   ask(prompt, member) → Promise<string | { text, truncated, truncationReason, provider, model, fallback }>
 *   onOpinion(id, opinion)   — each time a councilor's opinion changes
 *   onStatus(line), onPhase('opening' | 'deliberating' | 'verdict')
 *
 * Resolves to { opinions, verdict, verdictTruncated, verdictError }. Never
 * rejects for a model failure: a councilor that cannot answer is recorded as
 * such, and a chair that cannot answer leaves the debate with a verdictError
 * instead of discarding every opinion the operator already waited for.
 */
export async function runDebate({ question, councilors, chair, ask, onOpinion = () => {}, onStatus = () => {}, onPhase = () => {} }) {
  const opinions = {};
  const set = (id, patch) => { opinions[id] = { ...(opinions[id] || {}), ...patch }; onOpinion(id, opinions[id]); };

  onPhase('opening');
  for (const c of councilors) {
    onStatus(`${c.label} is forming an opinion…`);
    let r;
    try { r = normalise(await ask(openingPrompt(c, question), c)); }
    catch (e) { r = fromError(e); }
    if (!r.text && !r.error) r.error = 'the model returned no text';
    set(c.id, {
      opening: r.text, openingTruncated: !!r.truncated, openingTruncationReason: r.truncationReason || null,
      error: r.error || null, servedBy: r.servedBy || null,
    });
  }

  const answered = councilors.filter((c) => opinions[c.id]?.opening);

  onPhase('deliberating');
  for (const c of answered) {
    onStatus(`${c.label} is weighing the others…`);
    const others = answered.filter((o) => o.id !== c.id).map((o) => `${o.label}: ${opinions[o.id].opening}`).join('\n\n');
    let r;
    try { r = normalise(await ask(finalPrompt(c, question, opinions[c.id].opening, others), c)); }
    catch (e) { r = fromError(e); }
    // A failed final keeps the opening as the councilor's position — said so
    // in the record rather than silently.
    if (r.text) set(c.id, { revised: r.text, revisedTruncated: !!r.truncated, revisedTruncationReason: r.truncationReason || null });
    else set(c.id, { revisedError: r.error || 'the model returned no text' });
  }

  onPhase('verdict');
  if (!answered.length) {
    return { opinions, verdict: '', verdictTruncated: false, verdictError: 'No councilor could answer, so there was nothing for the chair to rule on.' };
  }
  onStatus(`${chair?.label || 'The chair'} is writing the verdict…`);
  const record = councilors.map((c) => {
    const o = opinions[c.id] || {};
    if (!o.opening) return `${c.label}\n  (no answer — ${o.error || 'unavailable'})`;
    const cut = (flag) => (flag ? ' [cut off at the model\'s output limit]' : '');
    return `${c.label}\n  Opening: ${o.opening}${cut(o.openingTruncated)}\n  Final: ${o.revised || o.opening}${cut(o.revised ? o.revisedTruncated : o.openingTruncated)}`;
  }).join('\n\n');

  try {
    const r = normalise(await ask(verdictPrompt(question, record), chair));
    if (!r.text) return { opinions, verdict: '', verdictTruncated: false, verdictError: 'The chair\'s model returned no text.' };
    return { opinions, verdict: r.text, verdictTruncated: !!r.truncated, verdictError: null, verdictServedBy: r.servedBy || null };
  } catch (e) {
    const r = fromError(e);
    if (r.text) return { opinions, verdict: r.text, verdictTruncated: true, verdictError: null };
    return { opinions, verdict: '', verdictTruncated: false, verdictError: `The chair could not write a verdict: ${r.error}` };
  }
}

/** The body POSTed to /api/council/debate/save — built from THIS run only. */
export function savePayload(question, councilors, result) {
  return {
    question,
    verdict: result.verdict || '',
    verdictTruncated: !!result.verdictTruncated,
    verdictError: result.verdictError || null,
    opinions: councilors.map((c) => {
      const o = result.opinions[c.id] || {};
      return {
        label: c.label,
        opening: o.opening || '',
        revised: o.revised || '',
        openingTruncated: !!o.openingTruncated,
        revisedTruncated: !!o.revisedTruncated,
        error: o.error || null,
      };
    }),
  };
}
