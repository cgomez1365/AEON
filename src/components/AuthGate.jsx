import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { securityAvailability } from '../kernel/auth';

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
 * Reads /api/kernel/security-availability (answered by the kernel itself,
 * never by the security block — see authGate.cjs) so a missing block can
 * never be confused with "no account configured." Three outcomes:
 *
 *   - open:          no account, or already authenticated → render the app
 *   - login:         account protected, not authenticated, block present
 *                     → show the Security block's real login UI
 *   - block-missing: account protected, not authenticated, block ABSENT
 *                     → locked out with an explicit message, never a bypass
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState({ ready: false, mode: 'open' });

  const check = useCallback(async () => {
    const d = await securityAvailability();
    if (!d.hasAccount || !d.guardActive || d.authenticated) {
      setState({ ready: true, mode: 'open' });
      return;
    }
    setState({ ready: true, mode: d.blockPresent ? 'login' : 'block-missing' });
  }, []);

  useEffect(() => { check(); }, [check]);

  // Re-check when the tab regains focus (e.g. after logging in elsewhere).
  useEffect(() => {
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  if (!state.ready) return null;          // brief, avoids a flash of the app
  if (state.mode === 'open') return children;

  if (state.mode === 'block-missing') {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#050912', color: '#dce8f5', padding: 24 }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 42, marginBottom: 12 }} aria-hidden="true">🔒</div>
          <h1 style={{ color: '#ff4455', fontSize: 20, margin: '0 0 12px' }}>AEON is locked — Security block missing</h1>
          <p style={{ fontSize: 13.5, lineHeight: 1.7, color: '#8aa0b8' }}>
            Your account is protected, but the Security block's files are gone from{' '}
            <code style={{ color: '#c8d4e0' }}>src/blocks/security/</code>, so there is
            no way to verify your password right now.
          </p>
          <p style={{ fontSize: 13.5, lineHeight: 1.7, color: '#8aa0b8' }}>
            This is not a bypass — deleting this folder does not open AEON.
            Your username, password, and recovery answers are untouched and
            saved separately in the Vault. Restore the Security block
            (reinstall AEON, or restore that folder from Git) and restart —
            your existing credentials will work exactly as before.
          </p>
        </div>
      </div>
    );
  }

  // mode === 'login'. Poll the same kernel endpoint the sign-in above is
  // gated by, so this loop never depends on a route the block owns.
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
      const d = await securityAvailability();
      if (d.authenticated) onAuthed();
    }, 1500);
    return () => clearInterval(id);
  }, [onAuthed]);
  return null;
}
