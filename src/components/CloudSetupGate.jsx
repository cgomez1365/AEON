import React, { useState, useEffect, useCallback } from 'react';
import SetupWizard from '../blocks/security/components/SetupWizard.jsx';

/**
 * CloudSetupGate — shows the cloud setup wizard on a fresh install, before
 * anything else renders. Non-blocking by design: a "Skip — use AEON
 * locally" choice (persisted in localStorage) lets the app boot with no
 * cloud connection at all, same as AuthGate's non-breaking default.
 */
export default function CloudSetupGate({ children }) {
  const [state, setState] = useState({ ready: false, showWizard: false });

  const check = useCallback(async () => {
    // Legacy: honour a skip recorded by an older build so upgrading does not
    // re-open a wizard the operator already dismissed.
    let skipped = false;
    try { skipped = localStorage.getItem('aeon_setup_wizard_skipped') === '1'; } catch {}
    if (skipped) return setState({ ready: true, showWizard: false });

    try {
      // BO-K — ask "has setup been done", not "is Supabase configured". The
      // old check re-derived first-run from cloud state, so the wizard came
      // back on every launch of a local-only install and its "you do this
      // once" promise was false. It also read /api/settings on mount, landing
      // in the un-awaited vault hydration window (endpoints.cjs:186-196), so
      // the answer depended on timing.
      const r = await fetch('/api/settings/first-run');
      const d = await r.json().catch(() => ({}));
      setState({ ready: true, showWizard: d?.complete !== true });
    } catch {
      // Kernel unreachable — don't block boot on a wizard we can't complete.
      setState({ ready: true, showWizard: false });
    }
  }, []);

  // Both exits are decisions worth remembering. Finishing setup and choosing
  // local-only are equally "the operator has been asked" — the old code
  // persisted only the second one.
  const markComplete = useCallback(async () => {
    try { await fetch('/api/settings/first-run/complete', { method: 'POST' }); } catch {}
    setState({ ready: true, showWizard: false });
  }, []);

  useEffect(() => { check(); }, [check]);

  if (!state.ready) return null;
  if (!state.showWizard) return children;

  return (
    <SetupWizard
      onComplete={markComplete}
      onSkip={markComplete}
    />
  );
}
