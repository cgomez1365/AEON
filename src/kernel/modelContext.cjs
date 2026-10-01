/**
 * How many input tokens does this provider's model accept?
 *
 * The memory, skill and recall budgets of a chat turn are fractions of the
 * model's context window (tokens.cjs inputBudgets). For cloud models that
 * window used to be a flat 8,192 — "cloud windows are big, a small floor is
 * safe" — but the budget is computed FROM the window, so the floor capped the
 * injection itself: a model serving 1,000,000 tokens got ~980 tokens of
 * memory, and the chat said memories it had indexed were not in context.
 *
 * This module asks the provider. Every catalogue AEON talks to publishes the
 * window on its /models rows under one of a handful of field names; one GET
 * returns the whole list, so every model in it is cached at once (roles often
 * use different models from the same provider).
 *
 * The answer is a positive integer or null. Null means "unknown — keep your
 * own floor"; it is never a size. An overstated window builds prompts the
 * provider rejects, while an unknown one only means a smaller injection than
 * was possible, so every doubt resolves to null.
 *
 * Rules this file keeps:
 *   - Kernel module: relative requires only, Node built-ins and global fetch.
 *   - Requiring it creates nothing. The cache path is resolved at load; the
 *     file is read on first use and its directory made only when written.
 *   - Quiet. It sits on the path of every chat turn: it never throws to its
 *     caller, never logs a provider error or a key, never speaks to the
 *     operator. Every failure is a null.
 *   - A key only ever goes to the host it belongs to: redirects are never
 *     followed, and Gemini (key in the query string) is only ever asked at
 *     Google's own address, whatever base_url a caller passes.
 *
 * Cache: <data>/model-context.json
 *   { "schema": 1,
 *     "models": { "<provider>|<model>": { "tokens": 131072|null, "at": <ms>, "why"?: "..." } } }
 * Read once per process; after that the in-memory copy is authoritative.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { roots } = require('./aeonHome.cjs');

// A known window is re-checked monthly: providers sometimes re-point a model
// name at a newer build.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A provider that publishes nothing must not be asked on every turn, but a
// model the operator just added deserves a fresh look the same working day.
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
// Real models fall inside this band; anything outside it is bad catalogue
// data, and an absurd value would size prompts the provider then refuses.
const MIN_SANE = 1024;
const MAX_SANE = 4000000;
// Same budget endpoints.cjs gives model discovery.
const FETCH_TIMEOUT_MS = 8000;

const CACHE_FILE = path.join(roots({ appRoot: path.join(__dirname, '..', '..') }).data, 'model-context.json');

// Public catalogue bases, as endpoints.cjs PROVIDER_TRANSPORT lists them.
// Copied rather than required: endpoints.cjs creates its secrets directory at
// require time, and this module must create nothing when loaded.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const OPENAI_STYLE_BASES = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
};

// Where each catalogue reports the window, most specific first.
const WINDOW_FIELDS = [
  (r) => r.context_length,                 // OpenRouter, many OpenAI-compatible servers
  (r) => r.context_window,                 // Groq
  (r) => r.max_input_tokens,               // Anthropic
  (r) => r.inputTokenLimit,                // Gemini
  (r) => r.max_context_length,             // other OpenAI-compatible servers
  (r) => r.n_ctx,                          // llama.cpp-based servers
  (r) => r.top_provider?.context_length,   // OpenRouter's per-provider copy
];

const MISS_UNREACHABLE = 'provider unreachable or published nothing';
const MISS_UNLISTED = "not in this provider's list";

/** The window one catalogue row reports, or null. Pure. */
function windowFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  for (const read of WINDOW_FIELDS) {
    const n = Number(read(row));
    // Number(undefined) is NaN, Number(null) and Number('') are 0 — all fail
    // the range test, so a missing or blank field is simply skipped.
    if (Number.isFinite(n) && n >= MIN_SANE && n <= MAX_SANE) return Math.floor(n);
  }
  return null;
}

/** A row's model id, with Gemini's "models/" prefix removed. */
function rowId(row) {
  let id = null;
  if (typeof row === 'string') id = row;
  else if (row && typeof row === 'object') {
    const v = row.id ?? row.name ?? row.model;
    if (typeof v === 'string') id = v;
  }
  if (!id) return null;
  return id.startsWith('models/') ? id.slice('models/'.length) : id;
}

