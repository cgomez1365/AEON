/**
 * AEON Endpoint Registry + Resolver.
 *
 * The single source of truth for "what models exist and how to reach them."
 * Connection metadata is safe to persist/sync (no raw keys — secrets live in
 * the vault, referenced by auth_ref). The resolver picks the right endpoint
 * for a role given WHERE the code is running (desktop vs Vercel) and whether
 * each endpoint is reachable from there.
 *
 *   endpoint = {
 *     id, label, kind: 'cloud'|'local', provider,
 *     base_url, auth_ref|null, models: [],
 *     reachable_from: ['local'] | ['cloud'] | ['local','cloud']
 *   }
 *
 * Role assignment (global) maps a role → { endpoint_id, model, cloud_fallback? }.
 */
const fs = require('fs');
const path = require('path');
const vault = require('./vault.cjs');

const isVercel = require('./runtime.cjs').isCloud();
const APP_ROOT = path.join(__dirname, '..', '..');
// Honors AEON_SECRETS_DIR, same as vault.cjs:22. Without this the endpoint
// registry stays pinned to the install dir while the vault follows the env —
// on a portable/USB install that splits secrets across two filesystems.
const SECRETS_DIR = process.env.AEON_SECRETS_DIR || path.join(APP_ROOT, 'secrets');
try { if (!isVercel) fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch {}
const REG_FILE = path.join(SECRETS_DIR, 'aeon-endpoints.json');
const REG_ROW_ID = 1;

// Single source of truth for the local LM Studio host (env-overridable). Settings
// and the transport profile below both resolve through this, so the default lives
// in exactly one place instead of being hardcoded per call site. (BO7)
function lmStudioHost() {
  return process.env.LMSTUDIO_HOST || 'http://localhost:1234';
}

// True when AEON is running from portable/USB media: no cloud keys expected,
// every role resolves local, and no outbound provider probing on boot.
function isPortable() {
  return process.env.AEON_PORTABLE === 'true';
}

// ── Provider transport profiles (how to actually call them) ──────────
const PROVIDER_TRANSPORT = {
  groq:   { style: 'openai', base: 'https://api.groq.com/openai/v1', list: '/models',     reach: ['local', 'cloud'] },
  openai: { style: 'openai', base: 'https://api.openai.com/v1',      list: '/models',     reach: ['local', 'cloud'] },
  gemini: { style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', list: '/models', reach: ['local', 'cloud'] },
  claude: { style: 'anthropic', base: 'https://api.anthropic.com/v1', list: '/models',    reach: ['local', 'cloud'] },
  grok:   { style: 'openai', base: 'https://api.x.ai/v1',             list: '/models',    reach: ['local', 'cloud'] },
  openrouter: { style: 'openai', base: 'https://openrouter.ai/api/v1', list: '/models', reach: ['local', 'cloud'] },
  local:  { style: 'local',  base: null,                              list: null,          reach: ['local'] },
  lmstudio: { style: 'openai', base: `${lmStudioHost()}/v1`,          list: '/models',     reach: ['local'] },
};

function defaultRegistry() {
  return { endpoints: [], roles: {}, updated_at: null };
}

// ── Storage (local file + Supabase mirror) ───────────────────────────
function readLocal() {
  if (!fs.existsSync(REG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch { return null; }
}
function writeLocal(reg) {
  const tmp = REG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REG_FILE);
}
async function readCloud(supabase) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from('aeon_endpoints').select('registry').eq('id', REG_ROW_ID).maybeSingle();
    return data?.registry || null;
  } catch { return null; }
}
async function writeCloud(supabase, reg) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('aeon_endpoints')
      .upsert({ id: REG_ROW_ID, registry: reg, updated_at: new Date().toISOString() });
    return !error;
  } catch { return false; }
}

/** Load the registry. Vercel sources cloud-first; desktop local-first. */
async function load(supabase) {
  const reg = isVercel
    ? (await readCloud(supabase)) || readLocal() || defaultRegistry()
    : readLocal() || (await readCloud(supabase)) || defaultRegistry();
  if (!reg.endpoints) reg.endpoints = [];
  if (!reg.roles) reg.roles = {};
  return reg;
}

