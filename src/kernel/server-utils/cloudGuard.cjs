'use strict';
/**
 * BO-E4 — offline degradation for cloud-backed block routes.
 *
 * AEON's stated mode is local-first and offline-capable. A route that reaches
 * for a cloud service must therefore fail FAST and SAY SO. It must never block.
 *
 * `/api/notes` was the worst case found on 2026-07-31: with no Supabase
 * credentials it built a client from `undefined`, awaited a query with no
 * deadline, and never answered — GET and POST both hung past the probe ceiling.
 * A spinner that never resolves is a worse failure than an error banner, and it
 * is the first failure a user with no keys hits.
 *
 * Two helpers, both boring on purpose:
 *   requireCloud()  — answer 503 with a usable message instead of proceeding
 *   withDeadline()  — put a ceiling on any promise, so "configured but
 *                     unreachable" is also bounded
 */

const DEFAULT_DEADLINE_MS = 15_000;

/** Is a Supabase configuration actually present? */
function supabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  return { url: String(url).trim(), key: String(key).trim() };
}

function hasSupabase(env = process.env) {
  const { url, key } = supabaseConfig(env);
  return !!(url && key);
}

/**
 * Express guard: answer 503 when the cloud dependency this route needs is not
 * configured. Returns true when the request has been answered — the caller
 * must stop.
 *
 * 503 (not 500) because nothing is broken: the feature is unconfigured, which
 * is a legitimate steady state for a local-first install.
 */
function requireCloud(res, { service = 'Supabase', feature = 'This feature' } = {}, env = process.env) {
  if (service === 'Supabase' && hasSupabase(env)) return false;
  if (service !== 'Supabase') return false;
  res.status(503).json({
    error: 'CLOUD_NOT_CONFIGURED',
    service,
    message: `${feature} needs ${service}, which is not configured on this install.`,
    hint: 'Add credentials in Settings → Connections, or use the local equivalent.',
  });
  return true;
}

/**
 * Reject a promise that outlives its deadline, rather than waiting forever.
 * The underlying work is not cancellable here — the point is that the REQUEST
 * ends, so the UI stops spinning and the socket is released.
 */
function withDeadline(promise, ms = DEFAULT_DEADLINE_MS, label = 'operation') {
  let timer;
  const ceiling = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'AEON_DEADLINE' })),
      ms,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

/** Map a deadline error onto a 504, anything else onto a 500. */
function sendFailure(res, err, label = 'request') {
  if (err && err.code === 'AEON_DEADLINE') {
    return res.status(504).json({
      error: 'UPSTREAM_TIMEOUT',
      message: `${label} did not respond in time.`,
      hint: 'The cloud service is configured but unreachable. Check your connection.',
    });
  }
  return res.status(500).json({ error: (err && err.message) || String(err) });
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  supabaseConfig,
  hasSupabase,
  requireCloud,
  withDeadline,
  sendFailure,
};
