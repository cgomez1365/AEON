/**
 * One chat turn, as rounds: the tool loop and auto-continue, over
 * kernelLLM.stream.
 *
 *   round  = one kernelLLM.stream call
 *   a tool block in a round → the generation is stopped (AeonToolStop, a
 *            clean stop in services/ai.js), the tool runs (agentTools.cjs),
 *            its wrapped result goes back as the next message, next round
 *   a round cut off by the output limit (the provider SAID so: truncated)
 *          → "continue exactly where it stopped", the seam stitched
 *            (continuation.cjs), streamed as the same answer
 *
 * Everything the operator sees goes through `emit(event, data)`: `token`,
 * `tool_call`, `tool_result`, `continue`, `notice`. The answer (`text`) is
 * exactly the concatenated `token` events — tool blocks never reach it, nor
 * result markers the model wrote itself (toolProtocol.cjs createMarkerFilter).
 *
 * Privacy: `callOpts` (agents.callOptions — the agent's model and Local only)
 * is spread into EVERY stream call, rounds and continuations alike. Tools run
 * only between rounds, never while a generation is in flight.
 *
 * Kernel module: relative requires only.
 */
'use strict';

const protocol = require('./toolProtocol.cjs');
const continuation = require('./continuation.cjs');

class AeonToolStop extends Error {
  constructor() { super('stopped for a tool call'); this.name = 'AeonToolStop'; }
}

const NOTICE_FOR = {
  'write-limit': 'A save was refused: this reply already made the most saves one reply may make.',
  'results-budget': 'A tool was refused: this reply already carries as many tool results as its context allows.',
};

/**
 * @returns {Promise<{ text, tokens, latencyMs, provider, model, truncated,
 *   truncationReason, cancelled, parts, continued, toolCalls, toolWrites, rounds }>}
 */
