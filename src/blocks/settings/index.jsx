import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Settings as SettingsIcon, Check, X, RefreshCw, Zap, Shield, ChevronDown, ChevronUp, Search, Wifi, WifiOff, Activity, Cpu, Database, Layers, ToggleLeft, ToggleRight, User, Lock, KeyRound, LogOut, LogIn, Save, Eye, Palette, Wrench } from 'lucide-react';
import { authFetch, login as apiLogin, logout as apiLogout } from '../../kernel/auth';
import { BLOCKS as INSTALLED_BLOCKS } from '../../kernel/blockRegistry';
import { BlockIcon } from '../../components/BlockIcon';

// Derive provider registry from nervous system — no mutable module state.
function getProviderRegistry(ns) {
  if (!ns || !ns.providers) return []; // error payloads (429/500) must not crash Settings
  return Object.values(ns.providers).map(p => ({
    id: p.id, label: p.label, icon: p.icon, kind: p.kind,
    fallbackModels: p.registryModels || [],
  }));
}

// Roles are derived from whatever's configured in settings.models (aeon-settings.json).
// No hardcoded list — if the user adds a new role via the API, it appears automatically.
const ROLE_DEFAULTS = {
  chat: { label: 'Chat / Terminal', desc: 'Neural Terminal conversations and slash commands', icon: '💬' },
  grading: { label: 'Grading / Analysis', desc: 'ATS resume scoring, sandbox audits', icon: '📊' },
  research: { label: 'Research', desc: 'Deep research pipeline and report generation', icon: '🔬' },
  creative: { label: 'Creative', desc: 'Email drafting, content generation, idea hooks', icon: '✨' },
  agent_worker: { label: 'Agent — Worker', desc: 'Mission Runner: executes tool calls, one step at a time. Keep this fast/free.', icon: '🛠️' },
  agent_heavy: { label: 'Agent — Planner/Auditor', desc: 'Mission Runner: plans subtasks and audits the final report against evidence.', icon: '🧭' },
  agent_final: { label: 'Agent — Final Output', desc: 'Set this to Claude for the polished final answer while worker/planner stay on free tiers.', icon: '🎯' },
  agent_final_advisor: { label: 'Agent — Final Advisor (optional)', desc: 'Only used when Agent — Final Output is Claude. Set a stronger Claude model here (e.g. claude-opus-4-8) and it can consult that model mid-answer for hard judgment calls. Leave the model blank to disable.', icon: '🧭' },
  vision: { label: 'Vision (image reading)', desc: 'Reads images for the terminal upload and the agent\'s read_image tool. Needs a vision-capable model — Groq Llama 4 Scout (free), Gemini, or Claude.', icon: '👁️' },
};
function deriveRoles(settingsModels) {
  if (!settingsModels) return [];
  return Object.keys(settingsModels).map(key => ({
    key,
    label: ROLE_DEFAULTS[key]?.label || fieldLabel(key),
    desc: ROLE_DEFAULTS[key]?.desc || '',
    icon: ROLE_DEFAULTS[key]?.icon || '⚙️',
  }));
}

// ── Toast System ─────────────────────────────────────────────────────
const toastQueue = [];
let toastTimer = null;

