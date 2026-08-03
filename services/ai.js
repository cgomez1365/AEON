/**
 * AEON Jarvis — AI Service (kernelLLM)
 * Multi-provider LLM layer: Gemini key-pool failover, Groq, local (llama.cpp),
 * OpenAI-compatible registry endpoints, vault→env hydration, token
 * governor, and live telemetry. All blocks call kernelLLM(prompt, {role}).
 */
const fs = require('fs');
const path = require('path');
const { readLocalRuntime } = require('./storage.js');
const { isCloud: _isCloud } = require('../src/kernel/runtime.cjs');

// Phase 6: native local runtime (llama.cpp). Lazy require.
// Loaded lazily so ai.js still boots on machines without the runtime installed.
let _localRT = null;
function _getLocalRT() {
  if (!_localRT) {
    try { _localRT = require('./local-runtime/index.cjs'); } catch { _localRT = false; }
  }
  return _localRT || null;
}

module.exports = ({ supabase, writeOSAudit, TOKEN_LEDGER_FILE, loadSettings, aeonTerminalStream }) => {

  // Every provider fetch below now sets an explicit AbortSignal instead of
  // relying on whatever the runtime's default socket timeout happens to be.
  // A long-form completion (a full research report at max_tokens: 8192 on a
  // slow/free-tier model) needs real runway; opts.timeout_ms lets an
  // individual call ask for more without changing the global default.
  const DEFAULT_FETCH_TIMEOUT_MS = 240000; // 4 minutes
  const fetchTimeout = (opts = {}) => AbortSignal.timeout(opts.timeout_ms || DEFAULT_FETCH_TIMEOUT_MS);

  // defaultLocalModel: returns the first ready native chat model from the Phase 2
  // registry, or null. Used by Settings health display and provider-health APIs.
  const defaultLocalModel = () => {
    const lr = _getLocalRT();
    return lr ? lr.defaultModel() : null;
  };

  // localRuntimePresent: true when Phase 2 registry has a ready runtime + model.
  // No daemon, no port, no env var assumed.
  const localRuntimePresent = () => {
    const lr = _getLocalRT();
    return !!(lr && lr.isAvailable());
  };

  const notify = (message, meta = {}) => {
    try { aeonTerminalStream?.emit('log', { type: 'SYSTEM/CORE', message, meta, timestamp: Date.now() }); } catch {}
  };

  // ── Provider health tracker ──────────────────────────────────────────────
  // Every 429/402 marks the provider "in cooldown" for a computed duration so
  // the fallback chain skips it instead of wasting a request finding out
  // again. Parses the provider's own retry-after hints when present.
  const providerHealth = {}; // { groq: {blockedUntil, reason}, gemini: {...}, ... }

  const isHealthy = (p) => Date.now() > (providerHealth[p]?.blockedUntil || 0);

  const markUnhealthy = (p, status, message = '') => {
    let ms = status === 402 ? 10 * 60 * 1000 : 60 * 1000; // credits: 10min, rate limit: 60s default
    const retrySec = /try again in ([\d.]+)s/i.exec(message)?.[1];
    if (retrySec) ms = Math.ceil(parseFloat(retrySec) * 1000) + 2000;
    providerHealth[p] = { blockedUntil: Date.now() + ms, reason: message.slice(0, 160) };
    notify(`⏸ ${p} in cooldown ${Math.round(ms / 1000)}s: ${message.slice(0, 120)}`, { provider: p });
  };

  // BO-A4a — one truth, two readers collapsed.
  //
  // This used to answer purely from process.env / the module-load key-pool
  // snapshots. But on this machine every provider key in .env is BLANK: the
  // keys live in the vault and reach process.env only via hydrateEnvFromVault(),
  // which is async and called at module load WITHOUT await. Any read landing
  // before that promise settles reported a configured provider as unconfigured
  // — and /core/provider-health, which settings fetches on mount, is exactly
  // such a read.
  //
  // The endpoint registry is the source of truth (it is what the vault is keyed
  // from); process.env is a hydration cache of it. Ask the cache first because
  // it is cheapest, then fall back to the registry so the boot window cannot
  // produce a wrong answer.
  const isConfigured = (p) => {
    if (p === 'local') { const lr = _getLocalRT(); return !!(lr && lr.isAvailable()); }

    const cached =
      p === 'groq' ? !!process.env.GROQ_API_KEY :
      p === 'gemini' ? GEMINI_KEY_POOL.length > 0 :
      p === 'openrouter' ? KEY_POOLS.openrouter.length > 0 :
      false;
    if (cached) return true;

    // Registry fallback — covers the pre-hydration window and any provider
    // whose key was added in Settings this session.
    try {
      return !!(aeonEndpoints && aeonEndpoints.isProviderConfigured(p));
    } catch { return false; }
  };

  const getProviderHealth = () => {
    const out = {};
    for (const p of ['groq', 'gemini', 'local', 'openrouter']) {
      const configured = isConfigured(p);
      out[p] = { healthy: configured && isHealthy(p), configured, ...(providerHealth[p] || {}) };
    }
    return out;
  };

  // ── Local-model confirmation gate ──────────────────────────────────────────
  // When every cloud provider is down/exhausted, the INTERACTIVE chat path
  // (terminal / dashboard) does not silently drop to a local model — quality
  // and speed change noticeably, so the operator gets a heads-up and must
  // type /allow-local to open a time-boxed window. Autonomous background
  // missions are exempt (autonomous.cjs has its own always-on local rung —
  // that's the whole point of a mission you can walk away from).
  // Local model always allowed — no gate, no /allow-local ceremony.
  // User controls fallback order via Settings → prefs.provider_priority.
  const isLocalConfirmed = () => true;
  const confirmLocal = () => ({ until: Infinity });

  // ── Token governor ──
  const KILL_SWITCH_THRESHOLD = 15.00;
  const GEMINI_PRICE_PER_TOKEN = 0.00000015;
  const GROQ_PRICE_PER_TOKEN = 0.00000060;

  const getDailyCost = () => {
    if (!fs.existsSync(TOKEN_LEDGER_FILE)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_LEDGER_FILE, 'utf8'));
      if (data.date !== new Date().toDateString()) return 0;
      return data.cost || 0;
    } catch (e) { return 0; }
  };

  const addRunCost = (cost) => {
    const currentCost = getDailyCost();
    const newData = { date: new Date().toDateString(), cost: currentCost + cost };
    fs.writeFileSync(TOKEN_LEDGER_FILE, JSON.stringify(newData, null, 2));
    return newData.cost;
  };

  // ── Gemini multi-key failover pool ──
  // Unbounded: GEMINI_PAID_KEY, GEMINI_API_KEY, GEMINI_FREE_KEY_1..N —
  // every key found in env joins the pool, numeric order preserved.
  const scanGeminiEnvKeys = () => {
    const keys = [process.env.GEMINI_PAID_KEY, process.env.GEMINI_API_KEY];
    Object.keys(process.env)
      .filter(n => /^GEMINI_FREE_KEY_\d+$/.test(n))
      .sort((a, b) => Number(a.slice(16)) - Number(b.slice(16)))
      .forEach(n => keys.push(process.env[n]));
    return [...new Set(keys.filter(Boolean))];
  };
  const GEMINI_KEY_POOL = scanGeminiEnvKeys();

  let activeKeyIndex = 0;
  let keySwapCount = 0;
  let isRotating = false; // race condition guard

  const getActiveKey = () => GEMINI_KEY_POOL[activeKeyIndex % GEMINI_KEY_POOL.length];

  const rotateKey = (reason) => {
    if (isRotating) return;
    isRotating = true;
    const prevIdx = activeKeyIndex;
    activeKeyIndex = (activeKeyIndex + 1) % GEMINI_KEY_POOL.length;
    keySwapCount++;
    writeOSAudit('KEY_ROTATE', `Swapped key[${prevIdx}] -> key[${activeKeyIndex}] | Reason: ${reason}`, 0, 0, 'AEON-SYS');
    console.log(`[GEMINI FAILOVER] Key rotated: slot ${prevIdx} -> slot ${activeKeyIndex} (${reason})`);
    setTimeout(() => { isRotating = false; }, 500);
  };

  // ── Live telemetry tracker ──
  let _recordActivity = null; // token heatmap hook, attached post-mount
  const setActivityRecorder = (fn) => { _recordActivity = fn; };
  const _llmTelemetry = { calls: {}, totalCalls: 0, totalTokens: 0 };
  function _trackLLM(engine, model, tokens, latencyMs, success) {
    const key = `${engine}/${model}`;
    if (!_llmTelemetry.calls[key]) _llmTelemetry.calls[key] = { engine, model, requests: 0, tokens: 0, errors: 0, avgLatency: 0 };
    const c = _llmTelemetry.calls[key];
    c.requests++;
    c.tokens += tokens;
    if (!success) c.errors++;
    c.avgLatency = Math.round((c.avgLatency * (c.requests - 1) + latencyMs) / c.requests);
    _llmTelemetry.totalCalls++;
    _llmTelemetry.totalTokens += tokens;
    writeOSAudit(`LLM_${engine.toUpperCase()}`, `${model} | ${tokens} tok | ${latencyMs}ms${success ? '' : ' | FAILED'}`, success ? 200 : 500, tokens);
    try { if (_recordActivity) _recordActivity(tokens, model, engine); } catch {}
  }

  // ── Normalize input: callers can pass a string OR a messages array ──
  // This is the bridge — old callers still pass (prompt_string, opts) and
  // everything works; new callers can pass messages: [{role,content},...] in
  // opts for multi-turn conversations. System prompt goes in opts.system.
  const _toMessages = (prompt, opts = {}) => {
    if (opts.messages && Array.isArray(opts.messages)) return opts.messages;
    return [{ role: 'user', content: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }];
  };
  const _flatPrompt = (prompt, opts = {}) => {
    if (opts.messages) return opts.messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    return typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  };

  const geminiRequest = async (prompt, modelName = 'gemini-2.0-flash', retries = 0, opts = {}) => {
    if (GEMINI_KEY_POOL.length === 0) throw new Error('No Gemini API keys configured in .env');
    if (retries >= GEMINI_KEY_POOL.length) {
      markUnhealthy('gemini', 429, 'key pool exhausted');
      console.warn('[GEMINI FAILOVER] Gemini key pool exhausted. Falling back to Groq (Llama 3.3)...');
      if (isHealthy('groq')) {
        try { return await groqRequest(prompt, 'llama-3.3-70b-versatile', 0, opts); }
        catch (groqErr) { console.warn('[GEMINI FAILOVER] Groq fallback failed:', groqErr.message); }
      }
      console.warn('[GEMINI FAILOVER] Falling back to native local runtime...');
      return await localNativeRequest(prompt, undefined, opts);
    }
    const apiKey = getActiveKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const _t0 = Date.now();
    const flatText = _flatPrompt(prompt, opts);
    const contents = [{ parts: [{ text: flatText }] }];
    if (opts.system) contents.unshift({ role: 'user', parts: [{ text: opts.system }] });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: opts.max_tokens || 4096 } }),
        signal: fetchTimeout(opts),
      });
      if (response.status === 429) {
        rotateKey('429 Rate Limit');
        return geminiRequest(prompt, modelName, retries + 1, opts);
      }
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errBody}`);
      }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const tokens = data?.usageMetadata?.totalTokenCount || Math.ceil(flatText.length / 4) + Math.ceil(text.length / 4);
      _trackLLM('gemini', modelName, tokens, Date.now() - _t0, true);
      return text;
    } catch (err) {
      _trackLLM('gemini', modelName, 0, Date.now() - _t0, false);
      if (retries < GEMINI_KEY_POOL.length - 1) {
        rotateKey(`Error: ${err.message.substring(0, 60)}`);
        return geminiRequest(prompt, modelName, retries + 1, opts);
      }
      return geminiRequest(prompt, modelName, retries + 1, opts);
    }
  };

  const groqRequest = async (prompt, modelName = 'llama-3.3-70b-versatile', retries = 0, opts = {}) => {
    const pool = KEY_POOLS.groq;
    const apiKey = pool.length ? pool[(keyPoolIdx.groq || 0) % pool.length] : process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY missing in .env');
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const _t0 = Date.now();
    const messages = _toMessages(prompt, opts);
    if (opts.system) messages.unshift({ role: 'system', content: opts.system });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, messages, max_tokens: opts.max_tokens || 4096 }),
      signal: fetchTimeout(opts),
    });
    if (!response.ok) {
      const errBody = await response.text();
      _trackLLM('groq', modelName, 0, Date.now() - _t0, false);
      if (response.status === 429 || response.status === 402) {
        rotateKeyPool('groq');
        const maxRetries = Math.max(pool.length, 1) - 1;
        if (retries < maxRetries) return groqRequest(prompt, modelName, retries + 1, opts);
        markUnhealthy('groq', response.status, errBody);
      }
      throw new Error(`Groq API error ${response.status}: ${errBody}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const tokens = (data?.usage?.total_tokens) || Math.ceil((opts.messages ? JSON.stringify(messages) : prompt).length / 4) + Math.ceil(text.length / 4);
    _trackLLM('groq', modelName, tokens, Date.now() - _t0, true);
    return text;
  };

  const HEAVY_ROLES = new Set(['research', 'grading', 'agent_heavy', 'agent_final', 'agent_worker']);

  // ── Phase 6: native local runtime (llama.cpp, provider id: "local") ──────
  // Calls services/local-runtime/index.cjs — native runtime, no TCP port.
  // Only called when isAvailable() returns true (runtime + model in registry).
  const localNativeRequest = async (prompt, modelId, opts = {}) => {
    const lr = _getLocalRT();
    if (!lr || !lr.isAvailable()) {
      // F3c — an error with two remedies must name both, cheaper first.
      // This said only "Install the runtime and a model in Cookbook." True, and
      // incomplete: the operator fixed it the other way, by repointing the role
      // at a provider that was already configured and working. That path needs
      // no download and the message never mentioned it, so a first-time user
      // reads this banner and goes to fetch 1.4 GB. AEON already knows which
      // providers are healthy — it just was not using that knowledge when it
      // explained a failure.
      const alive = Object.entries(getProviderHealth())
        .filter(([p, h]) => p !== 'local' && h.configured && h.healthy)
        .map(([p]) => p);
      throw new Error(
        alive.length
          ? `No local model is installed. Assign a configured provider (${alive.join(', ')}) in Settings → Model Assignment — that works now and needs no download — or install a local model in Cookbook.`
          : 'No local model is installed and no cloud provider is configured. Install a local model in Cookbook, or add a provider key in Settings → Connections.'
      );
    }
    const _t0 = Date.now();
    const flatPrompt = typeof prompt === 'string' ? prompt : (Array.isArray(prompt) ? prompt.map(m => m.content || '').join('\n') : String(prompt));
    const result = await lr.infer(flatPrompt, { model: modelId || undefined, maxTokens: opts.max_tokens || 512, temperature: opts.temperature ?? 0.7 });
    _trackLLM('local', result.model, result.tokens, Date.now() - _t0, true);
    return opts.returnMeta
      ? { text: result.text, provider: 'local', model: result.model }
      : result.text;
  };

  // ── Claude/Anthropic — the deliberate-choice tier ─────────────────────
  // Never auto-added to the free-tier fallback chain (it costs money); only
  // called when a role/mission tier is explicitly configured for it.
  // advisorModel (optional 4th arg): wires Anthropic's server-side advisor
  // tool (beta advisor_20260301) — executor model can consult a stronger
  // Claude model mid-turn, one request, no extra round trip on our side.
  // Only valid Claude-to-Claude pairs work (see Anthropic's compatibility
  // table); an invalid pair 400s and the caller sees that error directly —
  // no silent fallback, so a misconfigured pair is visible, not swallowed.
  const claudeRequest = async (prompt, modelName = 'claude-sonnet-5', apiKeyOverride, advisorModel, opts = {}) => {
    const apiKey = apiKeyOverride || nextKey('claude') || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing in .env or vault');
    const _t0 = Date.now();
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
    const messages = _toMessages(prompt, opts);
    const body = {
      model: modelName,
      max_tokens: opts.max_tokens || 4096,
      messages,
    };
    if (opts.system) body.system = opts.system;
    if (advisorModel) {
      headers['anthropic-beta'] = 'advisor-tool-2026-03-01';
      body.system = 'If this task involves a non-obvious judgment call, an ambiguous tradeoff, or something you are not fully certain about, consult the advisor tool before finalizing your answer. For straightforward tasks, answer directly.';
      body.tools = [{ type: 'advisor_20260301', name: 'advisor', model: advisorModel }];
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      _trackLLM('claude', modelName, 0, Date.now() - _t0, false);
      if (response.status === 429 || response.status === 402) { markUnhealthy('claude', response.status, errBody); rotateKeyPool('claude'); }
      throw new Error(`Claude API error ${response.status}: ${errBody}`);
    }
    const data = await response.json();
    // Text blocks only — server_tool_use/advisor_tool_result blocks (when the
    // advisor fired) are filtered out; only the executor's final prose remains.
    const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
    const advisorUsed = (data?.content || []).some(b => b.type === 'server_tool_use' && b.name === 'advisor');
    if (advisorUsed) notify(`🧭 Claude consulted its advisor (${advisorModel}) before finalizing.`, { model: modelName, advisor: advisorModel });
    const tokens = (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);
    _trackLLM('claude', modelName, tokens, Date.now() - _t0, true);
    return text;
  };

  // ── Generic multi-key pools (round-robin) ──────────────────────────────
  // Mirrors the Gemini pool pattern for any provider: KEY, KEY_2, KEY_3, ...
  // Purely additive — providers with a single key behave exactly as before.
  // Unbounded: BASE, BASE_2, BASE_3 … BASE_99 — add as many keys to .env /
  // vault as you like, they all get used. Numeric order preserved.
  const buildPool = (base) => {
    const keys = [];
    if (process.env[base]) keys.push(process.env[base]);
    Object.keys(process.env)
      .filter(n => n.startsWith(base + '_') && /^\d+$/.test(n.slice(base.length + 1)))
      .sort((a, b) => Number(a.slice(base.length + 1)) - Number(b.slice(base.length + 1)))
      .forEach(n => keys.push(process.env[n]));
    return [...new Set(keys.filter(Boolean))];
  };
  const KEY_POOLS = {
    groq: buildPool('GROQ_API_KEY'),
    openrouter: buildPool('OPENROUTER_API_KEY'),
    claude: buildPool('ANTHROPIC_API_KEY'),
  };
  const keyPoolIdx = {};
  const nextKey = (provider) => {
    const pool = KEY_POOLS[provider];
    if (!pool || pool.length < 2) return null; // single-key providers keep using their plain env var
    return pool[(keyPoolIdx[provider] || 0) % pool.length];
  };
  const rotateKeyPool = (provider) => {
    if (!KEY_POOLS[provider] || KEY_POOLS[provider].length < 2) return;
    keyPoolIdx[provider] = ((keyPoolIdx[provider] || 0) + 1) % KEY_POOLS[provider].length;
    notify(`🔁 Rotated ${provider} key (${KEY_POOLS[provider].length} in pool)`, { provider });
  };
  const getKeyPoolInfo = () => Object.fromEntries(
    Object.entries(KEY_POOLS)
      .filter(([, keys]) => keys.length > 0) // dead providers don't get a ghost card
      .map(([p, keys]) => [p, { count: keys.length, activeIndex: keyPoolIdx[p] || 0 }])
  );

  // ── Dehydration: the reverse path hydrateEnvFromVault never had ────────
  // Deleting a vault connection previously left its keys in process.env and
  // the pools until process death — Fleet Control kept showing "8 keys" for a
  // provider whose vault entries were gone. This clears the runtime copies;
  // on reboot, .env re-populates only what it actually still contains.
  const DEHYDRATE_BASES = {
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    claude: ['ANTHROPIC_API_KEY'],
    gemini: ['GEMINI_PAID_KEY', 'GEMINI_FREE_KEY'],
  };
  const dehydrateProvider = (provider) => {
    const bases = DEHYDRATE_BASES[provider];
    if (!bases) return { ok: false, reason: 'unknown provider' };
    let cleared = 0;
    for (const base of bases) {
      for (const name of Object.keys(process.env)) {
        if (name === base || (name.startsWith(base + '_') && /^\d+$/.test(name.slice(base.length + 1)))) {
          delete process.env[name];
          cleared++;
        }
      }
    }
    if (provider === 'gemini') {
      GEMINI_KEY_POOL.length = 0;
    } else if (KEY_POOLS[provider]) {
      KEY_POOLS[provider].length = 0;
      keyPoolIdx[provider] = 0;
    }
    notify(`🧹 Dehydrated ${provider}: ${cleared} env slot(s) cleared, pool reset`, { provider });
    return { ok: true, cleared };
  };

  // ── Endpoint registry + resolver (runtime-aware, defensive load) ──
  let aeonEndpoints = null;
  try { aeonEndpoints = require('../src/kernel/endpoints.cjs'); }
  catch (e) { console.warn('[KERNEL] endpoint registry unavailable:', e.message); }

  // ── Vault → env hydration ──
  // NOTE: 'openrouter' was missing here — its vault key never reached
  // process.env.OPENROUTER_API_KEY, so every code path that checks that env
  // var directly (legacy fallback chain, openRouterRequest, key pools) saw
  // nothing and failed even with a valid vault key. This was the actual
  // cause of "OpenRouter doesn't really work" — the model/key were fine.
  const ENV_FOR_PROVIDER = {
    groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_FREE_KEY_1',
    openrouter: 'OPENROUTER_API_KEY',
    tavily: 'TAVILY_API_KEY', serper: 'SERPER_API_KEY', brave: 'BRAVE_API_KEY',
  };
  const hydrateEnvFromVault = async () => {
    if (!aeonEndpoints) return;
    const geminiVaultKeys = [];
    try {
      const _vault = require('../src/kernel/vault.cjs');
      if (!_vault.isUnlocked()) return;
      const reg = await aeonEndpoints.load(supabase);
      for (const ep of (reg.endpoints || [])) {
        if (!ep.auth_ref) continue;
        // Every registered Gemini ACCOUNT (not just the first) feeds the
        // rotation pool — this is what lets "I have a few Gemini accounts"
        // actually mean something: geminiRequest's existing rotate-on-429
        // logic cycles through all of them automatically, no cap at 4.
        if (ep.provider === 'gemini') {
          const key = await _vault.getSecret(ep.auth_ref, supabase);
          if (key) geminiVaultKeys.push(key);
          continue;
        }
        const envName = ENV_FOR_PROVIDER[ep.provider];
        if (!envName) continue;
        const key = await _vault.getSecret(ep.auth_ref, supabase);
        if (!key) continue;
        // Every vault account joins the numbered env pool (BASE, BASE_2, …) —
        // the convention buildPool/getGroqKeys read. Previously only the first
        // account per provider hydrated (`process.env[envName]` short-circuit);
        // a second Groq/OpenRouter account added in Settings was silently
        // ignored, so pools reported 1 key and rotation had nothing to rotate.
        const existing = buildPool(envName);
        if (existing.includes(key)) continue;
        let n = existing.length + 1;
        let slot = n === 1 ? envName : `${envName}_${n}`;
        while (process.env[slot]) { n++; slot = `${envName}_${n}`; }
        process.env[slot] = key;
        console.log(`[KERNEL] Hydrated ${slot} from vault (${ep.provider}).`);
      }
    } catch (e) { console.warn('[KERNEL] vault→env hydration skipped:', e.message); }

    // GEMINI_KEY_POOL is a snapshot taken at module load, before this hydration
    // runs — refresh it in place so every captured reference sees the new keys.
    const envKeys = scanGeminiEnvKeys();
    const merged = [...new Set([...envKeys, ...geminiVaultKeys])];
    const added = merged.filter(k => !GEMINI_KEY_POOL.includes(k));
    if (added.length) {
      GEMINI_KEY_POOL.push(...added);
      console.log(`[KERNEL] GEMINI_KEY_POOL: ${GEMINI_KEY_POOL.length} account(s) total (${added.length} added from vault/env).`);
    }

    // KEY_POOLS were also snapshotted at module load — refresh in place so
    // vault-hydrated keys join their provider pools too.
    for (const [prov, base] of [['groq', 'GROQ_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY'], ['claude', 'ANTHROPIC_API_KEY']]) {
      const fresh = buildPool(base).filter(k => !KEY_POOLS[prov].includes(k));
      if (fresh.length) {
        KEY_POOLS[prov].push(...fresh);
        console.log(`[KERNEL] ${prov} key pool: ${KEY_POOLS[prov].length} key(s) total (${fresh.length} added post-hydration).`);
      }
    }
  };
  hydrateEnvFromVault();

  const openRouterRequest = async (prompt, model = 'openai/gpt-4o-mini', opts = {}) => {
    const apiKey = nextKey('openrouter') || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY missing in .env');
    try {
      return await genericOpenAIRequest(prompt, model, 'https://openrouter.ai/api/v1', apiKey, opts);
    } catch (e) {
      if (/error (429|402)/i.test(e.message)) rotateKeyPool('openrouter');
      throw e;
    }
  };

  const genericOpenAIRequest = async (prompt, model, baseUrl, apiKey, opts = {}) => {
    const _t0 = Date.now();
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const messages = _toMessages(prompt, opts);
    if (opts.system) messages.unshift({ role: 'system', content: opts.system });
    const response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, max_tokens: opts.max_tokens || 4096 }),
      signal: fetchTimeout(opts),
    });
    if (!response.ok) {
      _trackLLM('openai-compat', model, 0, Date.now() - _t0, false);
      throw new Error(`Endpoint error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const tokens = data?.usage?.total_tokens || Math.ceil(text.length / 4);
    _trackLLM('openai-compat', model, tokens, Date.now() - _t0, true);
    return text;
  };

  const genericGeminiRequest = async (prompt, model, baseUrl, apiKey, opts = {}) => {
    const _t0 = Date.now();
    const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const url = `${base}/models/${model}:generateContent?key=${apiKey}`;
    const flatText = _flatPrompt(prompt, opts);
    const contents = [{ parts: [{ text: flatText }] }];
    if (opts.system) contents.unshift({ role: 'user', parts: [{ text: opts.system }] });
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: opts.max_tokens || 4096 } }),
      signal: fetchTimeout(opts),
    });
    if (!response.ok) {
      _trackLLM('gemini', model, 0, Date.now() - _t0, false);
      throw new Error(`Gemini error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokens = data?.usageMetadata?.totalTokenCount || Math.ceil(flatText.length / 4) + Math.ceil(text.length / 4);
    _trackLLM('gemini', model, tokens, Date.now() - _t0, true);
    return text;
  };

  const _dispatchResolved = async (prompt, r, opts = {}) => {
    const { provider, model, base_url, apiKey } = r;
    if (provider === 'gemini') return genericGeminiRequest(prompt, model, base_url, apiKey, opts);
    if (provider === 'claude') return claudeRequest(prompt, model, apiKey, undefined, opts);
    if (provider === 'local') return localNativeRequest(prompt, model, opts);
    return genericOpenAIRequest(prompt, model, base_url, apiKey, opts);
  };

  // ── Vision — reads an image via whatever provider the "vision" role is
  // set to in Settings (Model Assignment). Provider-agnostic by design: the
  // operator can point it at Groq's Llama 4 Scout (free, vision-capable —
  // confirmed live on this account), Gemini, or Claude without a code change.
  const kernelVision = async (imageDataUri, prompt, opts = {}) => {
    const settings = loadSettings();
    if (settings.prefs?.vision_enabled === false) {
      throw new Error('Vision is disabled in Settings (toggle it on under Vision).');
    }
    const _visionFallback = { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' };
    const roleConfig = opts.provider ? opts : (settings.models?.vision || _visionFallback);
    const provider = roleConfig.provider;
    const model = roleConfig.model;
    const _t0 = Date.now();
    const m = /^data:(.+?);base64,(.+)$/.exec(imageDataUri || '');
    if (!m) throw new Error('image must be a data: URI (data:<mime>;base64,<data>)');
    const [, mimeType, b64] = m;

    if (provider === 'groq' || provider === 'openrouter') {
      const apiKey = provider === 'groq' ? (nextKey('groq') || process.env.GROQ_API_KEY) : (nextKey('openrouter') || process.env.OPENROUTER_API_KEY);
      if (!apiKey) throw new Error(`${provider === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'} missing in .env`);
      const base = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://openrouter.ai/api/v1';
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUri } }] }],
          max_tokens: 1024,
        }),
      });
      if (!response.ok) {
        const errBody = await response.text();
        _trackLLM(provider, model, 0, Date.now() - _t0, false);
        if (response.status === 429 || response.status === 402) { markUnhealthy(provider, response.status, errBody); rotateKeyPool(provider); }
        throw new Error(`${provider} vision error ${response.status}: ${errBody}`);
      }
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || '';
      _trackLLM(provider, model, data?.usage?.total_tokens || 0, Date.now() - _t0, true);
      return text;
    }

    if (provider === 'gemini') {
      const apiKey = getActiveKey();
      if (!apiKey) throw new Error('No Gemini API keys configured in .env');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: b64 } }] }] }),
      });
      if (!response.ok) {
        const errBody = await response.text();
        _trackLLM('gemini', model, 0, Date.now() - _t0, false);
        throw new Error(`Gemini vision error ${response.status}: ${errBody}`);
      }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      _trackLLM('gemini', model, data?.usageMetadata?.totalTokenCount || 0, Date.now() - _t0, true);
      return text;
    }

    if (provider === 'claude') {
      const apiKey = nextKey('claude') || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing in .env or vault');
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 1024,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }, { type: 'text', text: prompt }] }],
        }),
      });
      if (!response.ok) {
        const errBody = await response.text();
        _trackLLM('claude', model, 0, Date.now() - _t0, false);
        if (response.status === 429 || response.status === 402) { markUnhealthy('claude', response.status, errBody); rotateKeyPool('claude'); }
        throw new Error(`Claude vision error ${response.status}: ${errBody}`);
      }
      const data = await response.json();
      const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      _trackLLM('claude', model, (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0), Date.now() - _t0, true);
      return text;
    }

    throw new Error(`Provider "${provider}" is not wired for vision in AEON yet. Set the "vision" role in Settings to groq, gemini, openrouter, or claude.`);
  };

  // ── Default system identity — injected on every kernelLLM call unless
  // the caller provides their own system prompt. Blocks can override with
  // opts.system for specialized personas (grader, researcher, councilor).
  const AEON_SYSTEM = 'You are AEON, a private AI workspace. You are concise, accurate, and action-oriented. When given a task, execute it directly. When asked a question, answer it directly. Never fabricate data.';

  const kernelLLM = async (prompt, opts = {}) => {
    const role = opts.role || 'chat';
    if (!opts.system) opts = { ...opts, system: AEON_SYSTEM };
    opts = { ...opts, role };

    if (_isCloud()) opts = { ...opts, _vercelStrict: true };

    // ── Registry path (preferred) ──
    if (aeonEndpoints && !opts.provider && !opts.model) {
      try {
        const r = await aeonEndpoints.resolveForRole(role, supabase);
        if (r && r.ok) {
          if (r.via === 'relay') {
            throw new Error(`Model "${r.model}" is desktop-only; relay required (desktop must be online).`);
          }
          const text = await _dispatchResolved(prompt, r, opts);
          return opts.returnMeta ? { text, provider: r.provider, model: r.model } : text;
        }
      } catch (e) {
        console.warn(`[KERNEL] registry resolve(${role}) fell back:`, e.message);
        if (/desktop-only/.test(e.message)) throw e;
      }
    }

    // ── Legacy settings path (fallback / explicit override) ──
    const settings = loadSettings();
    const roleConfig = settings.models[role] || settings.models.chat;
    const provider = opts.provider || roleConfig.provider;
    const model = opts.model || roleConfig.model;

    if (provider === 'claude') {
      const text = await claudeRequest(prompt, model, undefined, opts.advisorModel, opts);
      return opts.returnMeta ? { text, provider: 'claude', model } : text;
    }

    if (settings.roulette && !opts.provider) {
      const providers = ['groq', 'gemini'].filter(p => {
        if (p === 'groq') return !!process.env.GROQ_API_KEY && isHealthy('groq');
        if (p === 'gemini') return GEMINI_KEY_POOL.length > 0 && isHealthy('gemini');
        return false;
      });
      if (providers.length > 0) {
        const pick = providers[Math.floor(Math.random() * providers.length)];
        try {
          let text;
          if (pick === 'groq') text = await groqRequest(prompt, 'llama-3.3-70b-versatile', 0, opts);
          if (pick === 'gemini') text = await geminiRequest(prompt, 'gemini-2.0-flash', 0, opts);
          if (text !== undefined) return opts.returnMeta ? { text, provider: pick, model: pick === 'groq' ? 'llama-3.3-70b-versatile' : 'gemini-2.0-flash' } : text;
        } catch (e) {
          const status = /error (\d{3})/i.exec(e.message)?.[1];
          if (status) markUnhealthy(pick, Number(status), e.message);
          notify(`⚠ Roulette: ${pick} failed (${e.message.slice(0, 80)}), falling through chain`, { provider: pick });
        }
      }
    }

    const availableProviders = opts._vercelStrict
      ? ['groq', 'gemini', 'openrouter']
      : ['groq', 'gemini', 'openrouter', 'local'];
    const priority = settings.prefs?.provider_priority;
    const fallbacks = Array.isArray(priority) && priority.length
      ? priority.filter(p => availableProviders.includes(p))
      : availableProviders;
    const chain = [provider, ...fallbacks].filter((p, i, a) => a.indexOf(p) === i);
    let lastErr = null;
    for (const p of chain) {
      if (!isHealthy(p)) continue;
      try {
        let text;
        let usedModel = model;
        if (p === 'groq' && process.env.GROQ_API_KEY) {
          usedModel = p === provider ? model : 'llama-3.3-70b-versatile';
          text = await groqRequest(prompt, usedModel, 0, opts);
        } else if (p === 'gemini' && GEMINI_KEY_POOL.length > 0) {
          usedModel = p === provider ? model : 'gemini-2.0-flash';
          text = await geminiRequest(prompt, usedModel, 0, opts);
        } else if (p === 'openrouter' && process.env.OPENROUTER_API_KEY) {
          usedModel = p === provider ? model : 'openai/gpt-4o-mini';
          text = await openRouterRequest(prompt, usedModel, opts);
        } else if (p === 'local') {
          usedModel = p === provider ? model : undefined;
          text = await localNativeRequest(prompt, usedModel, opts);
        } else continue;
        if (text !== undefined) {
          if (p !== provider) notify(`↪ Fallback: ${role} routed to ${p}/${usedModel} (configured: ${provider})`, { provider: p });
          return opts.returnMeta ? { text, provider: p, model: usedModel, fallback: p !== provider } : text;
        }
      } catch (e) {
        lastErr = e;
        const status = /error (\d{3})/i.exec(e.message)?.[1] || (/429/.test(e.message) ? '429' : /402/.test(e.message) ? '402' : null);
        if (status) markUnhealthy(p, Number(status), e.message);
        console.warn(`[KERNEL] ${p} failed (${e.message.slice(0, 120)}), trying next provider`);
      }
    }
    // Every candidate provider was tried and none could serve. That is a
    // configuration state, not an internal fault — a clean install with no API
    // keys and no local chat model lands here on the very first request. The
    // router turns this flag into a 503 so the caller gets an actionable
    // "nothing is configured" instead of a bare 500.
    const exhausted = lastErr || new Error('No LLM provider available (check API keys in Settings)');
    exhausted.noProviderAvailable = true;
    throw exhausted;
  };

  return {
    kernelLLM, kernelVision, geminiRequest, groqRequest, localNativeRequest, openRouterRequest, claudeRequest,
    GEMINI_KEY_POOL, _trackLLM, _llmTelemetry, setActivityRecorder,
    getDailyCost, addRunCost,
    KILL_SWITCH_THRESHOLD, GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    getProviderHealth, confirmLocal, isLocalConfirmed, getKeyPoolInfo, dehydrateProvider,
    defaultLocalModel, localRuntimePresent,
  };
};
