/**
 * SetupWizard — first-run cloud setup, done once, inside AEON.
 *
 * The operator pastes Supabase/Firebase keys here and never opens either
 * dashboard again: AEON validates the keys, stores them encrypted in the
 * Vault (services/settings.js createCloudCredentialStore — already existed;
 * this wizard is the UI on top of it), and self-creates its own database
 * schema via the existing /api/settings/connectivity/supabase/setup route.
 *
 * The Supabase service-role key is shown exactly once (Step 3) — AEON never
 * displays it again after this screen.
 */
import React, { useState } from 'react';
import ModalPortal from '../../../components/ModalPortal.jsx';
import { resetSupabase } from '../../../kernel/supabase';

const S = {
  overlay: { minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(5,9,18,0.92)', color: '#dce8f5' },
  panel: { width: 'min(560px, 100%)', background: 'rgba(10,16,26,0.96)', border: '1px solid rgba(0,242,255,0.22)', borderRadius: 14, padding: 28 },
  h1: { margin: '0 0 6px', fontSize: 20, color: '#00f2ff' },
  sub: { fontSize: 13, color: '#8aa0b8', lineHeight: 1.6, margin: '0 0 20px' },
  label: { fontSize: 12.5, color: '#c8d4e0', display: 'block', margin: '12px 0 4px' },
  input: { background: '#0b0f19', border: '1px solid #1e2d45', borderRadius: 6, padding: '9px 12px', color: '#e8f0fa', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  btnRow: { display: 'flex', gap: 10, marginTop: 22, justifyContent: 'space-between' },
  btn: { background: 'rgba(0,242,255,0.14)', border: '1px solid #00f2ff', color: '#00f2ff', padding: '9px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btnGhost: { background: 'transparent', border: '1px solid #33445c', color: '#8aa0b8', padding: '9px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  msgOk: { color: '#39ff14', fontSize: 12.5, marginTop: 10 },
  msgErr: { color: '#ff4455', fontSize: 12.5, marginTop: 10 },
  dots: { display: 'flex', gap: 6, marginBottom: 18 },
  dot: (active, done) => ({ width: 8, height: 8, borderRadius: '50%', background: done ? '#39ff14' : active ? '#00f2ff' : '#33445c' }),
  keyBox: { background: '#050912', border: '1px dashed #f59e0b', borderRadius: 8, padding: 14, margin: '14px 0', fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all', color: '#f5c977' },
};

const STEPS = ['Welcome', 'Supabase', 'Key', 'Firebase', 'Apply'];

export default function SetupWizard({ onComplete, onSkip }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'ok'|'err', text }

  const [supabase, setSupabase] = useState({ url: '', anonKey: '', serviceRoleKey: '' });
  const [supabaseTested, setSupabaseTested] = useState(false);
  const [keyAcknowledged, setKeyAcknowledged] = useState(false);

  const [firebase, setFirebase] = useState({ apiKey: '', authDomain: '', projectId: '', storageBucket: '', messagingSenderId: '', appId: '' });
  const [firebaseJson, setFirebaseJson] = useState('');
  const [firebaseTested, setFirebaseTested] = useState(false);
  const [firebaseSkipped, setFirebaseSkipped] = useState(false);

  const [applyLog, setApplyLog] = useState([]);

  const say = (kind, text) => setMsg({ kind, text });

  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `${url} failed (${r.status})`);
    return d;
  };

  const skipEntirely = () => {
    try { localStorage.setItem('aeon_setup_wizard_skipped', '1'); } catch {}
    onSkip && onSkip();
  };

  const testSupabase = async () => {
    setBusy(true); setMsg(null);
    try {
      // serviceRoleKey is a fallback the backend only needs if the project
      // restricts anon-tier REST access entirely (a valid, hardened setup,
      // not a broken one) -- send it whenever the operator already typed it.
      await post('/api/settings/connectivity/supabase/test', { url: supabase.url, anonKey: supabase.anonKey, serviceRoleKey: supabase.serviceRoleKey });
      setSupabaseTested(true);
      say('ok', 'Connected — project reachable and key accepted.');
    } catch (e) { setSupabaseTested(false); say('err', e.message); }
    finally { setBusy(false); }
  };

  const goToStep3OrSkip = () => {
    setMsg(null);
    setStep(supabase.serviceRoleKey.trim() ? 2 : 3);
  };

  const applyFirebaseJson = () => {
    try {
      const parsed = JSON.parse(firebaseJson);
      setFirebase(f => ({
        ...f,
        apiKey: parsed.apiKey || f.apiKey,
        authDomain: parsed.authDomain || f.authDomain,
        projectId: parsed.projectId || f.projectId,
        storageBucket: parsed.storageBucket || f.storageBucket,
        messagingSenderId: String(parsed.messagingSenderId || f.messagingSenderId || ''),
        appId: parsed.appId || f.appId,
      }));
      say('ok', 'Parsed — review the fields below.');
    } catch { say('err', 'That is not valid JSON. Paste the Firebase Web Config object, or fill the fields in manually.'); }
  };

  const testFirebase = async () => {
    setBusy(true); setMsg(null);
    try {
      await post('/api/settings/connectivity/firebase/test', { apiKey: firebase.apiKey, projectId: firebase.projectId });
      setFirebaseTested(true);
      say('ok', 'Connected — Firebase API key accepted.');
    } catch (e) { setFirebaseTested(false); say('err', e.message); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true); setMsg(null);
    const log = [];
    try {
      await post('/api/settings/connectivity/supabase/save', supabase);
      // BO-K — drop the cached browser client so the credentials just saved
      // take effect now. Without this the operator would have to reload to
      // use what they just entered — a milder version of the same defect.
      resetSupabase();
      log.push('✓ Supabase saved to encrypted Vault.');
      setApplyLog([...log]);

      if (supabase.serviceRoleKey.trim()) {
        try {
          const schema = await post('/api/settings/connectivity/supabase/setup', {});
          log.push(`✓ Database ready — ${schema.applied?.length || 0} schema file(s) applied.`);
        } catch (e) {
          // Schema RPC may not exist yet on a fresh project — surface the
          // one-time paste-into-SQL-Editor fallback rather than failing setup.
          log.push(`⚠ Database schema needs one manual step: ${e.message}`);
        }
        setApplyLog([...log]);
      }

      if (!firebaseSkipped && firebase.apiKey && firebase.projectId) {
        await post('/api/settings/connectivity/firebase/save', firebase);
        log.push('✓ Firebase saved to encrypted Vault.');
        setApplyLog([...log]);
      }

      // BO-K — this used to REMOVE the skip flag on success and replace it
      // with nothing, so finishing setup made the wizard more likely to return
      // than skipping it. Completion is now recorded server-side by the gate's
      // onComplete; the legacy flag is left alone rather than deleted.
      try { await fetch('/api/settings/first-run/complete', { method: 'POST' }); } catch {}
      say('ok', 'Setup complete. AEON now owns your cloud connection — you will not need to open Supabase or Firebase again.');
      setStep(5);
    } catch (e) {
      say('err', e.message);
    } finally { setBusy(false); }
  };

  return (
    <ModalPortal ariaLabel="AEON cloud setup">
      <div style={S.overlay}>
        <div style={S.panel}>
          <div style={S.dots}>
            {STEPS.map((label, i) => <span key={label} style={S.dot(i === step, i < step)} title={label} />)}
          </div>

          {step === 0 && (
            <>
              <h1 style={S.h1}>Set up AEON's cloud</h1>
              <p style={S.sub}>
                AEON needs Supabase (and optionally Firebase) credentials to enable sync and cloud features.
                You do this once, right here. After this screen, you will never need to open those dashboards
                again — AEON owns the connection from now on.
              </p>
              <div style={S.btnRow}>
                <button style={S.btnGhost} onClick={skipEntirely}>Skip — use AEON locally</button>
                <button style={S.btn} onClick={() => setStep(1)}>Begin setup</button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1 style={S.h1}>Supabase</h1>
              <p style={S.sub}>Go to supabase.com → your project → Settings → API. Copy the Project URL and the anon (public) key. The service role key is optional but unlocks AEON's automatic database setup.</p>
              <label style={S.label}>Project URL</label>
              <input style={S.input} placeholder="https://xxxx.supabase.co" value={supabase.url}
                onChange={e => { setSupabase(s => ({ ...s, url: e.target.value })); setSupabaseTested(false); }} />
              <label style={S.label}>Anon / public key</label>
              <input style={S.input} value={supabase.anonKey}
                onChange={e => { setSupabase(s => ({ ...s, anonKey: e.target.value })); setSupabaseTested(false); }} />
              <label style={S.label}>Service role key (optional — enables automatic schema setup)</label>
              <input style={S.input} type="password" value={supabase.serviceRoleKey}
                onChange={e => setSupabase(s => ({ ...s, serviceRoleKey: e.target.value }))} />
              {msg && <div style={msg.kind === 'ok' ? S.msgOk : S.msgErr}>{msg.text}</div>}
              <div style={S.btnRow}>
                <button style={S.btnGhost} onClick={() => setStep(0)}>Back</button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={S.btnGhost} onClick={testSupabase} disabled={busy || !supabase.url || !supabase.anonKey}>
                    {busy ? 'Testing…' : 'Validate connection'}
                  </button>
                  <button style={S.btn} onClick={goToStep3OrSkip} disabled={!supabaseTested}>Next</button>
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1 style={S.h1}>Save this key — it will not be shown again</h1>
              <p style={S.sub}>AEON stores this key encrypted in your local Vault. It never leaves this machine and is never displayed again after you leave this screen. Save a copy in your password manager now.</p>
              <div style={S.keyBox}>{supabase.serviceRoleKey}</div>
              <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={keyAcknowledged} onChange={e => setKeyAcknowledged(e.target.checked)} />
                I have saved this key somewhere safe.
              </label>
              <div style={S.btnRow}>
                <button style={S.btnGhost} onClick={() => setStep(1)}>Back</button>
                <button style={S.btn} onClick={() => setStep(3)} disabled={!keyAcknowledged}>Next</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h1 style={S.h1}>Firebase (optional)</h1>
              <p style={S.sub}>Go to console.firebase.google.com → your project → Project settings → General → Your apps → Web app config. Paste the whole config object below, or fill the fields in yourself.</p>
              <label style={S.label}>Paste Firebase Web Config (JSON)</label>
              <textarea style={{ ...S.input, minHeight: 70, fontFamily: 'monospace', fontSize: 11.5 }}
                placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "...", ... }'
                value={firebaseJson} onChange={e => setFirebaseJson(e.target.value)} />
              <div style={{ margin: '6px 0 4px' }}>
                <button style={S.btnGhost} onClick={applyFirebaseJson} disabled={!firebaseJson.trim()}>Parse into fields</button>
              </div>
              <label style={S.label}>API key</label>
              <input style={S.input} value={firebase.apiKey} onChange={e => { setFirebase(f => ({ ...f, apiKey: e.target.value })); setFirebaseTested(false); }} />
              <label style={S.label}>Project ID</label>
              <input style={S.input} value={firebase.projectId} onChange={e => { setFirebase(f => ({ ...f, projectId: e.target.value })); setFirebaseTested(false); }} />
              <label style={S.label}>Auth domain</label>
              <input style={S.input} value={firebase.authDomain} onChange={e => setFirebase(f => ({ ...f, authDomain: e.target.value }))} />
              <label style={S.label}>App ID</label>
              <input style={S.input} value={firebase.appId} onChange={e => setFirebase(f => ({ ...f, appId: e.target.value }))} />
              {msg && <div style={msg.kind === 'ok' ? S.msgOk : S.msgErr}>{msg.text}</div>}
              <div style={S.btnRow}>
                <button style={S.btnGhost} onClick={() => setStep(supabase.serviceRoleKey.trim() ? 2 : 1)}>Back</button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={S.btnGhost} onClick={() => { setFirebaseSkipped(true); setStep(4); }}>Skip Firebase</button>
                  <button style={S.btnGhost} onClick={testFirebase} disabled={busy || !firebase.apiKey || !firebase.projectId}>
                    {busy ? 'Testing…' : 'Validate connection'}
                  </button>
                  <button style={S.btn} onClick={() => { setFirebaseSkipped(false); setStep(4); }} disabled={!firebaseTested}>Next</button>
                </div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h1 style={S.h1}>Confirm &amp; apply</h1>
              <p style={S.sub}>
                Supabase: <strong style={{ color: '#39ff14' }}>connected</strong>
                {supabase.serviceRoleKey.trim() ? ' (with automatic database setup)' : ''}
                <br />
                Firebase: <strong style={{ color: firebaseSkipped ? '#8aa0b8' : '#39ff14' }}>{firebaseSkipped ? 'skipped' : 'connected'}</strong>
              </p>
              {applyLog.length > 0 && (
                <div style={{ fontSize: 12, color: '#8aa0b8', lineHeight: 1.8 }}>{applyLog.map((l, i) => <div key={i}>{l}</div>)}</div>
              )}
              {msg && <div style={msg.kind === 'ok' ? S.msgOk : S.msgErr}>{msg.text}</div>}
              <div style={S.btnRow}>
                <button style={S.btnGhost} onClick={() => setStep(3)} disabled={busy}>Back</button>
                <button style={S.btn} onClick={apply} disabled={busy}>{busy ? 'Applying…' : 'Apply'}</button>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <h1 style={S.h1}>You're set.</h1>
              <p style={S.sub}>AEON owns the cloud connection from here. You will not need Supabase or Firebase's dashboards again — everything runs from inside AEON.</p>
              {applyLog.length > 0 && (
                <div style={{ fontSize: 12, color: '#8aa0b8', lineHeight: 1.8, marginBottom: 16 }}>{applyLog.map((l, i) => <div key={i}>{l}</div>)}</div>
              )}
              <div style={S.btnRow}>
                <span />
                <button style={S.btn} onClick={onComplete}>Enter AEON</button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
