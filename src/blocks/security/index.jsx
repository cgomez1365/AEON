/**
 * AEON Security 2.0 — The Guardian (UI)
 *
 * One page a 75-year-old can operate: a big status light, plain-English
 * toggles, and two buttons that matter (Lock now / Sync & protect).
 * Talks to /api/auth/* (auth core) and /api/security/* (guardian).
 */
import React, { useState, useEffect, useCallback } from 'react';

const S = {
  page: { padding: 24, maxWidth: 860, margin: '0 auto', color: '#dce8f5', fontFamily: 'Inter, sans-serif' },
  card: { background: 'rgba(10,16,26,0.75)', border: '1px solid rgba(0,242,255,0.18)', borderRadius: 12, padding: 20, marginBottom: 16 },
  h2: { margin: '0 0 4px', fontSize: 15, letterSpacing: '0.08em', color: '#00f2ff', textTransform: 'uppercase' },
  sub: { fontSize: 12.5, color: '#8aa0b8', margin: '0 0 14px', lineHeight: 1.6 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.05)' },
  label: { fontSize: 13.5, lineHeight: 1.5 },
  hint: { fontSize: 11.5, color: '#6a7f95' },
  input: { background: '#0b0f19', border: '1px solid #1e2d45', borderRadius: 6, padding: '9px 12px', color: '#e8f0fa', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  btn: { background: 'rgba(0,242,255,0.12)', border: '1px solid #00f2ff', color: '#00f2ff', padding: '8px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  btnAmber: { background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', color: '#f59e0b', padding: '8px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  btnRed: { background: 'rgba(255,68,85,0.08)', border: '1px solid #ff4455', color: '#ff4455', padding: '8px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  select: { background: '#0b0f19', border: '1px solid #1e2d45', borderRadius: 6, padding: '7px 10px', color: '#e8f0fa', fontSize: 13 },
};

function Toggle({ checked, onChange, id }) {
  return (
    <button role="switch" aria-checked={checked} id={id} onClick={() => onChange(!checked)}
      style={{ width: 46, height: 24, borderRadius: 12, border: '1px solid ' + (checked ? '#39ff14' : '#33445c'),
        background: checked ? 'rgba(57,255,20,0.25)' : 'rgba(255,255,255,0.05)', position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: checked ? 24 : 2, width: 18, height: 18, borderRadius: '50%',
        background: checked ? '#39ff14' : '#6a7f95', transition: 'left 0.15s' }} />
    </button>
  );
}

export default function Security() {
  const [status, setStatus] = useState(null);      // /api/auth/status
  const [policy, setPolicy] = useState(null);      // /api/security/policy
  const [twoFA, setTwoFA] = useState({ enabled: false });
  const [setup2FA, setSetup2FA] = useState(null);  // { qrDataUrl, secret, uri }
  const [backupCodes, setBackupCodes] = useState(null);
  const [form, setForm] = useState({ username: '', password: '', confirm: '', email: '', displayName: '' });
  const [pwForm, setPwForm] = useState({ current: '', next: '' });
  const [sessions, setSessions] = useState([]);
  const [msg, setMsg] = useState(null);            // { kind: 'ok'|'err', text }
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [login, setLogin] = useState({ username: '', password: '', code: '', requires2FA: false });

  const say = (kind, text) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 6000); };

  const refresh = useCallback(async () => {
    try {
      const [a, p, t] = await Promise.all([
        fetch('/api/auth/status').then(r => r.json()),
        fetch('/api/security/policy').then(r => r.json()).catch(() => null),
        fetch('/api/auth/2fa/status').then(r => r.json()).catch(() => ({ enabled: false })),
      ]);
      setStatus(a); setPolicy(p); setTwoFA(t);
      if (a.authenticated) {
        fetch('/api/auth/sessions').then(r => r.json()).then(d => setSessions(d.sessions || [])).catch(() => {});
      }
    } catch (e) { say('err', 'Cannot reach the AEON kernel: ' + e.message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const post = async (url, body) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${url} failed (${r.status})`);
      return d;
    } finally { setBusy(false); }
  };

  const createAccount = async () => {
    if (form.password !== form.confirm) return say('err', 'Passwords do not match.');
    try {
      await post('/api/auth/setup', { username: form.username, password: form.password, email: form.email, displayName: form.displayName });
      const d = await post('/api/auth/login', { username: form.username, password: form.password });
      if (d.token) try { localStorage.setItem('aeon_session_token', d.token); } catch {}
      say('ok', 'Account created. AEON is now protected — it will ask for this password every time it opens.');
      refresh();
    } catch (e) { say('err', e.message); }
  };

  const doLogin = async () => {
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: login.username, password: login.password, code: login.code || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.requires2FA) { setLogin(l => ({ ...l, requires2FA: true })); say('ok', 'Enter the 6-digit code from your authenticator app.'); return; }
      if (!r.ok) throw new Error(d.error || 'Sign in failed');
      if (d.token) try { localStorage.setItem('aeon_session_token', d.token); } catch {}
      say('ok', `Welcome back, ${d.user?.displayName || login.username}.`);
      setLogin({ username: '', password: '', code: '', requires2FA: false });
      refresh();
    } catch (e) { say('err', e.message); }
  };

  const setPolicyField = async (patch) => {
    try {
      await post('/api/security/policy', patch);
      setPolicy(p => p ? { ...p, policy: { ...p.policy, ...patch } } : p);
      say('ok', 'Protection updated.');
    } catch (e) { say('err', e.message); refresh(); }
  };

  const lockNow = async () => {
    try {
      const d = await post('/api/security/lock');
      say('ok', d.text || 'Locked.');
      try { localStorage.removeItem('aeon_session_token'); } catch {}
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { say('err', e.message); }
  };

  const flushNow = async () => {
    try { const d = await post('/api/security/flush'); say('ok', d.text || 'Synced.'); refresh(); }
    catch (e) { say('err', e.message); }
  };

  const start2FA = async () => {
    try { setSetup2FA(await post('/api/auth/2fa/setup')); }
    catch (e) { say('err', e.message); }
  };
  const confirm2FA = async () => {
    try {
      const d = await post('/api/auth/2fa/verify', { code });
      setBackupCodes(d.backupCodes || []);
      setSetup2FA(null); setCode('');
      say('ok', 'Two-factor is ON. Save your backup codes somewhere safe.');
      refresh();
    } catch (e) { say('err', e.message); }
  };

  const changePassword = async () => {
    try {
      await post('/api/auth/change-password', { currentPassword: pwForm.current, newPassword: pwForm.next });
      setPwForm({ current: '', next: '' });
      say('ok', 'Password changed. Other devices were signed out.');
    } catch (e) { say('err', e.message); }
  };

  if (!status) return <div style={S.page}><p>Checking security status…</p></div>;

  const p = (policy && policy.policy) || {};
  const protectedNow = status.configured && (p.guardEnabled ?? true);

  return (
    <div style={S.page}>
      {msg && (
        <div role="status" style={{ position: 'sticky', top: 8, zIndex: 5, marginBottom: 14, padding: '10px 16px', borderRadius: 8, fontSize: 13,
          background: msg.kind === 'ok' ? 'rgba(57,255,20,0.08)' : 'rgba(255,68,85,0.08)',
          border: `1px solid ${msg.kind === 'ok' ? '#39ff14' : '#ff4455'}`, color: msg.kind === 'ok' ? '#39ff14' : '#ff4455' }}>
          {msg.text}
        </div>
      )}

      {/* ── Status hero ── */}
      <div style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div aria-hidden="true" style={{ fontSize: 42 }}>{protectedNow ? '🛡️' : '⚠️'}</div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: protectedNow ? '#39ff14' : '#f59e0b' }}>
            {protectedNow ? 'AEON IS PROTECTED' : status.configured ? 'PROTECTION PAUSED' : 'NOT PROTECTED YET'}
          </div>
          <div style={{ ...S.sub, margin: '4px 0 0' }}>
            {protectedNow
              ? `Password required ${p.lockEveryLaunch ? 'every time AEON opens' : 'after sign-out'} · auto-locks after ${p.idleMinutes} min away${policy && policy.syncConfigured ? ' · data syncs to your cloud on lock' : ''}.`
              : status.configured
                ? 'Your account exists but the guard is off. Anyone at this computer can open AEON.'
                : 'Create your account below. From then on, AEON asks for your password — even if the laptop is stolen.'}
          </div>
        </div>
        {status.configured && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={S.btnAmber} onClick={lockNow} disabled={busy}>🔒 Lock now</button>
            <button style={S.btn} onClick={flushNow} disabled={busy}>☁ Sync &amp; protect</button>
          </div>
        )}
      </div>

      {/* ── Locked: account exists but this device isn't signed in ── */}
      {status.configured && !status.authenticated && (
        <div style={S.card}>
          <h2 style={S.h2}>🔒 Sign in to AEON</h2>
          <p style={S.sub}>This computer is locked. Enter your operator password to continue.</p>
          <div style={{ display: 'grid', gap: 10, maxWidth: 380 }}>
            <input aria-label="Username" style={S.input} placeholder="Username" autoComplete="username"
              value={login.username} onChange={e => setLogin(l => ({ ...l, username: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && doLogin()} />
            <input aria-label="Password" style={S.input} type="password" placeholder="Password" autoComplete="current-password"
              value={login.password} onChange={e => setLogin(l => ({ ...l, password: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && doLogin()} />
            {login.requires2FA && (
              <input aria-label="Two-factor code" style={S.input} inputMode="numeric" maxLength={8}
                placeholder="6-digit code (or a backup code)"
                value={login.code} onChange={e => setLogin(l => ({ ...l, code: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && doLogin()} />
            )}
            <button style={S.btn} onClick={doLogin} disabled={busy || !login.username || !login.password}>Sign in</button>
          </div>
        </div>
      )}

      {/* ── First-run account creation ── */}
      {!status.configured && (
        <div style={S.card}>
          <h2 style={S.h2}>Create your operator account</h2>
          <p style={S.sub}>One account, stored only on this computer, password scrambled with bank-grade hashing. No email required — but adding one enables rescue codes.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={S.label}>Username<input aria-label="Username" style={S.input} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label>
            <label style={S.label}>Display name<input aria-label="Display name" style={S.input} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label>
            <label style={S.label}>Password<input aria-label="Password" type="password" style={S.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
            <label style={S.label}>Confirm password<input aria-label="Confirm password" type="password" style={S.input} value={form.confirm} onChange={e => setForm({ ...form, confirm: e.target.value })} /></label>
            <label style={{ ...S.label, gridColumn: '1 / -1' }}>Email (optional, for rescue codes)<input aria-label="Email" type="email" style={S.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          </div>
          <div style={{ fontSize: 11.5, color: '#6a7f95', margin: '8px 0 12px' }}>At least 8 characters with an UPPERCASE letter, a lowercase letter, and a number.</div>
          <button style={S.btn} onClick={createAccount} disabled={busy}>Create account &amp; protect AEON</button>
        </div>
      )}

      {/* ── Protection policy ── */}
      {status.configured && policy && (
        <div style={S.card}>
          <h2 style={S.h2}>Protection</h2>
          <p style={S.sub}>Plain rules, enforced by the kernel on every single request.</p>

          <div style={S.row}>
            <div>
              <div style={S.label}>Ask for my password every time AEON opens</div>
              <div style={S.hint}>Stolen-laptop defense. Closing AEON (or restarting the computer) always locks it.</div>
            </div>
            <Toggle id="lockEveryLaunch" checked={!!p.lockEveryLaunch} onChange={v => setPolicyField({ lockEveryLaunch: v })} />
          </div>

          <div style={S.row}>
            <div>
              <div style={S.label}>Lock automatically when I step away</div>
              <div style={S.hint}>Doctor's office, library, HR desk — if you forget, AEON doesn't.</div>
            </div>
            <select aria-label="Auto-lock after minutes" style={S.select} value={p.idleMinutes || 5}
              onChange={e => setPolicyField({ idleMinutes: Number(e.target.value) })}>
              {[1, 5, 10, 15, 30, 60].map(m => <option key={m} value={m}>after {m} min</option>)}
            </select>
          </div>

          <div style={S.row}>
            <div>
              <div style={S.label}>Sync my data to my own cloud when AEON locks</div>
              <div style={S.hint}>
                {policy.syncConfigured
                  ? 'Encrypted with your vault key, pushed to YOUR Supabase (free tier). Nothing goes to us.'
                  : 'Needs a free Supabase connection — add it in Settings → Connections. Locking works either way.'}
              </div>
            </div>
            <Toggle id="flushOnLock" checked={!!p.flushOnLock} onChange={v => setPolicyField({ flushOnLock: v })} />
          </div>

          <div style={S.row}>
            <div>
              <div style={S.label}>Deployment shield</div>
              <div style={S.hint}>If you publish AEON to Vercel, Cloudflare, or a tunnel, no cache anywhere may store your data. {policy.earlywareActive ? '' : '⚠ Partial — update the AEON kernel for full coverage.'}</div>
            </div>
            <Toggle id="shield" checked={!!p.shield} onChange={v => setPolicyField({ shield: v })} />
          </div>

          <div style={S.row}>
            <div>
              <div style={S.label}>Guard on</div>
              <div style={S.hint}>Master switch. Off = AEON opens for anyone at this computer.</div>
            </div>
            <Toggle id="guardEnabled" checked={!!p.guardEnabled} onChange={v => setPolicyField({ guardEnabled: v })} />
          </div>

          {policy.lastFlush && (
            <div style={{ ...S.hint, marginTop: 10 }}>
              Last sync: {new Date(policy.lastFlush.at).toLocaleString()} · {policy.lastFlush.stores} store(s) · {policy.lastFlush.pushed ? 'pushed to your cloud ✓' : 'local only'} ({policy.lastFlush.reason})
            </div>
          )}
        </div>
      )}

      {/* ── Two-factor ── */}
      {status.configured && status.authenticated && (
        <div style={S.card}>
          <h2 style={S.h2}>Two-step verification</h2>
          {twoFA.enabled ? (
            <p style={S.sub}>✅ ON — signing in needs your password <b>and</b> a 6-digit code from your phone's authenticator app.</p>
          ) : setup2FA ? (
            <div>
              <p style={S.sub}>1) Open Google Authenticator (or any authenticator app) → add account → scan this code. 2) Type the 6-digit code it shows.</p>
              {setup2FA.qrDataUrl
                ? <img src={setup2FA.qrDataUrl} alt="QR code for authenticator app setup" style={{ background: '#fff', borderRadius: 8, padding: 6 }} />
                : <div style={{ ...S.hint, wordBreak: 'break-all' }}>Manual key: <b>{setup2FA.secret}</b></div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, maxWidth: 320 }}>
                <input aria-label="Six digit code" style={S.input} inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={e => setCode(e.target.value)} />
                <button style={S.btn} onClick={confirm2FA} disabled={busy || code.length !== 6}>Turn on</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={S.sub}>Even if someone learns your password, they can't get in without your phone. Free, works offline.</p>
              <button style={S.btn} onClick={start2FA} disabled={busy}>Set up two-step verification</button>
              {policy && policy.syncConfigured === false && (
                <div style={{ ...S.hint, marginTop: 8 }}>Prefer email codes? Connect the free Supabase tier in Settings and AEON can email you a rescue code instead.</div>
              )}
            </div>
          )}
          {backupCodes && (
            <div style={{ marginTop: 12, padding: 12, border: '1px dashed #f59e0b', borderRadius: 8 }}>
              <div style={{ ...S.label, color: '#f59e0b', marginBottom: 6 }}>Backup codes — print or write these down. Each works once.</div>
              <div style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: 1, lineHeight: 1.9 }}>{backupCodes.join('   ')}</div>
            </div>
          )}
        </div>
      )}

      {/* ── Password + sessions ── */}
      {status.configured && status.authenticated && (
        <div style={S.card}>
          <h2 style={S.h2}>Password &amp; devices</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end', maxWidth: 640 }}>
            <label style={S.label}>Current password<input aria-label="Current password" type="password" style={S.input} value={pwForm.current} onChange={e => setPwForm({ ...pwForm, current: e.target.value })} /></label>
            <label style={S.label}>New password<input aria-label="New password" type="password" style={S.input} value={pwForm.next} onChange={e => setPwForm({ ...pwForm, next: e.target.value })} /></label>
            <button style={S.btn} onClick={changePassword} disabled={busy || !pwForm.current || !pwForm.next}>Change</button>
          </div>
          {sessions.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ ...S.hint, marginBottom: 6 }}>Signed-in devices</div>
              {sessions.map(s => (
                <div key={s.id} style={{ ...S.row, fontSize: 12.5 }}>
                  <span>{s.current ? '● This device' : '○ ' + (s.ua || 'Unknown device')}<span style={S.hint}> · since {new Date(s.created).toLocaleString()}</span></span>
                  {!s.current && (
                    <button style={S.btnRed} onClick={async () => { await post('/api/auth/sessions/revoke', { id: s.id }); refresh(); }}>Sign out</button>
                  )}
                </div>
              ))}
              <button style={{ ...S.btnRed, marginTop: 8 }} onClick={async () => { await post('/api/auth/sessions/revoke', { all: true }); refresh(); say('ok', 'All other devices signed out.'); }}>
                Sign out everywhere else
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
