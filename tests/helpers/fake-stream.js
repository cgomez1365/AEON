/**
 * A scripted stand-in for kernelLLM.stream, for the 3.3 turn-engine tests.
 *
 * Each round is { tokens: [...], truncated?, provider?, model?, fallback?, onCall?(messages, opts) }.
 * `fallback: true` says a provider other than the role's own served the round.
 * It behaves like services/ai.js's kernelLLMStream where the engine depends
 * on it: tokens go to opts.onToken one by one; an abort with an AeonToolStop
 * ends the round cleanly (stoppedFor: 'tool'); any other abort is a cancel.
 */
export function fakeStream(rounds, { provider = 'groq', model = 'role-model' } = {}) {
  const calls = [];
  let i = 0;
  const stream = async (messages, opts) => {
    const round = rounds[Math.min(i, rounds.length - 1)];
    i++;
    calls.push({ messages: messages.map((m) => ({ ...m })), opts });
    if (round.onCall) await round.onCall(messages, opts);
    if (round.throw) throw round.throw;
    let text = '';
    for (const t of round.tokens || []) {
      if (opts.signal?.aborted) break;
      text += t;
      opts.onToken(t);
      if (round.delayMs) await new Promise((r) => setTimeout(r, round.delayMs));
    }
    const p = round.provider || opts.provider || provider;
    const m = round.model || opts.model || model;
    if (opts.signal?.aborted) {
      if (opts.signal.reason?.name === 'AeonToolStop') {
        return { text, tokens: 1, latencyMs: 1, provider: p, model: m, fallback: !!round.fallback, truncated: false, cancelled: false, stoppedFor: 'tool' };
      }
      return { text, tokens: 1, latencyMs: 1, provider: p, model: m, truncated: false, cancelled: true };
    }
    return {
      text, tokens: (round.tokens || []).length, latencyMs: 1, provider: p, model: m, fallback: !!round.fallback,
      truncated: !!round.truncated, truncationReason: round.truncated ? 'max_tokens' : null, cancelled: false,
    };
  };
  return { stream, calls };
}

/** Collect emitted events as [{event, data}]. */
export function collector() {
  const events = [];
  const emit = (event, data) => events.push({ event, data });
  const tokens = () => events.filter((e) => e.event === 'token').map((e) => e.data.t).join('');
  const of = (name) => events.filter((e) => e.event === name).map((e) => e.data);
  return { events, emit, tokens, of };
}
