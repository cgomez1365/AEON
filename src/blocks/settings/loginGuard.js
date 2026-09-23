// Settings → Account → "Require login", wired to the thing that actually
// requires a login: the Security Guardian's policy (guardEnabled), read and
// written through /api/security/policy. Pure and DOM-free
// (tests/settings-login-guard.test.js drives it against the real Guardian).
//
// Before 2026-09-23 this switch wrote the `require_login` PREFERENCE, which
// nothing enforces — the Guardian only mirrors its own state into it. Turning
// it off said "Login requirement disabled" while every route still demanded a
// session; turning it on after the guard was off protected nothing.

export const SELF_REPORTED = { 'x-aeon-self-reported': '1' };

/** Operator-facing sentence for the current state. */
export function loginGuardText({ enabled, accountConfigured }) {
  if (!accountConfigured) return 'No operator account yet — AEON is open to anyone on this computer. Create one under Security to turn login on.';
  return enabled
    ? 'On — every screen and API asks for your operator password.'
    : 'Off — anyone who can reach this computer\'s AEON gets in without a password. Remote access stays locked while this is off.';
}

export function createLoginGuardClient({ base = '', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function call(method, body) {
    let res;
    try {
      res = await doFetch(`${base}/api/security/policy`, {
        method,
        headers: { ...SELF_REPORTED, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'same-origin',
      });
    } catch (e) {
      return { ok: false, error: `Could not reach AEON: ${e?.message || e}` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !data) {
      if (res.status === 401) return { ok: false, status: 401, error: 'Your session ended — sign in again, then retry.' };
      if (res.status === 404) return { ok: false, status: 404, error: 'The Security block is not installed, so login cannot be changed here.' };
      return { ok: false, status: res.status, error: (data && data.error) || `AEON answered HTTP ${res.status}.` };
    }
    return { ok: true, status: res.status, data };
  }

  return {
    async read() {
      const r = await call('GET');
      if (!r.ok) return r;
      return { ok: true, enabled: !!r.data.policy?.guardEnabled, accountConfigured: !!r.data.accountConfigured };
    },
    async set(enabled) {
      const r = await call('POST', { guardEnabled: !!enabled });
      if (!r.ok) return r;
      // Read back rather than trust the echo: the Guardian's effective state
      // is guardEnabled AND an account exists.
      return this.read();
    },
  };
}
