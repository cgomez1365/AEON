/**
 * AEON SSE Chat Stream — token-by-token streaming through the kernel.
 *
 *   • POST /chat/stream — asks the kernel which provider/model serves the
 *     role (kernelLLM.describeRole), assembles the turn (identity, working
 *     memory, approved skills, Second Brain recall), then streams it through
 *     kernelLLM.stream and relays every token over SSE (text/event-stream)
 *     so the Neural Terminal renders as the answer arrives.
 *   • POST /chat/stop — cancels a generation by streamId, or all of them.
 *
 * This block holds NO provider code. It used to: its own Groq/Gemini/local
 * streamers, its own vault key lookup, its own fallback chain — and a Claude
 * branch that posted to Groq's URL. Routing by role, key resolution, pacing,
 * key-pool rotation, cooldowns, fallback and telemetry all live in the one
 * LLM layer (services/ai.js), where every other AI call already goes. The
 * block's job is the conversation and the wire format, nothing underneath.
 */
const express = require('express');
const router = express.Router();
const tokens = require('../../../kernel/tokens.cjs');
const kernelContext = require('../../../kernel/context.cjs');

module.exports = function ({ kernelLLM, loadSettings: loadSettingsDep, VAULT_ROOT }) {
  // Settings come from the kernel's own authority, injected — never a
  // sideways require into services/. A missing or throwing loader degrades to
  // empty prefs; provider/model resolution is the kernel's concern now.
  const loadSettings = () => {
    try { return (typeof loadSettingsDep === 'function' && loadSettingsDep()) || {}; }
    catch { return {}; }
  };

  // ── Second Brain recall ─────────────────────────────────────────────
  //
  // BO-MEM M1. The gate, the loopback transport, the failure taxonomy and the
  // budget moved to src/kernel/context.cjs. Three copies of this policy
  // existed — here, in chat.cjs, and in aeon_matrix/api/retrieve.cjs — and
  // they had already drifted in eight ways. Doctrine R05: one recall policy,
  // in one place.
  //
  // Two defects went with them:
  //   * this call carried no credentials onto a route that declares auth:true,
  //     so with the guard on it 401'd, and a 401 body has neither `documents`
  //     nor `unavailable` — the operator was told "no relevant indexed
  //     documents were found" for a search that never ran;
  //   * retrieved documents were the only context block outside the token
  //     budget, worth up to four times the memory allowance.
  const buildSecondBrainContext = (message, auth, budgetTokens) =>
    kernelContext.buildRecallContext(message, { auth, budgetTokens });

  // ── Memory injection ───────────────────────────────────────────────
  // Pinned + recent memories ride along on every message (brain_settings
  // gates it). The wake phrase "vp come online" triggers a FULL memory
  // read. A hard char budget keeps the local model's context window from
  // overflowing regardless of how large the memory store grows.
  // Store is owned by the memory_core block, vault-resident so every memory
  // is operator-visible in Aeon Matrix; the kernel resolves it from the
  // shared VAULT_ROOT so it cannot drift from memory_core's own MEM_DIR.
  const { WAKE_RE } = kernelContext;   // one wake phrase, shared with the terminal

  /**
   * Working memory for this turn.
   *
   * BO-MEM M1, second half. The recall tier moved to src/kernel/context.cjs and
   * this one did not, which left the change written to enforce "one policy, one
   * place" with two memory builders in the tree — R05 broken again, one tier
   * later. What stays here is only what is genuinely the dashboard's: its
   * prefs, its wake phrase, its window. Ranking, budget accounting, the skills
   * cap and the honest counts all come from the kernel.
   *
   * The old wake block also announced the raw store length while the line
   * beneath it stated the real injected count — two contradictory numbers in
   * one system prompt, with the model explicitly ordered to state one of them.
   * The kernel states the count it actually injected.
   */
  function buildMemoryContext(message, settings, contextTokens = 8192) {
    const prefs = settings.prefs?.brain_settings || {};
    const wake = WAKE_RE.test(message || '');
    const budgets = tokens.inputBudgets(contextTokens, { wake });

    const skills = (settings.prefs?.brain_skills || [])
      .filter(sk => sk.status === 'approved' && sk.body)
      .slice(0, prefs.skill_max_injected || 30);

    const out = kernelContext.buildMemoryContext(message, {
      vaultRoot: VAULT_ROOT,
      budgetTokens: budgets.memoryTokens,
      skillTokens: budgets.skillTokens,
      skills,
      wake,
      // Wake lifts the count cap entirely; otherwise the operator's cap applies
      // and memory-policy still keeps pinned memories ahead of it.
      //
      // The default was 25, chosen when budgetTokens above was a fraction of an
      // assumed 8k window and could not be trusted to hold anything back. It
      // can now: describeRole reports the model's real window and inputBudgets
      // caps what may be spent on memory in tokens, which is the honest unit —
      // selectForInjection ranks, slices to this count, THEN fits to the
      // budget, so a low count is the one limiter that discards a memory
      // without ever pricing it.
      //
      // 200 leaves the token budget as the real constraint (32,000 tokens is
      // roughly 180 average memories) while staying a rail against a runaway
      // store. An operator who set this value explicitly still wins.
      maxCount: wake ? 0 : Math.max(prefs.memory_max_context || 200, 0),
      enabled: prefs.memory_in_context !== false,
      autoMemoryEnabled: !!prefs.auto_memory,
    });

    return { ...out, budgets };
  }

  // ── SSE helpers ────────────────────────────────────────────────────
  function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // D1c — streams in flight, so /chat/stop can reach one. Keyed by the id
  // the client sends (or one we mint and hand back in the opening meta
  // event), because "stop" has to name WHICH generation to stop.
  const activeStreams = new Map();

  // ── POST /chat/stream — the main SSE endpoint ─────────────────────
  router.post('/chat/stream', async (req, res) => {
    const { message, role = 'chat', history = [], streamId: clientStreamId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const streamId = String(clientStreamId || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const abort = new AbortController();
    activeStreams.set(streamId, abort);
    // A client that closes the tab is a stop too — the old code left the
    // model generating into a socket nobody was reading.
    res.on('close', () => { try { abort.abort(); } catch {} activeStreams.delete(streamId); });

    // The kernel says what will serve this role. Announced before the first
    // token so the terminal can label the answer; corrected below if the
    // kernel has to fall back.
    let provider = null, model = null, contextTokens = 8192;
    try {
      if (typeof kernelLLM?.describeRole === 'function') {
        ({ provider, model, contextTokens } = await kernelLLM.describeRole(role));
      }
    } catch {}

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    sseWrite(res, 'meta', { provider, model, role, streamId });

    let fullText = '';
    let tokenCount = 0;

    try {
      if (typeof kernelLLM?.stream !== 'function') {
        throw new Error('Streaming is unavailable: the kernel LLM layer did not provide kernelLLM.stream.');
      }
      const settings = loadSettings();

      // D1f — the memory and skill budgets are fractions of the window we are
      // actually about to spend from. Local models know their real window;
      // cloud providers are far larger than anything we inject, so the 8k
      // floor is a safe assumption there rather than a guess that matters.
      const mem = buildMemoryContext(message, settings, contextTokens || 8192);
      // The caller's credentials are forwarded onto the internal retrieve call.
      // Without this the guard refuses it and the refusal reads as an empty vault.
      const sb = await buildSecondBrainContext(
        message,
        { authorization: req.headers.authorization, cookie: req.headers.cookie },
        mem.budgets?.recallTokens,
      );
      const messages = [
        // AEON is a tool, not a staff member. This prompt used to cast the
        // assistant as "VP (VP of Operations), the operator's autonomous
        // second-in-command" — an org-chart metaphor from how AEON is built,
        // which is not what a customer is buying.
        // The formatting directive sits with the identity and AHEAD of
        // mem.text, so the memory rules the kernel appends stay the last word
        // on this system turn. It governs layout only — see its definition in
        // src/kernel/context.cjs.
        { role: 'system', content: 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise. When the user asks you to do something, do it directly. '
          + kernelContext.FORMATTING + mem.text },
        ...history.slice(-20).map(m => ({ role: m.role === 'error' || m.role === 'system' ? 'user' : m.role, content: m.content })),
        // Retrieved documents ride with the user's turn, not as a system
        // message: they are material for THIS question, and a system turn
        // would imply they outrank the operator's own instructions.
        { role: 'user', content: sb.query + sb.context },
      ];
      // D2a #11 — eviction is reported, not silent. "22 of 34 injected,
      // 12 dropped for space" is the operator's answer to "do you have all
      // my memories?", and previously nothing could answer it. Emitted even
      // when count is 0, because "no memories were injected" is itself an
      // answer the operator is entitled to (§08).
      sseWrite(res, 'meta', {
        memory: mem.count,
        memoryConsidered: mem.considered,
        memoryDropped: mem.dropped,
        skillsDropped: mem.skillsDropped,
        autoMemory: mem.autoMemoryEnabled,
        wake: mem.wake,
        // Same principle as the memory counts: a retrieval that happened and
        // found nothing is an answer, and the operator should be able to tell
        // it apart from one that never ran.
        recall: sb.count,
        // Reported by the search itself, not inferred from its results. The
        // inference here read `forced || count > 0 || unavailable`, which
        // called a forced search that was REFUSED a search that ran.
        recallRan: sb.ran,
        recallDropped: sb.dropped,
        recallUnavailable: sb.unavailable || null,
        recallError: sb.error || null,
        citations: sb.citations,
      });

      // The kernel streams, falls back, and records. This block only relays:
      // tokens as they arrive, and a corrected label whenever the provider
      // actually serving differs from the one announced.
      let announced = provider;
      const result = await kernelLLM.stream(messages, {
        role,
        signal: abort.signal,
        onToken: (t) => {
          fullText += t;
          tokenCount++;
          sseWrite(res, 'token', { t: t });
        },
        onAttempt: ({ provider: p, model: m }) => {
          if (p !== announced) {
            announced = p;
            sseWrite(res, 'meta', { provider: p, model: m, role });
          }
        },
        onFallback: ({ from, to, model: m, reason }) => {
          announced = to;
          sseWrite(res, 'warning', { message: `⚠ ${from} unavailable — falling back to ${to}` });
          sseWrite(res, 'meta', { provider: to, model: m, role, fallbackFrom: `${from}: ${String(reason).slice(0, 140)}` });
        },
      });

      sseWrite(res, 'done', {
        text: result.text,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        provider: result.provider,
        model: result.model,
        truncated: result.truncated,
        truncationReason: result.truncationReason,
        cancelled: result.cancelled,
      });
      fullText = result.text || fullText;

      // ── Auto-extract memory (fire-and-forget, non-blocking) ────────
      //
      // BO-MEM P0-2. This block read a bare `SETTINGS_FILE` that is declared
      // NOWHERE — not in module scope, not in the deps destructure above, not
      // a global. It threw ReferenceError on its first line, into the bare
      // `catch {}` that closes this try. So the whole auto-memory path below
      // — the third-person extract prompt, the /api/ai call, the /memory/add
      // writes, and every console.warn added to stop it failing silently —
      // has never executed once on the streaming route, which is the route the
      // operator actually uses. The R-05 plumbing was itself unreachable.
      //
      // Settings come from the injected authority, not a hand-built path
      // re-read per request.
      try {
        const brainPrefs = loadSettings()?.prefs?.brain_settings;
        if (brainPrefs?.auto_memory && message && fullText && !result.cancelled) {
          setImmediate(async () => {
            try {
              // D2a #10 — the extractor is told whose voice to write in.
              // It was producing "your name is Cristian", which reads as the
              // MODEL's name once injected into a system prompt. Asking for
              // third person here is cheaper and more accurate than
              // rewriting prose afterwards; /memory/add still normalises as
              // a backstop for anything that slips through.
              const extractPrompt = `Extract any important facts, preferences, or context from this conversation that should be remembered long-term.

Write every fact in the THIRD PERSON, about the operator. Never use "you", "your", or "I".
  Good: "The operator's name is Cristian"
  Good: "The operator prefers terse output"
  Bad:  "your name is Cristian"
  Bad:  "I am Nanaki"

Return ONLY a JSON array of objects like [{"text":"fact","category":"fact|identity|preference|contact|project|goal"}]. If nothing worth remembering, return [].

User said: ${message.slice(0, 500)}
Assistant replied: ${fullText.slice(0, 1000)}`;
              const kernelBase = process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`;
              const extractResult = await fetch(`${kernelBase}/api/ai`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: extractPrompt, role: 'chat', background: true }),
              }).then(r => r.json());
              if (extractResult.text) {
                // R-05 — this whole block used to end in a bare `catch {}`.
                // Extraction could fail on every single turn and the only
                // evidence would be Memory Core reading 0 MEMORIES, which is
                // exactly what the operator saw and could not explain.
                let facts = [];
                try {
                  facts = JSON.parse(extractResult.text.match(/\[[\s\S]*\]/)?.[0] || '[]');
                } catch (pe) {
                  console.warn('[AUTO-MEMORY] model did not return parseable JSON:', pe.message);
                }
                let saved = 0;
                for (const fact of facts.slice(0, 3)) {
                  if (!fact?.text || fact.text.length <= 5) continue;
                  try {
                    const r = await fetch(`${kernelBase}/api/memory/add`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: fact.text, category: fact.category || 'fact', source: 'auto-extract' }),
                    });
                    if (r.ok) saved++;
                    else console.warn('[AUTO-MEMORY] /memory/add refused:', r.status, (await r.text()).slice(0, 160));
                  } catch (ae) {
                    console.warn('[AUTO-MEMORY] /memory/add unreachable:', ae.message);
                  }
                }
                if (facts.length && !saved) {
                  console.warn(`[AUTO-MEMORY] extracted ${facts.length} fact(s) and saved none.`);
                }
              }
            } catch (e) { console.warn('[AUTO-MEMORY] extraction failed:', e.message); }
          });
        }
      } catch {}
    } catch (err) {
      // A failure after tokens were shown carries what arrived, so the
      // terminal can keep the partial answer on screen and say it broke.
      sseWrite(res, 'error', {
        error: err.message,
        ...(err.partialText ? { partialText: err.partialText, tokens: tokenCount } : {}),
        ...(err.noProviderAvailable ? { noProviderAvailable: true } : {}),
        ...(err.rateLimited ? { rateLimited: true, retryable: true } : {}),
      });
    }

    activeStreams.delete(streamId);
    res.end();
  });

  // ── POST /chat/stop — cancel an active stream ─────────────────────
  //
  // D1c. This returned {ok:true} and cancelled nothing: the UI said
  // "cancelled" while the model kept generating. At the old 512-token cap
  // that was a two-minute annoyance. With D1a's derived budget it is up to
  // ~43 minutes of unstoppable CPU behind a screen claiming it stopped —
  // §08 again, and the reason a fake stop could not survive D1a.
  router.post('/chat/stop', (req, res) => {
    const { streamId } = req.body || {};

    if (streamId) {
      const abort = activeStreams.get(String(streamId));
      if (!abort) {
        // Say so. "Nothing to stop" and "stopped" are different outcomes and
        // must not both render as success.
        return res.status(404).json({ ok: false, stopped: 0, error: `No active stream ${streamId}. It may have already finished.` });
      }
      abort.abort();
      activeStreams.delete(String(streamId));
      return res.json({ ok: true, stopped: 1, streamId });
    }

    // No id: stop everything this process is generating.
    let stopped = 0;
    for (const [id, abort] of activeStreams) {
      try { abort.abort(); stopped++; } catch {}
      activeStreams.delete(id);
    }
    // Local generations may also be held by the runtime itself; the kernel
    // owns that handle, so the block asks rather than reaching for it.
    try { stopped += kernelLLM?.cancelAll?.() || 0; } catch {}

    res.json({ ok: true, stopped, note: stopped ? `Cancelled ${stopped} generation(s).` : 'Nothing was generating.' });
  });

  return router;
};
