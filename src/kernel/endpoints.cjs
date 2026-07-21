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

const isVercel = !!process.env.VERCEL;
const APP_ROOT = path.join(__dirname, '..', '..');
const SECRETS_DIR = path.join(APP_ROOT, 'secrets');
try { if (!isVercel) fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch {}
const REG_FILE = path.join(SECRETS_DIR, 'aeon-endpoints.json');
const REG_ROW_ID = 1;

// ── Provider transport profiles (how to actually call them) ──────────
const PROVIDER_TRANSPORT = {
  groq:   { style: 'openai', base: 'https://api.groq.com/openai/v1', list: '/models',     reach: ['local', 'cloud'] },
  openai: { style: 'openai', base: 'https://api.openai.com/v1',      list: '/models',     reach: ['local', 'cloud'] },
  gemini: { style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', list: '/models', reach: ['local', 'cloud'] },
  claude: { style: 'anthropic', base: 'https://api.anthropic.com/v1', list: '/models',    reach: ['local', 'cloud'] },
  grok:   { style: 'openai', base: 'https://api.x.ai/v1',             list: '/models',    reach: ['local', 'cloud'] },
  openrouter: { style: 'openai', base: 'https://openrouter.ai/api/v1', list: '/models', reach: ['local', 'cloud'] },
  ollama: { style: 'ollama', base: 'http://localhost:11434',         list: '/api/tags',   reach: ['local'] },
  lmstudio: { style: 'openai', base: 'http://localhost:1234/v1',     list: '/models',     reach: ['local'] },
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
    if (profile.style === 'ollama') {
      const r = await Promise.race([fetch(`${base}/api/tags`), timeout(5000)]);
      const d = await r.json();
      return (d.models || []).map(m => m.name);
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

// ── RESOLVER: role → concrete { provider, model, base_url, key, via } ─
/**
 * Picks the endpoint for a role that is actually reachable from this runtime.
 *   runtime = 'cloud' on Vercel, 'local' on desktop.
 * Returns { ok, provider, model, base_url, apiKey, via } where `via` is
 * 'direct' or 'relay' (local-only model requested from cloud → needs desktop).
 */
async function resolveForRole(role, supabase) {
  const runtime = isVercel ? 'cloud' : 'local';
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
    const prefer = (candidate.models || []).find(m => /llama.*(versatile|instruct)|instruct|gpt-4|gemini|claude|chat/i.test(m));
    mapping = { endpoint_id: candidate.id, model: prefer || (candidate.models || [])[0] || null };
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

module.exports = {
  PROVIDER_TRANSPORT, load, save,
  addEndpoint, removeEndpoint, assignRole,
  discoverModels, resolveForRole, isVercel,
};