async function save(reg, supabase) {
  reg.updated_at = new Date().toISOString();
  if (!isVercel) writeLocal(reg);
  await writeCloud(supabase, reg);
  return reg;
}

// ── Registry mutations ───────────────────────────────────────────────
async function addEndpoint(ep, supabase) {
  const reg = await load(supabase);
  const profile = PROVIDER_TRANSPORT[ep.provider] || {};
  const endpoint = {
    id: ep.id || `${ep.provider}-${Date.now().toString(36)}`,
    label: ep.label || ep.provider,
    kind: ep.kind || (profile.reach && profile.reach.includes('cloud') ? 'cloud' : 'local'),
    provider: ep.provider,
    base_url: ep.base_url || profile.base || '',
    auth_ref: ep.auth_ref || null,
    models: ep.models || [],
    reachable_from: ep.reachable_from || profile.reach || ['local'],
  };
  reg.endpoints = reg.endpoints.filter(e => e.id !== endpoint.id);
  reg.endpoints.push(endpoint);
  await save(reg, supabase);
  return endpoint;
}

async function removeEndpoint(id, supabase) {
  const reg = await load(supabase);
  reg.endpoints = reg.endpoints.filter(e => e.id !== id);
  for (const [role, m] of Object.entries(reg.roles)) {
    if (m.endpoint_id === id) delete reg.roles[role];
  }
  await save(reg, supabase);
  return reg;
}

async function assignRole(role, endpoint_id, model, cloud_fallback, supabase) {
  const reg = await load(supabase);
  reg.roles[role] = { endpoint_id, model, cloud_fallback: cloud_fallback || null };
  await save(reg, supabase);
  return reg.roles[role];
}

