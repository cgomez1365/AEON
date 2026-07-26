/**
 * AEON Auth Client — shared session-token helper.
 *
 * The user-identity layer (security block) issues a session token on login.
 * We persist it in localStorage and attach it as a Bearer header so it rides
 * alongside the existing AEON_MOBILE_SECRET machine auth without conflict.
 */
const TOKEN_KEY = 'aeon_session_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}
export function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function clearToken() { setToken(null); }

/** fetch() wrapper that injects the session bearer + JSON headers. */
export async function authFetch(url, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(url, { ...opts, headers, credentials: 'include' });
}

export async function authStatus() {
  try {
    const r = await authFetch('/api/auth/status');
    return await r.json();
  } catch { return { configured: false, authenticated: false, loginRequired: false }; }
}

// Answered by the kernel (authGate.cjs), never by the security block itself —
// this is what lets AEON tell "no account configured" apart from "the block
// that would show a login screen is gone" instead of collapsing both into a
// silent bypass. The fallback below only fires when the server is genuinely
// unreachable (dev server down); "block missing" is a different, detectable
// state and never lands here.
export async function securityAvailability() {
  try {
    const r = await authFetch('/api/kernel/security-availability');
    return await r.json();
  } catch { return { blockPresent: true, hasAccount: false, guardActive: false, authenticated: false }; }
}

export async function login(username, password, code) {
  const r = await authFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, code: code || undefined }) });
  const d = await r.json();
  if (r.ok && d.token) setToken(d.token);
  return { ok: r.ok, ...d };
}

export async function setupAccount(payload) {
  const r = await authFetch('/api/auth/setup', { method: 'POST', body: JSON.stringify(payload) });
  const d = await r.json();
  return { ok: r.ok, ...d };
}

export async function logout() {
  try { await authFetch('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
}