function cacheKey(provider, model) {
  return `${provider || '?'}|${model || '?'}`;
}

// ── Cache ────────────────────────────────────────────────────────────────

let _cache = null;

function emptyCache() { return { schema: 1, models: {} }; }

function loadCache() {
  if (_cache) return _cache;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  const usable = parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models);
  _cache = usable ? { schema: 1, models: { ...parsed.models } } : emptyCache();
  return _cache;
}

// A failed write costs a re-fetch after the next restart and nothing else;
// the in-memory copy still serves this process. It must never fail a chat.
function saveCache() {
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2) + '\n');
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function fresh(entry, now) {
  if (!entry || !Number.isFinite(entry.at)) return false;
  const age = now - entry.at;
  if (Number.isFinite(entry.tokens) && entry.tokens > 0) return age < TTL_MS;
  if (entry.tokens == null) return age < MISS_TTL_MS;
  return false;
}

// ── Catalogue fetch ──────────────────────────────────────────────────────

function stripSlash(u) { return String(u).replace(/\/+$/, ''); }

/** { url, headers } for this provider's model list, or null when there is nowhere to ask. */
function catalogueRequest(provider, base_url, apiKey) {
  const key = apiKey ? String(apiKey) : '';
  if (provider === 'gemini') {
    // Never the caller's base_url: the key rides in the query string, so it
    // may only ever be sent to Google itself.
    return { url: `${GEMINI_BASE}/models?key=${encodeURIComponent(key)}`, headers: {} };
  }
  if (provider === 'claude' || provider === 'anthropic') {
    return {
      url: `${stripSlash(base_url || ANTHROPIC_BASE)}/models`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    };
  }
  const base = base_url || OPENAI_STYLE_BASES[provider];
  if (!base) return null;
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: `${stripSlash(base)}/models`, headers };
}

/** Map of model id → window, possibly empty; null when the provider could not be read. */
async function fetchCatalogue({ provider, base_url, apiKey }) {
  const req = catalogueRequest(provider, base_url, apiKey);
  if (!req) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    // redirect:'manual' — a 3xx comes back as itself (not OK) instead of
    // carrying the key on to wherever it points.
    const res = await fetch(req.url, { method: 'GET', headers: req.headers, redirect: 'manual', signal: ac.signal });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch {}
      return null;
    }
    const body = await res.json();
    if (body === null) return null;
    const rows = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models
          : [];
    const out = new Map();
    for (const row of rows) {
      const id = rowId(row);
      const tokens = windowFromRow(row);
      if (id && tokens) out.set(id, tokens);
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * The model's input window in tokens, or null when unknown.
 * Never rejects; a null always means "use your own fallback".
 */
async function lookup({ provider, model, base_url = null, apiKey = null } = {}) {
  try {
    if (!provider || !model) return null;
    // Local windows come from the local runtime's own plan, not a catalogue.
    if (provider === 'local') return null;

    const cache = loadCache();
    const key = cacheKey(provider, model);
    const now = Date.now();
    const hit = cache.models[key];
    if (fresh(hit, now)) return hit.tokens > 0 ? hit.tokens : null;

    const catalogue = await fetchCatalogue({ provider, base_url, apiKey });
    const at = Date.now();
    if (!catalogue) {
      cache.models[key] = { tokens: null, at, why: MISS_UNREACHABLE };
      saveCache();
      return null;
    }
    for (const [id, tokens] of catalogue) cache.models[cacheKey(provider, id)] = { tokens, at };
    const tokens = catalogue.get(model) || null;
    if (!tokens) cache.models[key] = { tokens: null, at, why: MISS_UNLISTED };
    saveCache();
    return tokens;
  } catch {
    return null;
  }
}

/** The cached window for a pair (any age), or null. Sync, no network — for diagnostics. */
function peek(provider, model) {
  try {
    const entry = loadCache().models[cacheKey(provider, model)];
    return entry && Number.isFinite(entry.tokens) && entry.tokens > 0 ? entry.tokens : null;
  } catch {
    return null;
  }
}

module.exports = { lookup, peek, windowFromRow, CACHE_FILE, TTL_MS, MIN_SANE, MAX_SANE };
