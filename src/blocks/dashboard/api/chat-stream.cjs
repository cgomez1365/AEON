/**
 * AEON SSE Chat Stream — token-by-token streaming from any provider.
 *
 * Ported from Odysseus's chat_stream pattern, adapted for AEON's kernel:
 *   • Reads role→provider→model from aeon-settings.json (same as kernelLLM)
 *   • Streams via SSE (text/event-stream) so the Neural Terminal renders
 *     tokens as they arrive instead of waiting for the full response
 *   • Supports Groq, Gemini, local runtime, OpenAI (all OpenAI-compatible)
 *   • Falls back to non-streaming kernelLLM if the provider doesn't stream
 *   • Tracks telemetry (tokens, latency) per call
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const settingsAuthority = require('../../../../services/settings.js');
const tokens = require('../../../kernel/tokens.cjs');
const memoryPolicy = require('../../../kernel/memory-policy.cjs');
const kernelContext = require('../../../kernel/context.cjs');

module.exports = function ({ getLocalFile, GEMINI_KEY_POOL, _trackLLM, writeOSAudit, VAULT_ROOT, DEFAULT_LOCAL_MODEL, defaultLocalModel }) {
  const localModel = (defaultLocalModel ? defaultLocalModel() : null) || DEFAULT_LOCAL_MODEL || null;
  // Settings come from the authority (services/settings.js), not a hand-built
  // relative path re-read per request. The local-model fallback is preserved so
  // a settings file with no chat role still resolves offline (BO-F1).
  const loadSettings = () => {
    try {
      const s = settingsAuthority.loadSettings();
      if (s && s.models && s.models.chat) return s;
      return { ...(s || {}), models: { ...((s && s.models) || {}), chat: { provider: 'local', model: localModel } } };
    } catch { return { models: { chat: { provider: 'local', model: localModel } } }; }
  };

  // ── Second Brain recall ────────────────────────────────────────────
  // Ported from chat.cjs, which had it and this endpoint never did. The
  // terminal moved to streaming and quietly lost the ability to answer from
  // the operator's own indexed documents — the single feature that separates
  // "a chat box" from "a chat box that knows my vault". Asking "what's in my
  // notes about X" hit the model's training data and nothing else.
  //
  // `/matrix <request>` forces a lookup; otherwise the patterns gate it so an
  // ordinary message never pays for a retrieval round-trip. Same patterns and
  // same route as chat.cjs, deliberately: two copies of a recall policy that
  // drift apart is how this endpoint came to have none.
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
  // is operator-visible in Aeon Matrix. (Old path pointed at the removed
  // `memory` block — injection silently read an empty store for weeks. Now
  // derived from the shared VAULT_ROOT constant instead of a second
  // independently-hardcoded path, so it can't drift out of sync with
  // memory_core's own MEM_DIR again.)
  const MEMORY_FILE = path.join(VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'), 'Agents', 'Aeon', 'memory', 'memories.json');
  const WAKE_RE = /\bvp[,!]?\s+(?:come\s+)?online\b/i;

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
      maxCount: wake ? 0 : Math.max(prefs.memory_max_context || 25, 0),
      enabled: prefs.memory_in_context !== false,
      autoMemoryEnabled: !!prefs.auto_memory,
    });

    return { ...out, budgets };
  }

  // Resolve a provider's key from .env OR the vault (added via "Add connection"),
  // so the streaming terminal uses the same source of truth as kernelLLM/Writer.
  const resolveKey = async (provider, ...envNames) => {
    for (const n of envNames) { if (process.env[n]) return process.env[n]; }
    try {
      const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const reg = await endpointsMod.load(null);
      const ep = (reg.endpoints || []).find(e => e.provider === provider && e.auth_ref);
      if (ep) {
        const vault = require(path.join(__dirname, '..', '..', '..', 'kernel', 'vault.cjs'));
        return await vault.getSecret(ep.auth_ref, null);
      }
    } catch {}
    return null;
  };

  // ── SSE helpers ────────────────────────────────────────────────────
  function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ── Provider-specific streaming ────────────────────────────────────

  async function* streamGroq(messages, model, apiKey, url = 'https://api.groq.com/openai/v1/chat/completions') {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // max_tokens capped: OpenRouter defaults to the model max and 402s
      // when prepaid credits can't cover the reservation
      body: JSON.stringify({ model, messages, stream: true, max_tokens: 4096 }),
    });
    if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          const chunk = JSON.parse(payload);
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch {}
      }
    }
  }

  // The local path takes the SAME messages array every cloud provider gets.
  //
  // It used to receive `promptFlat` — every message's content joined with
  // newlines, system prompt included — so the model saw one undifferentiated
  // block of text with no idea which lines were its instructions, which were
  // the operator's, and which were its own earlier replies. That is why a
  // local chat answered as a generic assistant while the same settings on a
  // cloud provider answered as AEON: the identity and the injected memories
  // were present in the string but carried no more weight than any other
  // line in it. llama.cpp applies the model's own chat template to a real
  // messages array, which is what makes a system turn a system turn.
  async function* streamLocal(messages, model, signal) {
    const lr = (() => { try { return require('../../../../services/local-runtime/index.cjs'); } catch { return null; } })();
    if (!lr || !lr.isAvailable()) throw new Error('Native local runtime not ready');
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const tokens = [];
    let ended = false;
    // D1c — the signal has to reach llama-server. Without it, "stop" could
    // only ever stop the display.
    lr.inferStream('', { model: model || undefined, signal, messages }, (token) => {
      tokens.push(token);
      if (resolve) { const r = resolve; resolve = null; r(); }
    }).then(() => { ended = true; if (resolve) resolve(); }).catch(e => { ended = true; if (reject) reject(e); });
    while (true) {
      while (tokens.length) { yield tokens.shift(); }
      if (ended) break;
      await new Promise(r => { resolve = r; });
    }
  }

  // Same messages array as every other provider, mapped onto Gemini's shape.
  //
  // This too was handed the flattened string, which threw away both the
  // system turn and the conversation's turn boundaries — Gemini has a
  // dedicated systemInstruction field and its own role names, and using
  // neither meant the identity and memory block arrived as ordinary user
  // text the model could weigh however it liked.
  async function* streamGemini(messages, model, apiKey) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = messages
      .filter(m => m.role !== 'system')
      // Gemini names the model's own turns "model", not "assistant".
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const token = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (token) yield token;
        } catch {}
      }
    }
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

    const settings = loadSettings();
    const roleConfig = settings.models[role] || settings.models.chat;
    const provider = roleConfig.provider;
    const model = roleConfig.model;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    sseWrite(res, 'meta', { provider, model, role, streamId });

    const t0 = Date.now();
    let fullText = '';
    let tokenCount = 0;

    try {
      // Build messages array (OpenAI-format providers)
      //
      // D1f — the memory and skill budgets are fractions of the window we are
      // actually about to spend from. Local models know their real window;
      // cloud providers are far larger than anything we inject, so the 8k
      // floor is a safe assumption there rather than a guess that matters.
      const contextTokens = provider === 'local'
        ? ((await (async () => {
            try {
              const lr = require('../../../../services/local-runtime/index.cjs');
              return (await lr.plannedContext(model))?.contextTokens;
            } catch { return null; }
          })()) || 8192)
        : 8192;
      const mem = buildMemoryContext(message, settings, contextTokens);
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
        { role: 'system', content: 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise. When the user asks you to do something, do it directly.' + mem.text },
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

      const buildGenerator = async (provider, model) => {
        if (provider === 'groq') {
          const apiKey = await resolveKey('groq', 'GROQ_API_KEY');
          if (!apiKey) throw new Error('No Groq key (set GROQ_API_KEY or add a connection)');
          return streamGroq(messages, model, apiKey);
        }
        if (provider === 'local') return streamLocal(messages, model, abort.signal);
        if (provider === 'gemini') {
          const apiKey = await resolveKey('gemini', 'GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_1');
          if (!apiKey) throw new Error('No Gemini key');
          return streamGemini(messages, model, apiKey);
        }
        if (provider === 'openrouter') {
          const apiKey = await resolveKey('openrouter', 'OPENROUTER_API_KEY');
          if (!apiKey) throw new Error('No OpenRouter key');
          return streamGroq(messages, model, apiKey, 'https://openrouter.ai/api/v1/chat/completions');
        }
        if (provider === 'openai' || provider === 'claude') {
          const apiKey = provider === 'openai'
            ? await resolveKey('openai', 'OPENAI_API_KEY')
            : await resolveKey('claude', 'ANTHROPIC_API_KEY');
          if (!apiKey) throw new Error(`${provider} API key not set`);
          return streamGroq(messages, model, apiKey); // same SSE format
        }
        throw new Error(`Unknown provider: ${provider}`);
      };

      // Try the configured provider; if it fails before the first token,
      // fall back to Groq. Use chat_fallback if configured; otherwise only
      // reuse chat.model if it's already a Groq model — never send a Gemini
      // model name (e.g. 'gemini-2.5-flash') to Groq, which 404s.
      const _chatCfg = settings.models?.chat;
      const fallbackGroqModel = settings.models?.chat_fallback?.model
        || (_chatCfg?.provider === 'groq' ? _chatCfg?.model : null)
        || 'llama-3.3-70b-versatile';
      let generator;
      let activeProvider = provider;

      // Helper: try a generator, fall through to next provider on failure
      const tryProvider = async (p, m) => {
        try { return { gen: await buildGenerator(p, m), provider: p }; } catch (e) { return { error: e.message }; }
      };

      // Build the fallback chain: configured → groq → local
      const chain = [
        { p: provider, m: model },
        ...(provider !== 'groq' && process.env.GROQ_API_KEY ? [{ p: 'groq', m: fallbackGroqModel }] : []),
        { p: 'local', m: localModel },
      ];

      let lastErr = null;
      for (const { p, m } of chain) {
        const attempt = await tryProvider(p, m);
        if (attempt.error) {
          lastErr = attempt.error;
          if (p !== provider) sseWrite(res, 'warning', { message: `⚠ ${p} unavailable (${attempt.error.slice(0, 80)})` });
          continue;
        }
        if (p !== provider) {
          sseWrite(res, 'warning', { message: `⚠ ${provider} unavailable — falling back to ${p}` });
          sseWrite(res, 'meta', { provider: p, model: m, role, fallbackFrom: `${provider}: ${lastErr?.slice(0, 140) || 'unavailable'}` });
        }
        generator = attempt.gen;
        activeProvider = p;
        break;
      }
      if (!generator) throw new Error(lastErr || 'All providers unavailable');

      try {
        for await (const token of generator) {
          fullText += token;
          tokenCount++;
          sseWrite(res, 'token', { t: token });
        }
      } catch (e) {
        // Stream died mid-flight — retry with local runtime if untouched
        if (!fullText && activeProvider !== 'local') {
          sseWrite(res, 'warning', { message: `⚠ ${activeProvider} stream failed — falling back to local runtime` });
          sseWrite(res, 'meta', { provider: 'local', model: localModel, role, fallbackFrom: `${activeProvider}: ${e.message.slice(0, 140)}` });
          const retry = await buildGenerator('local', localModel);
          for await (const token of retry) {
            fullText += token;
            tokenCount++;
            sseWrite(res, 'token', { t: token });
          }
        } else throw e;
      }

      const latency = Date.now() - t0;
      const estTokens = Math.ceil(fullText.length / 4);
      if (_trackLLM) _trackLLM(provider, model, estTokens, latency, true);

      sseWrite(res, 'done', {
        text: fullText,
        tokens: estTokens,
        latencyMs: latency,
        provider,
        model,
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
      // Settings come from the authority the rest of this file already uses,
      // not a hand-built path re-read per request.
      try {
        const brainPrefs = loadSettings()?.prefs?.brain_settings;
        if (brainPrefs?.auto_memory && message && fullText) {
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
      sseWrite(res, 'error', { error: err.message });
      if (_trackLLM) _trackLLM(provider || 'unknown', model || 'unknown', 0, Date.now() - t0, false);
    }

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
    // Local generations may also be held by the runtime itself.
    try {
      const lr = require('../../../../services/local-runtime/index.cjs');
      stopped += lr.cancelAll?.() || 0;
    } catch {}

    res.json({ ok: true, stopped, note: stopped ? `Cancelled ${stopped} generation(s).` : 'Nothing was generating.' });
  });

  return router;
};