async function runAgentTurn({
  kernelLLM,
  messages,
  role = 'chat',
  callOpts = {},
  signal = null,
  emit = () => {},
  toolbox = null,
  autoContinue = true,
  continueParts = continuation.DEFAULT_PARTS,
  onAttempt,
  onFallback,
} = {}) {
  if (!kernelLLM || typeof kernelLLM.stream !== 'function') {
    throw new Error('Streaming is unavailable: the kernel LLM layer did not provide kernelLLM.stream.');
  }
  const maxParts = autoContinue ? continuation.clampParts(continueParts) : 0;
  const t0 = Date.now();
  const convo = [...messages];
  let visible = '';
  let segmentText = '';
  let continuesLeft = maxParts;
  let parts = 1;
  let continued = 0;
  let rounds = 0;
  let tokens = 0;
  let pinned = null;
  let last = null;
  let finalRound = false;    // the tool cap is reached: blocks are no longer run
  let seamPrev = null;       // set when the next round continues a cut-off one
  let carry = '';            // text the cut-off round's scanner still held (a possible opener)
  let contBase = '';         // the cut-off answer so far, as the model is shown it (without `carry`)
  let needSep = false;       // a new segment after a tool result
  let contTail = false;      // convo ends with [assistant, CONTINUE_PROMPT]
  const scanners = [];       // one per round: each counts the result markers the model wrote itself
  const roundCap = (toolbox ? toolbox.callsLeft() : 0) + 1 + maxParts + 1;

  const out = (t) => {
    if (!t) return;
    if (needSep) {
      needSep = false;
      if (visible && !/\s$/.test(visible)) { visible += '\n\n'; segmentText += '\n\n'; emit('token', { t: '\n\n' }); }
    }
    visible += t;
    segmentText += t;
    emit('token', { t });
  };

  const notice = (level, code, message) => emit('notice', { level, code, message });

  for (;;) {
    rounds++;
    if (rounds > roundCap) break;
    const child = new AbortController();
    const relay = () => { try { child.abort(signal.reason); } catch {} };
    if (signal) {
      if (signal.aborted) relay();
      else signal.addEventListener('abort', relay, { once: true });
    }

    let roundText = '';
    const contRound = seamPrev != null;
    const seam = seamPrev != null
      ? continuation.createSeam(seamPrev, { onText: (t) => { roundText += t; out(t); } })
      : null;
    const sink = seam ? (t) => seam.push(t) : (t) => { roundText += t; out(t); };
    // A continuation that starts inside a code block the cut-off part opened
    // reads an aeon-tool line there as an example, as the first part would.
    const scanner = toolbox ? protocol.createScanner({
      onText: sink, initialFence: seamPrev != null ? protocol.codeFenceState(seamPrev) : null, carry,
    }) : null;
    if (scanner) scanners.push(scanner);
    carry = '';
    let block = null;

    let r;
    try {
      r = await kernelLLM.stream(convo, {
        role,
        ...callOpts,
        ...(pinned || {}),
        // Never trimmed and retried: see services/ai.js (noTrimRetry). That
        // retry keeps the system head and the LAST user message — after a
        // tool result that message is the wrapped result, and the head cut
        // drops the ## TOOLS rules (nonce, "data, not instructions"). A round
        // after a tool result still falls back to the next provider; only a
        // continuation (opts.continuation) is never sent anywhere else.
        ...((contRound || rounds > 1) ? { noTrimRetry: true } : {}),
        ...(contRound ? { continuation: true } : {}),
        signal: child.signal,
        onToken: (t) => {
          if (block) return;
          if (!scanner) { sink(t); return; }
          const hit = scanner.push(t);
          if (hit) { block = hit.block; try { child.abort(new AeonToolStop()); } catch {} }
        },
        onAttempt,
        onFallback,
      });
    } catch (e) {
      if (signal) signal.removeEventListener('abort', relay);
      if (scanner && !block) { try { scanner.end({ truncated: false }); } catch {} }
      if (seam) seam.end();
      // A continuation that could not be fetched: the parts already shown
      // are the answer, cut off where the model stopped, as without
      // auto-continue. (Review round 4: a "too large" continuation, or a
      // reasoning model that spent its budget thinking, ended the turn with
      // a provider error and no done.)
      if (contRound && !(signal && signal.aborted)) {
        const cause = (e && e.cause) || e;
        const tooLarge = !!(e?.tooLarge || cause?.tooLarge);
        const why = tooLarge
          ? 'the question and the answer so far are more than this model accepts in one request'
          : String(cause?.message || e?.message || 'the model did not answer').slice(0, 300);
        notice('warn', 'continue-stopped', `Auto-continue stopped at part ${parts}: ${why}.`);
        return finish({
          stopped: tooLarge
            ? 'The answer is too long for this model to continue automatically. Type "continue" to ask for the rest.'
            : 'The answer stopped at the model\'s output limit and could not be continued automatically. Type "continue" to try again.',
        });
      }
      // A round after a tool result that no provider would take: what was
      // shown stays, and the reason is said — never a trimmed retry (above).
      // With nothing shown yet it is an error, as before (an empty answer
      // would go back to the model as an empty assistant turn).
      if (!contRound && rounds > 1 && visible && !(signal && signal.aborted)) {
        const cause = (e && e.cause) || e;
        if (e?.tooLarge || cause?.tooLarge || e?.reasoningExhausted || cause?.reasoningExhausted) {
          const tooLarge = !!(e?.tooLarge || cause?.tooLarge);
          notice('warn', 'tool-round-stopped', tooLarge
            ? 'The model could not take the tool result: the conversation and the result are more than it accepts in one request.'
            : 'The model spent its output budget before answering after the tool result.');
          return finish({
            stopped: tooLarge
              ? 'The tool result was too large for this model to answer from. Ask a narrower question, or use a model with a larger context.'
              : 'The model stopped before answering after the tool result. Ask again, or use another model.',
          });
        }
      }
      // What the operator was shown, never the raw round: a tool block the
      // kernel saw as text must not surface in the error.
      if (visible) e.partialText = visible;
      else if (scanner || seam) delete e.partialText;
      throw e;
    }
    if (signal) signal.removeEventListener('abort', relay);
    last = r;
    tokens += Number(r?.tokens) || 0;

    if (r?.cancelled || (signal && signal.aborted)) {
      if (scanner && !block) scanner.end({ truncated: false });
      if (seam) seam.end();
      return finish({ cancelled: true });
    }

    let tail = null;
    // Cut off with a continuation to come: what the scanner still holds (an
    // opener cut mid-word) goes to the next round's scanner, not on screen.
    if (scanner && !block) tail = scanner.end({ truncated: !!r.truncated, carry: !!r.truncated && continuesLeft > 0 });
    const heldTail = tail && typeof tail.heldTail === 'string' ? tail.heldTail : '';
    if (seam) seam.end();
    seamPrev = null;
    // Later rounds stay on the model that answered round 1 — but only a
    // FALLBACK needs pinning. When the role's own primary served, the same
    // options resolve the same way again (registry address, key pool, rpm
    // pacing); an override would take the env key and the default host.
    // A pinned round still resolves through the registry (_pinnedRound).
    if (!pinned && r?.provider && r.fallback) {
      pinned = { provider: r.provider, ...(r.model ? { model: r.model } : {}), _pinnedRound: true };
    }

    // end() also returns a COMPLETE block: one whose closing fence was the
    // last thing the model sent, with no newline after it (common — many
    // models stop right there). That call is run like any other.
    const found = block || (tail ? tail.block : null);
    if (found) {
      if (finalRound) {
        notice('warn', 'tool-limit', `The model asked for another tool after this reply's ${toolbox.outcomes().length} tool uses; it was not run.`);
        return finish({});
      }
      let call;
      if (tail && tail.unterminated && r.truncated) {
        // The tool it named still names the chip; the call itself is not run.
        const p = protocol.parseBlock(found);
        const named = p.tool || null;
        call = {
          ok: false, error: 'cut-off', ...(named ? { tool: named } : {}),
          message: `Your tool call was cut off by the output limit (about ${Number(String(found.raw || '').length).toLocaleString('en-US')} characters reached AEON before it stopped), so it was not run. Send a shorter call${named === 'artifact_save' ? ': save a shorter document, or save it as several artifacts' : ''}.`,
        };
      } else {
        call = protocol.parseBlock(found);
      }
      const outcome = await toolbox.run(call, {
        signal,
        onStart: (d) => emit('tool_call', d),
      });
      emit('tool_result', {
        id: outcome.id, n: outcome.n, tool: outcome.tool, ok: outcome.ok, status: outcome.status,
        code: outcome.code, summary: outcome.summary, preview: outcome.preview, chars: outcome.chars,
        truncated: outcome.truncated, ms: outcome.ms, notice: outcome.notice || null,
      });
      if (NOTICE_FOR[outcome.code]) notice('warn', outcome.code, NOTICE_FOR[outcome.code]);
      if (signal && signal.aborted) return finish({ cancelled: true });
      const left = toolbox.callsLeft();
      convo.push(
        { role: 'assistant', content: `${roundText}${roundText && !roundText.endsWith('\n') ? '\n' : ''}${found.raw}` },
        { role: 'user', content: protocol.wrapResult(outcome, { n: outcome.n, callsLeft: left, writesLeft: toolbox.writesLeft(), nonce: toolbox.nonce || '' }) },
      );
      contTail = false;
      segmentText = '';
      needSep = true;
      if (left === 0) finalRound = true;
      continue;
    }

    if (r?.truncated && continuesLeft > 0) {
      continuesLeft--;
      parts++;
      continued++;
      emit('continue', { part: parts, max: 1 + maxParts, reason: 'max_tokens' });
      // One assistant turn holds the whole cut-off answer so far, as the
      // model wrote it: the held tail included, so it continues after it.
      if (contTail) {
        contBase += roundText;
        convo[convo.length - 2] = { role: 'assistant', content: contBase + heldTail };
      } else {
        contBase = segmentText;
        convo.push({ role: 'assistant', content: contBase + heldTail }, { role: 'user', content: continuation.CONTINUE_PROMPT });
        contTail = true;
      }
      seamPrev = segmentText;
      carry = heldTail;
      continue;
    }

    return finish({});
  }
  return finish({});

  function finish({ cancelled = false, stopped = null }) {
    if (scanners.some((sc) => sc.removed())) {
      notice('warn', 'result-marker', 'The model wrote a tool-result marker itself; AEON left it out. No tool returned that text: a real result shows as a TOOL line above the answer.');
    }
    const truncated = !cancelled && (!!stopped || !!last?.truncated);
    let truncationReason = null;
    if (stopped && truncated) truncationReason = stopped;
    else if (truncated) {
      truncationReason = continued > 0 || maxParts > 0
        ? `The answer was continued ${continued} time${continued === 1 ? '' : 's'} and still reached the model's output limit. Type "continue" for more.`
        : (last?.truncationReason || 'max_tokens');
    }
    return {
      text: visible,
      tokens,
      latencyMs: Date.now() - t0,
      provider: last?.provider || pinned?.provider || null,
      model: last?.model || pinned?.model || null,
      truncated,
      truncationReason,
      cancelled,
      parts,
      continued,
      toolCalls: toolbox ? toolbox.outcomes().length : 0,
      toolWrites: toolbox ? toolbox.outcomes().filter((o) => o.saved).length : 0,
      rounds,
    };
  }
}

module.exports = { runAgentTurn, AeonToolStop };
