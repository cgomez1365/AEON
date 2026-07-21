import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { authStatus } from '../kernel/auth';

// Static lazy import — the security block ships with the app now. A variable
// path with @vite-ignore was never bundled, so production builds 404'd the
// import and the gate showed "Security block not found" instead of login.
const Security = lazy(() =>
  import('../blocks/security/index.jsx').catch(() => ({
    default: () => <div style={{ padding: 40, color: '#ff4466', textAlign: 'center' }}>Security block not found. Reinstall it to enable login.</div>
  }))
);

/**
 * AuthGate — operator-login enforcement layer.
 *
 * Non-breaking by design: it only blocks when the `require_login` pref is ON
 * *and* an account exists *and* this client isn't authenticated. In every
 * other case (pref off, no account yet, already signed in) it renders the app
 * untouched, so the default localhost dev flow is unaffected.
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState({ ready: false, blocked: false });

  const check = useCallback(async () => {
    const st = await authStatus();
    const blocked = !!(st.loginRequired && st.configured && !st.authenticated);
    setState({ ready: true, blocked });
  }, []);

  useEffect(() => { check(); }, [check]);

  // Re-check when the tab regains focus (e.g. after logging in elsewhere).
  useEffect(() => {
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  if (!state.ready) return null;          // brief, avoids a flash of the app
  if (!state.blocked) return children;     // default path — pass through

  // Gated: show the Security block's login. Poll so a successful sign-in
  // (which the Security block performs in-place) lifts the gate automatically.
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #020508)', overflow: 'auto' }}>
      <GateWatcher onAuthed={check} />
      <Suspense fallback={null}><Security /></Suspense>
    </div>
  );
}

function GateWatcher({ onAuthed }) {
  useEffect(() => {
    const id = setInterval(async () => {
      const st = await authStatus();
      if (st.authenticated) onAuthed();
    }, 1500);
    return () => clearInterval(id);
  }, [onAuthed]);
  return null;
}