function showToast(msg, type = 'info') {
  const el = document.getElementById('aeon-settings-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `settings-toast settings-toast--${type} settings-toast--visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'settings-toast'; }, 2200);
}

// ── Pref Helpers (Odysseus syncPref pattern) ─────────────────────────
async function loadPref(key, fallback = null) {
  try {
    const r = await fetch(`/api/prefs/${key}`);
    if (!r.ok) return fallback;
    const d = await r.json();
    return d.value !== null && d.value !== undefined ? d.value : fallback;
  } catch { return fallback; }
}

async function savePref(key, value) {
  try {
    const r = await fetch(`/api/prefs/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    return r.ok;
  } catch { return false; }
}

// ── Searchable Model Picker ──────────────────────────────────────────
function ModelPicker({ models, value, onChange, label = 'Model', id }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = models.filter(m => m.toLowerCase().includes(search.toLowerCase()));

  if (models.length <= 5) {
    return (
      <select id={id} value={value} onChange={e => onChange(e.target.value)} className="settings-select" aria-label={label}>
        {models.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
    );
  }

  return (
    <div ref={ref} className="model-picker-wrap">
      <button id={id} type="button" className="model-picker-trigger" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        <span className="model-picker-value">{value || 'Select model...'}</span>
        <ChevronDown size={12} style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div className="model-picker-dropdown">
          <div className="model-picker-search-wrap">
            <Search size={12} style={{ opacity: 0.4 }} />
            <input
              autoFocus
              className="model-picker-search"
              placeholder="Search models..."
              aria-label="Search models"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="model-picker-list" role="listbox" aria-label="Models">
            {filtered.length === 0 && <div className="model-picker-empty">No matches</div>}
            {filtered.map(m => (
              <div
                key={m}
                role="option"
                aria-selected={m === value}
                tabIndex={0}
                className={`model-picker-item ${m === value ? 'model-picker-item--active' : ''}`}
                onClick={() => { onChange(m); setOpen(false); setSearch(''); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(m); setOpen(false); setSearch(''); } }}
              >
                {m}
                {m === value && <Check size={12} style={{ color: 'var(--accent)' }} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toggle Switch (Odysseus syncPrefToggle) ──────────────────────────
function PrefToggle({ label, desc, prefKey, defaultVal = true, onMsg, offMsg, onChange: externalOnChange }) {
  const [checked, setChecked] = useState(defaultVal);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPref(prefKey, defaultVal).then(v => { setChecked(!!v); setLoading(false); });
  }, [prefKey]);

  const toggle = async () => {
    const next = !checked;
    setChecked(next);
    const ok = await savePref(prefKey, next);
    if (!ok) {
      setChecked(!next);
      showToast('Failed to save preference', 'error');
      return;
    }
    showToast(next ? (onMsg || `${label} enabled`) : (offMsg || `${label} disabled`));
    if (externalOnChange) externalOnChange(next);
  };

  return (
    <div className="pref-toggle-row">
      <div className="pref-toggle-info">
        <span className="pref-toggle-label">{label}</span>
        {desc && <span className="pref-toggle-desc">{desc}</span>}
      </div>
      <button
        className={`pref-toggle-btn ${checked ? 'pref-toggle-btn--on' : ''} ${loading ? 'pref-toggle-btn--loading' : ''}`}
        onClick={toggle}
        disabled={loading}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span className="pref-toggle-knob" />
      </button>
    </div>
  );
}

// ── Provider Card with Live Test ─────────────────────────────────────
function ProviderCard({ id, label, connected, onTest, providerRegistry }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const reg = (providerRegistry || []).find(p => p.id === id);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const t0 = performance.now();
      const r = await fetch(`/api/settings/test-provider/${id}`, { method: 'POST' });
      const data = await r.json();
      data.latency_ms = Math.round(performance.now() - t0);
      setResult(data);
      if (data.ok) showToast(`${label} connected (${data.latency_ms}ms)`);
      else showToast(`${label}: ${data.error || 'Failed'}`, 'error');
    } catch (err) {
      setResult({ ok: false, error: err.message });
      showToast(`${label}: connection failed`, 'error');
    }
    setTesting(false);
  };

  // F3b — ONE status, derived from ability to serve.
  //
  // This badge said "Connected" from CONFIGURATION while the Test button's live
  // probe said "Failed" in a toast, and the card showed both at once with
  // nothing saying which question each had answered. The operator saw
  // "Local · Connected · 11 ms" beside "local: Failed" and neither was wrong.
  //
  // "Connected" now requires a probe that actually came back. Configuration
  // alone earns "Configured" — true, and it does not claim the provider can
  // serve. The probe result stays as detail BENEATH the badge, never as a
  // contradiction beside it.
  const status = !connected
    ? { text: 'Not configured', tone: 'off' }
    : result == null
      ? { text: 'Configured', tone: 'idle' }
      : result.ok
        ? { text: 'Connected', tone: 'ok' }
        : { text: 'Configured · not responding', tone: 'warn' };

  return (
    <div className={`provider-card provider-card--${status.tone === 'ok' ? 'ok' : status.tone === 'off' ? 'off' : status.tone}`}>
      <div className="provider-card-header">
        <span className={`provider-dot ${status.tone === 'ok' ? 'provider-dot--on' : ''}`} />
        <span className="provider-card-icon">{reg?.icon || '🔌'}</span>
        <span className="provider-card-label">{label}</span>
        <span className={`provider-card-status ${status.tone === 'off' ? 'provider-card-status--off' : ''}`}
              title={status.tone === 'idle' ? 'Configured. Press Test to check it can serve.' : undefined}>
          {status.text}
        </span>
      </div>
      {result && result.ok && result.models && (
        <div className="provider-card-models">
          {result.models.slice(0, 6).map(m => <span key={m} className="provider-model-chip">{m}</span>)}
          {result.models.length > 6 && <span className="provider-model-chip provider-model-chip--more">+{result.models.length - 6}</span>}
        </div>
      )}
      {result && !result.ok && <div className="provider-card-error">{result.error}</div>}
      <button className={`provider-test-btn ${testing ? 'provider-test-btn--spin' : ''}`} onClick={test} disabled={testing} title="Test connection">
        <Activity size={11} />
        <span>{testing ? 'Testing...' : result ? `${result.latency_ms}ms` : 'Test'}</span>
      </button>
    </div>
  );
}

// ── Role Card ────────────────────────────────────────────────────────
function RoleCard({ role, config, providers, liveModels, onUpdate, providerBlocks, providerRegistry }) {
  const providerReg = (providerRegistry || []).find(p => p.id === config?.provider);
  // `?.length ?` not `||` — an empty array is truthy, so a provider that
  // answered with zero models short-circuited the fallback and rendered a
  // blank <select>. That is how a ready local model stayed invisible.
  const live = liveModels[config?.provider];
  const models = (live?.length ? live : providerReg?.fallbackModels) || [];
  const isLocal = config?.provider === 'local';
  const isConfigured = providers[config?.provider];
  const poweredBlocks = providerBlocks?.[config?.provider] || [];

  return (
    <div className="admin-card role-card">
      <div className="role-card-header">
        <span className="role-card-icon">{role.icon}</span>
        <div>
          <div className="role-card-title">{role.label}</div>
          <div className="role-card-desc">{role.desc}</div>
        </div>
        {!isConfigured && config?.provider && (
          <span className="role-card-warning">⚠ {config.provider} not configured</span>
        )}
        {isConfigured && poweredBlocks.length > 0 && (
          <span className="role-card-count">{poweredBlocks.length} blocks</span>
        )}
      </div>
      <div className="role-card-selects">
        <div className="role-select-group">
          <label className="role-select-label" htmlFor={`role-provider-${role.key}`}>Provider</label>
          <select
            id={`role-provider-${role.key}`}
            className="settings-select"
            value={config?.provider || 'groq'}
            onChange={e => onUpdate(role.key, 'provider', e.target.value)}
          >
            {(providerRegistry || []).filter(p => providers[p.id]).map(p => (
              <option key={p.id} value={p.id}>{p.icon} {p.label}</option>
            ))}
            {(providerRegistry || []).filter(p => !providers[p.id]).length > 0 && (
              <optgroup label="Not configured">
                {(providerRegistry || []).filter(p => !providers[p.id]).map(p => (
                  <option key={p.id} value={p.id}>{p.icon} {p.label} (no key)</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="role-select-group" style={{ flex: 2 }}>
          <label className="role-select-label" htmlFor={`role-model-${role.key}`}>Model</label>
          <ModelPicker
            id={`role-model-${role.key}`}
            label={`Model for ${role.label}`}
            models={models}
            value={config?.model || ''}
            onChange={v => onUpdate(role.key, 'model', v)}
          />
          {/* §08 — an error must name every remedy, cheapest first. A blank
              dropdown tells the operator nothing they can act on, and it looks
              identical whether the provider has no models, no key, or is
              simply not installed. */}
          {models.length === 0 && (
            <div style={{ fontSize: 11, color: '#ffb454', marginTop: 3 }}>
              {isLocal
                ? 'No local model installed yet — install one in Cookbook ▸ Hardware, then reopen this page.'
                : `No models available from ${config?.provider || 'this provider'} — add a key under Connections, or switch to Local and install a model in Cookbook.`}
            </div>
          )}
        </div>
      </div>
      {poweredBlocks.length > 0 && (
        <div className="role-card-blocks">
          {poweredBlocks.map(b => {
            const label = typeof b === 'string' ? b : (b.label || b.id);
            const id = typeof b === 'string' ? b : b.id;
            return <span key={id} className={`role-block-chip ${isConfigured ? 'role-block-chip--ok' : ''}`}>{label.replace(/_/g, ' ')}</span>;
          })}
        </div>
      )}
    </div>
  );
}

// ── Account & Security Panel (reuses security block API) ─────────────
function AccountPanel() {
  const [status, setStatus] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [profile, setProfile] = useState({ displayName: '', email: '' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/auth/status');
      // Auth block removed → route 404s. Show the honest empty state instead
      // of loading forever (never call what does not exist — Rule 2).
      if (r.status === 404) { setStatus({ unavailable: true }); return; }
      const d = await r.json();
      setStatus(d);
      if (d.user) setProfile({ displayName: d.user.displayName || '', email: d.user.email || '' });
    } catch { setStatus({ unavailable: true }); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const doLogin = async () => {
    setBusy(true);
    const r = await apiLogin(loginForm.username, loginForm.password);
    setBusy(false);
    if (r.ok) { showToast(`Signed in as ${r.user?.displayName || loginForm.username}`); setLoginForm({ username: '', password: '' }); refresh(); }
    else showToast(r.error || 'Login failed', 'error');
  };

  const doLogout = async () => { await apiLogout(); showToast('Logged out'); refresh(); };

  const saveProfile = async () => {
    setBusy(true);
    const r = await authFetch('/api/auth/profile', { method: 'POST', body: JSON.stringify(profile) });
    const d = await r.json();
    setBusy(false);
    if (r.ok) { showToast('Profile updated'); refresh(); } else showToast(d.error || 'Update failed', 'error');
  };

  const changePw = async () => {
    if (pw.newPassword !== pw.confirm) return showToast('New passwords do not match', 'error');
    setBusy(true);
    const r = await authFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: pw.currentPassword, newPassword: pw.newPassword }) });
    const d = await r.json();
    setBusy(false);
    if (r.ok) { showToast('Password changed'); setPw({ currentPassword: '', newPassword: '', confirm: '' }); }
    else showToast(d.error || 'Change failed', 'error');
  };

  if (!status) return <div className="admin-card" style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading account...</div>;

  // Auth block not installed — honest empty state, no dead controls.
  if (status.unavailable) {
    return (
      <div className="admin-card account-empty">
        <Shield size={18} color="var(--text-dim)" />
        <span>Operator auth is not installed in this build. Account controls will appear when a security block is added.</span>
      </div>
    );
  }

  // No account yet — point to the Security block for first-run setup.
  if (!status.configured) {
    return (
      <div className="admin-card account-empty">
        <Shield size={18} color="var(--accent)" />
        <span>No operator account configured. Open the <b>Security</b> block to create one.</span>
      </div>
    );
  }

  // Account exists but this client isn't authenticated — inline login.
  if (!status.authenticated) {
    return (
      <div className="admin-card">
        <div className="account-head"><Lock size={14} color="var(--accent)" /> Sign in to manage your account</div>
        <div className="account-form">
          <input className="settings-select" placeholder="Username" aria-label="Username" autoComplete="username" value={loginForm.username} onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))} onKeyDown={e => e.key === 'Enter' && doLogin()} />
          <input className="settings-select" type="password" placeholder="Password" aria-label="Password" autoComplete="current-password" value={loginForm.password} onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} onKeyDown={e => e.key === 'Enter' && doLogin()} />
          <button type="button" className="settings-btn settings-btn--primary" onClick={doLogin} disabled={busy || !loginForm.username || !loginForm.password}><LogIn size={12} /> Sign in</button>
        </div>
      </div>
    );
  }

  // Authenticated — profile + password management.
  return (
    <div className="account-section">
      <div className="admin-card">
        <div className="account-head">
          <div className="account-avatar">{(status.user.displayName || status.user.username).slice(0, 1).toUpperCase()}</div>
          <div style={{ flex: 1 }}>
            <div className="account-name">{status.user.displayName}</div>
            <div className="account-sub">@{status.user.username} · <span className="account-role">{status.user.role}</span> · {status.user.sessionCount} session(s)</div>
          </div>
          <button className="settings-btn settings-btn--secondary" onClick={doLogout}><LogOut size={12} /> Log out</button>
        </div>
        <div className="account-fields">
          <div className="account-field">
            <label htmlFor="account-display-name">Display name</label>
            <input id="account-display-name" className="settings-select" value={profile.displayName} onChange={e => setProfile(p => ({ ...p, displayName: e.target.value }))} />
          </div>
          <div className="account-field">
            <label htmlFor="account-email">Email</label>
            <input id="account-email" className="settings-select" value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))} placeholder="you@example.com" />
          </div>
          <button type="button" className="settings-btn settings-btn--secondary account-save" onClick={saveProfile} disabled={busy}><Check size={12} /> Save profile</button>
        </div>
      </div>

      <div className="admin-card">
        <div className="account-head"><KeyRound size={14} color="var(--accent)" /> Change password</div>
        <div className="account-pw">
          <input className="settings-select" type="password" placeholder="Current password" aria-label="Current password" value={pw.currentPassword} onChange={e => setPw(p => ({ ...p, currentPassword: e.target.value }))} autoComplete="current-password" />
          <input className="settings-select" type="password" placeholder="New password" aria-label="New password" value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} autoComplete="new-password" />
          <input className="settings-select" type="password" placeholder="Confirm new password" aria-label="Confirm new password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} autoComplete="new-password" />
          <button type="button" className="settings-btn settings-btn--primary" onClick={changePw} disabled={busy || !pw.currentPassword || !pw.newPassword}><Lock size={12} /> Update password</button>
        </div>
        <p className="account-hint">8+ chars with upper, lower & a number. Changing your password revokes all other active sessions.</p>
      </div>
    </div>
  );
}

// ── Build Approval Queue (W5/GAP 2 behaviors surfaced; M3 UI debt) ────
// MEDIUM = single-click + permission summary. HIGH = full review + code
// diff + explicit approve. Tier 3 (shell) additionally needs IDE mode ON.
function BuildQueuePanel() {
  const [items, setItems] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/build/queue').then(r => r.json()).then(d => setItems(d.items || [])).catch(() => {});
    fetch('/api/build/blocks').then(r => r.json()).then(d => setBlocks(d.blocks || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const decide = async (id, verb) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/build/queue/${id}/${verb}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) window.alert(d.error || `${verb} failed`);
    } catch {}
    setBusy(false); load();
  };
  const setRun = async (id, on) => {
    await fetch(`/api/build/blocks/${id}/${on ? 'start' : 'stop'}`, { method: 'POST' }).catch(() => {});
    load();
  };

  const pending = items.filter(i => i.status === 'pending');
  const stopped = blocks.filter(b => !b.running);

  return (
    <div className="admin-card">
      {pending.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No builds waiting for your approval.</div>}
      {pending.map(item => (
        <div key={item.id} style={{ border: '1px solid var(--border, #1f2937)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13 }}>{item.blockId}</b>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
              background: item.score === 'HIGH' ? 'rgba(239,68,68,.15)' : 'rgba(245,158,11,.15)',
              color: item.score === 'HIGH' ? '#f87171' : '#fbbf24' }}>
              {item.score} · {item.behavior === 'full-review' ? 'full review required' : 'single-click'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>from {item.source}</span>
            <span style={{ flex: 1 }} />
            {item.score === 'HIGH' && (
              <button type="button" className="settings-btn settings-btn--secondary" style={{ fontSize: 11 }} aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                {expanded === item.id ? 'Hide code' : 'Review code'}
              </button>
            )}
            <button type="button" className="settings-btn" disabled={busy || (item.score === 'HIGH' && expanded !== item.id)}
              title={item.score === 'HIGH' && expanded !== item.id ? 'HIGH builds require reviewing the code first' : ''}
              onClick={() => decide(item.id, 'approve')}>Approve</button>
            <button type="button" className="settings-btn settings-btn--secondary" disabled={busy} onClick={() => decide(item.id, 'reject')}>Reject</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            {(item.reasons || []).map((r, i) => <div key={i}>• [{r.sev}] {r.why}</div>)}
            {item.permissions?.shell === true && <div style={{ color: '#f87171', fontWeight: 600 }}>• Tier 3: shell access — approving requires IDE mode ON.</div>}
          </div>
          {expanded === item.id && (
            <pre style={{ fontSize: 10, maxHeight: 260, overflow: 'auto', background: 'rgba(0,0,0,.35)', borderRadius: 6, padding: 8, marginTop: 8 }}>
              {(item.files || []).map(f => `── ${f.path} ──\n${f.content}`).join('\n\n') || '(no files on item)'}
            </pre>
          )}
        </div>
      ))}
      {stopped.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #1f2937)', paddingTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6 }}>INSTALLED BUT NOT RUNNING (start when ready)</div>
          {stopped.map(b => (
            <div key={b.blockId || b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
              <span>{b.blockId || b.id}</span><span style={{ flex: 1 }} />
              <button className="settings-btn" style={{ fontSize: 11 }} onClick={() => setRun(b.blockId || b.id, true)}>Start</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Connections Panel (endpoint registry + vault) ───────────────────
// ── All provider/service data comes from /api/settings/nervous-system ──
// No hardcoded provider, service, or field lists in the frontend.

// Auto-derive field labels from camelCase keys — no hardcoded map.
function fieldLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .replace(/Id$/, 'ID')
    .replace(/Url$/, 'URL')
    .trim();
}

// Block→provider dependencies are live-read from manifests via
// /api/settings/provider-blocks. No hardcoded maps.

function AccountIdentities({ endpoints, nervousSystem }) {
  const [accounts, setAccounts] = useState({});
  const [providerBlocks, setProviderBlocks] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [dirty, setDirty] = useState(false);

  const [providerDetails, setProviderDetails] = useState({});

  useEffect(() => {
    loadPref('provider_accounts', {}).then(a => setAccounts(a || {}));
    fetch('/api/settings/provider-blocks').then(r => r.json()).then(d => setProviderBlocks(d)).catch(() => {});
    fetch('/api/settings/provider-details').then(r => r.json()).then(d => setProviderDetails(d)).catch(() => {});
  }, []);

  const update = (svcId, field, value) => {
    setAccounts(prev => ({
      ...prev,
      [svcId]: { ...(prev[svcId] || {}), [field]: value }
    }));
    setDirty(true);
  };

  const saveAll = async () => {
    const ok = await savePref('provider_accounts', accounts);
    if (ok) { showToast('Account identities saved'); setDirty(false); }
    else showToast('Save failed', 'error');
  };

  // Derive service list from endpoints and nervous system
  const allServices = [];
  (endpoints || []).forEach(ep => {
    const p = nervousSystem?.providers?.[ep.provider] || { label: ep.provider, icon: '🔌', kind: 'cloud', details: {} };
    const fields = Object.keys(p.details || {}).filter(k => k !== 'keyHint' && k !== 'keyCount');
    if (!fields.includes('email')) fields.push('email');
    allServices.push({
      id: ep.id, providerId: ep.provider, label: ep.label || p.label, icon: p.icon, kind: p.kind, fields, isConfigured: true
    });
  });
  const ENV_KEY_HINTS = {
    coingecko: 'COINGECKO_API_KEY', coinbase: 'COINBASE_API_KEY', canva: 'CANVA_CLIENT_SECRET',
    youtube: 'YOUTUBE_API_KEY', cloudflare: 'CLOUDFLARE_ACCOUNT_ID',
    groq: 'GROQ_API_KEY', gemini: 'GEMINI_FREE_KEY_1', openai: 'OPENAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY', grok: 'GROK_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  };
  if (nervousSystem && nervousSystem.providers) {
    Object.values(nervousSystem.providers).forEach(p => {
      // Search providers (Tavily/Serper/Brave) live in their OWN "Search Keys"
      // tab — never mix them into the LLM/service account list.
      if (p.kind === 'search') return;
      if (!(endpoints || []).some(ep => ep.provider === p.id)) {
        const fields = Object.keys(p.details || {}).filter(k => k !== 'keyHint' && k !== 'keyCount');
        if (!fields.includes('email')) fields.push('email');
        allServices.push({
          // A provider keyed via .env (e.g. added at boot) IS configured even
          // though it has no vault endpoint — honor the nervous system's own
          // verdict so status is green everywhere, not green here / red there.
          id: p.id, providerId: p.id, label: p.label, icon: p.icon, kind: p.kind, fields,
          isConfigured: !!p.configured,
          envKey: ENV_KEY_HINTS[p.id] || null,
        });
      }
    });
  }

  const configured = allServices.filter(svc => svc.isConfigured);
  const unconfigured = allServices.filter(svc => !svc.isConfigured);
  const configuredCount = configured.length;
  const readyBlockIds = new Set(configured.flatMap(svc => (providerBlocks[svc.providerId] || []).map(b => typeof b === 'string' ? b : b.id)));
  const readyBlocks = readyBlockIds.size;

  const renderCard = (svc) => {
    const isOpen = expanded === svc.id;
    const acct = accounts[svc.id] || {};
    const connected = svc.isConfigured;
    const liveBlocks = providerBlocks[svc.providerId] || [];
    const usedBy = liveBlocks;
    const hasIdentity = svc.fields.some(f => acct[f]);
    const detail = providerDetails[svc.providerId] || {};

    return (
      <div key={svc.id} className={`acct-id-card ${isOpen ? 'acct-id-card--open' : ''} ${!connected ? 'acct-id-card--missing' : ''}`}>
        <div
          className="acct-id-row"
          onClick={() => setExpanded(isOpen ? null : svc.id)}
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={`${svc.label} — ${connected ? 'configured' : 'not set'}`}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(isOpen ? null : svc.id); } }}
        >
          <span className={`provider-dot ${connected ? 'provider-dot--on' : ''}`} />
          <span className="acct-id-icon">{svc.icon}</span>
          <span className="acct-id-label">{svc.label}</span>
          {connected && <span className="acct-id-email">{acct.email || detail.email || detail.projectId || detail.channelHandle || detail.host || acct.projectId || acct.host || ''}</span>}
          {!connected && usedBy.length > 0 && <span className="acct-id-needed">{usedBy.length} block{usedBy.length > 1 ? 's' : ''} need this</span>}
          {connected && usedBy.length > 0 && <span className="acct-id-usage">{usedBy.length} block{usedBy.length > 1 ? 's' : ''} ready</span>}
          <span className={`acct-id-status ${connected ? 'acct-id-status--ok' : 'acct-id-status--missing'}`}>
            {connected ? 'configured' : 'not set'}
          </span>
          <ChevronDown size={13} className={`acct-id-chev ${isOpen ? 'acct-id-chev--open' : ''}`} />
        </div>
        {isOpen && (
          <div className="acct-id-detail">
            {/* Auto-read info from the system — no user input needed */}
            {detail && Object.keys(detail).filter(k => k !== 'configured' && detail[k]).length > 0 && (
              <div className="acct-id-auto-info">
                {detail.projectUrl && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Project</span><span className="acct-id-auto-val">{detail.projectUrl}</span></div>}
                {detail.projectId && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Project ID</span><span className="acct-id-auto-val">{detail.projectId}</span></div>}
                {detail.authDomain && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Auth domain</span><span className="acct-id-auto-val">{detail.authDomain}</span></div>}
                {detail.host && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Host</span><span className="acct-id-auto-val">{detail.host}</span></div>}
                {detail.model && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Model</span><span className="acct-id-auto-val">{detail.model}</span></div>}
                {detail.keyHint && <div className="acct-id-auto-row"><span className="acct-id-auto-label">API key</span><span className="acct-id-auto-val">{detail.keyHint}</span></div>}
                {detail.keyCount > 0 && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Keys</span><span className="acct-id-auto-val">{detail.keyCount} key(s) · {detail.plan}</span></div>}
                {detail.channelHandle && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Channel</span><span className="acct-id-auto-val">{detail.channelHandle}</span></div>}
                {detail.email && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Account</span><span className="acct-id-auto-val">{detail.email}</span></div>}
                {detail.scriptUrl && <div className="acct-id-auto-row"><span className="acct-id-auto-label">Script</span><span className="acct-id-auto-val">{detail.scriptUrl}</span></div>}
              </div>
            )}
            {/* Quick key input for unconfigured services */}
            {!connected && svc.envKey && (
              <div className="acct-id-fields" style={{ marginBottom: 8 }}>
                <div className="acct-id-field">
                  <label htmlFor={`acct-key-${svc.id}`}>API key</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input id={`acct-key-${svc.id}`} className="settings-select" type="password" placeholder={`Paste ${svc.label} API key`} value={acct._pendingKey || ''}
                      onChange={e => update(svc.id, '_pendingKey', e.target.value)} style={{ flex: 1 }} />
                    <button type="button" className="settings-btn settings-btn--primary" disabled={!acct._pendingKey}
                      onClick={async () => {
                        try {
                          const r = await fetch('/api/settings/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ vars: { [svc.envKey]: acct._pendingKey } }) });
                          if (r.ok) { showToast(`${svc.label} key saved to encrypted Vault`); update(svc.id, '_pendingKey', ''); }
                          else showToast('Save failed', 'error');
                        } catch { showToast('Save failed', 'error'); }
                      }}>
                      <Save size={12} /> Save
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* Editable fields for power users */}
            <details className="acct-id-manual">
              <summary className="acct-id-manual-summary">Edit account details</summary>
              <div className="acct-id-fields">
                {svc.fields.map(f => (
                  <div key={f} className="acct-id-field">
                    <label htmlFor={`acct-field-${svc.id}-${f}`}>{fieldLabel(f)}</label>
                    <input id={`acct-field-${svc.id}-${f}`} className="settings-select" value={acct[f] || ''} placeholder={fieldLabel(f)} onChange={e => update(svc.id, f, e.target.value)} />
                  </div>
                ))}
              </div>
            </details>
            {usedBy.length > 0 && (
              <div className="acct-id-blocks">
                <span className="acct-id-blocks-label">{connected ? 'Powering:' : 'Will unlock:'}</span>
                {usedBy.map(b => {
                  const blockId = typeof b === 'string' ? b : b.id;
                  const blockLabel = typeof b === 'string' ? b : (b.label || b.id);
                  return <span key={blockId} className={`acct-id-block-chip ${connected ? 'acct-id-block-chip--active' : ''}`}>{blockLabel.replace(/_/g, ' ')}</span>;
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="acct-id-section">
      <div className="acct-id-head">
        <span className="acct-id-title">Service accounts</span>
        <span className="acct-id-sub">{configuredCount}/{allServices.length} services configured · {readyBlocks} blocks ready</span>
        {dirty && <button className="settings-btn settings-btn--primary acct-id-save" onClick={saveAll}><Save size={12} /> Save</button>}
      </div>

      {/* Configured services first */}
      {configured.map(renderCard)}

      {/* Unconfigured services with a label */}
      {unconfigured.length > 0 && (
        <div className="acct-id-divider">
          <span className="acct-id-divider-label">Not configured</span>
          <span className="acct-id-divider-hint">Add API keys to unlock these blocks</span>
        </div>
      )}
      {unconfigured.map(renderCard)}
    </div>
  );
}

function ReachBadge({ reach }) {
  const has = (k) => reach && reach.includes(k);
  return (
    <span className="reach-badges">
      {has('local') && <span className="reach-badge reach-badge--local">desktop</span>}
      {has('cloud') && <span className="reach-badge reach-badge--cloud">cloud</span>}
    </span>
  );
}

// ── Block Config Panel — per-block provider/model assignment ─────────
// ── Block Assign Picker — searchable dropdown of ALL system blocks ───
function BlockAssignPicker({ provider, providerBlocks, allBlocks, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-detected blocks from manifests for this provider
  const autoDetected = new Set((providerBlocks[provider] || []).map(b => typeof b === 'string' ? b : b.id));

  // All blocks in the system
  const allBlockList = (allBlocks || []).map(b => ({ id: b.id, label: b.label || b.id }));
  const filtered = allBlockList.filter(b =>
    (b.label || b.id).toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  };

  return (
    <div className="role-select-group" ref={ref}>
      <label className="role-select-label">Assign to blocks ({selected.length} selected · auto-detected highlighted)</label>
      {/* Selected chips */}
      <div className="conn-block-assign">
        {selected.map(id => {
          const b = allBlockList.find(x => x.id === id);
          const isAuto = autoDetected.has(id);
          return (
            <button key={id} type="button" className={`conn-block-chip conn-block-chip--on ${isAuto ? 'conn-block-chip--auto' : ''}`}
              onClick={() => toggle(id)} aria-label={`Remove ${(b?.label || id).replace(/_/g, ' ')} from assigned blocks`}>
              {(b?.label || id).replace(/_/g, ' ')} ×
            </button>
          );
        })}
        <button type="button" className="conn-block-add-btn" onClick={() => setOpen(!open)}>
          + {open ? 'Close' : 'Add blocks'}
        </button>
      </div>
      {/* Dropdown */}
      {open && (
        <div className="conn-block-dropdown">
          <div className="conn-block-search-wrap">
            <Search size={12} style={{ opacity: 0.4 }} />
            <input
              autoFocus
              className="conn-block-search"
              placeholder="Search all blocks..."
              aria-label="Search all blocks"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="conn-block-list" role="listbox" aria-label="All blocks" aria-multiselectable="true">
            {filtered.length === 0 && <div className="conn-block-empty">No blocks match</div>}
            {filtered.map(b => {
              const isSelected = selected.includes(b.id);
              const isAuto = autoDetected.has(b.id);
              return (
                <div key={b.id}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  className={`conn-block-option ${isSelected ? 'conn-block-option--on' : ''} ${isAuto ? 'conn-block-option--auto' : ''}`}
                  onClick={() => toggle(b.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(b.id); } }}>
                  <span className="conn-block-option-check">{isSelected ? '✓' : ''}</span>
                  <span>{(b.label || b.id).replace(/_/g, ' ')}</span>
                  {isAuto && <span className="conn-block-option-tag">auto</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionsPanel({ nervousSystem }) {
  // Derive CONN_PROVIDERS from nervous system (no hardcoded list)
  const CONN_PROVIDERS = nervousSystem
    ? Object.values(nervousSystem.providers)
        .filter(p => ['cloud', 'local', 'service', 'infra'].includes(p.kind))
        .map(p => ({ id: p.id, label: p.label, kind: p.kind, needsKey: p.needsKey, base: p.base || '' }))
    : [];
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ provider: 'groq', label: '', base_url: '', apiKey: '', models: [], selectedModel: '', accountEmail: '', assignedBlocks: [] });
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accts, setAccts] = useState({});
  const [providerBlocks, setProviderBlocks] = useState({});
  const [allBlocks, setAllBlocks] = useState([]);

  const load = useCallback(async () => {
    try { const r = await fetch('/api/connections'); setData(await r.json()); } catch {}
    loadPref('provider_accounts', {}).then(a => setAccts(a || {}));
    fetch('/api/settings/provider-blocks').then(r => r.json()).then(d => setProviderBlocks(d)).catch(() => {});
    fetch('/api/settings/blocks').then(r => r.json()).then(d => setAllBlocks(d)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const pickProvider = (id) => {
    const p = CONN_PROVIDERS.find(x => x.id === id);
    if (p) {
      const liveBlocks = (providerBlocks[id] || []).map(b => typeof b === 'string' ? b : b.id);
      setForm(f => ({ ...f, provider: id, base_url: p.base || '', models: [], selectedModel: '', assignedBlocks: liveBlocks }));
    } else {
      setForm(f => ({ ...f, provider: id }));
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await fetch('/api/connections/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: form.provider, base_url: form.base_url, apiKey: form.apiKey || undefined }),
      });
      const d = await r.json();
      if (d.ok) { setForm(f => ({ ...f, models: d.models, selectedModel: d.models[0] || '' })); showToast(`Found ${d.models.length} models`); }
      else showToast(d.error || 'Discovery failed', 'error');
    } catch { showToast('Discovery failed', 'error'); }
    setDiscovering(false);
  };

  const saveConn = async () => {
    setBusy(true);
    const p = CONN_PROVIDERS.find(x => x.id === form.provider);
    try {
      const r = await fetch('/api/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          label: form.label || p?.label,
          base_url: form.base_url,
          models: form.selectedModel ? [form.selectedModel, ...form.models.filter(m => m !== form.selectedModel)] : form.models,
          apiKey: form.apiKey || undefined,
        }),
      });
      const d = await r.json();
      if (d.ok) {
        // Also persist account identity + block assignments
        if (form.accountEmail || form.assignedBlocks.length) {
          const accts = await loadPref('provider_accounts', {}) || {};
          const epId = d.endpoint?.id || form.provider;
          accts[epId] = { ...(accts[epId] || {}), email: form.accountEmail || accts[epId]?.email || '', assignedBlocks: form.assignedBlocks };
          await savePref('provider_accounts', accts);
        }
        showToast('Connection saved'); setAdding(false);
        setForm({ provider: 'groq', label: '', base_url: '', apiKey: '', models: [], selectedModel: '', accountEmail: '', assignedBlocks: [] }); load();
      } else showToast(d.error || 'Save failed', 'error');
    } catch { showToast('Save failed', 'error'); }
    setBusy(false);
  };

  const removeConn = async (id) => {
    const r = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    if (r.ok) { showToast('Connection removed'); load(); }
  };

  const sync = async () => {
    const r = await fetch('/api/connections/sync', { method: 'POST' });
    const d = await r.json();
    showToast(d.mirror ? 'Synced to cloud mirror' : 'No cloud mirror configured', d.mirror ? 'info' : 'error');
  };

  if (!data) return <div className="admin-card" style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading connections...</div>;

  const prov = CONN_PROVIDERS.find(x => x.id === form.provider);

  return (
    <div className="conn-section">
      {/* Vault status */}
      <div className={`admin-card vault-status ${data.vault.unlocked ? 'vault-status--ok' : 'vault-status--locked'}`}>
        <Lock size={14} color={data.vault.unlocked ? '#00ff40' : '#ffaa00'} />
        <div style={{ flex: 1 }}>
          <div className="vault-status-title">{data.vault.unlocked ? 'Vault unlocked' : 'Vault locked'}</div>
          <div className="vault-status-sub">
            {data.vault.unlocked
              ? `${data.vault.refs.length} key(s) stored · AES-256-GCM · runtime: ${data.runtime}${data.cloudMirror ? ' · cloud mirror on' : ''}`
              : 'Set AEON_VAULT_MASTER_KEY in .env (and Vercel env) to store API keys'}
          </div>
        </div>
        {data.cloudMirror && <button className="settings-btn settings-btn--secondary" onClick={sync}><RefreshCw size={12} /> Sync</button>}
      </div>

      {/* Credential backup warning — only shown when vault has keys */}
      {data.vault.unlocked && data.vault.refs.length > 0 && (
        <div className="admin-card" style={{ borderColor: 'rgba(245,166,35,0.4)', background: 'rgba(245,166,35,0.06)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f5a623', marginBottom: 3 }}>Back up your credentials</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim, #4a6a8a)', lineHeight: 1.5 }}>
              A reinstall or lost <code>.env</code> permanently locks your vault. Back up all three files together — <code>.env</code>, <code>secrets/aeon-keyslots.json</code>, and <code>provider_credentials.json</code>. A partial restore causes a key mismatch and locks you out.
            </div>
          </div>
          <a
            href="/api/settings/export-credentials"
            download
            className="settings-btn settings-btn--secondary"
            style={{ flexShrink: 0, fontSize: 11, whiteSpace: 'nowrap' }}
          >
            ↓ Export backup
          </a>
        </div>
      )}

      {/* Endpoint list */}
      {data.endpoints.length === 0 && !adding && (
        <div className="admin-card conn-empty">No connections yet. Add a cloud API or a local model below.</div>
      )}
      {data.endpoints.map(ep => {
        const acctInfo = accts[ep.id] || accts[ep.provider];
        return (
          <div key={ep.id} className="admin-card conn-row">
            <div className="conn-row-main">
              <span className="conn-provider-icon">{(nervousSystem?.providers?.[ep.provider]?.icon) || (ep.kind === 'local' ? '🖥️' : '🔌')}</span>
              <div style={{ flex: 1 }}>
                <div className="conn-label">{ep.label} <ReachBadge reach={ep.reachable_from} /></div>
                <div className="conn-meta">
                  {ep.provider} · {ep.models.length} model(s){ep.auth_ref ? ' · 🔑 keyed' : ''}
                  {acctInfo?.email && <> · <span className="conn-acct-email">{acctInfo.email}</span></>}
                </div>
                {acctInfo?.assignedBlocks?.length > 0 && (
                  <div className="conn-assigned-blocks">
                    {acctInfo.assignedBlocks.map(b => <span key={b} className="conn-assigned-chip">{b.replace(/_/g, ' ')}</span>)}
                  </div>
                )}
              </div>
            </div>
            <button type="button" className="conn-remove" onClick={() => removeConn(ep.id)} title="Remove" aria-label={`Remove connection: ${ep.label || ep.provider}`}><X size={14} /></button>
          </div>
        );
      })}

      {/* Add form */}
      {adding ? (
        <div className="admin-card conn-add">
          <div className="conn-add-head">Add connection</div>
          <div className="conn-add-grid">
            <div className="role-select-group">
              <label className="role-select-label" htmlFor="conn-provider">Provider</label>
              <input id="conn-provider" className="settings-select" list="provider-list" placeholder="e.g. groq or custom_api" value={form.provider} onChange={e => pickProvider(e.target.value)} />
              <datalist id="provider-list">
                {CONN_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </datalist>
            </div>
            <div className="role-select-group" style={{ flex: 2 }}>
              <label className="role-select-label" htmlFor="conn-base-url">Base URL</label>
              <input id="conn-base-url" className="settings-select" value={form.base_url} onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))} />
            </div>
          </div>
          {prov?.needsKey && (
            <div className="role-select-group">
              <label className="role-select-label" htmlFor="conn-api-key">API key {data.vault.unlocked ? '(stored encrypted in vault)' : '— vault locked'}</label>
              <input id="conn-api-key" className="settings-select" type="password" placeholder="Paste key" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} disabled={!data.vault.unlocked} />
            </div>
          )}
          <div className="role-select-group">
            <label className="role-select-label" htmlFor="conn-account-email">Account email (tied to this key)</label>
            <input id="conn-account-email" className="settings-select" placeholder="you@example.com" value={form.accountEmail} onChange={e => setForm(f => ({ ...f, accountEmail: e.target.value }))} />
          </div>
          <BlockAssignPicker
            provider={form.provider}
            providerBlocks={providerBlocks}
            allBlocks={allBlocks}
            selected={form.assignedBlocks}
            onChange={(next) => setForm(f => ({ ...f, assignedBlocks: next }))}
          />
          <div className="conn-add-actions">
            <button type="button" className="settings-btn settings-btn--secondary" onClick={discover} disabled={discovering}>
              <Search size={12} /> {discovering ? 'Discovering...' : 'Discover models'}
            </button>
            {form.models.length > 0 && (
              <select className="settings-select" style={{ flex: 1 }} value={form.selectedModel} onChange={e => setForm(f => ({ ...f, selectedModel: e.target.value }))} aria-label="Selected model">
                {form.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </div>
          <div className="conn-add-footer">
            <button type="button" className="settings-btn settings-btn--secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="settings-btn settings-btn--primary" onClick={saveConn}
              disabled={busy || (form.models.length === 0 && !form.apiKey && !form.base_url)}
              title={form.models.length === 0 ? 'Models will be discovered automatically after saving' : ''}>
              <Check size={12} /> Save connection
            </button>
          </div>
        </div>
      ) : (
        <button className="conn-add-btn" onClick={() => setAdding(true)}>+ Add connection</button>
      )}

      {/* Account identities — full service map */}
      <AccountIdentities endpoints={data?.endpoints || []} nervousSystem={nervousSystem} />
    </div>
  );
}

// ── Vision Model Select ──────────────────────────────────────────────
function VisionModelSelect() {
  const [model, setModel] = useState('auto');
  useEffect(() => { loadPref('vision_model', 'auto').then(v => setModel(v || 'auto')); }, []);
  const change = async (v) => { setModel(v); await savePref('vision_model', v); showToast(`Vision model: ${v}`); };
  return (
    <select className="settings-select" style={{ width: '180px' }} value={model} onChange={e => change(e.target.value)}>
      <option value="auto">Auto-detect</option>
      <optgroup label="Cloud">
        <option value="gpt-4o">GPT-4o</option>
        <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
        <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
        <option value="claude-sonnet-4-6">Claude Sonnet</option>
        <option value="grok-2-vision">Grok 2 Vision</option>
      </optgroup>
      <optgroup label="Local">
        <option value="llava">LLaVA (local)</option>
      </optgroup>
    </select>
  );
}

// ── Appearance Panel ─────────────────────────────────────────────────
function AppearancePanel() {
  const [theme, setTheme] = useState('dark');
  const [accent, setAccent] = useState('#00f2ff');
  const [fontSize, setFontSize] = useState(13);
  const [sidebarWidth, setSidebarWidth] = useState('normal');

  useEffect(() => {
    loadPref('appearance', {}).then(a => {
      if (a) { setTheme(a.theme || 'dark'); setAccent(a.accent || '#00f2ff'); setFontSize(a.fontSize || 13); setSidebarWidth(a.sidebarWidth || 'normal'); }
    });
  }, []);

  const save = async (key, value) => {
    const current = { theme, accent, fontSize, sidebarWidth, [key]: value };
    if (key === 'theme') setTheme(value);
    if (key === 'accent') setAccent(value);
    if (key === 'fontSize') setFontSize(value);
    if (key === 'sidebarWidth') setSidebarWidth(value);
    await savePref('appearance', current);

    // Live-apply accent color
    if (key === 'accent') document.documentElement.style.setProperty('--accent', value);
    if (key === 'fontSize') document.documentElement.style.setProperty('font-size', `${value}px`);
    showToast(`Appearance updated`);
  };

  const ACCENTS = [
    { color: '#00f2ff', label: 'Cyan' },
    { color: '#7b2fff', label: 'Purple' },
    { color: '#00ff40', label: 'Green' },
    { color: '#ff4466', label: 'Red' },
    { color: '#ffaa00', label: 'Amber' },
    { color: '#ff6b9d', label: 'Pink' },
    { color: '#4fc3f7', label: 'Sky' },
    { color: '#ffffff', label: 'White' },
  ];

  return (
    <div className="appearance-panel">
      <div className="appearance-row">
        <div className="appearance-label">Theme</div>
        <div className="appearance-options">
          {['dark', 'midnight', 'amoled'].map(t => (
            <button key={t} type="button" className={`appearance-chip ${theme === t ? 'appearance-chip--active' : ''}`} onClick={() => save('theme', t)} aria-pressed={theme === t}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-row">
        <div className="appearance-label">Accent color</div>
        <div className="appearance-colors">
          {ACCENTS.map(a => (
            <button key={a.color} type="button" className={`appearance-color ${accent === a.color ? 'appearance-color--active' : ''}`}
              style={{ background: a.color }} onClick={() => save('accent', a.color)} title={a.label}
              aria-label={`Accent color: ${a.label}`} aria-pressed={accent === a.color} />
          ))}
        </div>
      </div>

      <div className="appearance-row">
        <div className="appearance-label">Font size</div>
        <div className="appearance-slider-wrap">
          <span className="appearance-slider-val">{fontSize}px</span>
          <input type="range" min="11" max="16" value={fontSize} onChange={e => save('fontSize', parseInt(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)' }} aria-label="Font size" />
        </div>
      </div>

      <div className="appearance-row">
        <div className="appearance-label">Sidebar</div>
        <div className="appearance-options">
          {['compact', 'normal', 'wide'].map(w => (
            <button key={w} type="button" className={`appearance-chip ${sidebarWidth === w ? 'appearance-chip--active' : ''}`} onClick={() => save('sidebarWidth', w)} aria-pressed={sidebarWidth === w}>
              {w}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Theme Builder (deep customization) ──────────────────────────────
// Hoisted out of ThemeBuilder: stable component type keeps the native color
// picker mounted while dragging (nested definition remounted it every render).
function ColorRow({ label, colorKey, colors, updateColor }) {
  return (
    <div className="theme-color-row">
      <span className="theme-color-label">{label}</span>
      <input type="color" value={colors[colorKey]} onChange={e => updateColor(colorKey, e.target.value)} className="theme-color-input" aria-label={`${label} color`} />
      <span className="theme-color-hex">{colors[colorKey]}</span>
    </div>
  );
}

function ThemeBuilder() {
  const [colors, setColors] = useState({
    background: '#020508', text: '#d8e8f5', panel: '#0a1018',
    sidebar: '#080c14', border: '#1d2c3a', accent: '#00f2ff',
  });
  const [harmony, setHarmony] = useState('complementary');
  const [mode, setMode] = useState('dark');
  const [font, setFont] = useState('monospace');
  const [density, setDensity] = useState('comfortable');
  const [frosted, setFrosted] = useState(false);

  useEffect(() => {
    loadPref('theme_builder', null).then(t => { if (t) {
      if (t.colors) setColors(t.colors);
      if (t.harmony) setHarmony(t.harmony);
      if (t.mode) setMode(t.mode);
      if (t.font) setFont(t.font);
      if (t.density) setDensity(t.density);
      if (t.frosted != null) setFrosted(t.frosted);
    }});
  }, []);

  const updateColor = (key, value) => setColors(c => ({ ...c, [key]: value }));

  const generateHarmony = () => {
    const hex2hsl = (hex) => {
      let r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return [h * 360, s * 100, l * 100];
    };
    const hsl2hex = (h, s, l) => {
      h /= 360; s /= 100; l /= 100;
      const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
      let r, g, b;
      if (s === 0) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3); }
      return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    };

    const [h, s] = hex2hsl(colors.accent);
    const isDark = mode === 'dark';
    const bgL = isDark ? 2 : 96, panelL = isDark ? 6 : 92, sidebarL = isDark ? 4 : 94, textL = isDark ? 88 : 12, borderL = isDark ? 16 : 82;
    let accentH2;
    if (harmony === 'complementary') accentH2 = (h + 180) % 360;
    else if (harmony === 'analogous') accentH2 = (h + 30) % 360;
    else if (harmony === 'triadic') accentH2 = (h + 120) % 360;
    else accentH2 = (h + 150) % 360;

    setColors({
      background: hsl2hex(h, isDark ? 20 : 5, bgL),
      text: hsl2hex(h, 10, textL),
      panel: hsl2hex(h, isDark ? 15 : 5, panelL),
      sidebar: hsl2hex(h, isDark ? 18 : 4, sidebarL),
      border: hsl2hex(h, isDark ? 12 : 8, borderL),
      accent: colors.accent,
    });
  };

  const apply = async () => {
    const theme = { colors, harmony, mode, font, density, frosted };
    await savePref('theme_builder', theme);
    document.documentElement.style.setProperty('--bg', colors.background);
    document.documentElement.style.setProperty('--text', colors.text);
    document.documentElement.style.setProperty('--bg-card', colors.panel);
    document.documentElement.style.setProperty('--border', colors.border + '40');
    document.documentElement.style.setProperty('--accent', colors.accent);
    document.documentElement.style.setProperty('--accent-dim', colors.accent + '1a');
    if (frosted) document.documentElement.style.setProperty('--glass', 'blur(22px) saturate(170%)');
    showToast('Theme applied');
  };

  // NOTE: ColorRow must NOT be defined inside this component — a nested
  // definition creates a new component type on every render, which remounts
  // the <input type="color"> and closes the native picker mid-drag.

  return (
    <div className="theme-builder">
      <div className="theme-section">
        <h4 className="theme-section-title">Colors</h4>
        <div className="theme-colors-grid">
          <ColorRow label="Background" colorKey="background" colors={colors} updateColor={updateColor} />
          <ColorRow label="Text" colorKey="text" colors={colors} updateColor={updateColor} />
          <ColorRow label="Panel" colorKey="panel" colors={colors} updateColor={updateColor} />
          <ColorRow label="Sidebar" colorKey="sidebar" colors={colors} updateColor={updateColor} />
          <ColorRow label="Border" colorKey="border" colors={colors} updateColor={updateColor} />
          <ColorRow label="Accent" colorKey="accent" colors={colors} updateColor={updateColor} />
        </div>
      </div>

      <div className="theme-section">
        <h4 className="theme-section-title">Color Harmony</h4>
        <div className="theme-harmony-row">
          <div className="theme-harmony-preview" style={{ background: colors.accent }} />
          <span className="theme-color-hex">{colors.accent}</span>
          <select className="settings-select" style={{ flex: 1 }} value={harmony} onChange={e => setHarmony(e.target.value)}>
            <option value="complementary">Complementary</option>
            <option value="analogous">Analogous</option>
            <option value="triadic">Triadic</option>
            <option value="split">Split-complementary</option>
          </select>
        </div>
        <div className="theme-harmony-row">
          <span className="theme-color-label">Mode</span>
          <select className="settings-select" style={{ flex: 1 }} value={mode} onChange={e => setMode(e.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <button className="settings-btn settings-btn--primary" onClick={generateHarmony}>Generate</button>
        </div>
      </div>

      <div className="theme-section">
        <h4 className="theme-section-title">Font & Layout</h4>
        <div className="theme-layout-grid">
          <div className="theme-layout-item">
            <span>Font</span>
            <select className="settings-select" value={font} onChange={e => setFont(e.target.value)}>
              <option value="monospace">Monospace</option>
              <option value="sans-serif">Sans-serif</option>
              <option value="serif">Serif</option>
              <option value="inter">Inter</option>
            </select>
          </div>
          <div className="theme-layout-item">
            <span>Density</span>
            <select className="settings-select" value={density} onChange={e => setDensity(e.target.value)}>
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
              <option value="spacious">Spacious</option>
            </select>
          </div>
          <div className="theme-layout-item">
            <span>Frosted</span>
            <button
              type="button"
              className={`pref-toggle-btn ${frosted ? 'pref-toggle-btn--on' : ''}`}
              onClick={() => setFrosted(!frosted)}
              style={{ width: '36px', height: '20px' }}
              role="switch"
              aria-checked={frosted}
              aria-label="Frosted glass effect"
            >
              <span className="pref-toggle-knob" />
            </button>
          </div>
        </div>
      </div>

      <button className="settings-btn settings-btn--primary" style={{ alignSelf: 'flex-start', marginTop: '8px' }} onClick={apply}>
        <Palette size={12} /> Apply theme
      </button>
    </div>
  );
}

// ── Onboarding Setup Wizard (one-time, config-from-UI) ───────────────
// NOTE: no 'account' step here. Operator identity is owned entirely by the
// Security block (create account, login, 2FA, protection policy). Settings
// configures the machine (keys, providers, models); Security owns the person.
// Duplicating account creation here confused users and split the auth flow.
const WIZARD_STEPS = [
  { key: 'apiKeys',  label: 'API keys',     icon: Zap },
  { key: 'firebase', label: 'Firebase',     icon: Database },
  { key: 'supabase', label: 'Supabase',     icon: Database },
  { key: 'settings', label: 'Models',       icon: Cpu },
  { key: 'restart',  label: 'Restart',      icon: RefreshCw },
];

function parseFirebaseConfig(text) {
  // Accept a pasted `const firebaseConfig = { apiKey: "...", ... }` blob.
  const out = {};
  const map = {
    apiKey: 'VITE_FIREBASE_API_KEY', authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
    projectId: 'VITE_FIREBASE_PROJECT_ID', storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
    messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID', appId: 'VITE_FIREBASE_APP_ID',
    measurementId: 'VITE_FIREBASE_MEASUREMENT_ID',
  };
  for (const [k, env] of Object.entries(map)) {
    const m = text.match(new RegExp(`${k}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
    if (m) out[env] = m[1];
  }
  return out;
}

function SetupWizard({ onComplete }) {
  const [status, setStatus] = useState(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [acct, setAcct] = useState({ username: '', displayName: '', email: '', password: '', confirm: '' });
  const [keys, setKeys] = useState({ GROQ_API_KEY: '', GEMINI_FREE_KEY_1: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GROK_API_KEY: '', OPENROUTER_API_KEY: '' });
  const [fb, setFb] = useState({ paste: '', VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_AUTH_DOMAIN: '', VITE_FIREBASE_PROJECT_ID: '', VITE_FIREBASE_STORAGE_BUCKET: '', VITE_FIREBASE_MESSAGING_SENDER_ID: '', VITE_FIREBASE_APP_ID: '' });
  const [sb, setSb] = useState({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
  const [envPresence, setEnvPresence] = useState({});

  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/settings/setup-status'); setStatus(await r.json()); } catch {}
    try { const r = await fetch('/api/settings'); const d = await r.json(); if (d.envKeys) setEnvPresence(d.envKeys); } catch {}
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const saveSecrets = async (vars) => {
    const r = await fetch('/api/settings/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vars }) });
    return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})));
  };

  const saveCloudProvider = async (provider, config) => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudProvider: { provider, config } }),
    });
    return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})));
  };

  const next = () => setActive(a => Math.min(a + 1, WIZARD_STEPS.length - 1));

  const saveStep = async () => {
    setBusy(true);
    try {
      const step = WIZARD_STEPS[active].key;
      if (step === 'apiKeys') {
        const vars = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
        if (!Object.keys(vars).length) { showToast('Enter at least one API key', 'error'); setBusy(false); return; }
        await saveSecrets(vars); showToast('API keys saved to encrypted Vault'); next();
      } else if (step === 'firebase') {
        const vars = fb.paste ? parseFirebaseConfig(fb.paste) : Object.fromEntries(Object.entries(fb).filter(([k, v]) => k.startsWith('VITE_') && v));
        if (!Object.keys(vars).length) { showToast('Paste your Firebase config or fill the fields', 'error'); setBusy(false); return; }
        await saveCloudProvider('firebase', vars); showToast('Firebase saved to encrypted Vault'); next();
      } else if (step === 'supabase') {
        const vars = Object.fromEntries(Object.entries(sb).filter(([, v]) => v));
        if (!vars.SUPABASE_URL || !vars.SUPABASE_ANON_KEY) { showToast('URL + anon key required', 'error'); setBusy(false); return; }
        await saveCloudProvider('supabase', vars); showToast('Supabase saved to encrypted Vault'); next();
      } else if (step === 'settings') {
        showToast('Models use the assignment below — adjust anytime'); next();
      }
      refresh();
    } catch (e) { showToast(e.error || 'Save failed', 'error'); }
    setBusy(false);
  };

  const doRestart = async () => {
    setBusy(true);
    showToast('Restarting AEON to apply config…');
    try { await fetch('/api/settings/restart', { method: 'POST' }); } catch {}
    setTimeout(() => { showToast('AEON is restarting — reload in ~15s'); }, 1000);
  };

  if (!status) return null;
  if (status.complete && active === 0) return null; // fully set up — wizard hidden

  const st = status.steps || {};
  const done = (k) => !!st[k];
  const step = WIZARD_STEPS[active];

  return (
    <div className="wizard">
      <div className="wizard-head">
        <span className="wizard-title">⚡ First-time setup</span>
        <span className="wizard-sub">Configure once — AEON writes it to disk. Restart applies everything.</span>
      </div>
      {/* Stepper */}
      <div className="wizard-steps" role="tablist" aria-label="Setup steps">
        {WIZARD_STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-current={i === active ? 'step' : undefined}
              aria-label={`${s.label}${done(s.key) ? ' — done' : ''}`}
              className={`wizard-step ${i === active ? 'wizard-step--active' : ''} ${done(s.key) ? 'wizard-step--done' : ''}`}
              onClick={() => setActive(i)}
            >
              <span className="wizard-step-dot">{done(s.key) ? <Check size={11} /> : <Icon size={11} />}</span>
              <span className="wizard-step-label">{s.label}</span>
            </button>
          );
        })}
      </div>

      <div className="wizard-body">
        {step.key === 'apiKeys' && (
          <div className="wizard-fields">
            <p className="wizard-desc">At least one LLM key. Stored in the encrypted Security Vault and never returned to the browser.{done('apiKeys') && ' ✓ already configured — re-enter to replace.'}</p>
            {[
              ['GROQ_API_KEY', 'Groq API key (gsk_…)'],
              ['GEMINI_FREE_KEY_1', 'Gemini API key'],
              ['OPENAI_API_KEY', 'OpenAI key (optional)'],
              ['ANTHROPIC_API_KEY', 'Anthropic/Claude key (optional)'],
              ['GROK_API_KEY', 'Grok/xAI key (xai-…, optional)'],
              ['OPENROUTER_API_KEY', 'OpenRouter key (sk-or-…, optional)'],
            ].map(([envKey, placeholder]) => {
              const present = envPresence[envKey] === 'configured' || envPresence[envKey] === 'vault';
              return (
                <div key={envKey} style={{ position: 'relative' }}>
                  <input className="settings-select" type="password"
                    placeholder={present ? `${placeholder} — ✓ already set` : placeholder}
                    aria-label={placeholder}
                    value={keys[envKey]} onChange={e => setKeys(k => ({ ...k, [envKey]: e.target.value }))}
                    style={present && !keys[envKey] ? { borderColor: 'rgba(16,185,129,0.4)' } : undefined}
                  />
                  {present && !keys[envKey] && (
                    <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#10b981', fontWeight: 700 }}>
                      ✓ {envPresence[envKey] === 'vault' ? 'vault' : 'set'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {step.key === 'firebase' && (
          <div className="wizard-fields">
            <p className="wizard-desc">Paste your <code>firebaseConfig</code> object from the Firebase console — fields auto-fill.{done('firebase') && ' ✓ configured.'}</p>
            <textarea className="settings-select wizard-textarea" placeholder={'const firebaseConfig = {\n  apiKey: "…", projectId: "…", appId: "…"\n}'} aria-label="Firebase config object" value={fb.paste} onChange={e => setFb(f => ({ ...f, paste: e.target.value }))} />
          </div>
        )}
        {step.key === 'supabase' && (
          <div className="wizard-fields">
            <p className="wizard-desc">From Supabase ▸ Project Settings ▸ API.{done('supabase') && ' ✓ configured.'}</p>
            <input className="settings-select" placeholder="Project URL (https://xxx.supabase.co)" aria-label="Supabase project URL" value={sb.SUPABASE_URL} onChange={e => setSb(s => ({ ...s, SUPABASE_URL: e.target.value }))} />
            <input className="settings-select" type="password" placeholder="anon public key" aria-label="Supabase anon public key" value={sb.SUPABASE_ANON_KEY} onChange={e => setSb(s => ({ ...s, SUPABASE_ANON_KEY: e.target.value }))} />
          </div>
        )}
        {step.key === 'settings' && (
          <div className="wizard-fields">
            <p className="wizard-desc">Model-per-role is set in the “Model assignment” section below. Defaults work out of the box — continue to finish.</p>
            <div className="wizard-already"><Check size={13} /> Defaults active (chat→Groq, grading→Gemini)</div>
          </div>
        )}
        {step.key === 'restart' && (
          <div className="wizard-fields">
            <p className="wizard-desc">Restart AEON to apply API keys, Firebase, and Supabase (the frontend bundle reloads them). You only do this once.</p>
            <div className={`wizard-restart-note ${status.restartPending ? 'wizard-restart-note--pending' : ''}`}>
              {status.restartPending ? '⚠ Config changed — restart required to apply.' : 'No pending changes.'}
            </div>
            <button type="button" className="settings-btn settings-btn--primary wizard-restart-btn" onClick={doRestart} disabled={busy}>
              <RefreshCw size={13} /> Restart AEON now
            </button>
          </div>
        )}
      </div>

      {step.key !== 'restart' && (
        <div className="wizard-footer">
          {active > 0 && <button type="button" className="settings-btn settings-btn--secondary" onClick={() => setActive(a => a - 1)}>Back</button>}
          <button type="button" className="settings-btn settings-btn--secondary" onClick={next}>Skip</button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={saveStep} disabled={busy}>
            {busy ? 'Saving…' : (done(step.key) ? 'Continue' : 'Save & continue')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Key Scanner — paste any API key, AEON detects the provider + models ──
function KeyScanner({ onConnected }) {
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [scanReport, setScanReport] = useState(null);

  const detect = async () => {
    setBusy(true); setFound(null);
    try {
      const r = await fetch('/api/connections/detect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key.trim() || undefined, base_url: baseUrl.trim() || undefined }),
      });
      const d = await r.json();
      if (d.ok) setFound(d);
      else showToast(d.error || 'Not recognized', 'error');
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  };

  const connect = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: found.provider, label: `${found.provider} (scanned)`,
          base_url: found.base_url || undefined, models: found.models,
          apiKey: key.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (d.ok) { showToast(`Connected: ${found.provider} — ${found.models.length} models`, 'success'); setKey(''); setFound(null); onConnected?.(); }
      else showToast(d.error || 'Save failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  };

  const scanAll = async () => {
    setBusy(true); setScanReport(null);
    try {
      const r = await fetch('/api/connections/scan-all');
      const d = await r.json();
      setScanReport(d.results || []);
      showToast(`Scanned ${d.scanned} connections — model lists refreshed`, 'success');
      onConnected?.();
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  };

  const inputStyle = { flex: 1, minWidth: 200, padding: 8, borderRadius: 6, border: '1px solid var(--border, #333)', background: 'transparent', color: 'inherit' };
  return (
    <div className="admin-card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}><Search size={13} /> Key scanner</div>
      <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>
        Paste any API key — AEON detects the provider, lists its live models, and stores the key in the vault.
        Or paste a local server address (LM Studio, OpenAI-compatible) with no key.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="API key (sk-…, gsk_…, AIza…, xai-…)" aria-label="API key" style={{ ...inputStyle, flex: 2, minWidth: 220 }} />
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="or local URL (http://localhost:8080)" aria-label="Local server URL" style={inputStyle} />
        <button type="button" disabled={busy || (!key.trim() && !baseUrl.trim())} onClick={detect}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
          {busy ? 'Scanning…' : 'Detect'}
        </button>
        <button type="button" disabled={busy} onClick={scanAll} title="Re-scan every saved connection and refresh its model list"
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border, #444)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
          <RefreshCw size={12} /> Rescan all
        </button>
      </div>
      {found && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          ✅ <b>{found.provider}</b> — {found.models.length} models available
          <span style={{ opacity: 0.6 }}> ({found.models.slice(0, 4).join(', ')}{found.models.length > 4 ? '…' : ''})</span>{' '}
          <button type="button" onClick={connect} disabled={busy}
            style={{ padding: '4px 14px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', cursor: 'pointer' }}>
            Save to vault & connect
          </button>
        </div>
      )}
      {scanReport && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {scanReport.map(r => (
            <div key={r.id} style={{ opacity: r.ok ? 0.85 : 0.6 }}>
              {r.ok ? '🟢' : '🔴'} <b>{r.id}</b> ({r.provider}) — {r.ok ? `${r.count} models` : (r.error || 'unreachable')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Search Keys Panel ─────────────────────────────────────────────────
const SEARCH_PROVIDERS = [
  { id: 'tavily',  label: 'Tavily',        envKey: 'TAVILY_API_KEY',  icon: '🔍', desc: 'AI-native search. Best quality. Recommended first.', url: 'https://app.tavily.com' },
  { id: 'serper',  label: 'Serper',         envKey: 'SERPER_API_KEY',  icon: '🔎', desc: 'Real Google results via serper.dev. Excellent for news/recency.', url: 'https://serper.dev' },
  { id: 'brave',   label: 'Brave Search',   envKey: 'BRAVE_API_KEY',   icon: '🦁', desc: 'Privacy-first index. Good fallback.', url: 'https://api.search.brave.com' },
  { id: 'ddg',     label: 'DuckDuckGo',     envKey: null,              icon: '🦆', desc: 'Always-on scrape fallback. No key needed.', url: null },
];

function SearchKeysPanel({ providers, onReload }) {
  const [keys, setKeys] = useState({ TAVILY_API_KEY: '', SERPER_API_KEY: '', BRAVE_API_KEY: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const isConnected = (envKey) => {
    if (!envKey) return true; // DDG always on
    const pid = envKey.replace('_API_KEY', '').toLowerCase();
    return providers?.[pid] === true;
  };

  const save = async () => {
    setSaving(true);
    const vars = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) vars[k] = v.trim();
    }
    if (!Object.keys(vars).length) { setSaving(false); return; }
    try {
      await fetch('/api/settings/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vars }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (onReload) onReload();
    } catch {}
    setSaving(false);
  };

  return (
    <div className="admin-card">
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Web Search Providers</div>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 14 }}>
        Priority chain: <strong>Tavily → Serper → Brave → DuckDuckGo</strong>. First keyed provider with results wins. Agent and all blocks use this automatically.
      </div>
      {SEARCH_PROVIDERS.map(p => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
          <div style={{ paddingTop: 3, fontSize: 18 }}>{p.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4,
                background: isConnected(p.envKey) ? 'rgba(0,255,128,0.12)' : 'rgba(255,255,255,0.06)',
                color: isConnected(p.envKey) ? '#00ff80' : '#888' }}>
                {isConnected(p.envKey) ? '● connected' : '○ no key'}
              </span>
              {p.url && <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, opacity: 0.5, color: 'inherit' }}>get key ↗</a>}
            </div>
            <div style={{ fontSize: 11, opacity: 0.55, marginBottom: p.envKey ? 6 : 0 }}>{p.desc}</div>
            {p.envKey && (
              <input
                type="password"
                placeholder={isConnected(p.envKey) ? '••••••••••••••••  (set — paste to replace)' : `Paste ${p.label} API key`}
                aria-label={`${p.label} API key`}
                value={keys[p.envKey]}
                onChange={e => setKeys(k => ({ ...k, [p.envKey]: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border, #333)',
                  background: 'rgba(255,255,255,0.04)', color: 'inherit', fontSize: 12, boxSizing: 'border-box' }}
              />
            )}
          </div>
        </div>
      ))}
      <button type="button" onClick={save} disabled={saving || !Object.values(keys).some(v => v.trim())}
        style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          background: saved ? 'rgba(0,255,128,0.2)' : 'var(--accent, #00f2ff)', color: saved ? '#00ff80' : '#000' }}>
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Keys'}
      </button>
      <div style={{ fontSize: 11, opacity: 0.45, marginTop: 8 }}>Keys are encrypted in the Security Vault and activated in memory immediately.</div>
    </div>
  );
}

// ── Unified Connections Panel (merged: providers + vault + cloud + tunnel + firebase) ──
function UnifiedConnectionsPanel({ providers, nervousSystem, onReload }) {
  const [tab, setTab] = useState('llm');
  const providerRegistry = getProviderRegistry(nervousSystem);

  const TABS = [
    { key: 'llm', label: 'LLM Keys', icon: '🧠' },
    { key: 'search', label: 'Search Keys', icon: '🔍' },
    { key: 'services', label: 'Services & Cloud', icon: '☁️' },
    { key: 'tunnel', label: 'Remote Access', icon: '🔗' },
  ];

  const tabStyle = (active) => ({
    padding: '8px 16px', borderRadius: '8px 8px 0 0', border: 'none', cursor: 'pointer',
    fontWeight: active ? 700 : 500, fontSize: 12,
    background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
    color: active ? 'var(--accent, #00f2ff)' : 'var(--text-dim, #888)',
    borderBottom: active ? '2px solid var(--accent, #00f2ff)' : '2px solid transparent',
    transition: 'all 0.15s',
  });

  return (
    <div>
      {/* Tab bar */}
      <div role="tablist" aria-label="Connections" style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid var(--border, #242d2e)' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            style={tabStyle(tab === t.key)}
            onClick={() => setTab(t.key)}
          >
            <span style={{ marginRight: 6 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* LLM Keys tab */}
      {tab === 'llm' && (
        <div style={{ paddingTop: 12 }}>
          <KeyScanner onConnected={onReload} />
          <div className="providers-grid" style={{ marginBottom: 12 }}>
            {Object.entries(providers).filter(([k]) => {
              const p = nervousSystem?.providers?.[k];
              return p && (p.kind === 'cloud' || p.kind === 'local');
            }).map(([key, ok]) => (
              <ProviderCard key={key} id={key} label={key} connected={ok} providerRegistry={providerRegistry} />
            ))}
          </div>
          <ConnectionsPanel nervousSystem={nervousSystem} />
        </div>
      )}

      {/* Services & Cloud tab */}
      {tab === 'services' && (
        <div style={{ paddingTop: 12 }}>
          {/* Service provider status */}
          <div className="admin-card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Service providers</div>
            <div className="providers-grid">
              {Object.entries(providers).filter(([k]) => {
                const p = nervousSystem?.providers?.[k];
                return p && (p.kind === 'infra' || p.kind === 'service');
              }).map(([key, ok]) => (
                <ProviderCard key={key} id={key} label={key} connected={ok} providerRegistry={providerRegistry} />
              ))}
            </div>
          </div>

          {/* Supabase setup (from ConnectivityPanel) */}
          <SupabaseFirebasePanel />
        </div>
      )}

      {/* Search Keys tab */}
      {tab === 'search' && (
        <div style={{ paddingTop: 12 }}>
          <SearchKeysPanel providers={providers} onReload={onReload} />
        </div>
      )}

      {/* Remote Access tab */}
      {tab === 'tunnel' && (
        <div style={{ paddingTop: 12 }}>
          <TunnelPanel />
        </div>
      )}
    </div>
  );
}

// ── Supabase + Firebase config (extracted from ConnectivityPanel) ────
function SupabaseFirebasePanel() {
  const [status, setStatus] = useState(null);
  const [sb, setSb] = useState({ url: '', anonKey: '' });
  const [fb, setFb] = useState({ paste: '' });
  const [busy, setBusy] = useState(false);
  const [fbSaved, setFbSaved] = useState(false);

  const load = () => fetch('/api/settings')
    .then(r => r.json())
    .then(d => {
      setStatus(d.cloudProviders || null);
      setFbSaved(!!d.cloudProviders?.firebase?.configured);
    })
    .catch(() => {});
  useEffect(() => { load(); }, []);

  const saveCloud = async (provider, config) => {
    setBusy(true);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudProvider: { provider, config } }),
      });
      const d = await r.json();
      if (!r.ok) showToast(d.error || 'Save failed', 'error');
      else showToast(`${provider === 'supabase' ? 'Supabase' : 'Firebase'} saved to encrypted Vault`, 'success');
      load();
      return d;
    } catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
  };

  const saveFirebase = async () => {
    const config = fb.paste ? parseFirebaseConfig(fb.paste) : {};
    if (!Object.keys(config).length) return showToast('Paste your Firebase config', 'error');
    await saveCloud('firebase', config);
  };

  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border, #242d2e)', background: 'rgba(255,255,255,0.03)', color: 'inherit', fontSize: 13, fontFamily: 'inherit' };
  const stepNum = (n) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: 'var(--accent, #00f2ff)', color: '#000', fontWeight: 800, fontSize: 12, marginRight: 10, flexShrink: 0 }}>{n}</span>
  );
  const accent = (text) => <span style={{ color: 'var(--accent, #00f2ff)', fontWeight: 700 }}>{text}</span>;

  return (
    <>
      {/* Supabase */}
      <div className="admin-card" style={{ padding: '20px 24px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 16 }}>☁️</span>
          <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: 1 }}>SUPABASE</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 12px', borderRadius: 8, background: status?.supabase?.attached ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)', color: status?.supabase?.attached ? '#10b981' : '#94a3b8', fontWeight: 700 }}>
            {status?.supabase?.configured ? 'configured' : 'not set up'}
          </span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16, lineHeight: 1.5 }}>
          Cloud sync, Second Brain mirror, and mobile relay. {accent('Free: 500MB + 1GB files.')}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16 }}>
          {stepNum(1)}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
              Create a free account — <a href="https://supabase.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>supabase.com</a>
            </div>
            <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 10, lineHeight: 1.6 }}>
              In Project Settings → API, copy the Project URL and the publishable {accent('anon')} key.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={sb.url} onChange={e => setSb({ ...sb, url: e.target.value })} placeholder="Project URL — https://xxxx.supabase.co" aria-label="Supabase project URL" style={inputStyle} />
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" value={sb.anonKey} onChange={e => setSb({ ...sb, anonKey: e.target.value })} placeholder="anon public key" aria-label="Supabase anon public key" style={{ ...inputStyle, flex: 1 }} />
                <button type="button" disabled={busy || !sb.url || !sb.anonKey} onClick={() => saveCloud('supabase', { url: sb.url, anonKey: sb.anonKey })}
                  style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: 'var(--accent, #00f2ff)', color: '#000', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 13 }}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Firebase */}
      <div className="admin-card" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 16 }}>🔥</span>
          <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: 1 }}>FIREBASE</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 12px', borderRadius: 8, background: fbSaved ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)', color: fbSaved ? '#10b981' : '#94a3b8', fontWeight: 700 }}>
            {fbSaved ? 'saved' : 'paste config below'}
          </span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
          Authentication, treasury sync, and real-time features. Paste your <code>firebaseConfig</code> object from the Firebase console.
        </div>
        <textarea
          className="settings-select"
          style={{ width: '100%', minHeight: 100, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "…",\n  projectId: "…",\n  storageBucket: "…",\n  messagingSenderId: "…",\n  appId: "…"\n}'}
          aria-label="Firebase config object"
          value={fb.paste}
          onChange={e => setFb({ paste: e.target.value })}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" disabled={busy || !fb.paste.trim()} onClick={saveFirebase}
            style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
            {busy ? 'Saving…' : 'Save Firebase config'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Tunnel Panel (extracted from ConnectivityPanel) ─────────────────
function TunnelPanel() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tunnelNote, setTunnelNote] = useState(null);

  const load = () => fetch('/api/settings/connectivity').then(r => r.json()).then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);

  const call = async (endpoint) => {
    setBusy(true);
    try {
      const r = await fetch(endpoint, { method: 'POST' });
      const d = await r.json();
      if (d.error) showToast(d.error, 'error');
      else showToast(d.url ? `Live: ${d.url}` : 'Done', 'success');
      if (d.note) setTunnelNote(d.note);
      load();
    } catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="admin-card" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>🔗</span>
        <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: 1 }}>CLOUDFLARE TUNNEL</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
        Reach this AEON from your phone or any browser — while this computer is on. No account needed. One click.
      </div>
      {status?.tunnel?.url && (
        <div style={{ fontSize: 13, marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
          <a href={status.tunnel.url} target="_blank" rel="noreferrer" style={{ color: '#10b981', fontWeight: 600 }}>{status.tunnel.url}</a>{' '}
          <button type="button" onClick={() => { navigator.clipboard.writeText(status.tunnel.url); showToast('Copied', 'success'); }} aria-label="Copy tunnel URL"
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border, #444)', background: 'transparent', color: 'inherit', cursor: 'pointer', marginLeft: 8 }}>Copy</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={busy || status?.tunnel?.running} onClick={() => call('/api/settings/connectivity/tunnel/start')}
          style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
          {busy ? 'Working…' : status?.tunnel?.running ? 'Tunnel live' : 'Start tunnel'}
        </button>
        <button type="button" disabled={busy || !status?.tunnel?.running} onClick={() => call('/api/settings/connectivity/tunnel/stop')}
          style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid var(--border, #444)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 }}>Stop</button>
      </div>
      {tunnelNote && <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8 }}>{tunnelNote}</div>}
      {status?.tunnel?.running && !status?.tunnel?.secured && (
        <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8 }}>⚠ AEON_MOBILE_SECRET not set — external API calls will be refused.</div>
      )}
    </div>
  );
}

