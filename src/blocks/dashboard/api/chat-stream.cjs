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
const tokens = require('../../../kernel/tokens.cjs');
const kernelContext = require('../../../kernel/context.cjs');
const blockSettings = require('../../../kernel/blockSettings.cjs');
const agentTools = require('../../../kernel/agentTools.cjs');
const agentTurn = require('../../../kernel/agentTurn.cjs');
const agentWorkspace = require('../../../kernel/agentWorkspace.cjs');
const toolProtocol = require('../../../kernel/toolProtocol.cjs');
const continuation = require('../../../kernel/continuation.cjs');

module.exports = function ({ kernelLLM, loadSettings: loadSettingsDep, VAULT_ROOT, fetchWebSearch, requestIndex, writeOSAudit }) {
  // One router per call. It was built once at module load, so every later
  // call added its handlers to the SAME router behind the first set — and
  // the first set answered every request, with the first call's model layer
  // and Vault. A block reloaded with AEON running (no restart) kept chatting
  // on what it had been given before (found 2026-10-02).
  const router = express.Router();
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
  // An agent set to Local only searches with a local embedder or not at all.
  const buildSecondBrainContext = (message, auth, budgetTokens, { localOnly = false } = {}) =>
    kernelContext.buildRecallContext(message, { auth, budgetTokens, localOnly });

  // ── Memory injection ───────────────────────────────────────────────
  // Pinned + recent memories ride along on every message (brain_settings
  // gates it). The wake phrase "vp come online" triggers a FULL memory
  // read. A hard char budget keeps the local model's context window from
  // overflowing regardless of how large the memory store grows.
  // Store is owned by the memory_core block, vault-resident so every memory
  // is operator-visible in Aeon Matrix; the kernel resolves it from the
  // shared VAULT_ROOT so it cannot drift from memory_core's own MEM_DIR.
  // Who is speaking: the operator's own AEON or one of their agents
  // (src/kernel/agents.cjs). The wake phrase is the kernel's too — it names
  // the agent it wakes.
  const agentsKernel = require('../../../kernel/agents.cjs');

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
  function buildMemoryContext(message, settings, contextTokens = 8192, { wake = false, agent = null } = {}) {
    const prefs = settings.prefs?.brain_settings || {};
    // Memory controls are memory_core's declared settings (Settings → Blocks).
    const mem = blockSettings.get('memory_core', settings);
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
      agent,
      // Wake lifts the count cap entirely; otherwise the operator's cap applies
      // and memory-policy still keeps pinned memories ahead of it.
      //
      // The default count is 200, not 25. The kernel ranks memories, keeps the
      // top maxCount, and only THEN fits them to the token budget, so a small
      // count throws memories away before their cost is ever weighed. 25 dates
      // from when the budget came from an assumed 8k window and could not be
      // trusted to limit anything. Now describeRole reports the real window and
      // inputBudgets caps memory in tokens (32,000 at most), the unit that
      // actually matters: about 180 average memories fit, so the budget binds
      // first and 200 is only a backstop for a store that grows without bound.
      // An operator who sets memory_max_context still gets exactly that.
      maxCount: wake ? 0 : Math.max(Number(mem.memory_max_context) || 200, 0),
      enabled: mem.memory_in_context !== false,
      // An agent captures by its own switch; the operator's AEON by the block's.
      autoMemoryEnabled: capturesFor(agent, mem),
    });

    return { ...out, budgets };
  }

  const BASE_IDENTITY = agentTools.BASE_IDENTITY;

  function capturesFor(agent, mem) {
    return agent && !agent.self ? agent.capture === true : !!mem.auto_memory;
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
    const { message, role = 'chat', history = [], streamId: clientStreamId, agent: agentRef = null } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    // The agent this turn belongs to. A wake that names an agent ("scout
    // come online") hands the turn to it, and the terminal follows (meta.agent).
    // An agent the terminal remembers but the Vault no longer has falls back
    // to the operator's own AEON, and says so.
    let agents = [];
    try { agents = agentsKernel.list(VAULT_ROOT, { withStats: false }); } catch {}
    const woke = agentsKernel.detectWake(message, agents);
    const asked = agentRef ? agentsKernel.get(VAULT_ROOT, agentRef, agents) : null;
    const agent = woke.agent || asked || agents.find((a) => a.self) || null;
    const agentNotice = agentRef && !asked && !woke.agent
      ? `No agent called "${agentRef}" any more — ${agent ? agent.name : 'AEON'} answered.` : null;
    const callOpts = agentsKernel.callOptions(agent);

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
    // An agent with its own model is announced as that model; the window
    // stays the role's (a safe floor — the kernel trims a request that is
    // too large for the model actually serving it).
    if (callOpts.provider) { provider = callOpts.provider; model = callOpts.model || null; }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const agentMeta = agent ? { id: agent.id, name: agent.name, self: !!agent.self } : null;
    sseWrite(res, 'meta', { provider, model, role, streamId, agent: agentMeta, ...(agentNotice ? { notice: agentNotice } : {}) });

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
      const mem = buildMemoryContext(message, settings, contextTokens || 8192, { wake: woke.wake, agent });
      // The caller's credentials are forwarded onto the internal retrieve call.
      // Without this the guard refuses it and the refusal reads as an empty vault.
      const sb = await buildSecondBrainContext(
        message,
        { authorization: req.headers.authorization, cookie: req.headers.cookie },
        mem.budgets?.recallTokens,
        { localOnly: !!callOpts.localOnly },
      );
      // 3.3 — the agent's own working files, and AEON's tools. The toolbox
      // holds only what THIS caller may use (Local only: no web search, no
      // asking across the Local only line); off when the operator turned it
      // off, for non-chat roles, and for a window too small to carry results.
      const memSettings = blockSettings.get('memory_core', settings);
      const ctxWindow = contextTokens || 8192;
      const smallWindow = ctxWindow < agentTools.LIMITS.TOOLS_MIN_CONTEXT;
      const toolsOff = memSettings.agent_tools === false ? 'off in Settings → Blocks → Memory Core'
        : role !== 'chat' ? 'only chat turns use tools'
          : !VAULT_ROOT ? 'no Vault is mounted'
            : smallWindow ? `the model's window (${ctxWindow} tokens) is too small for tools`
              : null;
      const auth = { authorization: req.headers.authorization, cookie: req.headers.cookie };
      const toolbox = toolsOff ? null : agentTools.createToolbox({
        vaultRoot: VAULT_ROOT, agent, agents, settings, memSettings, auth,
        kernelLLM, fetchWebSearch, requestIndex, writeOSAudit,
        correlationId: req.correlationId || streamId, contextTokens: ctxWindow, signal: abort.signal,
        baseIdentity: BASE_IDENTITY,
      });
      const workspace = agentWorkspace.promptBlock(VAULT_ROOT, agent);
      const autoContinue = memSettings.auto_continue !== false;
      const continueParts = continuation.clampParts(memSettings.auto_continue_parts);
      const messages = [
        // AEON is a tool, not a staff member. This prompt used to cast the
        // assistant as "VP (VP of Operations), the operator's autonomous
        // second-in-command" — an org-chart metaphor from how AEON is built,
        // which is not what a customer is buying.
        // The formatting directive sits with the identity and AHEAD of
        // mem.text, so the memory rules the kernel appends stay the last word
        // on this system turn. It governs layout only — see its definition in
        // src/kernel/context.cjs.
        // The workspace (scratchpad, last handoff) and the tool protocol come
        // before mem.text, so the memory rules stay the last word.
        { role: 'system', content: agentsKernel.identityFor(agent, BASE_IDENTITY)
          // Memories are data too: an aeon-tool block saved inside one is
          // neutralised like a recalled passage (context.cjs) or a result.
          + kernelContext.FORMATTING + workspace.text + (toolbox ? toolbox.promptText() : '') + toolProtocol.neutralise(mem.text) },
        // A turn the terminal tagged with an agent set to Local only reaches
        // only a Local only agent's model (one feed can switch agents).
        ...agentsKernel.shareableTurns(history, agent, agents).slice(-20)
          .map(m => ({ role: m.role === 'error' || m.role === 'system' ? 'user' : m.role, content: m.content })),
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
        memoryDisabled: mem.disabled || 0,
        // A store that could not be read is not "0 memories" (sweep C12).
        memoryError: mem.memoryError || null,
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
        // 3.3: what this turn may do, and the agent's own working files.
        tools: toolbox ? toolbox.names() : [],
        toolsOff,
        autoContinue: { on: autoContinue, maxParts: autoContinue ? continueParts : 0 },
        scratchpadChars: workspace.scratchpadChars,
        handoffAt: workspace.handoffAt,
      });
      if (toolsOff && smallWindow && memSettings.agent_tools !== false && role === 'chat' && VAULT_ROOT) {
        sseWrite(res, 'notice', { level: 'info', code: 'tools-off', message: `Tools are off for this reply: ${toolsOff}.` });
      }

      // The kernel streams, falls back, and records. This block only relays:
      // tokens as they arrive, and a corrected label whenever the provider
      // actually serving differs from the one announced. The turn engine
      // (src/kernel/agentTurn.cjs) runs the rounds: tool calls between them,
      // and the continuation of an answer cut off by the output limit.
      let announced = provider;
      const result = await agentTurn.runAgentTurn({
        kernelLLM,
        messages,
        role,
        // The agent's own model and privacy, on EVERY round and continuation;
        // nothing for a stock AEON, so Settings and roulette decide as before.
        callOpts,
        signal: abort.signal,
        toolbox,
        autoContinue,
        continueParts,
        emit: (event, data) => {
          if (event === 'token') { fullText += data.t; tokenCount++; }
          sseWrite(res, event, data);
        },
        onAttempt: ({ provider: p, model: m }) => {
          if (p !== announced) {
            announced = p;
            sseWrite(res, 'meta', { provider: p, model: m, role });
          }
        },
        onFallback: ({ from, to, model: m, reason, notice }) => {
          announced = to;
          // One quiet line, in words: a switch is a notice, not a failure.
          // The kernel words a retry on the SAME connection itself ("openrouter
          // (x) out of credits → openrouter free model", "groq request too
          // large for it → retried with less context").
          sseWrite(res, 'meta', { provider: to, model: m, role, notice: notice || `${from} ${reason} → ${to}` });
        },
      });

      // A claim the model made that no tool backs ("I searched your vault")
      // is pointed out, never edited.
      if (!result.cancelled) {
        // "I asked <name>" is checked against every agent the operator has,
        // not only those this caller may ask: a claim to have asked one it
        // may not (or with tools off) is the likeliest false one. The notice
        // goes to the operator only.
        const agentNames = agents.filter((a) => a && a.name && !(agent && a.id === agent.id)).map((a) => a.name);
        for (const n of toolProtocol.claimCheck(result.text, toolbox ? toolbox.outcomes() : [], { agentNames })) {
          sseWrite(res, 'notice', n);
        }
      }
      sseWrite(res, 'done', {
        text: result.text,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        provider: result.provider,
        model: result.model,
        truncated: result.truncated,
        truncationReason: result.truncationReason,
        cancelled: result.cancelled,
        parts: result.parts,
        continued: result.continued,
        toolCalls: result.toolCalls,
        toolWrites: result.toolWrites,
      });
      fullText = result.text || fullText;
      // Recent Agent Missions reads this: what the agent was last asked.
      agentsKernel.recordMission(VAULT_ROOT, agent, {
        asked: message, provider: result.provider, model: result.model,
        tokens: result.tokens, ok: !result.cancelled,
      });

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
        if (capturesFor(agent, blockSettings.get('memory_core', loadSettings())) && message && fullText && !result.cancelled) {
          // Both internal calls below are guarded routes, and a loopback fetch
          // carries no session unless one is forwarded — the recall call above
          // learned this already. Without it the guard 401'd /api/ai, the 401
          // body has no `text`, and the whole extraction was skipped without a
          // word: Memory Core sat at 0 auto-extracted memories with the toggle
          // on. Captured here, while the request is in hand.
          const internalHeaders = kernelContext.forwardedAuth({
            authorization: req.headers.authorization, cookie: req.headers.cookie,
          });
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
              const aiRes = await fetch(`${kernelBase}/api/ai`, {
                method: 'POST', headers: internalHeaders,
                // As the agent: its model, and its privacy — a Local only
                // agent's conversation is never sent to a cloud model to be
                // summarised either.
                body: JSON.stringify({ prompt: extractPrompt, role: 'chat', background: true, ...(agent ? { agent: agent.id } : {}) }),
              });
              const extractResult = await aiRes.json().catch(() => ({}));
              if (!aiRes.ok) {
                console.warn('[AUTO-MEMORY] /api/ai refused the extraction:', aiRes.status,
                  String(extractResult.error || extractResult.message || '').slice(0, 160));
                return;
              }
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
                      method: 'POST', headers: internalHeaders,
                      body: JSON.stringify({ text: fact.text, category: fact.category || 'fact', source: 'auto-extract', ...(agent && !agent.self ? { agent: agent.id } : {}) }),
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
              } else {
                console.warn('[AUTO-MEMORY] /api/ai answered with no text to extract from.');
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
