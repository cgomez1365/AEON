/**
 * AEON SSE Chat Stream — token-by-token streaming from any provider.
 *
 * Ported from Odysseus's chat_stream pattern, adapted for AEON's kernel:
 *   • Reads role→provider→model from aeon-settings.json (same as kernelLLM)
 *   • Streams via SSE (text/event-stream) so the Neural Terminal renders
 *     tokens as they arrive instead of waiting for the full response
 *   • Supports Groq, Gemini, Ollama, OpenAI (all OpenAI-compatible)
 *   • Falls back to non-streaming kernelLLM if the provider doesn't stream
 *   • Tracks telemetry (tokens, latency) per call
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

module.exports = function ({ getLocalFile, GEMINI_KEY_POOL, _trackLLM, writeOSAudit, VAULT_ROOT, DEFAULT_LOCAL_MODEL, defaultLocalModel }) {
  const SETTINGS_FILE = path.join(__dirname, '..', '..', '..', 'aeon-settings.json');
  const localModel = (defaultLocalModel ? defaultLocalModel() : null) || DEFAULT_LOCAL_MODEL || process.env.OLLAMA_MODEL || null;
  const loadSettings = () => {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return { models: { chat: { provider: 'ollama', model: localModel } } }; }
  };

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
  const MEMORY_FILE = path.join(VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'), 'Agents', 'vp', 'memory', 'memories.json');
  const WAKE_RE = /\bvp[,!]?\s+(?:come\s+)?online\b/i;

  function buildMemoryContext(message, settings) {
    const prefs = settings.prefs?.brain_settings || {};
    if (prefs.memory_in_context === false) return { text: '', wake: false, count: 0 };
    let all = [];
    try { all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch {}
    const wake = WAKE_RE.test(message || '');
    const pinned = all.filter(m => m.pinned);
    // Continuity > recency: operator-authored entries and settled decisions
    // outrank milestones/drive-by facts regardless of age (same doctrine as
    // memory_core's /memory/context). Recency only breaks ties.
    const TYPE_W = { decision: 400, algorithm: 300, outline: 300, milestone: 50 };
    const rank = m => (m.source === 'operator' ? 500 : 0) + (TYPE_W[m.type] !== undefined ? TYPE_W[m.type] : 150);
    const rest = all.filter(m => !m.pinned).sort((a, b) => (rank(b) - rank(a)) || ((b.timestamp || 0) - (a.timestamp || 0)));
    const maxN = wake ? all.length : Math.max(prefs.memory_max_context || 25, pinned.length);
    const chosen = [...pinned, ...rest].slice(0, maxN);

    const CHAR_BUDGET = wake ? 10000 : 4500; // context-window guard
    const lines = [];
    let used = 0;
    for (const m of chosen) {
      const line = `- [${m.category || 'fact'}] ${m.text}`;
      if (used + line.length > CHAR_BUDGET) break;
      lines.push(line);
      used += line.length + 1;
    }

    // Approved skills (brain_skills prefs), capped by count and budget
    const skills = (settings.prefs?.brain_skills || [])
      .filter(s => s.status === 'approved' && s.body)
      .slice(0, prefs.skill_max_injected || 30);
    let skillText = '';
    let skillBudget = wake ? 5000 : 2500;
    for (const s of skills) {
      const block = `\n### ${s.title}\n${String(s.body).slice(0, 1500)}`;
      if (block.length > skillBudget) break;
      skillText += block;
      skillBudget -= block.length;
    }

    let text = '';
    if (lines.length) text += `\n\n## MEMORY (long-term store — ground truth about the operator and this system)\n${lines.join('\n')}`;
    if (skillText) text += `\n\n## SKILLS (standing procedures — follow these)${skillText}`;
    if (wake) text += `\n\n## WAKE\nThe operator just said the wake phrase. You are VP, AEON's operations agent. All ${all.length} memories are loaded above. Confirm you are online, state the memory count, restate the prime directive, and ask for the mission. Do not ask what "VP" means.`;
    return { text, wake, count: lines.length };
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

  async function* streamOllama(prompt, model, options) {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const r = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: true, ...(options ? { options } : {}) }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
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
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.response) yield chunk.response;
          if (chunk.done) return;
        } catch {}
      }
    }
  }

  async function* streamGemini(prompt, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
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

  // ── POST /chat/stream — the main SSE endpoint ─────────────────────
  router.post('/chat/stream', async (req, res) => {
    const { message, role = 'chat', history = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

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

    sseWrite(res, 'meta', { provider, model, role });

    const t0 = Date.now();
    let fullText = '';
    let tokenCount = 0;

    try {
      // Build messages array (OpenAI-format providers)
      const mem = buildMemoryContext(message, settings);
      const messages = [
        { role: 'system', content: 'You are AEON, an AI-native operating system assistant built by Broken Gear Industries. Your terminal persona is VP (VP of Operations), the operator’s autonomous second-in-command. You are helpful, precise, and concise. When the user asks you to do something, do it directly.' + mem.text },
        ...history.slice(-20).map(m => ({ role: m.role === 'error' || m.role === 'system' ? 'user' : m.role, content: m.content })),
        { role: 'user', content: message },
      ];
      const promptFlat = messages.map(m => m.content).join('\n');
      // Wake reads need a bigger Ollama context window (default is 4096)
      const ollamaOpts = { num_ctx: mem.wake ? 16384 : 8192 };
      if (mem.count) sseWrite(res, 'meta', { memory: mem.count, wake: mem.wake });

      const buildGenerator = async (provider, model) => {
        if (provider === 'groq') {
          const apiKey = await resolveKey('groq', 'GROQ_API_KEY');
          if (!apiKey) throw new Error('No Groq key (set GROQ_API_KEY or add a connection)');
          return streamGroq(messages, model, apiKey);
        }
        if (provider === 'ollama') return streamOllama(promptFlat, model, ollamaOpts);
        if (provider === 'gemini') {
          const apiKey = await resolveKey('gemini', 'GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_1');
          if (!apiKey) throw new Error('No Gemini key');
          return streamGemini(promptFlat, model, apiKey);
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

      // Build the fallback chain: configured → groq → ollama
      const chain = [
        { p: provider, m: model },
        ...(provider !== 'groq' && process.env.GROQ_API_KEY ? [{ p: 'groq', m: fallbackGroqModel }] : []),
        { p: 'ollama', m: settings.models?.chat?.provider === 'ollama' ? settings.models.chat.model : localModel },
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
        // Stream died mid-flight — retry with ollama if untouched and not already on ollama
        if (!fullText && activeProvider !== 'ollama') {
          sseWrite(res, 'warning', { message: `⚠ ${activeProvider} stream failed — falling back to Ollama` });
          const ollamaModel = localModel;
          sseWrite(res, 'meta', { provider: 'ollama', model: ollamaModel, role, fallbackFrom: `${activeProvider}: ${e.message.slice(0, 140)}` });
          const retry = await buildGenerator('ollama', ollamaModel);
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
      try {
        const settingsRaw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const brainPrefs = JSON.parse(settingsRaw).prefs?.brain_settings;
        if (brainPrefs?.auto_memory && message && fullText) {
          setImmediate(async () => {
            try {
              const extractPrompt = `Extract any important facts, preferences, or context from this conversation that should be remembered long-term. Return ONLY a JSON array of objects like [{"text":"fact","category":"fact|identity|preference|contact|project|goal"}]. If nothing worth remembering, return [].

User said: ${message.slice(0, 500)}
Assistant replied: ${fullText.slice(0, 1000)}`;
              const kernelBase = process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`;
              const extractResult = await fetch(`${kernelBase}/api/ai`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: extractPrompt, role: 'chat', background: true }),
              }).then(r => r.json());
              if (extractResult.text) {
                try {
                  const facts = JSON.parse(extractResult.text.match(/\[[\s\S]*\]/)?.[0] || '[]');
                  for (const fact of facts.slice(0, 3)) {
                    if (fact.text && fact.text.length > 5) {
                      await fetch(`${kernelBase}/api/memory/add`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: fact.text, category: fact.category || 'fact' }),
                      });
                    }
                  }
                } catch {}
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

  // ── POST /chat/stop — cancel an active stream (future: track active) ─
  router.post('/chat/stop', (req, res) => {
    // Placeholder — full implementation tracks active streams by session ID
    res.json({ ok: true, note: 'Stream cancelled (client-side abort)' });
  });

  return router;
};