// ── Per-Block Settings (manifest-driven, fully modular) ──────────────
// Renders one card per installed block that declares contract.settings in
// its manifest. Block leaves → its card leaves; block arrives → its card
// appears. Values live in aeon-settings.json → blockSettings[<id>][<key>]:
// set once, come back only to change them.
function BlockSettingControl({ def, value, onChange }) {
  const current = value !== undefined ? value : def.default;
  const fieldLabel = def.label || def.key;
  if (def.type === 'toggle') {
    return (
      <button
        type="button"
        className={`roulette-btn ${current ? 'roulette-btn--on' : ''}`}
        onClick={() => onChange(!current)}
        role="switch"
        aria-checked={!!current}
        aria-label={fieldLabel}
      >
        {current ? <><ToggleRight size={14} /> ON</> : <><ToggleLeft size={14} /> OFF</>}
      </button>
    );
  }
  if (def.type === 'select') {
    return (
      <select className="settings-select" value={current ?? ''} onChange={e => onChange(e.target.value)} aria-label={fieldLabel}>
        {(def.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (def.type === 'number') {
    return <input className="settings-select" type="number" value={current ?? ''} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 110 }} aria-label={fieldLabel} />;
  }
  // text | secret
  return (
    <input
      className="settings-select"
      type={def.type === 'secret' ? 'password' : 'text'}
      placeholder={def.type === 'secret' ? '••••••••' : (def.placeholder || '')}
      value={current ?? ''}
      onChange={e => onChange(e.target.value)}
      style={{ minWidth: 220 }}
      aria-label={fieldLabel}
    />
  );
}

// ── Widget contract, consumer side ──────────────────────────────────────
// "Add a block and settings gains a control surface." Until 2026-08-04 that
// sentence was true of the data model and false of the product: the manifest
// carried `widget`, blockStandard passed it through, and nothing rendered it.
//
// Absence is the correct rendering of absence — a block declaring no widget
// contributes nothing here. No placeholder, no empty card, no disabled control.
function BlockWidget({ w }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        // authFetch, not fetch — it attaches the session Bearer from
        // localStorage and credentials:'include'. A widget pointed at a guarded
        // route with no credentials 401s at every auth setting, so signing in
        // would not have fixed this either.
        //
        // The header opts this request out of the global forensics banner: the
        // catch below renders every failure inline, so a toast on top of it is
        // the same failure said twice, with the less useful sentence on top.
        const r = await authFetch(w.endpoint, {
          headers: { 'x-aeon-self-reported': '1' },
        });
        if (!r.ok) {
          // Name the remedy, not just the fault (BO-F3c). A widget guarding a
          // privileged surface answers 401 to an operator who simply has not
          // signed in; "HTTP 401" tells them nothing they can act on. Found by
          // driving the real surface — host_os/widget sits behind
          // requireShellAuth, which does not accept loopback as authentication.
          if (r.status === 401 || r.status === 403) {
            throw new Error('sign in as operator to view this control surface');
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const d = await r.json();
        if (alive) { setData(d); setErr(null); }
      } catch (e) {
        // R-05: a widget that cannot answer says so. It does not render stale
        // data as if it were live, and it does not disappear.
        if (alive) setErr(e.message || 'unreachable');
      }
    };
    pull();
    if (!w.refresh_ms) return () => { alive = false; };
    const t = setInterval(pull, w.refresh_ms);
    return () => { alive = false; clearInterval(t); };
  }, [w.endpoint, w.refresh_ms]);

  return (
    <div className="admin-card">
      <div className="agent-tools-desc" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>{w.label}</b>
        <code style={{ fontSize: 10, opacity: 0.5 }}>{w.endpoint}</code>
        {!w.ready && <span className="block-chip-missing">not ready</span>}
      </div>

      {err ? (
        <div style={{ fontSize: 12, color: 'var(--danger, #ff4466)' }}>
          Widget unavailable — {err}
        </div>
      ) : data === null ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>
      ) : (
        <div>
          {data.kind === 'list' && Array.isArray(data.items) ? (
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
              {data.items.slice(0, 8).map((it, i) => (
                <li key={i}>{typeof it === 'string' ? it : (it.label ?? JSON.stringify(it))}</li>
              ))}
            </ul>
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 600, color: 'var(--accent)' }}>
                {String(data.value ?? '—')}
              </span>
              {data.sub && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{data.sub}</span>}
            </div>
          )}
        </div>
      )}

      {/* ── Optional richer surfaces a widget MAY declare (BO-A5a) ──────
          A widget that returns `capabilities` gets capability badges with a
          preflight preview: the exact executable and argv that would run, shown
          BEFORE anything is approved. That is the whole point of retiring a
          shell in favour of named actions — the operator can read the command.
          A widget that returns `safeMode` gets the toggle.
          Both are optional; a widget declaring neither renders as a plain card. */}
      {data && Array.isArray(data.capabilities) && data.capabilities.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
            Capabilities
          </div>
          {data.capabilities.map(c => (
            <div key={c.id} style={{ marginBottom: 6 }}>
              <span style={{
                display: 'inline-block', padding: '1px 6px', borderRadius: 3,
                border: '1px solid var(--accent)', color: 'var(--accent)',
                fontSize: 10, marginRight: 6,
              }}>{c.id}</span>
              <span style={{ fontSize: 11 }}>{c.description}</span>
              {Array.isArray(c.preflight) && (
                <div style={{ fontSize: 10, opacity: 0.65, fontFamily: 'monospace', marginTop: 2 }}>
                  runs: {c.preflight.join(' ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && typeof data.safeMode === 'boolean' && (
        <div className="pref-toggle-row" style={{ marginTop: 8 }}>
          <div className="pref-toggle-info">
            <span className="pref-toggle-label">Safe mode</span>
            <span className="pref-toggle-desc">
              Refuse every OS action. Enforced at the execution entry point, not in this UI.
            </span>
          </div>
          <button
            type="button"
            className={`roulette-btn ${data.safeMode ? 'roulette-btn--on' : ''}`}
            role="switch"
            aria-checked={data.safeMode}
            aria-label="Safe mode"
            onClick={async () => {
              try {
                const r = await fetch(`/api/${w.id}/safe-mode`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled: !data.safeMode }),
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const d = await r.json();
                setData(prev => ({ ...prev, safeMode: d.safeMode }));
              } catch (e) {
                // R-05: a failed toggle must not render as a successful one.
                setErr(`safe mode toggle failed — ${e.message}`);
              }
            }}
          >
            {data.safeMode ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      {/* Least privilege, stated rather than assumed. This is the same
          information createScopedDeps() enforces server-side. */}
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>
        Access: {w.scopeLabel}
      </div>
    </div>
  );
}

function BlockWidgetsPanel() {
  const [cat, setCat] = useState(null);

  useEffect(() => {
    authFetch('/api/blocks/widgets')
      .then(r => r.json())
      .then(d => setCat(d && Array.isArray(d.widgets) ? d : { widgets: [], refused: [] }))
      .catch(() => setCat({ widgets: [], refused: [] }));
  }, []);

  if (!cat) return null;
  if (cat.widgets.length === 0 && cat.refused.length === 0) return null;

  return (
    <>
      {cat.widgets.map(w => <BlockWidget key={w.id} w={w} />)}

      {/* A refused declaration is an operator-visible fact, not a silent drop. */}
      {cat.refused.length > 0 && (
        <div className="admin-card">
          <div className="agent-tools-desc"><b>Widget declarations refused</b></div>
          {cat.refused.map(r => (
            <div key={r.id} style={{ fontSize: 12, color: 'var(--danger, #ff4466)' }}>
              <code>{r.id}</code> — {r.reason}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BlockSettingsPanel({ blockSettings, onChange }) {
  // Manifests come from the frontend registry — the same source as nav, so
  // this list is always exactly the installed blocks (modularity guarantee).
  const withSettings = INSTALLED_BLOCKS.filter(b => (b.manifest?.contract?.settings || []).length > 0);

  if (withSettings.length === 0) {
    return (
      <div className="admin-card" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        No installed block declares settings yet. A block adds controls here by
        declaring <code>contract.settings</code> in its manifest — see the Master block for the reference.
      </div>
    );
  }

  return (
    <>
      {withSettings.map(b => (
        <div key={b.id} className="admin-card">
          <div className="agent-tools-desc" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BlockIcon
              iconAsset={b.iconAsset || b.manifest?.nav?.iconAsset}
              iconAssetPng={b.iconAssetPng || b.manifest?.nav?.iconAssetPng}
              fallback={b.icon}
              size={18}
              style={{ flexShrink: 0 }}
            />
            <b>{b.label}</b>
            <code style={{ fontSize: 10, opacity: 0.5 }}>blockSettings.{b.id}</code>
          </div>
          {b.manifest.contract.settings.map(def => (
            <div key={def.key} className="pref-toggle-row">
              <div className="pref-toggle-info">
                <span className="pref-toggle-label">{def.label || def.key}</span>
                {def.desc && <span className="pref-toggle-desc">{def.desc}</span>}
              </div>
              <BlockSettingControl
                def={def}
                value={blockSettings?.[b.id]?.[def.key]}
                onChange={v => onChange(b.id, def.key, v)}
              />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Settings 2.0 — the CEO-simple surface.
// Design law: one source of truth per concern, generated not hand-built.
// Bar: a 75-year-old CEO gets a key, connects Supabase, and goes.
// ═══════════════════════════════════════════════════════════════════════

// The "what do I do?" answer. Two real steps, live status, no jargon.
function GetStartedStrip() {
  const [st, setSt] = useState({ key: false, supabase: false, blocks: 0 });
  useEffect(() => {
    (async () => {
      try {
        const [s, conn, blks] = await Promise.all([
          fetch('/api/settings').then(r => r.json()).catch(() => ({})),
          fetch('/api/settings/connectivity').then(r => r.json()).catch(() => ({})),
          fetch('/api/settings/blocks').then(r => r.json()).catch(() => []),
        ]);
        const envKeys = s.envKeys || {};
        const hasKey = Object.entries(envKeys).some(([k, v]) => /KEY|TOKEN/.test(k) && (v === 'configured' || v === 'vault'));
        setSt({ key: hasKey, supabase: !!conn?.supabase?.attached, blocks: Array.isArray(blks) ? blks.length : 0 });
      } catch {}
    })();
  }, []);
  const allDone = st.key && st.supabase;
  const Step = ({ n, done, title, desc }) => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1, minWidth: 190 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700,
        background: done ? 'var(--accent, #00f2ff)' : 'transparent', color: done ? '#02121a' : 'var(--text-dim, #4a6a8a)',
        border: '1px solid ' + (done ? 'var(--accent, #00f2ff)' : 'var(--border, rgba(255,255,255,0.15))') }}>{done ? '✓' : n}</div>
      <div><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text, #dce8f5)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim, #4a6a8a)', lineHeight: 1.4 }}>{desc}</div></div>
    </div>
  );
  return (
    <div className="admin-card" style={{ marginBottom: 14, border: allDone ? '1px solid rgba(0,242,255,0.28)' : undefined }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: 'var(--accent, #00f2ff)', marginBottom: 12 }}>
        {allDone ? '✓ AEON IS LIVE' : 'GET STARTED'}
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Step n="1" done={st.key} title="Add a key" desc="One AI provider — or run local models, no key needed." />
        <Step n="2" done={st.supabase} title="Connect Supabase" desc="Your data's permanent home. The one setup that matters." />
        <Step n="3" done={allDone} title="You're running" desc={`${st.blocks} blocks ready. Pick your models below.`} />
      </div>
    </div>
  );
}

// "Blocks ask for access." Generated from each manifest's declared role —
// no hardcoded per-block panels, so a new block's card appears for free.
// Blocks INHERIT the role models; there is exactly one place to set a model.
// SCI — Settings Confidence Index. A block's score reflects OBSERVED state,
// never hope: model assigned (40) + that provider actually reachable (40) +
// required services connected (20). Green only when it will really run.
function sciFor(b, models, health, supabaseOk) {
  const role = b.contract?.ai?.role;
  const cfg = role ? models[role] : null;
  let score = 0;
  if (cfg && cfg.model) score += 40;
  if (cfg) {
    const p = cfg.provider;
    const alive = p === 'local' ? (health?.localConfirmed !== false)
      : !!(health?.providers?.[p]?.healthy);
    if (alive) score += 40;
  }
  const needsSupabase = (b.requires?.apis || []).includes('supabase');
  if (!needsSupabase || supabaseOk) score += 20;
  return score;
}
const sciColor = (s) => s >= 80 ? '#22d36f' : s >= 50 ? '#ffb454' : '#ff5a6a';

function SciBadge({ score, title }) {
  return (
    <span title={title} style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, padding: '2px 7px', borderRadius: 10,
      color: sciColor(score), border: `1px solid ${sciColor(score)}`, background: `${sciColor(score)}18`, flexShrink: 0 }}>
      {score}
    </span>
  );
}

function BlocksNeedsPanel({ onManageModels }) {
  const [blocks, setBlocks] = useState([]);
  const [models, setModels] = useState({});
  const [supabaseOk, setSupabaseOk] = useState(true);
  const [health, setHealth] = useState(null);
  useEffect(() => {
    fetch('/api/settings/blocks').then(r => r.json()).then(b => setBlocks(Array.isArray(b) ? b : [])).catch(() => {});
    fetch('/api/settings').then(r => r.json()).then(s => setModels(s.settings?.models || {})).catch(() => {});
    fetch('/api/settings/connectivity').then(r => r.json()).then(c => setSupabaseOk(!!c?.supabase?.attached)).catch(() => {});
    fetch('/core/provider-health').then(r => r.json()).then(setHealth).catch(() => {});
  }, []);
  const aiBlocks = blocks.filter(b => b.contract?.ai?.role);
  const agg = aiBlocks.length ? Math.round(aiBlocks.reduce((s, b) => s + sciFor(b, models, health, supabaseOk), 0) / aiBlocks.length) : 0;
  return (
    <div className="admin-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div className="agent-tools-desc" style={{ margin: 0, flex: 1 }}>
          Your blocks and what each one needs. Set your models once — every block uses them automatically.
        </div>
        {/* BO-A5c — say WHICH product the number scores, every time it is
            quoted. The Bible describes two: the workspace (p4–25) and the
            business layer (p26–27: paid packs, deployments, marketplace).
            This score covers the workspace only. Counting an unbuilt
            commercial layer against engineering readiness would be dishonest
            in both directions — it understates the engineering and overstates
            the business. */}
        {aiBlocks.length > 0 && (
          <SciBadge
            score={agg}
            title={`Workspace confidence — ${agg}/100 across ${aiBlocks.length} AI blocks. 80+ = deploy-ready. Scores the workspace only; the business layer (paid packs, marketplace) is not built and is not counted.`}
          />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
        {aiBlocks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim, #4a6a8a)' }}>No AI blocks installed.</div>}
        {aiBlocks.map(b => {
          const role = b.contract.ai.role;
          const cfg = models[role];
          const needsSupabase = (b.requires?.apis || []).includes('supabase');
          const supabaseMissing = needsSupabase && !supabaseOk;
          const providerAlive = cfg && (cfg.provider === 'local'
            ? (health?.localConfirmed !== false)
            : !!(health?.providers?.[cfg.provider]?.healthy));
          const providerMissing = !!cfg && !providerAlive;
          const score = sciFor(b, models, health, supabaseOk);
          return (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border, rgba(255,255,255,0.1))' }}>
              <BlockIcon
                iconAsset={b.iconAsset}
                iconAssetPng={b.iconAssetPng}
                fallback={b.icon}
                size={28}
                style={{ flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {b.label}
                  <SciBadge score={score} title={score >= 80 ? 'Ready' : score >= 50 ? 'Partly configured' : 'Not ready — set a model or connect its service'} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim, #4a6a8a)' }}>{b.contract.ai.blurb || b.description}</div>
                {providerMissing && <div style={{ fontSize: 11, color: '#ffb454', marginTop: 3 }}>⚠ {cfg.provider} not reachable — no key configured, or enable local models</div>}
                {supabaseMissing && <div style={{ fontSize: 11, color: '#ffb454', marginTop: 3 }}>⚠ needs Supabase — connect it under Services</div>}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--text-dim, #4a6a8a)' }}>USES YOUR {role.toUpperCase()} MODEL</div>
                <button onClick={onManageModels} title="Set this model under Models"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, color: cfg ? 'var(--accent, #00f2ff)' : '#ffb454' }}>
                  {cfg ? cfg.model : '— set a model —'} ✎
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Firebase tracking toggle — honest switch (localStorage flag firebase.js reads
// at init). Firebase is optional analytics, NOT login; off = Supabase-only.
function FirebaseTrackingToggle() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem('aeon_firebase_tracking') !== 'off'; } catch { return true; } });
  const toggle = () => {
    const next = !on;
    try { localStorage.setItem('aeon_firebase_tracking', next ? 'on' : 'off'); } catch {}
    setOn(next);
  };
  return (
    <div className="pref-toggle-row">
      <div className="pref-toggle-info">
        <span className="pref-toggle-label">Firebase live tracking</span>
        <span className="pref-toggle-desc">Optional analytics/session layer. Off = Supabase-only (recommended for testing). Takes effect on reload.</span>
      </div>
      <button
        type="button"
        className={`roulette-btn ${on ? 'roulette-btn--on' : ''}`}
        onClick={toggle}
        role="switch"
        aria-checked={on}
        aria-label="Firebase live tracking"
      >
        {on ? <><ToggleRight size={14} /> ON</> : <><ToggleLeft size={14} /> OFF</>}
      </button>
    </div>
  );
}

// Deploy — export the client-ready config (keys stripped) = the portable unit.
function DeployCard() {
  return (
    <div className="admin-card">
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: 'var(--accent, #00f2ff)', marginBottom: 6 }}>DEPLOY / SHARE</div>
      <div className="agent-tools-desc" style={{ marginBottom: 10 }}>
        Export a client-ready config: your chosen models baked in, <strong>every key stripped</strong>.
        Hand it to a client, they add their own keys, they're running AEON.
      </div>
      <a href="/api/settings/export-bundle" download="aeon-client-config.json"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          color: '#02121a', background: 'var(--accent, #00f2ff)', textDecoration: 'none' }}>
        <Save size={14} /> Export client config
      </a>
    </div>
  );
}

// Services — infrastructure, connect once. Reuses the panels that already work.
function ServicesPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SupabaseFirebasePanel />
      <div className="admin-card prefs-card"><FirebaseTrackingToggle /></div>
      <TunnelPanel />
      <DeployCard />
    </div>
  );
}

// ── Main Settings Component ──────────────────────────────────────────
export default function SystemSettings() {
  const [settings, setSettings] = useState(null);
  const [envKeys, setEnvKeys] = useState({});
  const [providers, setProviders] = useState({});
  const [blocks, setBlocks] = useState([]);
  const [liveModels, setLiveModels] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('start');
  const [dirty, setDirty] = useState(false);
  const [providerBlocksMap, setProviderBlocksMap] = useState({});
  const [nervousSystem, setNervousSystem] = useState(null);
  const [brainStatus, setBrainStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const [sRes, pRes, bRes] = await Promise.all([
        fetch('/api/settings').then(r => r.json()).catch(() => ({})),
        fetch('/api/settings/providers').then(r => r.json()).catch(() => ({})),
        fetch('/api/settings/blocks').then(r => r.json()).catch(() => []),
      ]);
      if (sRes.settings) setSettings(sRes.settings);
      if (sRes.envKeys) setEnvKeys(sRes.envKeys);
      setProviders(pRes);
      setBlocks(bRes);
      setDirty(false);
      fetch('/api/settings/provider-blocks').then(r => r.json()).then(d => setProviderBlocksMap(d)).catch(() => {});
      fetch('/api/settings/nervous-system').then(r => r.json()).then(ns => {
        setNervousSystem(ns);
      }).catch(() => {});
      fetch('/api/crn/second-brain/index-status').then(r => r.json()).then(s => {
        setBrainStatus(s);
      }).catch(() => {});
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // Fetch live models from connected providers
  useEffect(() => {
    const fetchLive = async (id) => {
      try {
        const r = await fetch(`/api/settings/test-provider/${id}`, { method: 'POST' });
        const d = await r.json();
        // An empty array is not a model list. Caching it here is what pinned
        // the picker empty even after the provider was fixed.
        if (d.ok && Array.isArray(d.models) && d.models.length) {
          setLiveModels(prev => ({ ...prev, [id]: d.models }));
        }
      } catch {}
    };
    Object.entries(providers).forEach(([id, ok]) => { if (ok) fetchLive(id); });
  }, [providers]);

  // Patch accumulator: only the keys this panel actually changed go to the
  // server. A full-object POST would overwrite prefs/blockSettings written by
  // other blocks between our load and our save (last-writer-wins clobber —
  // the "settings never save" bug).
  const patchRef = useRef({});
  const addPatch = (patch) => {
    const merge = (t, p) => {
      for (const k of Object.keys(p)) {
        if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) {
          if (!t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) t[k] = {};
          merge(t[k], p[k]);
        } else t[k] = p[k];
      }
    };
    merge(patchRef.current, patch);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: patchRef.current }),
      });
      if (r.ok) {
        patchRef.current = {};
        setSaved(true);
        setDirty(false);
        showToast('Settings saved');
        setTimeout(() => setSaved(false), 2000);
      } else {
        showToast('Failed to save settings', 'error');
      }
    } catch { showToast('Save failed — server unreachable', 'error'); }
    setSaving(false);
  };

  const updateRole = (role, field, value) => {
    setDirty(true);
    addPatch({ models: { [role]: { [field]: value } } });
    setSettings(prev => ({
      ...prev,
      models: { ...prev.models, [role]: { ...prev.models[role], [field]: value } }
    }));
    // Also sync to endpoint registry if connections exist (bridge settings → registry)
    fetch('/api/connections').then(r => r.json()).then(d => {
      if (d.endpoints?.length) {
        const provider = field === 'provider' ? value : settings?.models?.[role]?.provider;
        const model = field === 'model' ? value : settings?.models?.[role]?.model;
        const ep = d.endpoints.find(e => e.provider === provider);
        if (ep) {
          fetch('/api/connections/assign-role', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role, endpoint_id: ep.id, model }),
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  };

  // Per-block settings: set once into blockSettings[<id>][<key>], saved with
  // the same Save button. Blocks read them via /api/settings (client) or
  // loadSettings() (server).
  const updateBlockSetting = (blockId, key, value) => {
    setDirty(true);
    addPatch({ blockSettings: { [blockId]: { [key]: value } } });
    setSettings(prev => ({
      ...prev,
      blockSettings: { ...(prev.blockSettings || {}), [blockId]: { ...((prev.blockSettings || {})[blockId] || {}), [key]: value } },
    }));
  };

  if (!settings) return <div className="settings-loading"><RefreshCw size={16} className="spin" /> Loading settings...</div>;

  const connectedCount = Object.values(providers).filter(Boolean).length;
  const totalProviders = Object.keys(providers).length;

  // ── One tab per concern. No duplicate controls: a setting lives in
  // exactly one place. (Rebuild 2026-07-16 — was 12 stacked accordions.)
  const TABS = [
    { id: 'start',       label: 'Get Started' },
    { id: 'models',      label: 'Models' },
    { id: 'blocks',      label: 'Blocks', badge: blocks.length },
    { id: 'services',    label: 'Services' },
    { id: 'connections', label: 'Keys', badge: `${connectedCount}/${totalProviders}` },
    { id: 'account',     label: 'Account' },
    { id: 'agent',       label: 'Agent' },
    { id: 'appearance',  label: 'Appearance' },
    { id: 'system',      label: 'System' },
  ];

  return (
    <div className="settings-root">
      <div id="aeon-settings-toast" className="settings-toast" />

      {/* Header */}
      <div className="settings-header">
        <div className="settings-header-left">
          <SettingsIcon size={20} color="var(--accent)" />
          <h2 className="settings-title">System settings</h2>
        </div>
        <span className="settings-header-stat">{connectedCount}/{totalProviders} providers connected</span>
      </div>

      {/* ── First-time setup wizard (hidden once complete) ────────── */}
      <SetupWizard />

      {/* ── Tab rail ──────────────────────────────────────────────── */}
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            className={`settings-tab ${tab === t.id ? 'settings-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge !== undefined && <span className="settings-tab-badge">{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* ── GET STARTED — status + what to do, CEO-simple ─────────── */}
      {tab === 'start' && (
        <>
          <GetStartedStrip />
          <BlocksNeedsPanel onManageModels={() => setTab('models')} />
        </>
      )}

      {/* ── SERVICES — infrastructure, connect once ───────────────── */}
      {tab === 'services' && <ServicesPanel />}

      {/* ── ACCOUNT — identity, auth, login gate ──────────────────── */}
      {tab === 'account' && (
        <>
          <AccountPanel />
          <div className="admin-card prefs-card">
            <PrefToggle
              label="Require login"
              desc="Gate the portal behind operator authentication"
              prefKey="require_login"
              defaultVal={false}
              onMsg="Login required — portal is now gated"
              offMsg="Login requirement disabled"
            />
          </div>
        </>
      )}

      {/* ── CONNECTIONS — every key, provider, and cloud in one place ── */}
      {tab === 'connections' && (
        <UnifiedConnectionsPanel
          providers={providers}
          nervousSystem={nervousSystem}
          onReload={load}
        />
      )}

      {/* ── MODELS — the ONE place models are set. Blocks inherit these
             roles (see Blocks tab). The dead per-block dual-dial that used
             to lead this tab wrote to blockConfig, which nothing read. ── */}
      {tab === 'models' && (
        <div className="models-section">
          <div className="agent-tools-desc" style={{ marginBottom: 10 }}>
            Pick a model for each job. Every block uses these — set once, done.
            {' '}Don't have cloud keys? Choose a local runtime model and run free.
          </div>
          {deriveRoles(settings.models).map(role => (
            <RoleCard
              key={role.key}
              role={role}
              config={settings.models[role.key]}
              providers={providers}
              liveModels={liveModels}
              onUpdate={updateRole}
              providerBlocks={providerBlocksMap}
              providerRegistry={getProviderRegistry(nervousSystem)}
            />
          ))}

          {/* Automation knobs (advanced) */}
          <details className="role-defaults-details">
            <summary className="role-defaults-summary">
              <Wrench size={12} /> Automation (advanced)
            </summary>
            <div className="role-defaults-desc">
              Fallback and key-rotation behavior when a provider is rate-limited.
            </div>
            <div className="admin-card roulette-card">
              <div className="roulette-row">
                <Zap size={14} color="var(--accent)" />
                <div className="roulette-info">
                  <span className="roulette-label">Roulette mode</span>
                  <span className="roulette-desc">Cycle through free API keys automatically</span>
                </div>
                <button
                  type="button"
                  className={`roulette-btn ${settings.roulette ? 'roulette-btn--on' : ''}`}
                  onClick={() => { setDirty(true); addPatch({ roulette: !settings.roulette }); setSettings(prev => ({ ...prev, roulette: !prev.roulette })); }}
                  role="switch"
                  aria-checked={!!settings.roulette}
                  aria-label="Roulette mode"
                >
                  {settings.roulette ? <><ToggleRight size={14} /> ON</> : <><ToggleLeft size={14} /> OFF</>}
                </button>
              </div>
            </div>
            <div className="admin-card prefs-card">
              <PrefToggle
                label="Always allow local models"
                desc="Treat local runtime as a first-class provider — no /allow-local confirmation needed. Recommended when cloud keys are dead or you want zero-cost operation."
                prefKey="allow_local_llm"
                defaultVal={false}
                onMsg="Local models always allowed — workhorse mode"
                offMsg="Local models require /allow-local confirmation again"
              />
              <PrefToggle
                label="Agent step review"
                desc="Before accepting a subtask as done, the heavy tier checks the worker's claim against the actual tool-execution ledger and can send it back. Doubles heavy-tier calls per subtask — off by default."
                prefKey="agent_step_review"
                defaultVal={false}
                onMsg="Step review on"
                offMsg="Step review off"
              />
            </div>
          </details>

          {/* Vision — a models concern, lives here now */}
          <div className="admin-card prefs-card">
          <PrefToggle
            label="Vision enabled"
            desc="Analyze images with a vision-capable model (GPT-4o, Gemini Pro Vision, LLaVA)"
            prefKey="vision_enabled"
            defaultVal={false}
            onMsg="Vision enabled"
            offMsg="Vision disabled"
          />
          <div className="pref-toggle-row">
            <div className="pref-toggle-info">
              <span className="pref-toggle-label">Vision model</span>
              <span className="pref-toggle-desc">Select which model handles image analysis. Auto-detect picks the best available.</span>
            </div>
            <VisionModelSelect />
          </div>
          <PrefToggle
            label="Auto-detect images"
            desc="Automatically analyze images pasted or uploaded in the terminal"
            prefKey="vision_auto_detect"
            defaultVal={true}
            onMsg="Auto-detect on"
            offMsg="Auto-detect off"
          />
          </div>
        </div>
      )}

      {/* ── BLOCKS — manifest-driven access cards + installed chips ── */}
      {tab === 'blocks' && (
        <>
          <div className="admin-card">
            <div className="agent-tools-desc">Installed blocks — {blocks.length}. Each block that declares settings gets its own card below; remove the block and its settings disappear with it.</div>
            <div className="blocks-grid">
              {blocks.map(b => {
                const ready = b.readiness ? b.readiness.ready : true;
                const missing = b.readiness ? b.readiness.missingApis : [];
                return (
                  <div key={b.id} className="block-chip" title={ready ? 'All dependencies met' : `Missing: ${missing.join(', ')}`}>
                    <span className={`block-ready-dot ${ready ? 'block-ready-dot--ok' : 'block-ready-dot--off'}`} />
                    <BlockIcon
                      iconAsset={b.iconAsset}
                      iconAssetPng={b.iconAssetPng}
                      fallback={b.icon}
                      size={16}
                      className="block-chip-icon"
                    />
                    <span className="block-chip-label">{b.label}</span>
                    {!ready && <span className="block-chip-missing">{missing.length} dep</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <BlockWidgetsPanel />
          <BlockSettingsPanel blockSettings={settings.blockSettings} onChange={updateBlockSetting} />
        </>
      )}

      {/* ── AGENT — what the agent may do + build approvals ────────── */}
      {tab === 'agent' && (
        <>
          <BuildQueuePanel />
          <div className="admin-card prefs-card">
            <div className="agent-tools-desc">Control what the AI agent is allowed to do when processing requests. Disabled tools won't appear in the agent's toolset.</div>
            <PrefToggle label="File system access" desc="Read, write, and manage files on the local OS" prefKey="tool_filesystem" defaultVal={true} onMsg="FS access on" offMsg="FS access off" />
            <PrefToggle label="Shell commands" desc="Execute OS commands (ls, git, npm, etc.)" prefKey="tool_shell" defaultVal={true} onMsg="Shell on" offMsg="Shell off" />
            <PrefToggle label="Web search" desc="Search the internet via DuckDuckGo / API" prefKey="tool_web_search" defaultVal={true} onMsg="Web search on" offMsg="Web search off" />
            <PrefToggle label="Email dispatch" desc="Send emails via Google Apps Script" prefKey="tool_email" defaultVal={false} onMsg="Email on" offMsg="Email off" />
            <PrefToggle label="CRM management" desc="Add, edit, delete clients and invoices" prefKey="tool_crm" defaultVal={true} onMsg="CRM on" offMsg="CRM off" />
            <PrefToggle label="Memory management" desc="Add facts to persistent memory" prefKey="tool_memory" defaultVal={true} onMsg="Memory on" offMsg="Memory off" />
            <PrefToggle label="Autopilot control" desc="Start/stop YouTube autopilot pipeline" prefKey="tool_autopilot" defaultVal={false} onMsg="Autopilot on" offMsg="Autopilot off" />
            <PrefToggle label="Deploy" desc="Push to Vercel, Cloudflare, or other hosts" prefKey="tool_deploy" defaultVal={false} onMsg="Deploy on" offMsg="Deploy off" />
          </div>
        </>
      )}

      {/* ── APPEARANCE — one theming surface; deep colors are advanced ── */}
      {tab === 'appearance' && (
        <div className="admin-card">
          <AppearancePanel />
          <details className="role-defaults-details" style={{ marginTop: 12 }}>
            <summary className="role-defaults-summary"><Wrench size={12} /> Advanced theme colors</summary>
            <ThemeBuilder />
          </details>
        </div>
      )}

      {/* ── SYSTEM — prefs, brain index, blocks, env ───────────────── */}
      {tab === 'system' && (
        <>
        <div className="admin-card prefs-card">
          <PrefToggle
            label="Auto-sync to cloud"
            desc="Push local state to Supabase relay on changes"
            prefKey="auto_sync"
            defaultVal={true}
            onMsg="Cloud sync enabled"
            offMsg="Cloud sync disabled"
          />
          <PrefToggle
            label="Telemetry"
            desc="Track LLM latency, token usage, and error rates"
            prefKey="telemetry_enabled"
            defaultVal={true}
            onMsg="Telemetry enabled"
            offMsg="Telemetry disabled"
          />
          <PrefToggle
            label="Sound effects"
            desc="Play audio on notifications and events"
            prefKey="sound_effects"
            defaultVal={false}
            onMsg="Sound effects on"
            offMsg="Sound effects off"
          />
          <PrefToggle
            label="Auto-backup settings"
            desc="Snapshot settings to Supabase every 6 hours"
            prefKey="auto_backup"
            defaultVal={false}
            onMsg="Auto-backup enabled"
            offMsg="Auto-backup disabled"
          />
        </div>

        {/* Second Brain index status */}
        <div className="admin-card">
          <div className="agent-tools-desc">Second Brain index — {brainStatus?.totalDocs ?? 0} docs</div>
          {brainStatus ? (
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '12px' }}>
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', letterSpacing: '0.5px' }}>DOCS INDEXED</div>
                <div style={{ fontSize: '16px', fontWeight: 700 }}>{brainStatus.totalDocs ?? 0}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', letterSpacing: '0.5px' }}>LAST SYNC</div>
                <div style={{ fontSize: '13px' }}>{brainStatus.lastRun ? new Date(brainStatus.lastRun).toLocaleString() : 'Never'}</div>
              </div>
              {brainStatus.lastResult && (
                <div>
                  <div style={{ color: 'var(--text-dim)', fontSize: '10px', letterSpacing: '0.5px' }}>LAST RUN</div>
                  <div style={{ fontSize: '13px' }}>
                    +{brainStatus.lastResult.ingested || 0} · skip {brainStatus.lastResult.skipped || 0} · del {brainStatus.lastResult.deleted || 0}
                    {brainStatus.lastResult.errors?.length ? ` · ${brainStatus.lastResult.errors.length} errors` : ''}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Not indexed yet — run /index-brain in the Neural Terminal.</div>
          )}
        </div>

        {/* Environment variables */}
        <details className="role-defaults-details">
          <summary className="role-defaults-summary"><Wrench size={12} /> Environment variables</summary>
          <div className="admin-card env-card">
          {Object.entries(envKeys).map(([key, val]) => (
            <div key={key} className="env-row">
              <code className="env-key">{key}</code>
              <span className={`env-val env-val--${val === 'configured' ? 'ok' : val === 'vault' ? 'ok' : val === 'missing' ? 'err' : 'dim'}`}>
                {val === 'configured' && <Check size={10} />}
                {val === 'vault' && <><Lock size={10} /> vault</>}
                {val === 'missing' && <X size={10} />}
                {val !== 'vault' && val}
              </span>
            </div>
          ))}
          </div>
        </details>
        </>
      )}

      {/* ── Action Bar ────────────────────────────────────────────── */}
      <div className="settings-actions">
        {dirty && <span className="settings-dirty-dot" title="Unsaved changes" />}
        <button className="settings-btn settings-btn--secondary" onClick={load}>
          <RefreshCw size={12} /> Reload
        </button>
        <button className={`settings-btn settings-btn--primary ${saved ? 'settings-btn--saved' : ''}`} onClick={save} disabled={saving}>
          {saved ? <><Check size={12} /> Saved</> : saving ? 'Saving...' : <><Shield size={12} /> Save settings</>}
        </button>
      </div>

      <style>{`
        /* ── Settings Scoped Styles ─────────────────────────────────── */
        .settings-root {
          max-width: 780px;
          margin: 0 auto;
          padding: 24px 16px 80px;
          position: relative;
        }

        .settings-loading {
          padding: 60px;
          color: var(--text-dim);
          display: flex;
          align-items: center;
          gap: 8px;
          justify-content: center;
        }

        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Toast ── */
        .settings-toast {
          position: fixed;
          bottom: 80px;
          left: 50%;
          transform: translateX(-50%) translateY(20px);
          padding: 8px 18px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          pointer-events: none;
          opacity: 0;
          transition: all 0.2s var(--ease-out-expo);
          z-index: 9999;
          background: rgba(0,242,255,0.12);
          color: var(--accent);
          border: 1px solid rgba(0,242,255,0.2);
          backdrop-filter: blur(12px);
        }
        .settings-toast--visible { opacity: 1; transform: translateX(-50%) translateY(0); }
        .settings-toast--error { background: rgba(255,68,102,0.12); color: #ff4466; border-color: rgba(255,68,102,0.2); }

        /* ── Header ── */
        .settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
        }
        .settings-header-left { display: flex; align-items: center; gap: 10px; }
        .settings-title { font-size: 17px; font-weight: 500; color: var(--text); margin: 0; }
        .settings-header-stat { font-size: 11px; color: var(--text-dim); }

        /* ── Tab Rail (rebuild 2026-07-16) ── */
        .settings-tabs {
          display: flex;
          gap: 6px;
          margin: 14px 0 18px;
          border-bottom: 1px solid var(--border);
          padding-bottom: 0;
          flex-wrap: wrap;
        }
        .settings-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 9px 16px;
          border: none;
          background: none;
          cursor: pointer;
          color: var(--text-dim);
          font-size: 12.5px;
          font-weight: 600;
          letter-spacing: 0.03em;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.15s, border-color 0.15s;
        }
        .settings-tab:hover { color: var(--text); }
        .settings-tab--active {
          color: var(--accent);
          border-bottom-color: var(--accent);
        }
        .settings-tab-badge {
          font-size: 10px;
          padding: 1px 7px;
          border-radius: 10px;
          background: var(--accent-dim);
          color: var(--accent);
          font-weight: 600;
        }

        /* ── Admin Card (Odysseus pattern) ── */
        .admin-card {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 14px;
          margin: 8px 0;
          transition: border-color 0.2s;
        }
        .admin-card:hover { border-color: var(--border-hi); }

        /* ── Provider Cards ── */
        .providers-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .provider-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 12px;
          background: rgba(255,255,255,0.015);
          border-radius: 8px;
          border: 1px solid transparent;
          transition: all 0.15s;
        }
        .provider-card--ok { border-color: rgba(0,255,64,0.08); }
        .provider-card--off { opacity: 0.6; }
        .provider-card:hover { background: rgba(255,255,255,0.03); }
        .provider-card-header { display: flex; align-items: center; gap: 8px; }
        .provider-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #ff4466;
          flex-shrink: 0;
        }
        .provider-dot--on { background: #00ff40; box-shadow: 0 0 6px rgba(0,255,64,0.4); }
        .provider-card-icon { font-size: 13px; }
        .provider-card-label { font-size: 12px; color: var(--text); text-transform: capitalize; font-weight: 500; }
        .provider-card-status { margin-left: auto; font-size: 9px; color: rgba(0,255,64,0.7); font-weight: 600; letter-spacing: 0.3px; }
        .provider-card-status--off { color: rgba(255,68,102,0.6); }
        .provider-card-models { display: flex; flex-wrap: wrap; gap: 3px; padding-top: 2px; }
        .provider-model-chip {
          font-size: 9px;
          padding: 2px 6px;
          border-radius: 4px;
          background: rgba(0,242,255,0.06);
          color: var(--text-dim);
          font-family: monospace;
        }
        .provider-model-chip--more { background: rgba(255,255,255,0.05); color: var(--accent); }
        .provider-card-error { font-size: 10px; color: #ff4466; padding: 2px 0; }
        .provider-test-btn {
          display: flex;
          align-items: center;
          align-self: flex-end;
          gap: 4px;
          padding: 3px 8px;
          font-size: 9px;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--text-dim);
          cursor: pointer;
          transition: all 0.15s;
        }
        .provider-test-btn:hover { color: var(--accent); border-color: var(--accent); }
        .provider-test-btn--spin svg { animation: spin 0.8s linear infinite; }

        /* ── Model Assignment / Role Cards ── */
        .models-section { display: flex; flex-direction: column; gap: 4px; }
        .roulette-card { margin-bottom: 4px; }
        .roulette-row { display: flex; align-items: center; gap: 10px; }
        .roulette-info { flex: 1; }
        .roulette-label { font-size: 12px; color: var(--text); font-weight: 500; display: block; }
        .roulette-desc { font-size: 10px; color: var(--text-dim); }
        .roulette-btn {
          display: flex; align-items: center; gap: 5px;
          padding: 5px 14px;
          font-size: 11px;
          border-radius: 5px;
          border: none;
          cursor: pointer;
          font-weight: 600;
          background: rgba(255,255,255,0.06);
          color: var(--text-dim);
          transition: all 0.15s;
        }
        .roulette-btn--on { background: var(--accent); color: #020508; }

        .role-card { padding: 12px 14px; }
        .role-card-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
        .role-card-icon { font-size: 16px; margin-top: 1px; }
        .role-card-title { font-size: 13px; font-weight: 500; color: var(--text); }
        .role-card-desc { font-size: 10px; color: var(--text-dim); margin-top: 1px; }
        .role-card-warning { font-size: 9px; color: #ffaa00; background: rgba(255,170,0,0.1); padding: 3px 8px; border-radius: 4px; font-weight: 600; margin-left: auto; white-space: nowrap; }
        .role-card-count { font-size: 9px; color: var(--accent); background: var(--accent-dim); padding: 3px 8px; border-radius: 4px; font-weight: 600; margin-left: auto; white-space: nowrap; }

        /* ── Block Config Panel ── */
        .block-config-panel { display: flex; flex-direction: column; gap: 8px; }
        .block-config-header { display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px; }
        .block-config-stats { display: flex; gap: 12px; }
        .block-config-stat { font-size: 10px; color: var(--text-dim); }
        .block-config-actions { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
        .block-config-filters { display: flex; gap: 4px; }
        .block-config-filter { font-size: 10px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); cursor: pointer; transition: all 0.15s; }
        .block-config-filter:hover { border-color: var(--accent); color: var(--accent); }
        .block-config-filter--on { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }
        .block-config-list { display: flex; flex-direction: column; gap: 2px; }
        .block-config-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(255,255,255,0.015); border-radius: 6px; border: 1px solid transparent; transition: all 0.15s; }
        .block-config-row:hover { background: rgba(255,255,255,0.03); }
        .block-config-row--ok { border-color: rgba(0,255,64,0.06); }
        .block-config-row--noai { opacity: 0.4; }
        .block-config-info { display: flex; align-items: center; gap: 7px; min-width: 180px; flex-shrink: 0; }
        .block-config-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .block-config-dot--on { background: #00ff40; box-shadow: 0 0 5px rgba(0,255,64,0.4); }
        .block-config-dot--needs { background: #ffaa00; }
        .block-config-dot--noai { background: #333; }
        .block-config-icon { font-size: 13px; }
        .block-config-label { font-size: 11px; color: var(--text); font-weight: 500; }
        .block-config-tag { font-size: 8px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,0.05); color: var(--text-dim); }
        .block-config-tag--needs { background: rgba(255,170,0,0.1); color: #ffaa00; }
        .block-config-tag--warn { background: rgba(255,68,102,0.1); color: #ff4466; }
        .block-config-tag--svc { display: flex; gap: 4px; background: none; padding: 0; }
        .block-dep-ok { font-size: 8px; padding: 1px 6px; border-radius: 3px; background: rgba(0,255,64,0.08); color: rgba(0,255,64,0.7); }
        .block-dep-missing { font-size: 8px; padding: 1px 6px; border-radius: 3px; background: rgba(255,68,102,0.08); color: rgba(255,68,102,0.6); }
        .block-config-selects { display: flex; gap: 6px; flex: 1; align-items: center; }
        .block-config-select { flex: 1; padding: 5px 8px; font-size: 10px; }
        .block-config-clear { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; transition: all 0.15s; }
        .block-config-clear:hover { color: #ff4466; background: rgba(255,68,102,0.1); }

        /* ── Role Defaults (collapsed) ── */
        .role-defaults-details { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .role-defaults-summary { padding: 10px 14px; font-size: 11px; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 6px; transition: color 0.15s; }
        .role-defaults-summary:hover { color: var(--accent); }
        .role-defaults-desc { font-size: 10px; color: var(--text-dim); padding: 0 14px 10px; }
        .role-card-blocks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.04); }
        .role-block-chip { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.04); color: var(--text-dim); text-transform: capitalize; }
        .role-block-chip--ok { background: rgba(0,255,64,0.06); color: #00ff40; }
        .role-card-selects { display: flex; gap: 8px; }
        .role-select-group { flex: 1; display: flex; flex-direction: column; gap: 3px; }
        .role-select-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-dim); font-weight: 600; }

        .settings-select {
          width: 100%;
          padding: 7px 10px;
          background: rgba(10,15,24,0.9);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-size: 11px;
          cursor: pointer;
          transition: border-color 0.15s;
          outline: none;
        }
        .settings-select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim, rgba(0,242,255,0.25)); }

        /* ── Searchable Model Picker ── */
        .model-picker-wrap { position: relative; flex: 1; }
        .model-picker-trigger {
          width: 100%;
          padding: 7px 10px;
          background: rgba(10,15,24,0.9);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-size: 11px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          text-align: left;
          transition: border-color 0.15s;
        }
        .model-picker-trigger:focus, .model-picker-trigger:hover { border-color: var(--accent); }
        .model-picker-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .model-picker-dropdown {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          background: rgba(8,12,22,0.97);
          border: 1px solid var(--border-hi);
          border-radius: 8px;
          z-index: 100;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          backdrop-filter: blur(16px);
          overflow: hidden;
        }
        .model-picker-search-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
        }
        .model-picker-search {
          flex: 1;
          background: none;
          border: none;
          color: var(--text);
          font-size: 11px;
          outline: none;
        }
        .model-picker-search:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }
        .model-picker-list { max-height: 180px; overflow-y: auto; }
        .model-picker-item:focus-visible { outline: 1.5px solid var(--accent); outline-offset: -1.5px; }
        .model-picker-item {
          padding: 7px 12px;
          font-size: 11px;
          color: var(--text);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background 0.1s;
          font-family: monospace;
        }
        .model-picker-item:hover { background: var(--accent-dim); }
        .model-picker-item--active { color: var(--accent); }
        .model-picker-empty { padding: 12px; text-align: center; font-size: 11px; color: var(--text-dim); }

        /* ── Pref Toggles ── */
        .pref-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .pref-toggle-row:last-child { border-bottom: none; }
        .pref-toggle-info { display: flex; flex-direction: column; gap: 1px; }
        .pref-toggle-label { font-size: 12px; color: var(--text); font-weight: 500; }
        .pref-toggle-desc { font-size: 10px; color: var(--text-dim); }
        .pref-toggle-btn {
          width: 36px;
          height: 20px;
          border-radius: 10px;
          border: none;
          background: rgba(255,255,255,0.1);
          cursor: pointer;
          position: relative;
          transition: background 0.2s;
          flex-shrink: 0;
        }
        .pref-toggle-btn--on { background: var(--accent); }
        .pref-toggle-btn--loading { opacity: 0.3; }
        .pref-toggle-knob {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          transition: transform 0.2s var(--ease-spring);
        }
        .pref-toggle-btn--on .pref-toggle-knob { transform: translateX(16px); }

        /* ── Blocks Grid ── */
        .blocks-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .block-chip {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 7px 10px;
          background: rgba(255,255,255,0.015);
          border-radius: 6px;
        }
        .block-chip-icon { font-size: 13px; }
        .block-chip-label { font-size: 11px; color: var(--text); flex: 1; }
        .block-chip-deploy {
          font-size: 8px;
          padding: 2px 6px;
          border-radius: 3px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }
        .block-chip-deploy--cloud { background: rgba(0,255,64,0.1); color: #00ff40; }
        .block-chip-deploy--local { background: rgba(255,68,102,0.1); color: #ff4466; }
        .block-chip-deploy--hybrid { background: var(--accent-dim); color: var(--accent); }
        .block-ready-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .block-ready-dot--ok { background: #00ff40; box-shadow: 0 0 5px rgba(0,255,64,0.4); }
        .block-ready-dot--off { background: #ffaa00; }
        .block-chip-missing { font-size: 8px; color: #ffaa00; padding: 1px 5px; border-radius: 3px; background: rgba(255,170,0,0.1); }

        /* ── Env Vars ── */
        .env-card { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
        .env-row {
          display: flex;
          justify-content: space-between;
          padding: 5px 0;
          border-bottom: 1px solid rgba(255,255,255,0.02);
        }
        .env-row:last-child { border-bottom: none; }
        .env-key { font-size: 10px; color: var(--text-dim); }
        .env-val {
          font-size: 10px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .env-val--ok { color: #00ff40; }
        .env-val--err { color: #ff4466; }
        .env-val--dim { color: var(--text-dim); }

        /* ── Action Bar ── */
        .settings-actions {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 10px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid var(--border);
        }
        .settings-dirty-dot {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: #ffaa00;
          box-shadow: 0 0 8px rgba(255,170,0,0.4);
          margin-right: auto;
        }
        .settings-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 12px;
          font-weight: 500;
          border-radius: 7px;
          cursor: pointer;
          transition: all 0.15s;
          border: none;
        }
        .settings-btn--secondary {
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--border);
          color: var(--text-dim);
        }
        .settings-btn--secondary:hover { color: var(--text); border-color: var(--border-hi); }
        .settings-btn--primary {
          background: var(--accent);
          color: #020508;
          font-weight: 600;
        }
        .settings-btn--primary:hover { box-shadow: 0 0 20px rgba(0,242,255,0.3); }
        .settings-btn--saved { background: #00ff40; }
        .settings-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* ── Account & Security Panel ── */
        .account-section { display: flex; flex-direction: column; gap: 0; }
        .account-empty { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-dim); }
        .account-empty b { color: var(--accent); }
        .account-head { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500; color: var(--text); margin-bottom: 12px; }
        .account-avatar { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2, #7b2fff)); display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 700; color: #020508; flex-shrink: 0; }
        .account-name { font-size: 14px; font-weight: 600; color: var(--text); }
        .account-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
        .account-role { color: var(--accent); text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px; padding: 1px 6px; background: var(--accent-dim); border-radius: 4px; }
        .account-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .account-form .settings-select { flex: 1; min-width: 140px; }
        .account-fields { display: flex; flex-direction: column; gap: 10px; }
        .account-field { display: flex; flex-direction: column; gap: 4px; }
        .account-field label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-dim); font-weight: 600; }
        .account-save { align-self: flex-start; }
        .account-pw { display: flex; flex-direction: column; gap: 8px; }
        .account-hint { font-size: 10px; color: var(--text-dim); margin-top: 10px; line-height: 1.5; }

        /* ── Agent Tools ── */
        .agent-tools-desc { font-size: 11px; color: var(--text-dim); margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); line-height: 1.5; }

        /* ── Appearance ── */
        .appearance-panel { display: flex; flex-direction: column; gap: 0; }
        .appearance-row { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
        .appearance-row:last-child { border-bottom: none; }
        .appearance-label { font-size: 12px; font-weight: 500; color: var(--text); min-width: 100px; }
        .appearance-options { display: flex; gap: 6px; }
        .appearance-chip { font-size: 11px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: rgba(255,255,255,0.02); color: var(--text-dim); cursor: pointer; transition: all 0.15s; text-transform: capitalize; }
        .appearance-chip:hover { border-color: var(--accent); color: var(--accent); }
        .appearance-chip--active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }
        .appearance-colors { display: flex; gap: 6px; }
        .appearance-color { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: all 0.15s; }
        .appearance-color:hover { transform: scale(1.15); }
        .appearance-color--active { border-color: #fff; box-shadow: 0 0 8px rgba(255,255,255,0.3); }
        .appearance-slider-wrap { display: flex; align-items: center; gap: 10px; flex: 1; }
        .appearance-slider-val { font-size: 12px; color: var(--accent); font-weight: 600; min-width: 36px; }

        /* ── Theme Builder ── */
        .theme-builder { display: flex; flex-direction: column; gap: 16px; }
        .theme-section { border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
        .theme-section-title { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--text); }
        .theme-colors-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .theme-color-row { display: flex; align-items: center; gap: 8px; }
        .theme-color-label { font-size: 11px; color: var(--text-dim); min-width: 70px; }
        .theme-color-input { width: 28px; height: 28px; border: none; border-radius: 50%; cursor: pointer; background: none; padding: 0; }
        .theme-color-hex { font-size: 10px; color: var(--text-dim); font-family: monospace; }
        .theme-harmony-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .theme-harmony-preview { width: 24px; height: 24px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2); }
        .theme-layout-grid { display: flex; gap: 12px; flex-wrap: wrap; }
        .theme-layout-item { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim); }
        .theme-layout-item select { font-size: 11px; }

        /* ── Setup Wizard ── */
        .wizard { background: linear-gradient(180deg, rgba(0,242,255,0.06), var(--bg-card)); border: 1px solid var(--border-hi); border-radius: 12px; padding: 18px; margin-bottom: 20px; }
        .wizard-head { margin-bottom: 14px; }
        .wizard-title { font-size: 14px; font-weight: 600; color: var(--accent); }
        .wizard-sub { display: block; font-size: 11px; color: var(--text-dim); margin-top: 2px; }
        .wizard-steps { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
        .wizard-step { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 20px; border: 1px solid var(--border); background: rgba(255,255,255,0.02); color: var(--text-dim); font-size: 11px; cursor: pointer; transition: all 0.15s; }
        .wizard-step--active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
        .wizard-step--done { color: #00ff40; border-color: rgba(0,255,64,0.3); }
        .wizard-step-dot { display: flex; align-items: center; }
        .wizard-body { min-height: 90px; }
        .wizard-fields { display: flex; flex-direction: column; gap: 9px; }
        .wizard-desc { font-size: 11px; color: var(--text-dim); line-height: 1.5; }
        .wizard-desc code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px; font-size: 10px; }
        .wizard-textarea { min-height: 90px; font-family: monospace; font-size: 10px; resize: vertical; padding: 10px; }
        .wizard-already { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #00ff40; padding: 8px 0; }
        .wizard-restart-note { font-size: 11px; color: var(--text-dim); padding: 8px 12px; border-radius: 6px; background: rgba(255,255,255,0.03); margin: 4px 0; }
        .wizard-restart-note--pending { color: #ffaa00; background: rgba(255,170,0,0.08); }
        .wizard-restart-btn { align-self: flex-start; }
        .wizard-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }

        /* ── Connections ── */
        .conn-section { display: flex; flex-direction: column; gap: 8px; }
        .vault-status { display: flex; align-items: center; gap: 12px; }
        .vault-status--ok { border-color: rgba(0,255,64,0.15); }
        .vault-status--locked { border-color: rgba(255,170,0,0.2); }
        .vault-status-title { font-size: 12px; font-weight: 600; color: var(--text); }
        .vault-status-sub { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
        .conn-empty { font-size: 12px; color: var(--text-dim); text-align: center; }
        .conn-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
        .conn-row-main { display: flex; align-items: center; gap: 10px; flex: 1; }
        .conn-provider-icon { font-size: 16px; }
        .conn-label { font-size: 13px; color: var(--text); font-weight: 500; display: flex; align-items: center; gap: 8px; }
        .conn-meta { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
        .reach-badges { display: inline-flex; gap: 4px; }
        .reach-badge { font-size: 8px; padding: 1px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
        .reach-badge--local { background: rgba(0,242,255,0.1); color: var(--accent); }
        .reach-badge--cloud { background: rgba(0,255,64,0.1); color: #00ff40; }
        .conn-remove { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 5px; border-radius: 5px; transition: all 0.15s; }
        .conn-remove:hover { color: #ff4466; background: rgba(255,68,102,0.1); }
        .conn-add-btn { width: 100%; padding: 11px; background: rgba(0,242,255,0.04); border: 1px dashed var(--border-hi); border-radius: 10px; color: var(--accent); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
        .conn-add-btn:hover { background: rgba(0,242,255,0.08); }
        .conn-add-head { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
        .conn-add-grid { display: flex; gap: 8px; margin-bottom: 10px; }
        .conn-add-grid .role-select-group { flex: 1; }
        .conn-add-actions { display: flex; gap: 8px; align-items: flex-end; margin: 12px 0; }
        .conn-add-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
        .conn-block-assign { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; }
        .conn-block-chip { font-size: 10px; padding: 3px 9px; border-radius: 12px; border: 1px solid var(--border); background: rgba(255,255,255,0.02); color: var(--text-dim); cursor: pointer; transition: all 0.15s; text-transform: capitalize; }
        .conn-block-chip:hover { border-color: var(--accent); color: var(--accent); }
        .conn-block-chip--on { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }
        .conn-block-chip--auto { border-color: rgba(0,255,64,0.3); color: #00ff40; background: rgba(0,255,64,0.08); }
        .conn-block-add-btn { font-size: 10px; padding: 3px 10px; border-radius: 12px; border: 1px dashed var(--border-hi); background: transparent; color: var(--accent); cursor: pointer; transition: all 0.15s; }
        .conn-block-add-btn:hover { background: var(--accent-dim); }
        .conn-block-dropdown { background: rgba(8,12,22,0.97); border: 1px solid var(--border-hi); border-radius: 8px; margin-top: 6px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); backdrop-filter: blur(16px); overflow: hidden; z-index: 100; }
        .conn-block-search-wrap { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
        .conn-block-search { flex: 1; background: none; border: none; color: var(--text); font-size: 11px; outline: none; }
        .conn-block-search:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }
        .conn-block-list { max-height: 240px; overflow-y: auto; }
        .conn-block-empty { padding: 12px; text-align: center; font-size: 11px; color: var(--text-dim); }
        .conn-block-option { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 11px; color: var(--text-dim); cursor: pointer; transition: background 0.1s; text-transform: capitalize; }
        .conn-block-option:hover { background: var(--accent-dim); }
        .conn-block-option:focus-visible { outline: 1.5px solid var(--accent); outline-offset: -1.5px; }
        .conn-block-option--on { color: var(--accent); }
        .conn-block-option--auto { background: rgba(0,255,64,0.03); }
        .conn-block-option-check { width: 14px; font-size: 10px; color: var(--accent); }
        .conn-block-option-tag { font-size: 8px; padding: 1px 5px; border-radius: 3px; background: rgba(0,255,64,0.1); color: #00ff40; font-weight: 600; margin-left: auto; }
        .conn-acct-email { font-family: monospace; font-size: 10px; color: var(--text-dim); }
        .conn-assigned-blocks { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
        .conn-assigned-chip { font-size: 8px; padding: 1px 6px; border-radius: 4px; background: var(--accent-dim); color: var(--accent); text-transform: capitalize; font-weight: 500; }

        /* ── Account Identities ── */
        .acct-id-section { margin-top: 12px; }
        .acct-id-head { margin-bottom: 10px; }
        .acct-id-title { font-size: 12px; font-weight: 600; color: var(--text); display: block; }
        .acct-id-sub { font-size: 10px; color: var(--text-dim); display: block; margin-top: 2px; }
        .acct-id-save { margin-top: 8px; }
        .acct-id-card { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 4px; overflow: hidden; transition: border-color 0.15s; }
        .acct-id-card:hover { border-color: var(--border-hi); }
        .acct-id-card--open { border-color: rgba(0,242,255,0.2); }
        .acct-id-row { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; transition: background 0.12s; }
        .acct-id-row:hover { background: rgba(255,255,255,0.02); }
        .acct-id-icon { font-size: 14px; }
        .acct-id-label { font-size: 12px; font-weight: 500; color: var(--text); min-width: 120px; }
        .acct-id-email { font-size: 10px; color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; }
        .acct-id-usage { font-size: 9px; color: var(--accent); padding: 1px 7px; border-radius: 10px; background: var(--accent-dim); font-weight: 600; flex-shrink: 0; }
        .acct-id-chev { color: var(--text-dim); transition: transform 0.2s; flex-shrink: 0; }
        .acct-id-chev--open { transform: rotate(180deg); }
        .provider-dot--unknown { background: #555; }
        .acct-id-card--missing { opacity: 0.65; }
        .acct-id-card--missing:hover { opacity: 0.85; }
        .acct-id-status { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
        .acct-id-status--ok { color: #00ff40; background: rgba(0,255,64,0.08); }
        .acct-id-status--missing { color: #ff4466; background: rgba(255,68,102,0.08); }
        .acct-id-needed { font-size: 9px; color: #ffaa00; padding: 1px 7px; border-radius: 10px; background: rgba(255,170,0,0.1); font-weight: 600; flex-shrink: 0; }
        .acct-id-block-chip--active { background: rgba(0,255,64,0.08); color: #00ff40; }
        .acct-id-divider { display: flex; align-items: center; gap: 8px; padding: 12px 0 6px; margin-top: 4px; }
        .acct-id-divider-label { font-size: 10px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
        .acct-id-divider-hint { font-size: 10px; color: var(--text-dim); opacity: 0.6; }
        .acct-id-detail { padding: 0 12px 12px; border-top: 1px solid var(--border); }
        .acct-id-auto-info { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; padding: 8px 10px; background: rgba(0,242,255,0.03); border-radius: 6px; border: 1px solid rgba(0,242,255,0.06); }
        .acct-id-auto-row { display: flex; align-items: center; gap: 8px; }
        .acct-id-auto-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); font-weight: 600; min-width: 70px; }
        .acct-id-auto-val { font-size: 10px; color: var(--text); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .acct-id-manual { margin-top: 8px; }
        .acct-id-manual-summary { font-size: 10px; color: var(--text-dim); cursor: pointer; padding: 4px 0; transition: color 0.15s; }
        .acct-id-manual-summary:hover { color: var(--accent); }
        .acct-id-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        .acct-id-field { display: flex; flex-direction: column; gap: 3px; }
        .acct-id-field label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); font-weight: 600; }
        .acct-id-blocks { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.03); }
        .acct-id-blocks-label { font-size: 9px; color: var(--text-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .acct-id-block-chip { font-size: 9px; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.04); color: var(--text-dim); text-transform: capitalize; }
      `}</style>
    </div>
  );
}