// ── Discovery: probe an endpoint for its real model list ─────────────
async function discoverModels(provider, base_url, apiKey) {
  const profile = PROVIDER_TRANSPORT[provider] || {};
  const base = base_url || profile.base;
  const timeout = (ms) => new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms));
  try {
    if (profile.style === 'local') {
      try {
        const lr = require('../../services/local-runtime/index.cjs');
        return lr.status().readyModels.map(m => m.id);
      } catch { return []; }
    }
    if (profile.style === 'gemini') {
      const r = await Promise.race([fetch(`${base}/models?key=${apiKey}`), timeout(8000)]);
      const d = await r.json();
      return (d.models || []).map(m => m.name.replace('models/', ''));
    }
    if (profile.style === 'anthropic') {
      const r = await Promise.race([
        fetch(`${base}/models`, { headers: { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' } }),
        timeout(8000)
      ]);
      const d = await r.json();
      if (d.error) return { error: d.error.message || 'Anthropic auth failed' };
      return (d.data || []).map(m => m.id);
    }
    // openai-style (groq, openai, grok, lmstudio)
    const r = await Promise.race([
      fetch(`${base}/models`, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      timeout(8000)
    ]);
    const d = await r.json();
    return (d.data || []).map(m => m.id);
  } catch (e) {
    return { error: e.message };
  }
}

// ── One truth for "is this provider configured?" ─────────────────────
/**
 * BO-A4a. Two systems described the same providers:
 *
 *   - services/ai.js  isConfigured() → reads process.env
 *   - this file       the endpoint registry → reads the file + the vault
 *
 * On the operator's machine every provider key in .env is BLANK; the Groq key
 * lives in the vault and reaches process.env only through
 * hydrateEnvFromVault(). That function is async and is invoked at module load
 * WITHOUT await, so there is a real window during boot in which the registry
 * says a provider is configured and process.env says it is not.
 *
 * The window is observable, not theoretical: /core/provider-health calls
 * isConfigured(), and settings fetches provider-health on mount. A read landing
 * in that window reports "not configured" for a provider that is configured —
 * the same class as BO-F3, where AEON knew more about its own state than it
 * told the operator.
 *
 * So the registry is the truth and process.env is a hydration cache of it.
 * Sync, local-file only: this must be callable from the same places
 * isConfigured() already is.
 */
function isProviderConfigured(provider) {
  const reg = readLocal();
  if (!reg || !Array.isArray(reg.endpoints)) return false;
  return reg.endpoints.some(e => e.provider === provider && !!e.auth_ref);
}

// ── Auto-pick: which model on an endpoint can actually hold a conversation ──
/**
 * BO-A4. The previous rule was an ALLOW-list of model-name fragments:
 *
 *   /llama.*(versatile|instruct)|instruct|gpt-4|gemini|claude|chat/i
 *
 * `llama-3.1-8b-instant` matches none of it — "instant", not "instruct" — so
 * on an endpoint whose model list began with a transcription or guard model,
 * auto-pick handed the chat role a model that cannot chat. It worked in
 * practice only because the operator's registry happened to start with
 * `llama-3.3-70b-versatile`. That is ordering-dependent luck, not a rule.
 *
 * An allow-list of chat models is unmaintainable: every provider ships new
 * names monthly and each one is a silent failure until someone notices. The
 * intent was always the inverse — the comment at the call site said "prefer a
 * chat-capable model over transcription/guard models" — so this is a DENY-list
 * of the few model families that demonstrably cannot serve a chat turn.
 *
 * Unknown names are treated as chat-capable. That is the right default: a new
 * chat model works the day it ships, and the failure mode of a mistake here is
 * a visible bad answer rather than a silently skipped model.
 *
 * Used by BOTH resolveForRole (the router) and describeRoleLocal (the badge).
 * Fixing one and not the other would make the badge promise what the router
 * will not deliver — the precise defect class BO-F3 exists to remove.
 */
const NON_CHAT_MODEL_RE = /whisper|(^|[-_/])tts([-_]|$)|text-to-speech|embed|guard|moderation|rerank|stable-diffusion|sdxl|flux|dall-?e/i;

function pickChatModel(models) {
  const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m);
  // First model that is not a known non-chat family; else fall back to the
  // first entry, because returning nothing when an endpoint HAS models would
  // report "no model" for a merely unrecognised list.
  return list.find(m => !NON_CHAT_MODEL_RE.test(m)) || list[0] || null;
}

// ── RESOLVER: role → concrete { provider, model, base_url, key, via } ─
/**
 * Picks the endpoint for a role that is actually reachable from this runtime.
 *   runtime = 'cloud' on Vercel, 'local' on desktop.
 * Returns { ok, provider, model, base_url, apiKey, via } where `via` is
 * 'direct' or 'relay' (local-only model requested from cloud → needs desktop).
 */
async function resolveForRole(role, supabase) {
  const runtime = isVercel ? 'cloud' : 'local';

  // Portable/USB mode: every role resolves to the native local runtime, before the
  // registry is even consulted. A USB install has no cloud keys by design.
  // No cloud fallback is attempted — reaching for the network is exactly what
  // portable mode promises not to do.
  if (isPortable()) {
    const lrStatus = (() => { try { return require('../../services/local-runtime/index.cjs').status(); } catch { return null; } })();
    return {
      ok: true,
      provider: 'local',
      model: lrStatus?.readyModels?.[0]?.id || null,
      base_url: null,
      apiKey: null,
      via: 'direct',
      endpoint_id: 'portable-local',
      role,
    };
  }

  const reg = await load(supabase);
  let mapping = reg.roles[role] || reg.roles['chat'];

  // No explicit role mapping yet → auto-pick a reachable, keyed endpoint so a
  // freshly added connection works immediately, with no separate wiring step.
  // (Honors "add a key → it just works." Explicit role assignments still win.)
  if (!mapping) {
    const reachable = reg.endpoints.filter(e => e.reachable_from.includes(runtime));
    const candidate = reachable.find(e => e.auth_ref) || reachable[0];
    if (!candidate) return { ok: false, error: `No model assigned for role "${role}"` };
    // Prefer a chat-capable model over transcription/guard models.
    mapping = { endpoint_id: candidate.id, model: pickChatModel(candidate.models) };
  }
  if (!mapping.model) return { ok: false, error: `No model available on endpoint for role "${role}"` };

  const epById = (id) => reg.endpoints.find(e => e.id === id);
  let ep = epById(mapping.endpoint_id);
  let model = mapping.model;

  // If the primary endpoint isn't reachable from here, try the cloud fallback.
  if (ep && !ep.reachable_from.includes(runtime)) {
    if (mapping.cloud_fallback) {
      const fb = epById(mapping.cloud_fallback.endpoint_id);
      if (fb && fb.reachable_from.includes(runtime)) { ep = fb; model = mapping.cloud_fallback.model; }
      else ep = epById(mapping.endpoint_id); // keep primary, will route via relay
    }
  }
  if (!ep) return { ok: false, error: `Endpoint "${mapping.endpoint_id}" not found` };

  const apiKey = ep.auth_ref ? await vault.getSecret(ep.auth_ref, supabase) : null;
  const reachable = ep.reachable_from.includes(runtime);

  return {
    ok: true,
    provider: ep.provider,
    model,
    base_url: ep.base_url,
    apiKey,
    via: reachable ? 'direct' : 'relay',  // 'relay' → enqueue to desktop_commands
    endpoint_id: ep.id,
    role,
  };
}

/**
 * Can this role be served right now? Synchronous, local registry only.
 *
 * resolveForRole() is async because it awaits the Supabase mirror and unwraps
 * the API key from the vault. Readiness needs neither: it asks whether a role
 * maps to an endpoint carrying a model, which the local file already answers.
 * Keeping it sync is what lets checkReadiness() stay sync, which is what keeps
 * this change to two blocks instead of every caller in the tree.
 *
 * Mirrors resolveForRole's decision path deliberately — portable short-circuit,
 * explicit mapping, then the same auto-pick. If those two ever disagree, the
 * badge would promise something the router will not deliver, which is the exact
 * class of defect this build order exists to remove.
 *
 * @returns {{ok: boolean, provider?: string, model?: string, reason?: string}}
 */
/**
 * Env-var fallback for readiness when no endpoint registry exists.
 *
 * Ordered by what a fresh install is most likely to have working, and each
 * entry names a model the provider actually serves today — a readiness badge
 * that resolves to a model the router then 404s on is the BO-A5b defect, and
 * it is no less a defect for coming from the fallback path.
 *
 * This answers "can this install serve a turn at all", not "which model should
 * this role use". Once the operator adds a provider through Settings the
 * registry exists and this is never consulted again.
 */
const ENV_PROVIDER_FALLBACK = [
  { provider: 'groq',       model: 'llama-3.3-70b-versatile', vars: ['GROQ_API_KEY'] },
  { provider: 'gemini',     model: 'gemini-2.5-flash',        vars: ['GEMINI_PAID_KEY', 'GEMINI_API_KEY', 'GEMINI_FREE_KEY_1'] },
  { provider: 'openai',     model: 'gpt-4o-mini',             vars: ['OPENAI_API_KEY'] },
  { provider: 'claude',     model: 'claude-sonnet-5',         vars: ['ANTHROPIC_API_KEY'] },
  { provider: 'openrouter', model: 'openai/gpt-4o-mini',      vars: ['OPENROUTER_API_KEY'] },
];

function describeRoleFromEnv() {
  for (const cand of ENV_PROVIDER_FALLBACK) {
    // Numbered pool members count too (GROQ_API_KEY_2, GEMINI_FREE_KEY_3):
    // an operator who added a second account and removed the first still has
    // a working provider, and readiness must see it.
    const hit = cand.vars.some((base) => Object.keys(process.env).some(
      (k) => (k === base || k.startsWith(`${base}_`)) && !!process.env[k]
    ));
    if (hit) return { ok: true, provider: cand.provider, model: cand.model, source: 'env' };
  }

  // A local model with no cloud key is still a working install.
  try {
    const st = require('../../services/local-runtime/index.cjs').status();
    const model = st?.readyModels?.[0]?.id;
    if (model) return { ok: true, provider: 'local', model, source: 'local_runtime' };
  } catch { /* runtime absent — not an error, just nothing to report */ }

  return null;
}

function describeRoleLocal(role) {
  if (isPortable()) {
    const st = (() => {
      try { return require('../../services/local-runtime/index.cjs').status(); } catch { return null; }
    })();
    const model = st?.readyModels?.[0]?.id || null;
    return model
      ? { ok: true, provider: 'local', model }
      : { ok: false, provider: 'local', reason: 'no_local_model' };
  }

  const reg = readLocal();
  if (!reg || !Array.isArray(reg.endpoints) || !reg.endpoints.length) {
    // No registry file is the NORMAL state of a clean install — the file is
    // written the first time a provider is added through Settings. Reporting
    // "no providers configured" from its absence alone declared every install
    // broken that had put its keys in .env instead, which is the documented
    // way to configure one. The registry is the richer source; the environment
    // is the older one, and it still counts.
    const env = describeRoleFromEnv();
    return env || { ok: false, reason: 'no_providers_configured' };
  }

  const runtime = isVercel ? 'cloud' : 'local';
  let mapping = (reg.roles || {})[role] || (reg.roles || {})['chat'];
  if (!mapping) {
    const reachable = reg.endpoints.filter(e => (e.reachable_from || []).includes(runtime));
    const candidate = reachable.find(e => e.auth_ref) || reachable[0];
    if (!candidate) return { ok: false, reason: 'no_reachable_endpoint' };
    mapping = { endpoint_id: candidate.id, model: pickChatModel(candidate.models) };
  }
  if (!mapping.model) return { ok: false, reason: 'no_model_on_endpoint' };

  const ep = (reg.endpoints || []).find(e => e.id === mapping.endpoint_id);
  if (!ep) return { ok: false, reason: 'endpoint_missing' };

  // BO-A5b — an assignment must name a model the endpoint actually serves.
  //
  // Found in the operator's own restored registry: agent_worker →
  // `qwen3-1.7b-q4`, agent_heavy → `qwen3-4b-q4`, agent_memory_manager →
  // `gemini-2.5-flash`, all three assigned to a GROQ endpoint that serves none
  // of them. Readiness reported ok:true for every one. That is precisely the
  // BO-F3 defect this build order exists to remove: the badge promising what
  // the router will not deliver — here it would 404 on the first call.
  //
  // Stale assignments are normal and expected: they survive a provider being
  // re-pointed, a model being retired, or a config restored from another
  // machine. Reporting them is the fix, not preventing them.
  //
  // Only enforced when the endpoint HAS a discovered model list. An empty
  // models[] means discovery never ran, not that the endpoint serves nothing —
  // failing closed there would report every fresh install as broken.
  const known = Array.isArray(ep.models) ? ep.models : [];
  if (known.length && !known.includes(mapping.model)) {
    return {
      ok: false,
      provider: ep.provider,
      model: mapping.model,
      reason: 'model_not_on_endpoint',
      // Name the remedy, and name the cheaper one first (BO-F3's rule).
      detail: `${ep.provider} does not serve "${mapping.model}". Pick a model this provider offers in Settings → Model Assignment, or re-scan the provider's model list.`,
    };
  }

  return { ok: true, provider: ep.provider, model: mapping.model };
}

module.exports = {
  PROVIDER_TRANSPORT, load, save,
  addEndpoint, removeEndpoint, assignRole,
  discoverModels, resolveForRole, isVercel,
  lmStudioHost, isPortable, describeRoleLocal, describeRoleFromEnv,
  // Exported so the gate tests the REAL predicate rather than re-implementing it.
  pickChatModel, NON_CHAT_MODEL_RE, isProviderConfigured,
};
