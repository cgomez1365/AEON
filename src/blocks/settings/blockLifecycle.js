// Settings → Blocks lifecycle calls — pure, so they are testable without a DOM
// (tests/settings-block-lifecycle.test.js drives them against the real kernel
// router). The page renders whatever these return; they never throw.
//
// Kernel routes (src/kernel/routers/build.cjs):
//   GET  /api/build/blocks/:id/state
//   POST /api/build/blocks/:id/stop | start | uninstall | restore
//   GET  /api/build/blocks/removed
// Security is refused by the kernel for stop and uninstall; its words are
// shown as-is rather than re-invented here.

// The page shows its own errors inline; this header keeps the global
// forensics banner from also firing on the same response (interceptorPolicy).
export const SELF_REPORTED = { 'x-aeon-self-reported': '1' };

// True tonight: stop/start/remove/restore change the kernel at once, but the
// block list and nav in the UI are built into the bundle.
export const UI_NOTE = 'The screen updates after `npm run build` and a reload of this tab — no restart needed.';

/** 'Running' | 'Stopped' from a kernel state object. */
export function runLabel(state) {
  if (!state) return 'Unknown';
  if (state.mode === 'auto' || state.running === true) return 'Running';
  return 'Stopped';
}

function errorFrom(status, data, fallbackText) {
  if (status === 401) {
    return `Your session ended${data?.reason ? ` (${data.reason})` : ''} — sign in again, then retry.`;
  }
  if (data && typeof data.error === 'string' && data.error && data.error !== 'UNAUTHORIZED_SESSION') return data.error;
  return fallbackText || `AEON answered HTTP ${status}.`;
}

/** Operator-facing sentence for a successful change. */
export function describeChange(action, id, data = {}) {
  if (action === 'stop') return `${id} stopped — its routes now answer 503 until you start it. ${UI_NOTE}`;
  if (action === 'start') return `${id} started. ${UI_NOTE}`;
  if (action === 'uninstall') {
    const parts = [`${id} moved aside to ${data.movedTo} — not deleted. Restore it any time from "Removed blocks".`];
    if (data.warning) parts.push(data.warning);
    else if (Array.isArray(data.dependents) && data.dependents.length) parts.push(`Depends on it: ${data.dependents.join(', ')}.`);
    parts.push(UI_NOTE);
    return parts.join(' ');
  }
  if (action === 'restore') return `${id} restored from ${data.from}. ${UI_NOTE}`;
  return UI_NOTE;
}

/**
 * @param {{ base?: string, fetchImpl?: typeof fetch }} opts
 *   base — '' in the browser (same origin); a full origin in tests.
 */
export function createLifecycleClient({ base = '', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function request(method, url) {
    let res;
    try {
      res = await doFetch(`${base}${url}`, {
        method,
        headers: { ...SELF_REPORTED, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
        credentials: 'same-origin',
      });
    } catch (e) {
      return { ok: false, status: 0, data: null, error: `Could not reach AEON: ${e?.message || e}` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || data === null || data.ok === false) {
      return { ok: false, status: res.status, data, error: errorFrom(res.status, data, data === null ? `AEON answered HTTP ${res.status} with no readable reply.` : null) };
    }
    return { ok: true, status: res.status, data };
  }

  const enc = (id) => encodeURIComponent(String(id || ''));
  const change = (action) => async (id) => {
    const r = await request('POST', `/api/build/blocks/${enc(id)}/${action}`);
    return r.ok ? { ...r, message: describeChange(action, id, r.data) } : r;
  };

  return {
    state: (id) => request('GET', `/api/build/blocks/${enc(id)}/state`),
    removed: () => request('GET', '/api/build/blocks/removed'),
    stop: change('stop'),
    start: change('start'),
    remove: change('uninstall'),
    restore: change('restore'),
  };
}
