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
    let skipped = false;
    try { skipped = localStorage.getItem('aeon_setup_wizard_skipped') === '1'; } catch {}
    if (skipped) return setState({ ready: true, showWizard: false });
    try {
      const r = await fetch('/api/settings');
      const d = await r.json().catch(() => ({}));
      const configured = !!d?.cloudProviders?.supabase?.configured;
      setState({ ready: true, showWizard: !configured });
    } catch {
      // Kernel unreachable — don't block boot on a wizard we can't complete.
      setState({ ready: true, showWizard: false });
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  if (!state.ready) return null;
  if (!state.showWizard) return children;

  return (
    <SetupWizard
      onComplete={() => setState({ ready: true, showWizard: false })}
      onSkip={() => setState({ ready: true, showWizard: false })}
    />
  );
}
