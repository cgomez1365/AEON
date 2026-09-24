/**
 * How large is this model's context window, really?
 *
 * The memory and skill budgets are FRACTIONS of the window they spend from
 * (src/kernel/tokens.cjs, inputBudgets). That design scales by itself — but
 * only if it is told the truth about the window.
 *
 * It was not. services/ai.js describeRole() asked the local runtime for a real
 * number and then returned a flat 8,192 for every cloud model, with the
 * reasoning that "cloud windows are far larger than anything injected, so 8k is
 * a safe floor". That is backwards, and it is the whole defect: the injection
 * is DERIVED from the assumed window. 8,192 x 0.12 is 983 tokens of memory —
 * about six or seven memories — no matter how large the model actually is.
 *
 * Measured on the operator's own setup: `nvidia/nemotron-3-ultra-550b-a55b:free`
 * serves **1,000,000** tokens. AEON was using 0.8% of it and answering "not in
 * current context" about memories that were sitting right there. The floor
 * meant to protect the window was capping the thing it protected.
 *
 * So: ask the provider. Every one of them publishes the number in its own model
 * list, under its own name.
 *
 *   OpenAI-compatible (OpenRouter)  context_length
 *   Groq                            context_window
 *   Gemini                          inputTokenLimit
 *   Anthropic                       max_input_tokens
 *
 * The answer is cached on disk, because a context window is a property of the
 * model and does not change between turns. A miss is never fatal and never
 * slow twice: the caller keeps its own fallback, and the failure is remembered
 * so a provider that does not publish the number is not re-asked on every
 * message.
 *
 * Kernel module: relative requires only, no reach into services/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_PATH || require('./aeonHome.cjs').roots({ appRoot: ROOT }).data;
const CACHE_FILE = path.join(DATA_DIR, 'model-context.json');

// A model's window is fixed for as long as the name means the same thing.
// Providers do re-point a name at a new build, so this is not forever.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A provider that does not publish the number should not be asked again on the
// next message. Short enough that adding a model and retrying is not a day's
// wait; long enough that a chat is not making a network call per turn.
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

// Beyond this a "window" is a catalogue error, not a model. Nothing serves
// more than a few million tokens, and a bad number here would size the memory
// budget at something that cannot be sent.
const MAX_SANE = 4_000_000;
const MIN_SANE = 1_024;

const FETCH_TIMEOUT_MS = 8_000;

let memo = null;   // the cache, read once per process

function readCache() {
  if (memo) return memo;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    memo = raw && typeof raw === 'object' && raw.models ? raw : { schema: 1, models: {} };
  } catch {
    memo = { schema: 1, models: {} };
  }
  return memo;
}

function writeCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(memo, null, 2));
  } catch {
    // A cache that cannot be written still works for this process. Losing it
    // costs one network call next boot, which is not worth failing a chat over.
  }
}

const key = (provider, model) => `${provider || '?'}|${model || '?'}`;

/**
 * The window size a provider's own model row is reporting, whatever it calls
 * it. Returns null when the row says nothing — which is different from a row
 * that says zero.
 */
function windowFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    row.context_length,        // OpenRouter and most OpenAI-compatible servers
    row.context_window,        // Groq
    row.max_input_tokens,      // Anthropic
    row.inputTokenLimit,       // Gemini
    row.max_context_length,
    row.n_ctx,                 // llama.cpp servers
    row?.top_provider?.context_length,   // OpenRouter nests a second copy
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= MIN_SANE && n <= MAX_SANE) return Math.floor(n);
  }
  return null;
}

function rowId(row) {
  if (typeof row === 'string') return row;
  const raw = row?.id || row?.name || row?.model;
  return typeof raw === 'string' ? raw.replace(/^models\//, '') : null;
}

/**
 * Every model this provider publishes, as { id: windowTokens }.
 *
 * Deliberately a separate, smaller fetcher than endpoints.cjs
 * discoverModelCatalogue: that one is the operator-facing one and owns error
 * sentences, ordering and free-tier detection. This one runs behind a chat turn
 * and must be silent — any failure is a null, never a thrown error and never a
 * message the operator has to read mid-conversation.
 */
async function fetchCatalogue({ provider, base_url, apiKey }) {
  let url = null;
  let headers = {};

  if (provider === 'gemini') {
    // Gemini puts the key in the query string, which is why this is the one
    // provider endpoints.cjs refuses to pair with a custom address. Same rule
    // here: only its own base, never an operator-supplied one.
    const base = 'https://generativelanguage.googleapis.com/v1beta';
    url = `${base}/models?key=${encodeURIComponent(apiKey || '')}`;
  } else if (provider === 'claude' || provider === 'anthropic') {
    url = `${base_url || 'https://api.anthropic.com/v1'}/models`;
    headers = { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' };
  } else {
    const base = base_url || defaultBase(provider);
    if (!base) return null;
    url = `${base.replace(/\/$/, '')}/models`;
    if (apiKey) headers = { Authorization: `Bearer ${apiKey}` };
  }

  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',   // a 3xx must not carry the key to another host
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d) return null;
    const rows = Array.isArray(d) ? d
      : (Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []));
    const out = {};
    for (const row of rows) {
      const id = rowId(row);
      const win = windowFromRow(row);
      if (id && win) out[id] = win;
    }
    return out;
  } catch {
    return null;   // silent on purpose: this runs behind a chat turn
  }
}

function defaultBase(provider) {
  return {
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    openai: 'https://api.openai.com/v1',
    grok: 'https://api.x.ai/v1',
  }[provider] || null;
}

/**
 * The context window for one model, or null when nothing reliable is known.
 *
 * Null means "keep your own fallback" — it never means zero, and the caller
 * must not treat it as a window. A wrong large number would size a prompt that
 * the provider then refuses; a null costs one conservative turn.
 */
async function lookup({ provider, model, base_url = null, apiKey = null } = {}) {
  if (!provider || !model || provider === 'local') return null;

  const cache = readCache();
  const k = key(provider, model);
  const hit = cache.models[k];
  const now = Date.now();

  if (hit) {
    const age = now - (hit.at || 0);
    if (hit.tokens && age < TTL_MS) return hit.tokens;
    if (!hit.tokens && age < MISS_TTL_MS) return null;   // a remembered miss
  }

  const catalogue = await fetchCatalogue({ provider, base_url, apiKey });
  if (!catalogue) {
    cache.models[k] = { tokens: null, at: now, why: 'provider unreachable or published nothing' };
    writeCache();
    return null;
  }

  // Cache the whole catalogue, not only the model asked about: the fetch is
  // already paid for, and the operator's next role uses a different model from
  // the same provider more often than not.
  for (const [id, tokens] of Object.entries(catalogue)) {
    cache.models[key(provider, id)] = { tokens, at: now };
  }
  if (!catalogue[model]) {
    cache.models[k] = { tokens: null, at: now, why: 'not in this provider\'s list' };
  }
  writeCache();
  return catalogue[model] || null;
}

/** What is known right now, without asking anyone. For diagnostics. */
function peek(provider, model) {
  const hit = readCache().models[key(provider, model)];
  return hit && hit.tokens ? hit.tokens : null;
}

module.exports = { lookup, peek, windowFromRow, CACHE_FILE, TTL_MS, MIN_SANE, MAX_SANE };
