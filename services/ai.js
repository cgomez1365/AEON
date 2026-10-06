/**
 * AEON Jarvis — AI Service (kernelLLM)
 * Multi-provider LLM layer: Gemini key-pool failover, Groq, local (llama.cpp),
 * OpenAI-compatible registry endpoints, vault→env hydration, token
 * governor, and live telemetry. All blocks call kernelLLM(prompt, {role}).
 */
const fs = require('fs');
const path = require('path');
const { isCloud: _isCloud } = require('../src/kernel/runtime.cjs');
const _capabilities = require('../src/kernel/capabilities.cjs');
// Asks a cloud provider how big a model's window really is, so the memory
// budget is a fraction of that and not of a guessed 8k. Requiring it creates
// nothing on disk (this file loads at boot); its cache is written on first use.
const _modelContext = require('../src/kernel/modelContext.cjs');
// The one token estimator (D1f), for sizing a trimmed retry.
const _tokens = require('../src/kernel/tokens.cjs');

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

  // Keys must never reach a log line, an error message or an audit entry.
  // A provider's own error body frequently quotes the request back.
  const _redactKeys = (s) => String(s || '')
    .replace(/\b(sk-|gsk_|xai-|nvapi-|AIza|or-v1-)[A-Za-z0-9_\-]{8,}/g, '$1***')
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s]+/gi, '$1***');

  // ── Per-endpoint pacing ──────────────────────────────────────────────────
  // Free OpenAI-compatible tiers commonly cap near 40 requests/minute, and one
  // multi-step agent task can spend that inside a single run. Pacing locally is
  // cheaper than discovering the cap as a 429 halfway through.
  //
  // This sits at the TRANSPORT seam rather than the resolver, because the paths
  // that actually burst — Council fans out ~8 concurrent calls — pass a provider
  // and model directly and never touch resolveForRole. Keyed by address so two
  // custom endpoints get independent budgets instead of poisoning each other.
  //
  // BO-EMB: the bucket itself now lives in src/kernel/pacing.cjs, because
  // embedding an entire Vault bursts against the same addresses chat uses. Two
  // buckets would each grant the full quota and the endpoint would answer with
  // the 429 this exists to prevent.
  const { pace: _pace, paceKey: _paceKey } = require('../src/kernel/pacing.cjs');

  // The operator's own requests-per-minute limit (Settings → Keys), applied at
  // every transport. When it makes AEON wait, the operator is told in one line
  // — through opts.onNotice (the chat stream turns it into a notice) and the
  // system log — instead of a silent pause. When pace() gives up, the error is
  // reworded from its structured fields to say whose limit it is and where to
  // change it: that is the operator's setting, not a provider outage.
  const _paceNoticeAt = {};
  const _paceFor = async (opts, key, label) => {
    if (!opts.rpm_limit || opts.rpm_limit <= 0) return;
    try {
      await _pace(key, opts.rpm_limit, {
        signal: opts.signal,
        onWait: ({ waitMs, rpm }) => {
          // A burst (Council, parallel agent tools) would print one line per call.
          const since = Date.now() - (_paceNoticeAt[key] || 0);
          if (since >= 0 && since < 10_000) return;
          _paceNoticeAt[key] = Date.now();
          const message = `pacing: waiting ${Math.ceil(waitMs / 1000)}s for ${label} (your limit: ${rpm}/min — change it in Settings → Keys)`;
          console.warn(`[KERNEL] ${message}`);
          notify(message, { provider: label });
          try { opts.onNotice?.(message); } catch { /* a notice never breaks the call */ }
        },
      });
    } catch (e) {
      if (e && e.localThrottle) {
        e.provider = label;
        e.message = `${label} is at your limit of ${e.rpm} requests/min and the next free slot is ${Math.ceil(e.waitMs / 1000)}s away. AEON stopped waiting. Raise or clear the limit in Settings → Keys.`;
      }
      throw e;
    }
  };
  // One reading of Retry-After, shared with the credential pool that acts on it.
  const { parseRetryAfter: _parseRetryAfter } = require('../src/kernel/keyPool.cjs');

  // ── Provider health tracker ──────────────────────────────────────────────
  // Every 429/402 marks the provider "in cooldown" for a computed duration so
  // the fallback chain skips it instead of wasting a request finding out
  // again. Parses the provider's own retry-after hints when present.
  const providerHealth = {}; // { groq: {blockedUntil, reason}, gemini: {...}, ... }

  const isHealthy = (p) => Date.now() > (providerHealth[p]?.blockedUntil || 0);

  // A request bigger than the model (or its free tier) will take: HTTP 413,
  // llama.cpp/LM Studio "exceeds the available context size", the local
  // budget engine's "The prompt uses N of a M-token window", Groq's per-minute
  // "Request too large", OpenAI's "maximum context length", Anthropic's
  // "prompt is too long". It is a fact about the REQUEST, not the provider.
  const _TOO_LARGE_RE = /too large|(?:prompt|input|request) is too long|too long for|exceeds? (?:the )?(?:available |maximum )?context|context (?:length|size|window)|maximum context|context_length_exceeded|exceed_context_size|maximum number of tokens|token limit|-token window/i;
  const _isTooLarge = (e, status = _failureStatus(e)) => {
    if ([401, 402, 403, 404, 429].includes(status)) return false;
    const msg = String(e?.message || '');
    // A model that never started or stalled quotes llama-server's log tail,
    // which talks about context sizes; that is not a request too large.
    if (e?.code === 'MODEL_STALLED' || /llama-server (?:exited|did not become ready)|could not start llama-server/i.test(msg)) return false;
    return status === 413 || e?.code === 'CONTEXT_EXHAUSTED' || _TOO_LARGE_RE.test(msg);
  };

  // gpt-oss is trained on native (harmony) tool calls and writes one after
  // reading the ## TOOLS section, though no request AEON sends offers tools
  // (agents use the text aeon-tool protocol). Groq refuses that, mid-stream
  // under a 200 or as a 400: "Tool choice is none, but model called a tool"
  // (the CEO's drive, 2026-10-05). It is the model's FORMAT on this request,
  // not the provider failing: the same model is asked once more, told not to.
  const _NATIVE_TOOL_RE = /tool choice is none|model called a tool|tool_use_failed/i;
  const _isNativeToolRefusal = (e) => _NATIVE_TOOL_RE.test(String(e?.message || ''));
  const NO_NATIVE_TOOLS_NOTE = 'Function calling is not available in this chat: never emit a tool or function call. Reply in plain text only; an AEON tool is used by writing its aeon-tool block as text, when one is described above.';
  const _withNoNativeTools = (messages) => {
    const list = Array.isArray(messages) ? messages : [];
    const at = list.findIndex((m) => m?.role === 'system' && typeof m.content === 'string');
    if (at !== -1 && list[at].content.includes(NO_NATIVE_TOOLS_NOTE)) return list;
    if (at === -1) return [{ role: 'system', content: NO_NATIVE_TOOLS_NOTE }, ...list];
    return list.map((m, i) => (i === at ? { ...m, content: `${m.content}\n\n${NO_NATIVE_TOOLS_NOTE}` } : m));
  };
  const _nativeToolNotice = (p) => `${p} tried a native tool call → asked again in plain text`;

  // What the operator reads when a provider steps aside: a phrase, never the
  // provider's raw error body. The raw text stays in the server log.
  //
  // A status is read before any body text: Groq's 413 body links its billing
  // page and a Gemini 429 body mentions billing, and neither is out of credits.
  const _plainReason = (e) => {
    // The operator's own requests-per-minute limit, not anything the provider did.
    if (typeof e !== 'number' && e?.localThrottle) return `at your limit of ${e.rpm} requests/min (Settings → Keys)`;
    const status = typeof e === 'number' ? e : _failureStatus(e);
    const msg = typeof e === 'number' ? '' : String(e?.message || '');
    if (status === 402) return 'out of credits';
    // Gemini rejects a bad key with 400 + API_KEY_INVALID, not 401/403 (A041).
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg)) return 'key rejected';
    if (status === 401 || status === 403) return 'key rejected';
    if (status === 429) return 'rate-limited';
    if (typeof e !== 'number' && _isTooLarge(e, status)) return 'request too large for it';
    if (status === 413) return 'request too large for it';
    if (_isNativeToolRefusal({ message: msg })) return 'tried a native tool call';
    if (/credit|insufficient.?(funds|balance)|billing/i.test(msg)) return 'out of credits';
    if (/rate.?limit|quota/i.test(msg)) return 'rate-limited';
    if (status === 404) return 'model not available';
    // This computer's runtime says what actually happened. Every one of these
    // read "unavailable" (2026-09-30: the local rung's real error matched no
    // pattern), which names no cause and no remedy.
    if (e?.localRuntime || /llama-server|No local (?:AI engine|chat model|model) (?:is )?installed/i.test(msg)) {
      if (/No local AI engine installed/i.test(msg)) return 'no local engine installed';
      if (/No local (?:chat model|model) (?:is )?installed|^Model ".*" is not ready$/i.test(msg)) return 'no chat model installed';
      if (e?.code === 'MODEL_STALLED' || /stopped producing output/i.test(msg)) return 'stopped responding';
      if (/queue full/i.test(msg)) return 'busy with another request';
      if (/llama-server (?:exited|did not become ready|not found)|could not start llama-server|model file not found|ECONNRE|fetch failed/i.test(msg)) return 'no chat model running';
    }
    if (status >= 500) return 'provider error';
    if (/timeout|timed out|ETIMEDOUT|ECONNRE|ENOTFOUND|fetch failed|network/i.test(msg)) return 'unreachable';
    if (/failures in a row/.test(msg)) return 'failing repeatedly';
    return 'unavailable';
  };

  const markUnhealthy = (p, status, message = '') => {
    // No credits does not fix itself in a minute; rest it long enough that
    // the next turns go straight to a provider that can answer.
    let ms = status === 402 ? 30 * 60 * 1000 : 60 * 1000;
    const retrySec = /try again in ([\d.]+)s/i.exec(message)?.[1];
    if (retrySec) ms = Math.ceil(parseFloat(retrySec) * 1000) + 2000;
    const plain = _plainReason(status || { message });
    providerHealth[p] = { blockedUntil: Date.now() + ms, reason: message.slice(0, 160), plain };
    console.warn(`[KERNEL] ${p} resting ${Math.round(ms / 1000)}s: ${message.slice(0, 160)}`);
    notify(`⏸ ${p} ${plain} — resting ${Math.round(ms / 60000) || 1} min`, { provider: p });
  };

  // A provider that fails WITHOUT a 429/402 (an empty body, a budget spent
  // thinking, a timeout) never tripped the cooldown, so every turn tried it
  // first again: the 2026-09-23 call log shows one free model failing 11
  // times in a row. Three consecutive failures before any answer rest it the
  // way a 429 does; one success clears the count.
  const FAIL_STREAK_LIMIT = 3;
  const _failStreak = {};
  // A local model that is not installed is the ROLE's configuration, not
  // Local failing. settings.default.json ships one for four roles; three such
  // calls rested Local for every role — those whose model works included. The
  // error still reaches the caller (and readiness reports it); it is not
  // counted toward the streak.
  const _roleConfigFault = (p, e) => p === 'local' && /^Model ".*" is not ready$/.test(String(e?.message || ''));
  const noteProviderFailure = (p, e) => {
    if (_roleConfigFault(p, e)) return;
    // The operator's own limit made AEON stop waiting. The provider did nothing
    // wrong, so it is not counted toward the streak that rests it.
    if (e?.localThrottle) return;
    const n = (_failStreak[p] || 0) + 1;
    _failStreak[p] = n;
    if (n >= FAIL_STREAK_LIMIT) {
      _failStreak[p] = 0;
      markUnhealthy(p, 0, `${n} failures in a row (last: ${String(e?.message || 'unknown').slice(0, 100)})`);
    }
  };
  const noteProviderSuccess = (p) => { _failStreak[p] = 0; };
  // The chain's reading of a failure's status: the structured field, the
  // "error NNN" text, then a bare 429/402 (kept from the inline version it
  // replaces). Narrower _statusOf below feeds key rotation and stays as it is.
  const _failureStatus = (e) => e?.status
    || Number(/error (\d{3})/i.exec(e?.message || '')?.[1])
    // The runtime's own words quote token counts and llama-server's log tail
    // quotes sizes ("uses 4,402 of a 2,048-token window"): not a status.
    || (e?.localRuntime ? null : /429/.test(e?.message || '') ? 429 : /402/.test(e?.message || '') ? 402 : null);
  // Any other configured provider that could take a turn right now. Under
  // Local only (Settings → Models) the cloud ones cannot.
  const _anotherCanServe = (p, localOnly = false) => (localOnly ? ['local'] : ['groq', 'gemini', 'openrouter', 'local'])
    .some((q) => q !== p && isConfigured(q) && isHealthy(q));

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
    // A custom or registry provider was invisible here until it first failed —
    // a working custom endpoint read as "no provider configured" (agent C3,
    // 2026-09-23). Every provider the endpoint registry holds is listed.
    let registered = [];
    try { registered = aeonEndpoints?.configuredProviders?.() || []; } catch { /* registry unreadable */ }
    for (const p of new Set([...registered, ...Object.keys(providerHealth)])) {
      if (!out[p]) out[p] = { healthy: isHealthy(p), configured: registered.includes(p), ...(providerHealth[p] || {}) };
    }
    // Paid models resting is not the provider resting: its free models serve.
    for (const p of Object.keys(paidRest)) {
      if (out[p] && _paidResting(p)) Object.assign(out[p], { paidResting: true, paidPlain: paidRest[p].plain, paidBlockedUntil: paidRest[p].blockedUntil });
    }
    return out;
  };
  // Tests only: forget every cooldown and failure count.
  const _resetProviderHealth = () => {
    for (const k of Object.keys(providerHealth)) delete providerHealth[k];
    for (const k of Object.keys(_failStreak)) delete _failStreak[k];
    for (const k of Object.keys(paidRest)) delete paidRest[k];
    for (const k of Object.keys(_paceNoticeAt)) delete _paceNoticeAt[k];
  };

  // ── OpenRouter: paid out of credits is not OpenRouter down ─────────────
  // An account with no credits still serves every ':free' model, but a 402 on
  // a paid model benched the whole provider for 30 minutes, so the turn fell
  // to Groq and Local and failed there (2026-09-30, the CEO's drive: a 402 on
  // anthropic/claude-opus-4.6, "can only afford 4" tokens, one turn after a
  // ':free' model had answered). Only the PAID models rest now, and the same
  // connection is asked on a free model before any other provider.
  const PAID_REST_MS = 30 * 60 * 1000;
  const paidRest = {}; // { openrouter: { blockedUntil, model, reason, plain } }
  const _isFreeOpenRouterModel = (m) => m === 'openrouter/free' || /:free$/.test(String(m || ''));
  // OpenRouter reserves max_tokens against the credit balance even for a free
  // model: a 4096 reservation 402s on an account with minimal credits
  // (c79b974). Only the env-key rung and the stream capped it, so a registry
  // connection's paid→free hand-off on the blocking path asked openrouter/free
  // for 4096, was refused, and benched all of OpenRouter for 30 minutes — the
  // next chat turn skipped it. Every transport that can reach OpenRouter caps
  // a free model's reservation here.
  const OPENROUTER_FREE_MAX_TOKENS = 1024;
  const _reachesOpenRouter = (provider, baseUrl) => provider === 'openrouter'
    || /^https?:\/\/(?:[a-z0-9-]+\.)*openrouter\.ai(?:[:/]|$)/i.test(String(baseUrl || ''));
  const _maxTokensFor = (provider, baseUrl, model, requested) => (
    _reachesOpenRouter(provider, baseUrl) && _isFreeOpenRouterModel(model)
      ? Math.min(requested || OPENROUTER_FREE_MAX_TOKENS, OPENROUTER_FREE_MAX_TOKENS)
      : (requested || 4096));
  const _paidResting = (p) => Date.now() < (paidRest[p]?.blockedUntil || 0);
  const _paidOutOfCredits = (c, status) => c?.provider === 'openrouter' && status === 402
    && !!c.model && !_isFreeOpenRouterModel(c.model);
  const _paidNotice = (model) => `openrouter (${model}) out of credits → openrouter free model`;
  const _restPaid = (p, model, message = '') => {
    paidRest[p] = { blockedUntil: Date.now() + PAID_REST_MS, model, reason: _redactKeys(message).slice(0, 160), plain: 'out of credits' };
    console.warn(`[KERNEL] ${p} paid models resting ${PAID_REST_MS / 1000}s (${model}): ${_redactKeys(message).slice(0, 160)}`);
    notify(`⏸ ${p} paid models out of credits — resting ${PAID_REST_MS / 60000} min; its free models still serve`, { provider: p });
  };
  // The model's own ':free' twin when the connection lists it, else
  // OpenRouter's free router. A variant suffix (":nitro") is not part of the name.
  const _freeModelFor = async (c) => {
    const twin = `${String(c?.model || '').replace(/:[a-z0-9_-]+$/i, '')}:free`;
    const id = c?.endpoint_id || c?.resolved?.endpoint_id;
    let listed = [];
    if (id && aeonEndpoints?.load) {
      try { listed = (await aeonEndpoints.load(supabase)).endpoints.find((e) => e.id === id)?.models || []; } catch { /* registry unreadable */ }
    }
    return Array.isArray(listed) && listed.includes(twin) ? twin : 'openrouter/free';
  };
  // While paid rests, a candidate declared on a paid OpenRouter model starts on
  // the free one. Mutated in place: the caller's `primary` is this object.
  const _applyPaidRest = async (c) => {
    if (!c || c.provider !== 'openrouter' || !c.model || _isFreeOpenRouterModel(c.model) || !_paidResting('openrouter')) return false;
    const free = await _freeModelFor(c);
    c.paidFrom = c.model;
    c.model = free;
    if (c.resolved) c.resolved = { ...c.resolved, model: free };
    return true;
  };

  // ── Too large: one retry with less context ─────────────────────────────
  // The chat turn is sized for the DECLARED model's window — 68 memories for a
  // model serving hundreds of thousands of tokens — and when that model cannot
  // answer, every fallback rung received the same ~11,000 tokens: Groq's free
  // tier answers 413 on its per-minute cap, a local 8k window cannot hold it.
  // The same candidate is asked once more with the system prompt's head, the
  // newest turns that fit, and the operator's message intact, before the chain
  // moves on.
  const TRIMMED_RETRY_TOKENS = 6000;
  const TRIM_NOTE = '[Context trimmed: the full request was too large for this model, so stored memories and older turns were left out of this reply.]';
  const _systemHead = (s) => {
    const str = String(s || '');
    // The identity and formatting rules come first; memory, skills and rules
    // follow under markdown headings (src/kernel/context.cjs).
    const cut = str.search(/\n#{1,3} /);
    return (cut > 0 && cut <= 4000 ? str.slice(0, cut) : str.slice(0, 2000)).trimEnd();
  };
  const _trimMessages = (messages, budget) => {
    const list = Array.isArray(messages) ? messages : [];
    let lastUser = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.role === 'user') { lastUser = i; break; }
    if (lastUser === -1) return null;
    const head = _systemHead(list.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'));
    const system = { role: 'system', content: head ? `${head}\n\n${TRIM_NOTE}` : TRIM_NOTE };
    const last = list[lastUser];
    const older = list.slice(0, lastUser).filter((m) => m.role !== 'system');
    let room = budget - _tokens.estimateMessageTokens([system, last]);
    const kept = [];
    for (let i = older.length - 1; i >= 0; i--) {
      const cost = _tokens.estimateMessageTokens([older[i]]);
      if (cost > room) break;
      kept.unshift(older[i]);
      room -= cost;
    }
    const out = [system, ...kept, last, ...list.slice(lastUser + 1)];
    const before = _tokens.estimateMessageTokens(list);
    const after = _tokens.estimateMessageTokens(out);
    // Nothing to cut (a short system prompt, no older turns): a retry would
    // send the same request again.
    if (after >= before) return null;
    return { messages: out, before, after, droppedTurns: older.length - kept.length };
  };
  // How small the retry must be. A per-minute cap the provider names
  // ("Limit 8000") bounds the prompt AND the answer it reserves; a local
  // window bounds what llama-server can hold.
  const _trimBudget = async (c, e, opts = {}) => {
    if (c.provider === 'local') {
      let ctx = null;
      try { ctx = (await _getLocalRT()?.plannedContext?.(c.model))?.contextTokens || null; } catch { /* unknown window */ }
      return { promptTokens: Math.min(TRIMMED_RETRY_TOKENS, ctx ? Math.floor(ctx * 0.6) : TRIMMED_RETRY_TOKENS), maxTokens: opts.max_tokens };
    }
    const limit = Number(/\bLimit:?\s*(\d{3,})/i.exec(String(e?.message || ''))?.[1]) || null;
    const maxTokens = Math.min(opts.max_tokens || 4096, limit ? Math.max(256, Math.floor(limit * 0.25)) : 2048);
    const promptTokens = limit
      ? Math.max(1000, Math.min(TRIMMED_RETRY_TOKENS, limit - maxTokens - 500))
      : TRIMMED_RETRY_TOKENS;
    return { promptTokens, maxTokens };
  };
  const _tooLargeNotice = (p) => `${p} request too large for it → retried with less context`;
  // The local window is exact arithmetic (budget.cjs), known without starting
  // the model. A request it cannot hold is refused here, in the runtime's own
  // words, instead of after loading the weights (80 s on the CEO's drive,
  // 2026-10-05) to be told so. Null when it fits or the window is not known:
  // the runtime's own check then decides, as before.
  const _localWindowRefusal = async (c, messages) => {
    try {
      const ctx = (await _getLocalRT()?.plannedContext?.(c.model))?.contextTokens;
      if (!ctx) return null;
      const plan = require('./local-runtime/budget.cjs').outputBudget({ contextTokens: ctx, promptTokens: _tokens.estimateMessageTokens(messages) });
      return plan.fits ? null : Object.assign(new Error(plan.reason), { code: 'CONTEXT_EXHAUSTED', budget: plan });
    } catch { return null; }
  };

  // ── Local-model confirmation gate ──────────────────────────────────────────
  // When every cloud provider is down/exhausted, the INTERACTIVE chat path
  // (terminal / dashboard) does not silently drop to a local model — quality
  // and speed change noticeably, so the operator gets a heads-up and must
  // type /allow-local to open a time-boxed window. Autonomous background
  // missions are exempt (autonomous.cjs has its own always-on local rung —
  // that's the whole point of a mission you can walk away from).
  // BO-H1c — the local-confirmation gate was removed in BO-2. What survived
  // was isLocalConfirmed() hardcoded to true and confirmLocal() returning a
  // fake window: a check that could not fail, feeding a UI that told the
  // operator local models "require /allow-local confirmation". §08 — a claim
  // in the product must be true of the product. Both are gone; local is a
  // first-class provider and the fallback order is prefs.provider_priority.

  // ── Token governor ──
  const KILL_SWITCH_THRESHOLD = 15.00;
  const GEMINI_PRICE_PER_TOKEN = 0.00000015;
  const GROQ_PRICE_PER_TOKEN = 0.00000060;

  // ── BO-D2g: the call ledger ────────────────────────────────────────────
  //
  // Recording used to hang off addRunCost(), a COST calculation called from
  // exactly one route — the legacy non-streaming /api/chat that nothing
  // uses. db/token_ledger.json was therefore never created, and every
  // consumer (heatmap, Activity, Fleet Control, token-analytics, analytics)
  // correctly reported zero while live telemetry showed calls on screen.
  //
  // The ledger now sits beside TOKEN_LEDGER_FILE as per-call JSONL and is
  // written from _trackLLM — the one seam every provider crosses.
  const callLedger = (() => {
    try {
      const { createLedger } = require('../src/kernel/llm-ledger.cjs');
      const dir = path.dirname(TOKEN_LEDGER_FILE);
      return createLedger({ file: path.join(dir, 'llm_calls.jsonl') });
    } catch { return null; }
  })();

  const PRICE_PER_TOKEN = {
    gemini: GEMINI_PRICE_PER_TOKEN,
    groq: GROQ_PRICE_PER_TOKEN,
    // Local inference costs nothing and is most of the traffic. That is a
    // real zero, not a missing price.
    local: 0,
  };

  // Derived, not stored. The old {date, cost} file was one day's total,
  // overwritten — it could not answer a single question its readers asked.
  const getDailyCost = () => {
    if (!callLedger) return 0;
    try { return callLedger.dailyCost({ pricePerToken: PRICE_PER_TOKEN }); }
    catch { return 0; }
  };

  // Kept for the legacy /api/chat caller and any external one. It no longer
  // OWNS the number — it records a call so the same derivation covers it.
  const addRunCost = (cost) => {
    if (callLedger && cost > 0) {
      // A cost with no call behind it still belongs in the history.
      callLedger.record({ provider: 'legacy-cost', model: 'unknown', tokens: 0, latencyMs: 0, success: true, cost });
    }
    return getDailyCost() + (cost || 0);
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
  function _trackLLM(engine, model, tokens, latencyMs, success, info = {}) {
    // Why a call failed rides into the durable record. The ledger used to say
    // only success:false, so a rate limit, an empty body and a retired model
    // were indistinguishable in the 2026-09-23 call log. On one line: a
    // provider's pretty-printed JSON body would spend the cap on indentation.
    const why = success ? {} : {
      status: info.status ?? null,
      error: info.error ? _redactKeys(String(info.error)).replace(/\s+/g, ' ').slice(0, 160) : null,
    };
    // Settings → System → Telemetry. The toggle existed and was read by
    // nothing, so switching it off recorded exactly as much as switching it
    // on. Measurement stops here, at the one place every provider path funnels
    // through, rather than at each call site.
    //
    // The audit line and the cost ledger are NOT measurement and continue
    // regardless: the audit trail is a security record, and the ledger is what
    // stands between the operator and a surprise bill. Turning off performance
    // stats must not quietly turn off spend tracking.
    if (!_capabilities.enabled('telemetry_enabled')) {
      writeOSAudit(`LLM_${engine.toUpperCase()}`, `${model} | ${tokens} tok | ${latencyMs}ms${success ? '' : ` | FAILED${why.error ? `: ${why.error}` : ''}`}`, success ? 200 : (why.status || 500), tokens);
      try { if (callLedger) callLedger.record({ provider: engine, model, tokens, latencyMs, success, ...why }); } catch {}
      return;
    }
    const key = `${engine}/${model}`;
    if (!_llmTelemetry.calls[key]) _llmTelemetry.calls[key] = { engine, model, requests: 0, tokens: 0, errors: 0, avgLatency: 0 };
    const c = _llmTelemetry.calls[key];
    c.requests++;
    c.tokens += tokens;
    if (!success) c.errors++;
    c.avgLatency = Math.round((c.avgLatency * (c.requests - 1) + latencyMs) / c.requests);
    _llmTelemetry.totalCalls++;
    _llmTelemetry.totalTokens += tokens;
    writeOSAudit(`LLM_${engine.toUpperCase()}`, `${model} | ${tokens} tok | ${latencyMs}ms${success ? '' : ` | FAILED${why.error ? `: ${why.error}` : ''}`}`, success ? 200 : (why.status || 500), tokens);
    try { if (_recordActivity) _recordActivity(tokens, model, engine, { success, latencyMs }); } catch {}
    // D2g — the durable record. Everything above this line is in memory and
    // dies on restart, which is why the panels showed live calls and the
    // persistent surfaces showed nothing. Failures included: a day of failed
    // calls must not look like a day nobody worked.
    try { if (callLedger) callLedger.record({ provider: engine, model, tokens, latencyMs, success, ...why }); } catch {}
  }

  // What a failed call records and announces: the status the provider sent (a
  // rejected Gemini key rides the credential pool as 401; Google said 400) and
  // its words. _trackLLM redacts and caps them.
  const _failInfo = (e) => ({ status: e?.httpStatus || _statusOf(e), error: e?.message });
  // The phrase the operator reads, with the status behind it when there is one.
  const _reasonWithStatus = (e) => {
    const s = _failInfo(e).status;
    return s ? `${_plainReason(e)} (HTTP ${s})` : _plainReason(e);
  };

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

  // BO-SHIP P9 — default to the alias, not a version number.
  //
  // This defaulted to 'gemini-flash-latest', which Google has RETIRED: every
  // request answers HTTP 404 "This model is no longer available". The keys
  // authenticate fine — 404, not 401 — so the failure reads as a broken
  // provider rather than a stale model name, and the fallback chain then
  // reports whatever the next provider says.
  //
  // A pinned Gemini version is the opposite trade-off from the llama.cpp
  // converter (P4), and deliberately so. There, pinning prevents executing
  // code nobody reviewed. Here, a pinned version simply ROTS — Google removes
  // it on a schedule — and the alias is the only value that keeps working.
  const geminiRequest = async (prompt, modelName = 'gemini-flash-latest', retries = 0, opts = {}) => {
    if (GEMINI_KEY_POOL.length === 0) throw new Error('No Gemini API keys configured in .env');
    if (retries >= GEMINI_KEY_POOL.length) {
      markUnhealthy('gemini', 429, 'key pool exhausted');
      console.warn('[GEMINI FAILOVER] Gemini key pool exhausted. Falling back to Groq (GPT-OSS 120B)...');
      if (isHealthy('groq')) {
        try { return await groqRequest(prompt, 'openai/gpt-oss-120b', 0, opts); }
        catch (groqErr) { console.warn('[GEMINI FAILOVER] Groq fallback failed:', groqErr.message); }
      }
      console.warn('[GEMINI FAILOVER] Falling back to native local runtime...');
      // Text only, like _dispatchResolved: the caller wraps it. With the
      // caller's returnMeta the local transport answered {text, model}, and the
      // chain returned that object AS the text under provider 'gemini'.
      return await localNativeRequest(prompt, undefined, { ...opts, returnMeta: false });
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
      const cand = data?.candidates?.[0];
      const text = _geminiText(cand);
      // An answer with no text is the model's answer, not the key's fault:
      // recorded and thrown past the rotation below, never '' as success.
      if (text.trim() === '') {
        const noText = _geminiNoText({ finishReason: cand?.finishReason, blockReason: data?.promptFeedback?.blockReason, maxTokens: opts.max_tokens || 4096 });
        _trackLLM('gemini', modelName, 0, Date.now() - _t0, false, { error: noText.message });
        noText.noAnswer = true;
        throw noText;
      }
      const tokens = data?.usageMetadata?.totalTokenCount || Math.ceil(flatText.length / 4) + Math.ceil(text.length / 4);
      _trackLLM('gemini', modelName, tokens, Date.now() - _t0, true);
      return text;
    } catch (err) {
      if (err.noAnswer) throw err;
      _trackLLM('gemini', modelName, 0, Date.now() - _t0, false, _failInfo(err));
      if (retries < GEMINI_KEY_POOL.length - 1) {
        rotateKey(`Error: ${err.message.substring(0, 60)}`);
        return geminiRequest(prompt, modelName, retries + 1, opts);
      }
      return geminiRequest(prompt, modelName, retries + 1, opts);
    }
  };

  const groqRequest = async (prompt, modelName = 'openai/gpt-oss-120b', retries = 0, opts = {}) => {
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
      _trackLLM('groq', modelName, 0, Date.now() - _t0, false, { status: response.status, error: `Groq API error ${response.status}: ${errBody}` });
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
  // F3c — an error with two remedies must name both, cheaper first.
  // This said only "Install the runtime and a model in Cookbook." True, and
  // incomplete: the operator fixed it the other way, by repointing the role
  // at a provider that was already configured and working. That path needs
  // no download and the message never mentioned it, so a first-time user
  // reads this banner and goes to fetch 1.4 GB. AEON already knows which
  // providers are healthy — it just was not using that knowledge when it
  // explained a failure. Shared by the blocking and streaming local paths.
  const _noLocalModelError = () => {
    // Under Local only a configured cloud provider is not a remedy.
    if (_localOnly(_settingsNow())) {
      const err = new Error('Local only is on, and no local model is installed. Install one in Cookbook, or turn Local only off in Settings → Models.');
      err.localOnly = true;
      return err;
    }
    const alive = Object.entries(getProviderHealth())
      .filter(([p, h]) => p !== 'local' && h.configured && h.healthy)
      .map(([p]) => p);
    return new Error(
      alive.length
        ? `No local model is installed. Assign a configured provider (${alive.join(', ')}) in Settings → Model Assignment — that works now and needs no download — or install a local model in Cookbook.`
        : 'No local model is installed and no cloud provider is configured. Install a local model in Cookbook, or add a provider key in Settings → Keys.'
    );
  };

  // A local failure happens inside this process — often before llama-server
  // is asked anything — so it carried no status, left no ledger row, and its
  // words ("The prompt uses 11,230 of a 8,192-token window …") matched no
  // reason: the operator read "local unavailable" (2026-09-30). It is tagged
  // as the local runtime's, given the status llama-server answered when there
  // was one, recorded, and logged whole.
  const _localFailure = (e, model, t0) => {
    const err = e instanceof Error ? e : new Error(String(e));
    err.localRuntime = true;
    if (!err.status) {
      const s = Number(/llama-server returned (\d{3})/.exec(err.message || '')?.[1]);
      if (s) err.status = s;
    }
    _trackLLM('local', model || defaultLocalModel() || 'local', 0, Date.now() - t0, false, { status: err.status || null, error: err.message });
    console.warn(`[KERNEL] local runtime failed${model ? ` (${model})` : ''}: ${_redactKeys(err.message).slice(0, 300)}`);
    return err;
  };
  // Nothing installed is a state, not a failed call: tagged, not recorded.
  const _localMissing = () => Object.assign(_noLocalModelError(), { localRuntime: true });

  const localNativeRequest = async (prompt, modelId, opts = {}) => {
    const lr = _getLocalRT();
    if (!lr || !lr.isAvailable()) throw _localMissing();
    const _t0 = Date.now();
    const flatPrompt = typeof prompt === 'string' ? prompt : (Array.isArray(prompt) ? prompt.map(m => m.content || '').join('\n') : String(prompt));
    // D1a — no default here. `|| 512` made this the real ceiling on /api/ai:
    // an explicit value is treated as a caller ceiling downstream, and a
    // ceiling beats a derived budget, so every answer on the kernel route
    // capped at 512 no matter how large a window the model was serving.
    // Undefined means "derive it from the window", which is the only value
    // that can be right for every prompt size.
    let result;
    try {
      result = await lr.infer(flatPrompt, {
        model: modelId || undefined,
        maxTokens: opts.max_tokens,
        temperature: opts.temperature ?? 0.7,
        long: opts.long === true,
        signal: opts.signal,
      });
    } catch (e) { throw opts.signal?.aborted ? e : _localFailure(e, modelId, _t0); }
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
    await _paceFor(opts, _paceKey('https://api.anthropic.com/v1', 'claude', opts.credential_ref), 'claude');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      _trackLLM('claude', modelName, 0, Date.now() - _t0, false, { status: response.status, error: `Claude API error ${response.status}: ${errBody}` });
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

  // Forget ONE key everywhere the running process holds it — env slots and
  // pools — so a key removed in Settings stops serving now. Narrower than
  // dehydrateProvider, which would also drop the provider's .env keys.
  const forgetKey = (value) => {
    if (!value) return 0;
    let cleared = 0;
    for (const name of Object.keys(process.env)) {
      if (process.env[name] === value) { delete process.env[name]; cleared++; }
    }
    for (const [p, pool] of Object.entries(KEY_POOLS)) {
      const i = pool.indexOf(value);
      if (i === -1) continue;
      pool.splice(i, 1);
      keyPoolIdx[p] = pool.length ? (keyPoolIdx[p] || 0) % pool.length : 0;
      // A pool of one is read through its base name (nextKey steps aside
      // below two keys). Removing the key that sat there left the base empty
      // with a good key still pooled: every env-only path — openRouterRequest,
      // _legacyKeyFor, vision — said "key missing" until a restart (C34).
      const base = DEHYDRATE_BASES[p]?.[0];
      if (base && pool.length && !process.env[base]) process.env[base] = pool[0];
    }
    const g = GEMINI_KEY_POOL.indexOf(value);
    if (g !== -1) GEMINI_KEY_POOL.splice(g, 1);
    return cleared;
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
        // Every key in the connection's pool (auth_refs), not only auth_ref —
        // three keys on one connection used to hydrate as a pool of one, so
        // rotation had nothing to rotate. Gemini keys feed GEMINI_KEY_POOL;
        // the rest join the numbered env pool (BASE, BASE_2, …) buildPool reads.
        const refs = aeonEndpoints.credentialRefs(ep);
        const envName = ENV_FOR_PROVIDER[ep.provider];
        if (!refs.length || (ep.provider !== 'gemini' && !envName)) continue;
        for (const ref of refs) {
          // One unreadable key must not stop every connection after it.
          try {
            const key = await _vault.getSecret(ref, supabase);
            if (!key) { console.warn(`[KERNEL] vault key ${ref} (${ep.provider}) is empty — not hydrated.`); continue; }
            if (ep.provider === 'gemini') { geminiVaultKeys.push(key); continue; }
            const existing = buildPool(envName);
            if (existing.includes(key)) continue;
            let n = existing.length + 1;
            let slot = n === 1 ? envName : `${envName}_${n}`;
            while (process.env[slot]) { n++; slot = `${envName}_${n}`; }
            process.env[slot] = key;
            console.log(`[KERNEL] Hydrated ${slot} from vault (${ep.provider}).`);
          } catch (e) { console.error(`[KERNEL] vault key ${ref} (${ep.provider}) not hydrated: ${e.message}`); }
        }
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
  // The hydration promise is kept, not discarded. It used to be fired and
  // dropped: every consumer that read process.env during boot — block
  // readiness, Council's engineAlive, Deep Research's provider list — ran
  // against an env that had not been filled yet, and reported a correctly
  // configured install as having no providers. Exposing the promise lets
  // those callers await the one hydration that is already in flight instead
  // of each starting their own or guessing.
  const envHydrated = hydrateEnvFromVault().catch((e) => {
    console.warn('[KERNEL] vault→env hydration failed:', e.message);
  });

  const openRouterRequest = async (prompt, model = 'openai/gpt-4o-mini', opts = {}) => {
    const apiKey = nextKey('openrouter') || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY missing in .env');
    // Free-tier models (openrouter/free, or any :free suffix) are $0/token
    // but OpenRouter still reserves max_tokens against your credit balance to
    // prevent abuse — a large reservation 402s even with zero cost.
    // genericOpenAIRequest caps it (_maxTokensFor).
    try {
      return await genericOpenAIRequest(prompt, model, 'https://openrouter.ai/api/v1', apiKey, opts);
    } catch (e) {
      if (/error (429|402)/i.test(e.message)) rotateKeyPool('openrouter');
      throw e;
    }
  };

  // One error mapping for every OpenAI-compatible transport, streaming or not.
  // The message is operator-facing (§08 — an error names its remedy); the
  // status and retry-after ride along as fields so callers never scrape text.
  const _openAIError = async (response, model) => {
    const body = (await response.text().catch(() => '')).slice(0, 200);
    const err = new Error(
      response.status === 401 || response.status === 403
        ? 'That service rejected the API key.'
        : response.status === 404
          ? 'That address or model was not found. Check the Base URL ends in /v1 and the model name is right.'
          : `Endpoint error ${response.status}: ${_redactKeys(body)}`
    );
    // Structured, so callers never have to scrape the message text.
    err.status = response.status;
    err.model = model;
    const ra = response.headers.get('retry-after');
    if (ra) err.retryAfterMs = /^\d+$/.test(ra.trim())
      ? parseInt(ra, 10) * 1000
      : Math.max(0, new Date(ra).getTime() - Date.now());
    return err;
  };

  // OpenRouter reports an upstream provider's failure INSIDE an HTTP 200:
  // `{"error":{"code":429,...}}` with no choices, or a choice whose
  // finish_reason is "error" (streaming: a chunk with a top-level `error`).
  // Read as a body it was "no text" — reported as an empty response with a
  // remedy about custom endpoints, and a rate limit hidden this way never
  // reached the cooldown or the key rotation. Found in the 2026-09-23 blind
  // test; shape per OpenRouter's error docs. Keeps the "Endpoint error <code>"
  // form every caller already reads a status out of.
  const _bodyError = (obj) => {
    const choice = obj?.choices?.[0];
    const e = obj?.error || choice?.error
      || (choice?.finish_reason === 'error' ? { message: 'the provider ended the response with an error' } : null);
    if (!e) return null;
    const code = Number(e.code);
    const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
    const msg = _redactKeys(String(e.message || 'provider error')).slice(0, 200);
    const err = new Error(`Endpoint error ${status || 'in the response body'}: ${msg}`);
    err.status = status;
    err.inBody = true;
    return err;
  };

  // Reasoning counts against max_tokens (OpenRouter docs). A model that spends
  // the whole budget thinking returns empty content with finish_reason
  // "length": not an empty model, an exhausted budget. Its unfinished thinking
  // is not an answer and is never shown as one.
  const _reasoningBudgetError = (maxTokens) => {
    const err = new Error(
      `The model used its whole output budget${maxTokens ? ` (${maxTokens} tokens)` : ''} before it answered `
      + '(finish_reason "length"). Reasoning models spend part of it thinking; free OpenRouter models are capped at 1024.'
    );
    err.reasoningExhausted = true;
    return err;
  };

  // OpenRouter names a reasoning model's thinking `reasoning` (streaming may
  // also send `reasoning_details: [{ text }]`); other servers use
  // `reasoning_content`. Only `reasoning_content` was read, so OpenRouter's
  // was invisible.
  const _reasoningText = (m) => {
    if (!m) return '';
    if (typeof m.reasoning === 'string' && m.reasoning) return m.reasoning;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m.reasoning_content;
    if (Array.isArray(m.reasoning_details)) return m.reasoning_details.map((d) => d?.text || d?.summary || '').join('');
    return '';
  };

  const genericOpenAIRequest = async (prompt, model, baseUrl, apiKey, opts = {}) => {
    const _t0 = Date.now();
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const messages = _toMessages(prompt, opts);
    if (opts.system) messages.unshift({ role: 'system', content: opts.system });
    const maxTokens = _maxTokensFor(opts.provider, baseUrl, model, opts.max_tokens);
    // Pace before the call, not after the 429.
    await _paceFor(opts, _paceKey(baseUrl, opts.provider, opts.credential_ref), opts.provider || 'this endpoint');
    const response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: fetchTimeout(opts),
    });
    if (!response.ok) {
      const err = await _openAIError(response, model);
      _trackLLM(opts.provider || 'openai-compat', model, 0, Date.now() - _t0, false, { status: err.status, error: err.message });
      throw err;
    }
    const data = await response.json().catch(() => null);
    const bodyErr = _bodyError(data);
    if (bodyErr) {
      _trackLLM(opts.provider || 'openai-compat', model, 0, Date.now() - _t0, false, { status: bodyErr.status, error: bodyErr.message });
      throw bodyErr;
    }
    // An OpenAI-compatible server that is merely *incompatible* answers 200 with
    // a shape this used to read as an empty string — and returned that empty
    // string as SUCCESS. Callers then wrote it over the user's document. Read
    // the shapes that actually occur (some reasoning models put the text in
    // their reasoning field and leave content null), and if there is genuinely
    // nothing, fail loudly instead of returning ''.
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    const content = msg?.content || choice?.text || data?.message?.content || '';
    if ((typeof content !== 'string' || content.trim() === '') && choice?.finish_reason === 'length') {
      const err = _reasoningBudgetError(maxTokens);
      _trackLLM(opts.provider || 'openai-compat', model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const text = (typeof content === 'string' && content.trim()) ? content : _reasoningText(msg);
    if (typeof text !== 'string' || text.trim() === '') {
      const err = new Error('The model returned an empty response. If this is a custom endpoint, check the model name is one this service actually serves.');
      err.emptyResponse = true;
      _trackLLM(opts.provider || 'openai-compat', model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const tokens = data?.usage?.total_tokens || Math.ceil(text.length / 4);
    _trackLLM(opts.provider || 'openai-compat', model, tokens, Date.now() - _t0, true);
    return text;
  };

  // Gemini refuses a bad key with HTTP 400 and API_KEY_INVALID in the body,
  // where the other providers answer 401. Carried as a 400, the credential
  // pool read it as the provider's fault: no move to the next key, no rest,
  // and a two-key connection failed every other turn. The error carries 401
  // so the pool, its cooldown and the wording all see a rejected key; the
  // message keeps the status Google actually sent.
  const _geminiError = (response, body) => {
    const err = new Error(`Gemini error ${response.status}: ${_redactKeys(body.slice(0, 200))}`);
    const keyRejected = response.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body);
    err.status = keyRejected ? 401 : response.status;
    if (keyRejected) { err.keyRejected = true; err.httpStatus = 400; }
    return err;
  };

  // A Gemini answer is every text part that is not a thought. A thinking model
  // (Gemini 3.x) may lead with a `thought: true` part and split its answer over
  // several; parts[0] read the wrong one, or half of it.
  const _geminiText = (cand) =>
    (cand?.content?.parts || []).filter((p) => p && p.thought !== true).map((p) => p.text || '').join('');

  // Google's error as an event or body under HTTP 200 (`{"error":{"code":503,
  // ...}}`), in the "Gemini error NNN" form _geminiError uses, so the chain
  // reads the status the same way.
  const _geminiBodyError = (obj) => {
    const e = obj?.error;
    if (!e) return null;
    const code = Number(e.code);
    const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
    const err = new Error(`Gemini error ${status || 'in the response body'}: ${_redactKeys(String(e.message || e.status || 'provider error')).slice(0, 200)}`);
    err.status = status;
    err.inBody = true;
    return err;
  };

  // Why a Gemini reply carried no text. A thinking model's thought counts
  // against maxOutputTokens: a spent budget is not an empty model, and a
  // refusal is not a wrong model name.
  const _geminiNoText = ({ finishReason, blockReason, maxTokens }) => {
    if (finishReason === 'MAX_TOKENS') {
      const err = new Error(
        `The model used its whole output budget${maxTokens ? ` (${maxTokens} tokens)` : ''} before it answered `
        + '(finishReason MAX_TOKENS). Gemini 3 models spend part of it thinking.'
      );
      err.reasoningExhausted = true;
      return err;
    }
    const why = blockReason ? `the prompt was blocked (${blockReason})`
      : finishReason && finishReason !== 'STOP' ? `it stopped with finishReason ${finishReason}` : '';
    if (!why) return _emptyStreamError();
    return new Error(`Gemini returned no answer: ${why}.`);
  };

  const genericGeminiRequest = async (prompt, model, baseUrl, apiKey, opts = {}) => {
    const _t0 = Date.now();
    const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const url = `${base}/models/${model}:generateContent?key=${apiKey}`;
    const flatText = _flatPrompt(prompt, opts);
    const contents = [{ parts: [{ text: flatText }] }];
    if (opts.system) contents.unshift({ role: 'user', parts: [{ text: opts.system }] });
    // Gemini paced nowhere, so a free key's per-minute cap was discovered only
    // by hitting it. Same budget seam as every other transport.
    await _paceFor(opts, _paceKey(base, 'gemini', opts.credential_ref), 'gemini');
    const maxTokens = opts.max_tokens || 4096;
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
      signal: fetchTimeout(opts),
    });
    if (!response.ok) {
      // Structured, so the credential pool classifies this without scraping
      // the message — a 429 here is the KEY's minute, not the provider's.
      const err = _geminiError(response, await response.text().catch(() => ''));
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, _failInfo(err));
      const ra = _parseRetryAfter(response.headers.get('retry-after'));
      if (ra) err.retryAfterMs = ra;
      throw err;
    }
    const data = await response.json().catch(() => null);
    const bodyErr = _geminiBodyError(data);
    if (bodyErr) {
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, { status: bodyErr.status, error: bodyErr.message });
      throw bodyErr;
    }
    const cand = data?.candidates?.[0];
    const text = _geminiText(cand);
    // Callers write what this returns over the operator's document: an answer
    // with no text is an error, never an empty string reported as success.
    if (text.trim() === '') {
      const err = _geminiNoText({ finishReason: cand?.finishReason, blockReason: data?.promptFeedback?.blockReason, maxTokens });
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const tokens = data?.usageMetadata?.totalTokenCount || Math.ceil(flatText.length / 4) + Math.ceil(text.length / 4);
    _trackLLM('gemini', model, tokens, Date.now() - _t0, true);
    return text;
  };

  // ── Credential rotation at the transport boundary ──────────────────────
  //
  // The registry resolves ONE credential per turn. This is what makes a pool of
  // several behave like a pool: a 429/402/401 is a fact about that key, so the
  // key is cooled and the next healthy one takes the turn, in place, before the
  // caller is ever told the provider failed. Only once every key on the
  // endpoint has been refused does the error escape — which is the point at
  // which marking the whole provider unhealthy, and falling back to a different
  // provider, is actually a true statement.
  const _statusOf = (e) =>
    e?.status || Number(/error (\d{3})/i.exec(e?.message || '')?.[1]) || null;

  // A key that cannot go into a request header — a zero-width space from a
  // copy, a line break, an em-dash note — makes fetch throw a TypeError before
  // any request exists ("Cannot convert argument to a ByteString", "… is an
  // invalid header value"). No status came back, so the pool never learned it
  // was the key's fault: the turn failed while the next key sat unused (sweep
  // C05). Keys saved before the shape check existed can still hold one. It is
  // the credential's fault, rested like a refused key (401).
  const _isHeaderFault = (e) => e instanceof TypeError
    && /ByteString|header value|invalid character in header|Headers\.(append|set)/i.test(e?.message || '');

  /**
   * Run `attempt(apiKey, credentialRef)` against the endpoint's credential
   * pool. Single-credential endpoints take exactly the path they always did.
   *
   * `err.streamStarted` opts an attempt out of retrying: once tokens have
   * reached the operator, a silent second attempt would show them two answers.
   */
  const _withCredentials = async (r, attempt) => {
    const poolCount = KEY_POOLS[r.provider]?.length || 0;
    const regCount = r.credential_count || (r.credential_ref ? 1 : 0);
    const total = Math.max(regCount, poolCount, r.credential_ref ? 1 : 0);
    let apiKey = r.apiKey || _legacyKeyFor(r.provider);
    let ref = r.credential_ref || null;
    let tries = 0;

    for (;;) {
      // Transports rotate the env pool themselves on a 429/402; rotating again
      // here skipped a key, and on a two-key pool landed back on the one that
      // had just failed.
      const idxBefore = keyPoolIdx[r.provider] || 0;
      try {
        const out = await attempt(apiKey, ref);
        if (ref) aeonEndpoints?.markCredentialOk?.(r.endpoint_id, ref);
        return out;
      } catch (caught) {
        tries++;
        let e = caught;
        if (_isHeaderFault(caught)) {
          e = new Error(`${r.provider} key${ref ? ` ${ref}` : ''} cannot be sent: it holds a character a request header cannot carry (a space, a line break, or an invisible character from a copy). Re-enter it in Settings → Keys.`);
          e.status = 401;
          e.keyUnsendable = true;
          e.cause = caught;
        }
        const status = _statusOf(e);
        const rotatable = total > 1 && tries < total
          && !e.streamStarted
          // The operator's own limit on this connection is not a key's fault.
          && !e.localThrottle
          && (e.keyUnsendable || aeonEndpoints?.isCredentialFault?.(status) || status === 429 || status === 402 || /429|402|rate limit|quota/i.test(e.message || ''));
        if (!rotatable) throw e;

        if (ref && regCount > 1 && aeonEndpoints) {
          const next = await aeonEndpoints.rotateCredential(
            r.endpoint_id, ref, { status, retryAfterMs: e.retryAfterMs, message: e.message }, supabase,
          ).catch(() => null);
          if (next) {
            notify(
              `🔁 ${r.provider}: key ${ref} ${e.keyUnsendable ? 'cannot be sent (not a valid header value)' : e.keyRejected ? 'was rejected' : `answered ${status}`} — switching to key ${next.credential_index + 1} of ${next.credential_count}`,
              { provider: r.provider },
            );
            apiKey = next.apiKey;
            ref = next.credential_ref;
            continue;
          }
        }

        if (poolCount > 1) {
          if ((keyPoolIdx[r.provider] || 0) === idxBefore) rotateKeyPool(r.provider);
          apiKey = nextKey(r.provider);
          notify(
            `🔁 ${r.provider}: rotated to key ${(keyPoolIdx[r.provider] || 0) + 1} of ${poolCount} in pool (${status || 'rate limit'})`,
            { provider: r.provider },
          );
          continue;
        }

        throw e;
      }
    }
  };

  const _dispatchResolved = async (prompt, r, opts = {}) => {
    const { provider, model, base_url, rpm_limit } = r;
    // Carry the endpoint's own pacing budget into the transport. Everything
    // else already flows through opts.
    const base = rpm_limit != null ? { ...opts, rpm_limit, provider } : { ...opts, provider };
    return _withCredentials(r, (apiKey, credential_ref) => {
      const o = { ...base, credential_ref };
      if (provider === 'gemini') return genericGeminiRequest(prompt, model, base_url, apiKey, o);
      if (provider === 'claude') return claudeRequest(prompt, model, apiKey, undefined, o);
      // Text only: the caller wraps it. With returnMeta the local transport
      // answers {text, model} itself, which came back wrapped a second time.
      if (provider === 'local') return localNativeRequest(prompt, model, { ...o, returnMeta: false });
      return genericOpenAIRequest(prompt, model, base_url, apiKey, o);
    });
  };

  // ── Streaming transports ──────────────────────────────────────────────
  //
  // The dashboard's terminal used to carry its own copies of these — its own
  // Groq/Gemini/local streamers, its own key lookup, its own fallback chain —
  // which made "one LLM layer that routes every AI call by role" false for the
  // one route the operator actually talks to. Worse, its Claude and OpenAI
  // branches posted to Groq's URL. Every streaming call now comes through
  // here, resolves through the same registry and settings as kernelLLM, and
  // records through the same _trackLLM seam.
  //
  // Timeouts: the blocking transports wrap the whole request in
  // AbortSignal.timeout(240s). A stream must not be killed mid-answer by a
  // wall clock, so here the clock runs only until the response headers arrive;
  // after that only the caller's own signal (client closed the tab, /chat/stop)
  // can end it.
  const STREAM_CONNECT_TIMEOUT_MS = 60000;
  const _streamSignal = (opts = {}) => {
    const connect = new AbortController();
    const timer = setTimeout(
      () => connect.abort(new Error(`No response headers within ${Math.round((opts.timeout_ms || STREAM_CONNECT_TIMEOUT_MS) / 1000)}s`)),
      opts.timeout_ms || STREAM_CONNECT_TIMEOUT_MS,
    );
    const signal = opts.signal ? AbortSignal.any([connect.signal, opts.signal]) : connect.signal;
    return { signal, connected: () => clearTimeout(timer) };
  };

  // Read a text/event-stream body and hand each `data:` payload to onData.
  // onData returns false to stop early (the [DONE] sentinel).
  const _readSSE = async (body, onData) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (onData(payload) === false) return;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  };

  const _estimateTokens = (messages, text) =>
    Math.ceil(JSON.stringify(messages || '').length / 4) + Math.ceil((text || '').length / 4);

  const _emptyStreamError = () => {
    const err = new Error('The model returned an empty response. If this is a custom endpoint, check the model name is one this service actually serves.');
    err.emptyResponse = true;
    return err;
  };

  // OpenAI-compatible SSE: groq, openai, openrouter, grok, lmstudio, custom.
  const streamOpenAICompat = async (messages, model, baseUrl, apiKey, opts = {}) => {
    const provider = opts.provider || 'openai-compat';
    const _t0 = Date.now();
    const base = String(baseUrl || '').replace(/\/$/, '');
    if (!base) throw new Error(`No base URL for provider "${provider}".`);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // Free-tier models reserve max_tokens against the credit balance and 402
    // on a large reservation (_maxTokensFor).
    const maxTokens = _maxTokensFor(provider, base, model, opts.max_tokens);
    await _paceFor(opts, _paceKey(base, provider, opts.credential_ref), provider);
    const { signal, connected } = _streamSignal(opts);
    let response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
        signal,
      });
    } finally { connected(); }
    if (!response.ok) {
      const err = await _openAIError(response, model);
      _trackLLM(provider, model, 0, Date.now() - _t0, false, { status: err.status, error: err.message });
      if (response.status === 429 || response.status === 402) rotateKeyPool(provider);
      throw err;
    }
    let text = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;
    let bodyErr = null;
    await _readSSE(response.body, (payload) => {
      if (payload === '[DONE]') return false;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { return true; }
      // A provider failure mid-stream arrives as a chunk, under a 200.
      bodyErr = _bodyError(chunk);
      if (bodyErr) return false;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) { text += delta.content; opts.onToken?.(delta.content); }
      // A reasoning model's thinking is held back rather than streamed, so it
      // does not scroll through the terminal ahead of the answer; it stands in
      // for the answer only if the model FINISHED without content — the same
      // parity genericOpenAIRequest keeps.
      else reasoning += _reasoningText(delta);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
      return true;
    });
    if (bodyErr) {
      _trackLLM(provider, model, 0, Date.now() - _t0, false, { status: bodyErr.status, error: bodyErr.message });
      if (bodyErr.status === 429 || bodyErr.status === 402) rotateKeyPool(provider);
      throw bodyErr;
    }
    if (!text && finishReason === 'length') {
      const err = _reasoningBudgetError(maxTokens);
      _trackLLM(provider, model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    if (!text && reasoning) { text = reasoning; opts.onToken?.(reasoning); }
    if (text.trim() === '') {
      const err = _emptyStreamError();
      _trackLLM(provider, model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const tokens = usage?.total_tokens || _estimateTokens(messages, text);
    _trackLLM(provider, model, tokens, Date.now() - _t0, true);
    return {
      text, tokens, model, finishReason,
      complete: finishReason !== 'length',
      truncated: finishReason === 'length',
      truncationReason: finishReason === 'length' ? 'max_tokens' : null,
    };
  };

  // Same messages array as every other provider, mapped onto Gemini's shape:
  // system turns become systemInstruction, the model's own turns are "model".
  // Key-pool rotation on 429 happens only before the first token — a 429 is a
  // response status, so it can only ever arrive there.
  const streamGemini = async (messages, model, baseUrl, apiKey, opts = {}, retries = 0) => {
    const _t0 = Date.now();
    const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content ?? '') }] }));
    const url = `${base}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const maxTokens = opts.max_tokens || 4096;
    // Before the connect clock starts: waiting on the operator's own limit is
    // not a provider that failed to answer.
    await _paceFor(opts, _paceKey(base, 'gemini', opts.credential_ref), 'gemini');
    const { signal, connected } = _streamSignal(opts);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal,
      });
    } finally { connected(); }
    // The env pool is the legacy path, for a key that came from .env rather
    // than the registry. When the caller resolved through the registry it owns
    // the rotation (_withCredentials) and rotating here as well would swap the
    // key out from under it, spending two accounts on one turn.
    if (response.status === 429 && !opts.credential_ref
        && GEMINI_KEY_POOL.length > 1 && retries < GEMINI_KEY_POOL.length - 1) {
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, { status: 429, error: 'Gemini error 429: rate limited, key rotated' });
      rotateKey('429 Rate Limit');
      return streamGemini(messages, model, baseUrl, getActiveKey(), opts, retries + 1);
    }
    if (!response.ok) {
      const err = _geminiError(response, await response.text().catch(() => ''));
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, _failInfo(err));
      throw err;
    }
    let text = '';
    let usageTotal = 0;
    let finishReason = null;
    let blockReason = null;
    let bodyErr = null;
    await _readSSE(response.body, (payload) => {
      let chunk;
      try { chunk = JSON.parse(payload); } catch { return true; }
      // A failure mid-stream arrives as an event, under a 200.
      bodyErr = _geminiBodyError(chunk);
      if (bodyErr) return false;
      const cand = chunk.candidates?.[0];
      const t = _geminiText(cand);
      if (t) { text += t; opts.onToken?.(t); }
      if (cand?.finishReason) finishReason = cand.finishReason;
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      if (chunk.usageMetadata?.totalTokenCount) usageTotal = chunk.usageMetadata.totalTokenCount;
      return true;
    });
    if (bodyErr) {
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, { status: bodyErr.status, error: bodyErr.message });
      throw bodyErr;
    }
    if (text.trim() === '') {
      const err = _geminiNoText({ finishReason, blockReason, maxTokens });
      _trackLLM('gemini', model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const tokens = usageTotal || _estimateTokens(messages, text);
    _trackLLM('gemini', model, tokens, Date.now() - _t0, true);
    return {
      text, tokens, model, finishReason,
      complete: finishReason !== 'MAX_TOKENS',
      truncated: finishReason === 'MAX_TOKENS',
      truncationReason: finishReason === 'MAX_TOKENS' ? 'max_tokens' : null,
    };
  };

  // Anthropic Messages API, stream:true. Same headers and error handling as
  // claudeRequest; text arrives as content_block_delta / text_delta events.
  const streamClaude = async (messages, model, apiKey, opts = {}) => {
    const _t0 = Date.now();
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
    const body = { model, max_tokens: opts.max_tokens || 4096, messages: turns, stream: true };
    if (system) body.system = system;
    await _paceFor(opts, _paceKey('https://api.anthropic.com/v1', 'claude', opts.credential_ref), 'claude');
    const { signal, connected } = _streamSignal(opts);
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(body), signal,
      });
    } finally { connected(); }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 429 || response.status === 402) { markUnhealthy('claude', response.status, errBody); rotateKeyPool('claude'); }
      const err = new Error(`Claude API error ${response.status}: ${_redactKeys(errBody)}`);
      err.status = response.status;
      _trackLLM('claude', model, 0, Date.now() - _t0, false, _failInfo(err));
      throw err;
    }
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = null;
    let streamErr = null;
    await _readSSE(response.body, (payload) => {
      let ev;
      try { ev = JSON.parse(payload); } catch { return true; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        text += ev.delta.text; opts.onToken?.(ev.delta.text);
      } else if (ev.type === 'message_start') {
        inputTokens = ev.message?.usage?.input_tokens || 0;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) outputTokens = ev.usage.output_tokens;
      } else if (ev.type === 'error') {
        streamErr = new Error(`Claude API error: ${_redactKeys(ev.error?.message || JSON.stringify(ev.error || {}))}`);
        return false;
      } else if (ev.type === 'message_stop') {
        return false;
      }
      return true;
    });
    if (streamErr) {
      _trackLLM('claude', model, 0, Date.now() - _t0, false, _failInfo(streamErr));
      throw streamErr;
    }
    if (text.trim() === '') {
      const err = _emptyStreamError();
      _trackLLM('claude', model, 0, Date.now() - _t0, false, { error: err.message });
      throw err;
    }
    const tokens = (inputTokens + outputTokens) || _estimateTokens(messages, text);
    _trackLLM('claude', model, tokens, Date.now() - _t0, true);
    return {
      text, tokens, model, finishReason: stopReason,
      complete: stopReason !== 'max_tokens',
      truncated: stopReason === 'max_tokens',
      truncationReason: stopReason === 'max_tokens' ? 'max_tokens' : null,
    };
  };

  // Native local runtime. The runtime applies the model's own chat template to
  // a real messages array — a system turn is a system turn — and honours the
  // caller's signal, so /chat/stop reaches llama-server, not just the display.
  const streamLocal = async (messages, model, opts = {}) => {
    const lr = _getLocalRT();
    if (!lr || !lr.isAvailable()) throw _localMissing();
    const _t0 = Date.now();
    let result;
    try {
      result = await lr.inferStream('', {
        model: model || undefined,
        messages,
        signal: opts.signal,
        // D1a — undefined means "derive it from the window".
        maxTokens: opts.max_tokens,
        temperature: opts.temperature ?? 0.7,
      }, opts.onToken);
    } catch (e) { throw opts.signal?.aborted ? e : _localFailure(e, model, _t0); }
    // A stop for an agent tool call (agentTurn.cjs) is the turn working, not
    // a failed generation.
    _trackLLM('local', result.model || model || 'local', result.tokens || 0, Date.now() - _t0, !result.cancelled || _isToolStop(opts.signal));
    return {
      text: result.text || '',
      tokens: result.tokens || 0,
      model: result.model || model,
      complete: result.complete !== false && !result.cancelled,
      truncated: !!result.truncated,
      truncationReason: result.truncationReason || null,
      cancelled: !!result.cancelled,
      finishReason: result.finishReason || null,
    };
  };

  // Keys for the legacy (settings-file) path, where no registry endpoint
  // carried one. The registry path passes the vault key straight through.
  const _legacyKeyFor = (p) =>
    p === 'groq' ? (nextKey('groq') || process.env.GROQ_API_KEY) :
    p === 'gemini' ? getActiveKey() :
    p === 'openrouter' ? (nextKey('openrouter') || process.env.OPENROUTER_API_KEY) :
    p === 'claude' ? (nextKey('claude') || process.env.ANTHROPIC_API_KEY) :
    p === 'openai' ? process.env.OPENAI_API_KEY :
    p === 'grok' ? (process.env.XAI_API_KEY || process.env.GROK_API_KEY) :
    null;
  const _KEY_REQUIRED = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY', gemini: 'a Gemini key' };

  // Dispatch on the transport STYLE from the registry's provider profiles, so
  // custom/lmstudio/grok endpoints stream the same way groq does.
  const _dispatchStream = async (messages, c, opts = {}) => {
    const transport = aeonEndpoints?.PROVIDER_TRANSPORT || {};
    const profile = transport[c.provider] || {};
    const style = profile.style || (c.provider === 'local' ? 'local' : 'openai');
    const o = { ...opts, provider: c.provider, ...(c.rpm_limit != null ? { rpm_limit: c.rpm_limit } : {}) };
    if (style === 'local') return streamLocal(messages, c.model, o);
    const apiKey = c.apiKey || _legacyKeyFor(c.provider);
    if (!apiKey && _KEY_REQUIRED[c.provider]) {
      throw new Error(`${_KEY_REQUIRED[c.provider]} missing in .env or vault`);
    }
    const base = c.base_url || profile.base || null;

    // Exhaust this endpoint's OWN accounts before the caller concludes the
    // provider is down. Without this, one free key hitting its per-minute cap
    // marked the whole provider unhealthy and fell through to a different one,
    // with the operator's other keys sitting unused.
    return _withCredentials({ ...c, apiKey }, (key, credential_ref) => {
      let served = 0;
      const co = { ...o, credential_ref, onToken: (t) => { served++; o.onToken?.(t); } };
      const run =
        style === 'gemini' ? streamGemini(messages, c.model || 'gemini-flash-latest', base, key, co)
        : style === 'anthropic' ? streamClaude(messages, c.model || 'claude-sonnet-5', key, co)
        : streamOpenAICompat(messages, c.model, base, key, co);
      // Past the first token the operator has already seen text; a retry on
      // another key would print a second answer underneath the first.
      return run.catch((e) => { if (served > 0) e.streamStarted = true; throw e; });
    });
  };

  // The ordered list of {provider, model, base_url?, apiKey?} a streaming call
  // will try: the role's own assignment first (registry, else the settings
  // file), then the fallback chain kernelLLM uses, with local always last.
  // The providers kernelLLM's legacy chain dispatches by name. Anything else
  // a caller names is an endpoint in the registry.
  const LEGACY_CHAIN_PROVIDERS = new Set(['groq', 'gemini', 'openrouter', 'local', 'claude']);

  const _STREAM_FALLBACK_MODELS = { groq: 'openai/gpt-oss-120b', gemini: 'gemini-flash-latest', openrouter: 'openai/gpt-4o-mini', local: undefined };
  // Which provider and model a role uses is what Settings declares
  // (settings.models[role], else chat). The registry supplies that provider's
  // address, model list and key pool. It used to be the other way round: the
  // registry's own role map won, falling back to ITS chat entry, so a role set
  // to local — or to any provider the UI's best-effort mirror missed — was
  // served by whatever the registry last held.
  // A role with no provider set ("Same as Chat" in Settings) uses Chat.
  const _declaredFor = (models, role) => {
    const own = models?.[role];
    if (own && own.provider) return own;
    return role === 'embed' ? null : (models?.chat || null);
  };
  const _resolveDeclared = async (role, settings) => {
    if (!aeonEndpoints) return null;
    if (aeonEndpoints.isPortable?.()) return aeonEndpoints.resolveForRole(role, supabase);
    const models = settings?.models || {};
    const d = _declaredFor(models, role);
    // Nothing usable declared (no entry, "none", or the install default of
    // local with no local model): the registry's auto-pick, so adding a key
    // still just works.
    if (!d || !d.provider || d.provider === 'none' || (d.provider === 'local' && !localRuntimePresent())) {
      return aeonEndpoints.resolveForRole(role, supabase);
    }
    if (d.provider === 'local') return null;                                     // the settings path serves local
    // A connection for that provider (keyed or not — LM Studio and local
    // servers have none) serves it; without one, the env-key chain does.
    const r = await aeonEndpoints.resolveForProvider(d.provider, d.model || null, supabase).catch(() => null);
    return r && r.ok ? { ...r, role } : null;
  };

  // Every provider Settings declares, as fallback candidates after the
  // primary. Registry connections come first-class (their own model, address
  // and key pool — custom, openai, claude, lmstudio included); env-only
  // groq/gemini/openrouter keys still count. Roulette shuffles this list;
  // otherwise prefs.provider_priority orders it. One builder for the stream
  // and non-stream chains, so the two cannot route the same role differently.
  const _ENV_CHAIN = ['groq', 'gemini', 'openrouter'];
  // The models a fallback rung asks provider p for, best first: one Settings
  // declares for p (the serving role's, then Chat's, then any other role's —
  // never Embedding's, an embedder cannot chat), then the model this chain has
  // always used for p. The connection's auto-pick comes only after these: it
  // is the provider's own list order, and Groq lists a text-to-speech model
  // first, so failover to Groq asked for speech and never answered (C09).
  const _fallbackModelsFor = (p, settings, role) => {
    const models = settings?.models || {};
    const roles = [role, 'chat', ...Object.keys(models)].filter((r, i, a) => r && r !== 'embed' && a.indexOf(r) === i);
    const declared = roles.map((r) => models[r]).filter((m) => m && m.provider === p && m.model).map((m) => m.model);
    const nonChat = aeonEndpoints?.NON_CHAT_MODEL_RE;
    // OpenRouter's free router before its paid default when no role declares
    // an OpenRouter model: on a free-only key the paid default answered 402,
    // and markUnhealthy then rested OpenRouter for every caller — roles on
    // :free models included. A connection that does not list it moves on.
    const floor = p === 'openrouter' ? ['openrouter/free', _STREAM_FALLBACK_MODELS[p]] : [_STREAM_FALLBACK_MODELS[p]];
    return [...new Set([...declared, ...floor].filter((m) => m && !(nonChat && nonChat.test(m))))];
  };

  // ── Local only (Settings → Models) ──────────────────────────────────────
  // README calls local models "fully private", yet a role kept on Local handed
  // its prompt (Vault passages included) to every configured cloud provider
  // when Local failed, and roulette shuffled them in (audit A072).
  // settings.local_only makes that a switch: the fallback list holds only local
  // candidates, and a role or caller that names a cloud provider is refused
  // with the reason instead of answered. Off by default, so the failover the
  // operator relies on is unchanged until they turn it on.
  //
  // Local is this computer's runtime, or an LM Studio / custom connection whose
  // address is on this machine or the LAN, judged by the registry's own
  // classifier (isPrivateHost) so routing and the egress check agree. A named
  // vendor (groq, gemini, openai, claude, grok, openrouter) is cloud whatever
  // address it carries; an unknown provider counts as cloud.
  // An agent can be Local only on its own (Memory Core → agent → Privacy):
  // its calls carry opts.localOnly and get the same refusal and the same
  // local-only fallback chain, whatever the global switch says.
  const _localOnly = (settings, opts) => settings?.local_only === true || opts?.localOnly === true;
  const _settingsNow = () => { try { return loadSettings() || {}; } catch { return {}; } };
  // Decided before a provider is resolved, so Local only never draws a cloud
  // provider's key from its pool.
  const _mayBeLocal = (p) => {
    if (p === 'local') return true;
    const profile = aeonEndpoints?.PROVIDER_TRANSPORT?.[p];
    return !!profile && (!!profile.requiresBaseUrl || !(profile.reach || []).includes('cloud'));
  };
  const _isLocalCandidate = (c) => {
    if (!c || !_mayBeLocal(c.provider)) return false;
    if (c.provider === 'local') return true;
    const address = c.base_url || aeonEndpoints.PROVIDER_TRANSPORT[c.provider].base;
    try { return !!address && !!aeonEndpoints.isPrivateHost(new URL(address).hostname); } catch { return false; }
  };
  const _localOnlyRefusal = (role, provider, namedByCaller, opts = {}) => {
    const err = new Error(
      (opts.localOnlyReason || 'Local only is on (Settings → Models), so nothing is sent to a cloud model. ')
      + (namedByCaller ? `This request asked for ${provider}` : `The ${role} role is set to ${provider}`)
      + ', which is not on this computer. '
      + (opts.localOnlyRemedy || 'Assign a local model in Settings → Models, or turn Local only off.')
    );
    err.localOnly = true;
    // The routers' "nothing configured can answer" status (503) and remedy.
    err.noProviderAvailable = true;
    return err;
  };
  // The provider a call names (the caller's, else the role's declaration);
  // null when nothing real is named ("none", "Same as Chat" with no Chat).
  const _namedProvider = (settings, role, opts) => {
    const p = opts.provider || _declaredFor(settings?.models, role)?.provider;
    return p && p !== 'none' ? p : null;
  };

  const _fallbackCandidates = async (settings, exclude = [], opts = {}) => {
    const localOnly = _localOnly(settings, opts);
    let registryPs = [];
    try { registryPs = (aeonEndpoints?.configuredProviders?.() || []).filter((p) => p !== 'local'); } catch {}
    let ps = [...new Set([...registryPs, ..._ENV_CHAIN])]
      .filter((p) => !exclude.includes(p) && isHealthy(p) && (registryPs.includes(p) || isConfigured(p))
        && (!localOnly || _mayBeLocal(p)));
    if (settings.roulette && !opts.provider) {
      for (let i = ps.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ps[i], ps[j]] = [ps[j], ps[i]];
      }
    } else {
      const priority = Array.isArray(settings.prefs?.provider_priority) ? settings.prefs.provider_priority : [];
      const rank = (p) => { const i = priority.indexOf(p); return i === -1 ? priority.length : i; };
      ps = ps.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
    }
    const source = settings.roulette && !opts.provider ? 'roulette' : 'fallback';
    const out = [];
    for (const p of ps) {
      const prefer = _fallbackModelsFor(p, settings, opts.role || 'chat');
      if (registryPs.includes(p)) {
        const r = await aeonEndpoints.resolveForProvider(p, null, supabase, prefer).catch(() => null);
        if (r && r.ok && r.via !== 'relay') {
          out.push({
            provider: r.provider, model: r.model, base_url: r.base_url, apiKey: r.apiKey,
            rpm_limit: r.rpm_limit, source, resolved: r,
            endpoint_id: r.endpoint_id, credential_ref: r.credential_ref, credential_count: r.credential_count,
          });
          continue;
        }
      }
      if (_ENV_CHAIN.includes(p) && isConfigured(p)) out.push({ provider: p, model: prefer[0], source });
    }
    // A custom connection is only known to be local once its address is.
    return localOnly ? out.filter(_isLocalCandidate) : out;
  };

  const _streamCandidates = async (role, opts = {}) => {
    const settings = loadSettings() || {};
    const candidates = [];
    let primary = null;
    const localOnly = _localOnly(settings, opts);
    const named = _namedProvider(settings, role, opts);
    // Local only: a cloud provider named by the caller or declared for the
    // role is refused here, before its key is drawn from a pool.
    if (localOnly && named && !_mayBeLocal(named)) throw _localOnlyRefusal(role, named, !!opts.provider, opts);

    if (opts.provider && !LEGACY_CHAIN_PROVIDERS.has(opts.provider) && aeonEndpoints) {
      // A named custom/lmstudio endpoint carries its own address and key; an
      // override with neither could only fail (agent C2, 2026-09-23).
      const r = await aeonEndpoints.resolveForProvider(opts.provider, opts.model, supabase).catch(() => null);
      primary = r && r.ok
        ? {
          provider: r.provider, model: r.model, base_url: r.base_url, apiKey: r.apiKey,
          rpm_limit: r.rpm_limit, source: 'registry',
          endpoint_id: r.endpoint_id, credential_ref: r.credential_ref, credential_count: r.credential_count,
        }
        : { provider: opts.provider, model: opts.model, source: 'override', error: r?.error };
    } else if (opts.provider && opts._pinnedRound && opts.provider !== 'local' && aeonEndpoints) {
      // A later round of one chat turn (agentTurn.cjs) pinned to the provider
      // that served round 1. When that provider has a connection in the
      // registry, the round goes through it as round 1 did: the same address,
      // key pool and pacing, not the env key and default host an override gets.
      const r = await aeonEndpoints.resolveForProvider(opts.provider, opts.model, supabase).catch(() => null);
      primary = r && r.ok && r.via !== 'relay'
        ? {
          provider: r.provider, model: r.model, base_url: r.base_url, apiKey: r.apiKey,
          rpm_limit: r.rpm_limit, source: 'registry',
          endpoint_id: r.endpoint_id, credential_ref: r.credential_ref, credential_count: r.credential_count,
        }
        : { provider: opts.provider, model: opts.model, source: 'override' };
    } else if (opts.provider) {
      primary = { provider: opts.provider, model: opts.model, source: 'override' };
    } else if (aeonEndpoints) {
      try {
        const r = await _resolveDeclared(role, settings);
        if (r && r.ok) {
          if (r.via === 'relay') {
            throw new Error(`Model "${r.model}" is desktop-only; relay required (desktop must be online).`);
          }
          primary = {
            provider: r.provider, model: r.model, base_url: r.base_url, apiKey: r.apiKey,
            rpm_limit: r.rpm_limit, source: 'registry',
            // The pool travels with the candidate — _dispatchStream rotates
            // through it before this candidate is declared failed.
            endpoint_id: r.endpoint_id, credential_ref: r.credential_ref, credential_count: r.credential_count,
          };
        }
      } catch (e) {
        if (/desktop-only/.test(e.message)) throw e;
        console.warn(`[KERNEL] registry resolve(${role}) fell back:`, e.message);
      }
    }
    if (!primary) {
      // The settings file, with the same offline floor the terminal used to
      // build for itself: no chat role at all still resolves to a local model.
      const models = settings.models || {};
      const roleConfig = _declaredFor(models, role) || { provider: 'local', model: defaultLocalModel() };
      primary = { provider: roleConfig.provider || 'local', model: roleConfig.model, source: 'settings' };
    }
    if (localOnly && !primary.error && !_isLocalCandidate(primary)) {
      // A custom connection named for this role at a non-local address is
      // refused like any cloud provider. The registry's auto-pick (nothing
      // declared, or Local declared with no runtime) gives way to Local.
      // A named connection that does not exist keeps its own error.
      if (named && named !== 'local') throw _localOnlyRefusal(role, named, !!opts.provider, opts);
      primary = { provider: 'local', model: named === 'local' ? _declaredFor(settings.models, role)?.model : undefined, source: 'settings' };
    }
    candidates.push(primary);

    candidates.push(...await _fallbackCandidates(settings, [primary.provider], { ...opts, role }));
    // Local is the floor, never a rung in the middle: a local answer is a
    // noticeable change in quality and speed, so every configured cloud
    // provider gets its turn first.
    if (!opts._vercelStrict && localRuntimePresent() && !candidates.some(c => c.provider === 'local')) {
      candidates.push({ provider: 'local', model: undefined, source: 'fallback' });
    }
    const localIdx = candidates.findIndex((c, i) => i > 0 && c.provider === 'local');
    if (localIdx > 0 && localIdx !== candidates.length - 1) {
      candidates.push(...candidates.splice(localIdx, 1));
    }
    // The fallbacks above already skip a provider in cooldown; the primary did
    // not, so a resting primary was still tried first on every turn (the
    // 2026-09-23 log: fail, fall back, fail, fall back). It now goes after the
    // healthy cloud candidates — kept, not dropped: it may be the only one, and
    // cooldowns end.
    primary.configured = true;
    if (!isHealthy(primary.provider) && candidates.some((c) => c !== primary && c.provider !== 'local')) {
      candidates.splice(candidates.indexOf(primary), 1);
      const at = candidates.findIndex((c) => c.provider === 'local');
      candidates.splice(at === -1 ? candidates.length : at, 0, primary);
    }
    // OpenRouter's paid models resting: that connection serves on a free one.
    for (const c of candidates) await _applyPaidRest(c);
    return candidates;
  };

  /**
   * kernelLLM.stream — token-by-token dispatch by role.
   *
   *   opts = { role='chat', signal, onToken(delta) [required],
   *            onAttempt({provider, model, fallback}),
   *            onFallback({from, to, model, reason, status?, notice?}),
   *            max_tokens, timeout_ms, provider, model }
   *
   * Resolves like kernelLLM (registry, then settings, then the fallback
   * chain). A provider that fails BEFORE its first token is skipped and the
   * next candidate tried, with onFallback told why. A failure AFTER tokens
   * have reached the caller cannot be retried transparently — the caller has
   * already shown them — so it is rethrown with err.partialText. A caller
   * abort resolves to { cancelled: true } with whatever text had arrived.
   */
  // The turn engine (src/kernel/agentTurn.cjs) stops a generation the moment
  // a model has written a complete tool call, by aborting with an
  // AeonToolStop. That is a clean stop: the text so far is the round, nothing
  // failed, nothing is cancelled, and the provider is healthy.
  const _isToolStop = (signal) => !!(signal && signal.aborted && signal.reason && signal.reason.name === 'AeonToolStop');

  const kernelLLMStream = async (messages, opts = {}) => {
    if (typeof opts.onToken !== 'function') throw new Error('kernelLLM.stream requires opts.onToken');
    if (!Array.isArray(messages) || !messages.length) throw new Error('kernelLLM.stream requires a messages array');
    const role = opts.role || 'chat';
    if (_isCloud()) opts = { ...opts, _vercelStrict: true };
    const t0 = Date.now();
    const candidates = await _streamCandidates(role, opts);
    const primary = candidates.find((c) => c.configured) || candidates[0];
    const attempts = [];
    let lastErr = null;
    let lastFailed = null;
    let primaryErr = null;
    if (candidates[0] !== primary) {
      // Say why the configured provider was not tried first.
      opts.onFallback?.({
        from: primary.provider, to: candidates[0].provider, model: candidates[0].model,
        reason: providerHealth[primary.provider]?.plain || 'resting',
      });
    } else if (primary.paidFrom) {
      // Paid OpenRouter models are resting: this turn starts on a free one,
      // with one notice rather than a failure.
      opts.onFallback?.({
        from: primary.provider, to: primary.provider, model: primary.model,
        reason: 'out of credits', notice: _paidNotice(primary.paidFrom),
      });
    }

    // An index, not for…of: a recovery attempt on the same connection (a free
    // model after a paid 402, less context after a "too large") is inserted
    // right after the candidate that failed, ahead of every other provider.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const root = c.retryOf || c;
      const fallback = root !== primary || !!c.paidFrom;
      // A recovery attempt's notice went out when it was queued.
      if (!c.retryOf && c !== primary && lastFailed) {
        opts.onFallback?.({ from: lastFailed.provider, to: c.provider, model: c.model, reason: _plainReason(lastErr), status: _failInfo(lastErr).status });
      }
      opts.onAttempt?.({ provider: c.provider, model: c.model, fallback });

      const sent = c.noNativeTools ? _withNoNativeTools(c.trimmedMessages || messages) : (c.trimmedMessages || messages);
      const callOpts = c.trimmedMaxTokens ? { ...opts, max_tokens: c.trimmedMaxTokens } : opts;
      let partial = '';
      let served = 0;
      const onToken = (t) => { if (!t) return; served++; partial += t; opts.onToken(t); };
      try {
        if (c.provider === 'local') {
          const refusal = await _localWindowRefusal(c, sent);
          if (refusal) throw _localFailure(refusal, c.model, Date.now());
        }
        const r = await _dispatchStream(sent, c, { ...callOpts, onToken });
        noteProviderSuccess(c.provider);
        const usedModel = r.model || c.model;
        if (fallback) notify(`↪ Fallback: ${role} streamed via ${c.provider}/${usedModel} (configured: ${primary.provider}${c.paidFrom ? `/${c.paidFrom}` : ''})`, { provider: c.provider });
        // The local runtime answers a stop with `cancelled: true` instead of
        // throwing; a stop for a tool call is still not a cancel.
        const toolStop = !!r.cancelled && _isToolStop(opts.signal);
        return {
          text: r.text, tokens: r.tokens, latencyMs: Date.now() - t0,
          provider: c.provider, model: usedModel, fallback,
          complete: toolStop || r.complete !== false, truncated: toolStop ? false : !!r.truncated,
          truncationReason: toolStop ? null : (r.truncationReason || null), cancelled: toolStop ? false : !!r.cancelled,
          finishReason: toolStop ? 'tool' : (r.finishReason || null),
          ...(toolStop ? { stoppedFor: 'tool' } : {}),
          ...(c.trimmedMessages ? { trimmed: true } : {}),
        };
      } catch (e) {
        if (_isToolStop(opts.signal)) {
          // Stopped because the model finished writing a tool call: a clean
          // round, recorded as a success, and the provider stays healthy.
          _trackLLM(c.provider, c.model || 'unknown', _estimateTokens(sent, partial), Date.now() - t0, true);
          noteProviderSuccess(c.provider);
          return {
            text: partial, tokens: Math.ceil(partial.length / 4), latencyMs: Date.now() - t0,
            provider: c.provider, model: c.model, fallback,
            complete: true, truncated: false, truncationReason: null, cancelled: false,
            finishReason: 'tool', stoppedFor: 'tool',
          };
        }
        if (opts.signal?.aborted) {
          // The operator stopped it. Not a provider failure — do not fall back.
          _trackLLM(c.provider, c.model || 'unknown', _estimateTokens(sent, partial), Date.now() - t0, false);
          return {
            text: partial, tokens: Math.ceil(partial.length / 4), latencyMs: Date.now() - t0,
            provider: c.provider, model: c.model, fallback,
            complete: false, truncated: false, truncationReason: null, cancelled: true, finishReason: 'cancelled',
          };
        }
        if (served > 0) {
          // Tokens already reached the caller; a silent retry would show the
          // operator two answers. Surface it with what arrived.
          _trackLLM(c.provider, c.model || 'unknown', _estimateTokens(sent, partial), Date.now() - t0, false, _failInfo(e));
          e.partialText = partial;
          e.provider = c.provider;
          e.model = c.model;
          throw e;
        }
        const status = _failureStatus(e);
        if (root === primary) primaryErr = e;

        // A paid OpenRouter model out of credits: the paid models rest, not
        // OpenRouter, and the same connection answers on a free model next.
        if (_paidOutOfCredits(c, status)) {
          _restPaid(c.provider, c.model, e.message);
          const free = await _freeModelFor(c);
          attempts.push({ provider: c.provider, status, message: e.message, configured: root === primary, label: `openrouter (${c.model})`, model: c.model });
          candidates.splice(i + 1, 0, { ...c, model: free, paidFrom: c.model, retryOf: root });
          opts.onFallback?.({ from: c.provider, to: c.provider, model: free, reason: 'out of credits', notice: _paidNotice(c.model) });
          continue;
        }

        // A native tool call the provider refused is the model's format, not
        // the provider: the same candidate is asked once more with a note not
        // to call functions, and nothing has reached the operator (served is 0
        // here). A second refusal moves on like any other failure.
        if (_isNativeToolRefusal(e) && !c.noNativeTools) {
          console.warn(`[KERNEL] stream ${c.provider} refused a native tool call (${_redactKeys(e.message).slice(0, 120)}); asking again in plain text`);
          candidates.splice(i + 1, 0, { ...c, retryOf: root, noNativeTools: true });
          opts.onFallback?.({ from: c.provider, to: c.provider, model: c.model, reason: _plainReason(e), notice: _nativeToolNotice(c.provider) });
          continue;
        }

        // Too large is the request, not the provider: never a rest, and the
        // same candidate is asked once more with less context.
        const tooLarge = _isTooLarge(e, status);
        // opts.noTrimRetry (agentTurn.cjs: every round after the first) is
        // never retried trimmed. The trim keeps the system head and the LAST
        // user message: for a continuation that drops the cut-off answer and
        // the question, so whatever the model then wrote would be stitched on
        // as the rest of the answer; after a tool result it keeps the wrapped
        // result and drops the ## TOOLS rules. A continuation round
        // (opts.continuation) is not sent anywhere else either — nor is a
        // reasoning model that spent its budget thinking a provider failure
        // there — and the turn engine ends the answer where it stopped. Any
        // other round still goes on to the next provider, with the full request.
        if (opts.noTrimRetry && (tooLarge || e?.reasoningExhausted)) {
          if (tooLarge) e.tooLarge = true;
          if (opts.continuation) {
            console.warn(`[KERNEL] stream ${c.provider} continuation not sent (${_redactKeys(e.message).slice(0, 160)})`);
            throw e;
          }
        }
        if (tooLarge && !c.trimmedRetry && !opts.noTrimRetry) {
          const budget = await _trimBudget(c, e, callOpts);
          const cut = _trimMessages(sent, budget.promptTokens);
          // A local window is exact: a cut that still does not fit would fail
          // the same way, after another trip to the model.
          if (cut && !(c.provider === 'local' && await _localWindowRefusal(c, cut.messages))) {
            console.warn(`[KERNEL] stream ${c.provider} request too large (~${cut.before} tokens: ${_redactKeys(e.message).slice(0, 160)}); retrying with ~${cut.after}`);
            candidates.splice(i + 1, 0, { ...c, retryOf: root, trimmedRetry: true, trimmedMessages: cut.messages, trimmedMaxTokens: budget.maxTokens });
            opts.onFallback?.({ from: c.provider, to: c.provider, model: c.model, reason: 'request too large for it', notice: _tooLargeNotice(c.provider) });
            continue;
          }
        }

        lastErr = e;
        lastFailed = c;
        if (status === 429 || status === 402) markUnhealthy(c.provider, status, e.message);
        else if (!tooLarge) noteProviderFailure(c.provider, e);
        attempts.push({ provider: c.provider, status: status || null, message: e.message, configured: root === primary, ..._attemptExtras(c, e) });
        console.warn(`[KERNEL] stream ${c.provider} failed (${e.message.slice(0, 120)}), trying next provider`);
      }
    }
    // The configured provider's failure is the cause; a later rung that could
    // not even start ("no local model is installed") is not.
    throw _chainExhaustedError(attempts, primaryErr || lastErr, { localOnly: _localOnly(_settingsNow(), opts) });
  };

  // The provider/model the role WOULD stream through, and the context window
  // that turn's memory, skill and recall budgets are measured against.
  //
  // Cloud models used to report a flat 8,192 here on the theory that their
  // windows are large, so a small floor was safe. It was not: inputBudgets
  // derives the injection FROM this number, so the floor capped what was
  // injected. A 1M-token model got ~980 tokens of memory and told the
  // operator that memories it had indexed were not in context. The provider
  // is now asked (modelContext, cached on disk); one that will not say keeps
  // the 8,192 floor, which is the honest figure for an unknown size.
  const describeRole = async (role = 'chat') => {
    const opts = _isCloud() ? { _vercelStrict: true } : {};
    let c = null;
    try { c = (await _streamCandidates(role, opts))[0] || null; }
    catch (e) { console.warn(`[KERNEL] describeRole(${role}):`, e.message); }
    if (!c) return { provider: null, model: null, contextTokens: 8192 };
    let contextTokens = 8192;
    let model = c.model;
    if (c.provider === 'local') {
      const lr = _getLocalRT();
      if (!model) model = defaultLocalModel();
      try { contextTokens = (await lr?.plannedContext?.(model))?.contextTokens || 8192; } catch {}
    } else if (model) {
      // Same host and key the turn will stream through (Google's or
      // Anthropic's own API for those two); the candidate list is already
      // Local-only filtered. A null or a throw leaves the floor in place.
      try {
        const known = await _modelContext.lookup({
          provider: c.provider, model, base_url: c.base_url, apiKey: c.apiKey,
        });
        if (Number.isFinite(known) && known > 0) contextTokens = known;
      } catch {}
    }
    return { provider: c.provider, model: model ?? null, contextTokens };
  };

  // Local generations may be held by the runtime itself, not only by a
  // caller's AbortController — a stop that names no stream reclaims those too.
  const cancelAll = () => { try { return _getLocalRT()?.cancelAll?.() || 0; } catch { return 0; } };

  // ── Vision — reads an image via whatever provider the "vision" role is
  // set to in Settings (Model Assignment). Provider-agnostic by design: the
  // operator can point it at Groq's Llama 4 Scout (free, vision-capable —
  // confirmed live on this account), Gemini, or Claude without a code change.
  const kernelVision = async (imageDataUri, prompt, opts = {}) => {
    const settings = loadSettings();
    if (settings.prefs?.vision_enabled === false) {
      throw new Error('Vision is disabled in Settings (toggle it on under Vision).');
    }
    // Every transport below is a cloud provider; Local only sends none of them an image.
    if (_localOnly(settings)) {
      const err = new Error('Local only is on (Settings → Models), and images are read only by cloud models here (Groq, Gemini, OpenRouter, Claude), so the image was not sent. Turn Local only off to read images.');
      err.localOnly = true;
      throw err;
    }
    const _visionFallback = { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' };
    // Vision never borrows Chat (a chat model need not read images): a role
    // with no provider uses its own default. A saved {provider: ''} used to
    // reach the dispatch below as provider "" and fail every upload (C33).
    const declaredVision = settings.models?.vision;
    const roleConfig = opts.provider ? opts : (declaredVision?.provider ? declaredVision : _visionFallback);
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
        _trackLLM(provider, model, 0, Date.now() - _t0, false, { status: response.status, error: `${provider} vision error ${response.status}: ${errBody}` });
        // A paid OpenRouter model out of credits rests the paid models only;
        // chat on a ':free' model keeps working.
        if (_paidOutOfCredits({ provider, model }, response.status)) _restPaid(provider, model, errBody);
        else if (response.status === 429 || response.status === 402) markUnhealthy(provider, response.status, errBody);
        if (response.status === 429 || response.status === 402) rotateKeyPool(provider);
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
        _trackLLM('gemini', model, 0, Date.now() - _t0, false, { status: response.status, error: `Gemini vision error ${response.status}: ${errBody}` });
        throw new Error(`Gemini vision error ${response.status}: ${errBody}`);
      }
      const data = await response.json();
      const cand = data?.candidates?.[0];
      const text = _geminiText(cand);
      if (text.trim() === '') {
        const noText = _geminiNoText({ finishReason: cand?.finishReason, blockReason: data?.promptFeedback?.blockReason, maxTokens: null });
        _trackLLM('gemini', model, 0, Date.now() - _t0, false, { error: noText.message });
        throw noText;
      }
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
        _trackLLM('claude', model, 0, Date.now() - _t0, false, { status: response.status, error: `Claude vision error ${response.status}: ${errBody}` });
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

  // What an attempt carries beyond its status, for the one-line summary.
  const _attemptExtras = (cand, e) => ({
    ...(cand?.paidFrom ? { label: `openrouter (${cand.model})` } : {}),
    // Which OpenRouter model failed decides the next step: a paid one out of
    // credits means "pick a free one"; a free one out of credits does not.
    ...(cand?.provider === 'openrouter' && cand.model ? { model: cand.model } : {}),
    ...(e?.code ? { code: e.code } : {}),
    ...(e?.localRuntime ? { localRuntime: true } : {}),
    ...(e?.localThrottle ? { localThrottle: true, rpm: e.rpm } : {}),
  });

  // The blocking twin of the stream loop's recovery. One candidate, then — for
  // the two failures that are about the model or the request rather than the
  // provider — the same connection once more: a free model after a paid 402,
  // less context after "too large". `run(c, o)` answers. Returns
  // { ok, out | error, cand } so the caller rests and records by the candidate
  // the attempt ended on (an error never carries the candidate — it holds a key).
  const _runRecovering = async (c, run, prompt, opts, attempts, configured) => {
    let cur = c;
    let o = opts;
    let trimmed = false;
    if (cur.paidFrom) notify(`↪ ${_paidNotice(cur.paidFrom)}`, { provider: cur.provider });
    for (;;) {
      try {
        return { ok: true, out: await run(cur, o), cand: cur };
      } catch (e) {
        const status = _failureStatus(e);
        if (_paidOutOfCredits(cur, status)) {
          _restPaid(cur.provider, cur.model, e.message);
          attempts.push({ provider: cur.provider, status, message: e.message, ...(configured !== undefined ? { configured } : {}), label: `openrouter (${cur.model})`, model: cur.model });
          const free = await _freeModelFor(cur);
          notify(`↪ ${_paidNotice(cur.model)}`, { provider: cur.provider });
          cur = { ...cur, model: free, paidFrom: cur.model, ...(cur.resolved ? { resolved: { ...cur.resolved, model: free } } : {}) };
          continue;
        }
        // The blocking local transport sends the prompt alone, which is kept
        // whole, so a trimmed retry there would repeat the same request.
        if (!trimmed && cur.provider !== 'local' && _isTooLarge(e, status)) {
          const system = o.system ? [{ role: 'system', content: String(o.system) }] : [];
          const turns = Array.isArray(o.messages)
            ? o.messages
            : [{ role: 'user', content: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }];
          const budget = await _trimBudget(cur, e, o);
          const cut = _trimMessages([...system, ...turns], budget.promptTokens);
          if (cut) {
            trimmed = true;
            const [sys, ...rest] = cut.messages;
            o = {
              ...o, system: sys.content,
              ...(Array.isArray(o.messages) ? { messages: rest } : {}),
              ...(budget.maxTokens ? { max_tokens: budget.maxTokens } : {}),
            };
            console.warn(`[KERNEL] ${cur.provider} request too large (~${cut.before} tokens: ${_redactKeys(e.message).slice(0, 160)}); retrying with ~${cut.after}`);
            notify(`↪ ${_tooLargeNotice(cur.provider)}`, { provider: cur.provider });
            continue;
          }
        }
        return { ok: false, error: e, cand: cur };
      }
    }
  };

  const kernelLLM = async (prompt, opts = {}) => {
    const role = opts.role || 'chat';
    if (!opts.system) opts = { ...opts, system: AEON_SYSTEM };
    opts = { ...opts, role };

    if (_isCloud()) opts = { ...opts, _vercelStrict: true };

    // Local only — the same refusal the stream path gives (_streamCandidates).
    const settingsAtStart = _settingsNow();
    const localOnly = _localOnly(settingsAtStart, opts);
    const named = _namedProvider(settingsAtStart, role, opts);
    if (localOnly && named && !_mayBeLocal(named)) throw _localOnlyRefusal(role, named, !!opts.provider, opts);

    // ── Registry path (preferred) ──
    // Its failure is kept. It used to be logged and dropped, so when nothing
    // else could serve, the operator read the LAST rung's error — "No local
    // model is installed and no cloud provider is configured" — for a
    // configured provider that was rate-limited for a minute.
    let registryErr = null;
    let registryAttempt = null;
    // A paid OpenRouter model's 402, recorded before the free model's outcome.
    const preAttempts = [];
    // A provider the chain below does not carry (custom, lmstudio, openai…) is
    // resolved from the registry too; the chain skipped it and then reported
    // "No local model is installed" for a configured endpoint (agent C2).
    const namedRegistryProvider = opts.provider && !LEGACY_CHAIN_PROVIDERS.has(opts.provider);
    if (aeonEndpoints && ((!opts.provider && !opts.model) || namedRegistryProvider)) {
      let r = null;
      try {
        r = namedRegistryProvider
          ? await aeonEndpoints.resolveForProvider(opts.provider, opts.model, supabase)
          : await _resolveDeclared(role, loadSettings());
      }
      catch (e) { console.warn(`[KERNEL] registry resolve(${opts.provider || role}) fell back:`, e.message); }
      if (namedRegistryProvider && r && !r.ok) {
        registryErr = new Error(r.error);
        registryAttempt = { provider: opts.provider, status: null, message: r.error, configured: false };
      }
      if (r && r.ok && localOnly && !_isLocalCandidate(r)) {
        // As in _streamCandidates: a named connection at a non-local address
        // is refused; an auto-pick is dropped and the chain below serves Local.
        if (named && named !== 'local') throw _localOnlyRefusal(role, named, !!opts.provider, opts);
        r = null;
      }
      if (r && r.ok) {
        if (r.via === 'relay') {
          throw new Error(`Model "${r.model}" is desktop-only; relay required (desktop must be online).`);
        }
        // A resting registry provider is skipped while another can serve —
        // the same rule the chain below applies to every other provider.
        if (isHealthy(r.provider) || !_anotherCanServe(r.provider, localOnly)) {
          const rc = { ...r };
          await _applyPaidRest(rc);
          const res = await _runRecovering(rc, (cand, o) => _dispatchResolved(prompt, cand, o), prompt, opts, preAttempts, true);
          if (res.ok) {
            noteProviderSuccess(r.provider);
            return opts.returnMeta
              ? { text: res.out, provider: r.provider, model: res.cand.model, ...(res.cand.paidFrom ? { fallback: true } : {}) }
              : res.out;
          }
          const e = res.error;
          const status = _failureStatus(e);
          if (status === 429 || status === 402) markUnhealthy(r.provider, status, e.message);
          else if (!_isTooLarge(e, status)) noteProviderFailure(r.provider, e);
          registryErr = e;
          registryAttempt = { provider: r.provider, status: status || null, message: e.message, configured: true, ..._attemptExtras(res.cand, e) };
          // A registry failure is otherwise narrated only by the answer that
          // follows. The operator's own limit is theirs to change, so say so.
          if (e?.localThrottle) notify(`↪ ${r.provider} ${_plainReason(e)} — trying the next provider`, { provider: r.provider });
          console.warn(`[KERNEL] registry ${r.provider} failed (${e.message.slice(0, 120)}), trying the chain`);
        }
      }
    }

    // ── Legacy settings path (fallback / explicit override) ──
    const settings = loadSettings();
    const declared = _declaredFor(settings.models, role);
    const roleConfig = declared || { provider: 'local', model: undefined };
    const provider = opts.provider || roleConfig.provider;
    // A caller that names a provider but no model (the kill-switch's
    // {provider:'local'}) gets that provider's default, not the model the
    // role declares for a DIFFERENT provider — Local was asked to load the
    // chat role's cloud model and answered "not ready".
    const model = opts.model || (opts.provider && opts.provider !== roleConfig.provider ? undefined : roleConfig.model);

    // The registry already asked Claude and AEON stopped waiting on the
    // operator's own limit. This branch carries no limit (opts has no
    // rpm_limit, the key comes from the env pool), so asking again would send
    // the request the limit exists to hold back.
    const claudeAtLimit = registryAttempt?.provider === 'claude' && registryErr?.localThrottle;
    if (provider === 'claude' && !claudeAtLimit) {
      try {
        const text = await claudeRequest(prompt, model, undefined, opts.advisorModel, opts);
        noteProviderSuccess('claude');
        return opts.returnMeta ? { text, provider: 'claude', model } : text;
      } catch (e) {
        const status = _failureStatus(e);
        if (status === 429 || status === 402) markUnhealthy('claude', status, e.message);
        else noteProviderFailure('claude', e);
        // A caller that NAMED Claude (a Council seat) asked for Claude; another
        // provider's text would be shown and credited as Claude's (C35). Only
        // Claude assigned in Settings hands over to the chain below.
        if (opts.provider === 'claude') {
          // Rethrown raw, a Claude 429 reached POST /api/ai as a plain 500:
          // tagged the way the chain's own exhaustion error is, so the route
          // answers 429 and a caller can tell "wait" from "broken".
          if (status === 429) { e.rateLimited = true; e.provider = 'claude'; }
          throw e;
        }
        if (!registryErr) { registryErr = e; registryAttempt = { provider: 'claude', status: status || null, message: e.message, configured: true }; }
        notify(`↪ claude ${_reasonWithStatus(e)} — trying the next provider`, { provider: 'claude' });
      }
    }

    // A caller that named a provider with no connection asked for THAT
    // provider; answering from another would hide the missing connection.
    if (namedRegistryProvider && registryAttempt && registryAttempt.configured === false) throw registryErr;
    // The settings-named provider first (when the chain can call it), then
    // every other provider Settings declares, then local as the floor.
    const tried = registryAttempt ? [registryAttempt.provider] : [];
    const chain = [];
    // Local named on purpose — by the caller (a Council local seat, the
    // kill-switch) or by Settings (a role kept on-device) — is the provider,
    // not the floor. It went last, so every configured cloud provider answered
    // prompts the operator kept local, while the stream path kept it first
    // (C10). The install default ("nothing declared") stays the floor.
    const localChosen = provider === 'local' && !opts._vercelStrict
      && (opts.provider === 'local' || declared?.provider === 'local');
    // OpenAI assigned in Settings with only OPENAI_API_KEY (no connection):
    // readiness called it ready and the stream path served it, but this chain
    // could not dispatch it, so every non-stream call went to a fallback.
    const openaiFromEnv = provider === 'openai' && !!_legacyKeyFor('openai');
    if ((_ENV_CHAIN.includes(provider) || localChosen || openaiFromEnv) && !tried.includes(provider)) chain.push({ provider, model, source: 'settings' });
    chain.push(...await _fallbackCandidates(settings, [...tried, provider], opts));
    if (!opts._vercelStrict && !chain.some((c) => c.provider === 'local')) {
      chain.push({ provider: 'local', model: provider === 'local' ? model : undefined, source: 'fallback' });
    }
    let lastErr = null;
    // Every failure in the chain, so the thrown error can name the real cause
    // rather than whichever provider happened to be tried last. See P8c below.
    const attempts = [...preAttempts, ...(registryAttempt ? [registryAttempt] : [])];
    let prev = registryAttempt ? registryAttempt.provider : null;
    // A caller that NAMED Local — a Council local seat, the /api/chat
    // kill-switch past its spend threshold — asked for this computer. Handing
    // its turn to the cloud showed a cloud model's words as the local model's,
    // or spent exactly what the kill-switch exists to stop: C35's rule, for
    // Local. Local declared in Settings still hands over; Local asked for by
    // name is tried even while resting, and its failure is the answer.
    const namedLocal = opts.provider === 'local' && !opts._vercelStrict;
    for (const c of chain) {
      const p = c.provider;
      if (namedLocal && p !== 'local') continue;
      if (!isHealthy(p) && !namedLocal) continue;
      if (p === 'local' && !localRuntimePresent()) {
        // Not a failure of a provider: nothing is installed to try.
        continue;
      }
      // The model the env-key OpenRouter rung would ask for, made explicit so
      // a 402 on it is read as the paid model it is.
      if (p === 'openrouter' && !c.resolved && !c.model) c.model = 'openai/gpt-4o-mini';
      await _applyPaidRest(c);
      const res = await _runRecovering(c, async (cand, o) => {
        if (cand.resolved) return { text: await _dispatchResolved(prompt, cand.resolved, o), model: cand.resolved.model };
        const m = cand.model;
        if (p === 'groq') return { text: await groqRequest(prompt, m || 'openai/gpt-oss-120b', 0, o), model: m };
        if (p === 'gemini') return { text: await geminiRequest(prompt, m || 'gemini-flash-latest', 0, o), model: m };
        if (p === 'openrouter') return { text: await openRouterRequest(prompt, m, o), model: m };
        if (p === 'openai') {
          const om = m || 'gpt-4o-mini';
          return { text: await genericOpenAIRequest(prompt, om, aeonEndpoints?.PROVIDER_TRANSPORT?.openai?.base || 'https://api.openai.com/v1', _legacyKeyFor('openai'), o), model: om };
        }
        if (p === 'local') {
          // The runtime names the model it loaded. Asked with the caller's
          // returnMeta it answered {text, model}, returned below as the text
          // of a second wrapper — the kill-switch's local answer was an object.
          const r = await localNativeRequest(prompt, m, { ...o, returnMeta: true });
          return { text: r.text, model: r.model || m };
        }
        return null;
      }, prompt, opts, attempts);
      if (res.ok) {
        if (!res.out || res.out.text === undefined) continue;
        const { text, model: usedModel } = res.out;
        noteProviderSuccess(p);
        if (p !== provider) notify(`↪ ${role} answered by ${p}/${usedModel || 'default'}`, { provider: p });
        return opts.returnMeta ? { text, provider: p, model: usedModel, fallback: p !== provider || !!res.cand.paidFrom } : text;
      }
      const e = res.error;
      lastErr = e;
      const status = _failureStatus(e);
      if (status === 429 || status === 402) markUnhealthy(p, status, e.message);
      // Too large is the request, not the provider: no rest, no streak.
      else if (!_isTooLarge(e, status)) noteProviderFailure(p, e);
      attempts.push({ provider: p, status: status ? Number(status) : null, message: e.message, ..._attemptExtras(res.cand, e) });
      if (prev !== p) notify(`↪ ${p} ${_reasonWithStatus(e)} — trying the next provider`, { provider: p });
      prev = p;
      console.warn(`[KERNEL] ${p} failed (${e.message.slice(0, 120)}), trying next provider`);
    }

    if (namedLocal) throw lastErr || _noLocalModelError();
    // The configured (registry) provider's failure is the cause; a later rung
    // that could not even start ("no local model is installed") is not.
    // Under Local only, Local not being installed is the whole answer.
    throw _chainExhaustedError(attempts, registryErr || lastErr || (localOnly ? _noLocalModelError() : null), { localOnly });
  };

  // One attempt in words. A bare status keeps the provider's body out of the
  // phrase (a Gemini 429 body mentions "billing" and is still a rate limit),
  // except for a 400, whose status alone says nothing: Gemini's rejected key
  // is a 400 that only its body names (A041).
  // A local attempt keeps its body and code: llama-server's 400 "exceeds the
  // available context size" and the runtime's own CONTEXT_EXHAUSTED say what a
  // bare status cannot.
  const _attemptReason = (a) => _plainReason(a.status && a.status !== 400 && !a.localRuntime
    ? a.status
    : { status: a.status || null, message: a.message || '', code: a.code, localRuntime: a.localRuntime, localThrottle: a.localThrottle, rpm: a.rpm });
  const _attemptName = (a) => a.label || a.provider;

  // The one step most likely to get the next turn answered, for the causes
  // the chain actually met — never a raw body.
  const _nextStep = (attempts, o = {}) => {
    const seen = attempts.map((a) => ({ a, why: _attemptReason(a) }));
    const has = (why, p) => seen.find((x) => x.why === why && (!p || x.a.provider === p));
    const orBroke = seen.filter((x) => x.why === 'out of credits' && x.a.provider === 'openrouter');
    if (orBroke.some((x) => _isFreeOpenRouterModel(x.a.model))) {
      return 'Add OpenRouter credits — its free models were refused too — or assign another provider in Settings → Models.';
    }
    if (orBroke.length) {
      return "Pick a ':free' OpenRouter model for this role in Settings → Models, or add OpenRouter credits.";
    }
    const broke = has('out of credits');
    if (broke) return `Add credits for ${broke.a.provider}, or pick a free model in Settings → Models.`;
    const rejected = has('key rejected');
    if (rejected) return `Re-enter the ${rejected.a.provider} key in Settings → Keys.`;
    if (has('tried a native tool call')) return 'Ask again, or assign a different model for this role in Settings → Models.';
    if (has('request too large for it')) {
      return 'Start a new chat, send a shorter message, or lower "Most memories per turn" in Settings → Blocks → Memory Core.';
    }
    if (has('no chat model running') || has('no chat model installed') || has('no local engine installed') || has('stopped responding')) {
      return o.localOnly ? 'Check the local model in Cookbook.' : 'Check the local model in Cookbook, or add a key or credits in Settings.';
    }
    const atLimit = seen.find((x) => x.a.localThrottle);
    if (atLimit) return `Raise or clear the requests-per-minute limit on ${atLimit.a.provider} in Settings → Keys, or try again in a minute.`;
    return 'Add a key or credits in Settings, or try again shortly.';
  };

  // BO-SHIP P8c — say which provider failed and why.
  //
  // This used to throw `lastErr`: the error from the LAST provider in the
  // chain, which is `local`. So a configured, working Groq key that had
  // simply hit its per-minute token limit produced
  //
  //     "No local model is installed and no cloud provider is configured.
  //      Install a local model in Cookbook, or add a provider key."
  //
  // — a permanent-sounding configuration error, telling the operator to add a
  // key they already had, for a condition that clears in seconds. Found by
  // driving /write three times against a live server on a Groq free tier:
  // call one succeeded, calls two and three "had no provider".
  //
  // A transient throttle and an unconfigured install are different states
  // with different remedies. The old comment asserted this was always "a
  // configuration state, not an internal fault"; that is only true when
  // nothing was actually configured.
  //
  // Shared by kernelLLM and kernelLLM.stream so a streaming chat and a blocking
  // call report the same failure the same way.
  function _chainExhaustedError(attempts, lastErr, o = {}) {
    const throttled = attempts.find((a) => a.status === 429);
    // AEON's own wait ran out against the operator's limit. Not a provider that
    // is down, and not "add a key": the remedy is the number in Settings → Keys.
    const atLimit = attempts.find((a) => a.localThrottle);
    if (atLimit && !throttled) {
      const others = attempts.filter((a) => a !== atLimit).map((a) => `${_attemptName(a)} ${_attemptReason(a)}`).join(', ');
      const err = new Error(
        `${atLimit.provider} is at your limit of ${atLimit.rpm} requests/min (Settings → Keys)`
        + (others ? `, and the other providers in the chain could not serve either: ${others}. ` : '. ')
        + `${_nextStep(attempts, o)}`
      );
      err.rateLimited = true;
      err.provider = atLimit.provider;
      err.retryable = true;
      err.localThrottle = true;
      err.attempts = attempts;
      return err;
    }
    if (throttled) {
      const err = new Error(
        `${throttled.provider} is rate-limited right now (HTTP 429). This is temporary — `
        + `retry in a few seconds. Other providers in the chain could not serve either: `
        // Parenthesised: the || used to bind to the whole (never-empty) string,
        // so the message ended on "either: " (agent C2, 2026-09-23).
        + (attempts.filter((a) => a !== throttled)
          .map((a) => `${_attemptName(a)} ${_attemptReason(a)}`).join(', ') || 'none configured')
      );
      err.rateLimited = true;
      err.provider = throttled.provider;
      err.retryable = true;
      // Deliberately NOT noProviderAvailable: a provider IS available, and
      // sending the operator to Settings would be sending them nowhere.
      return err;
    }

    // Local only, and the only thing that failed is Local not being
    // installed: that sentence is the answer.
    if (o.localOnly && lastErr?.localOnly && attempts.every((a) => a.provider === 'local')) {
      lastErr.noProviderAvailable = true;
      lastErr.attempts = attempts;
      return lastErr;
    }

    // Every candidate provider was tried and none could serve. That is a
    // configuration state, not an internal fault — a clean install with no API
    // keys and no local chat model lands here on the very first request. The
    // router turns this flag into a 503 so the caller gets an actionable
    // "nothing is configured" instead of a bare 500.
    let exhausted = lastErr || new Error('No LLM provider available (check API keys in Settings)');
    // Only runtime failures of configured providers are summarised; "no such
    // connection" is already the actionable sentence and keeps its words.
    if (attempts.some((a) => a.configured !== false)) {
      // One line per provider, in words — the raw bodies are in the server log.
      const summary = attempts.map((a) => `${_attemptName(a)} ${_attemptReason(a)}`).join(', ');
      // "Add a key" is the wrong remedy when Local only kept every cloud key out.
      const plain = new Error(o.localOnly
        ? `Local only is on, so no cloud model was tried, and the local one could not answer — ${summary}. Check the local model in Cookbook, or turn Local only off in Settings → Models.`
        : `No provider could answer right now — ${summary}. ${_nextStep(attempts, o)}`);
      plain.cause = exhausted;
      if (exhausted.partialText) plain.partialText = exhausted.partialText;
      exhausted = plain;
    }
    // A configured provider that ran and failed is not "nothing is configured":
    // the router turns that flag into "assign a model in Settings", which is the
    // wrong remedy for a provider that answered with an error or ran out of
    // budget. Only an install where nothing configured could run gets it.
    if (attempts.some((a) => a.configured)) exhausted.providerFailed = true;
    else exhausted.noProviderAvailable = true;
    exhausted.attempts = attempts;
    return exhausted;
  }

  // Streaming rides on the same function object every block already holds, so
  // a block that was handed `kernelLLM` can stream without a new dependency.
  kernelLLM.stream = kernelLLMStream;
  kernelLLM.describeRole = describeRole;
  kernelLLM.cancelAll = cancelAll;

  return {
    kernelLLM, kernelLLMStream, describeRole, cancelAll,
    kernelVision, geminiRequest, groqRequest, localNativeRequest, openRouterRequest, claudeRequest,
    GEMINI_KEY_POOL, _trackLLM, _llmTelemetry, setActivityRecorder,
    getDailyCost, addRunCost,
    KILL_SWITCH_THRESHOLD, GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    getProviderHealth, _resetProviderHealth, _chainExhaustedError, getKeyPoolInfo, dehydrateProvider, forgetKey, hydrateEnvFromVault,
    defaultLocalModel, localRuntimePresent,
    envHydrated,
  };
};
