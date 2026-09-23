// Fleet Control wording — pure functions (tests/home-blocks-ui-logic.test.js).
//
// GET /core/provider-health lists every provider the kernel knows, configured
// or not. Before 2026-09-23 the page painted every unhealthy row red as
// "Unhealthy — cooling down", so a fresh install with one custom provider
// showed groq, gemini, local and openrouter "cooling down" — providers that
// were never set up — and the card read "0/5 healthy engines".

/**
 * The server card from the /api/llm-telemetry probe ({ ok, status, uptime };
 * status 0 = no answer). It said "CLOUD MODE · Supabase relay" for every
 * non-200 — including an expired session on a local-only install.
 */
export function serverStatus(probe) {
  if (!probe) return { value: '…', sub: 'Checking', tone: 'idle' };
  if (probe.ok) {
    const m = Number.isFinite(Number(probe.uptime)) ? Math.floor(Number(probe.uptime) / 60) : null;
    return { value: 'ONLINE', sub: m === null ? 'Local kernel' : `Local kernel · up ${m}m`, tone: 'ok' };
  }
  if (probe.status === 401) return { value: 'SIGNED OUT', sub: 'Session expired — sign in again', tone: 'warn' };
  if (!probe.status) return { value: 'UNREACHABLE', sub: 'The AEON server is not answering', tone: 'warn' };
  return { value: `HTTP ${probe.status}`, sub: 'Telemetry route failed', tone: 'warn' };
}

/** Seconds until `blockedUntil`, or null. */
function retryIn(blockedUntil, now) {
  const ms = Number(blockedUntil) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : null;
}

/**
 * One row per provider: configured-and-healthy, cooling down (with why), or
 * not set up.
 *
 * `endpoints` — the connection registry (GET /api/connections), optional.
 * The kernel's health map lists groq/gemini/local/openrouter plus any provider
 * that has had a failure, so a configured custom endpoint with no failures is
 * absent from it (services/ai.js getProviderHealth). Without this merge a
 * fresh install with one working custom provider read "No provider
 * configured". A provider with no cooldown is healthy by the kernel's own
 * definition (isHealthy = not blocked).
 */
export function providerRows(health, now = Date.now(), endpoints = []) {
  const providers = { ...((health && health.providers) || {}) };
  for (const ep of Array.isArray(endpoints) ? endpoints : []) {
    const p = ep && ep.provider;
    if (p && !providers[p]) providers[p] = { healthy: true, configured: true, _fromRegistry: true };
  }
  const pools = (health && health.keyPools) || {};
  return Object.entries(providers).map(([id, p]) => {
    const pool = pools[id];
    const keys = pool ? ` · ${pool.count} key${pool.count === 1 ? '' : 's'} · slot ${pool.activeIndex}` : '';
    if (p.configured === false) {
      return { id, state: 'unconfigured', label: 'Not configured', detail: 'Add it in Settings → Connections' };
    }
    if (p.healthy) {
      return { id, state: 'healthy', label: p._fromRegistry ? 'Healthy — no failures recorded' : 'Healthy', detail: keys.replace(/^ · /, '') };
    }
    const wait = retryIn(p.blockedUntil, now);
    const reason = String(p.reason || '').replace(/^Endpoint error \d+:\s*/, '').slice(0, 120);
    return {
      id,
      state: 'cooling',
      label: wait ? `Cooling down — retry in ${wait}s` : 'Unhealthy',
      detail: [reason, keys.replace(/^ · /, '')].filter(Boolean).join(' · '),
    };
  }).sort((a, b) => order(a.state) - order(b.state) || a.id.localeCompare(b.id));
}

const order = (s) => (s === 'cooling' ? 0 : s === 'healthy' ? 1 : 2);

/** The Providers status card. Only configured providers are counted. */
export function providerCard(rows) {
  const configured = rows.filter(r => r.state !== 'unconfigured');
  const healthy = configured.filter(r => r.state === 'healthy').length;
  if (!configured.length) {
    return { value: '0', sub: 'No provider configured', tone: 'warn' };
  }
  return {
    value: `${healthy}/${configured.length}`,
    sub: 'configured providers healthy',
    tone: healthy === configured.length ? 'ok' : 'warn',
  };
}

/** What the hardware panel says about this machine, from /api/hwfit/models. */
export function hardwareSummary(hw) {
  if (!hw || !hw.system) return null;
  const s = hw.system;
  const models = Array.isArray(hw.models) ? hw.models : [];
  const count = (fit) => models.filter(m => m.fit === fit).length;
  const gpu = s.has_gpu ? `${s.gpu_name || 'GPU'} · ${s.gpu_vram_gb} GB VRAM` : 'No GPU detected';
  return {
    machine: `${s.cpu_model || 'CPU'} · ${s.cpu_cores || '?'} cores · ${s.total_ram_gb} GB RAM`,
    gpu,
    fits: { gpu: count('gpu'), offload: count('offload'), cpu: count('cpu'), tooLarge: count('too_large') },
    catalog: models.length,
    best: models.filter(m => m.fit !== 'too_large' && m.fit !== 'unknown')
      .sort((a, b) => (b.params_b || 0) - (a.params_b || 0))
      .slice(0, 3)
      .map(m => `${m.short_name} (${m.params_b}B, ${m.label})`),
  };
}
