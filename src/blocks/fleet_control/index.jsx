/**
 * Fleet Control — live ops for everything that runs: LLM engines, provider
 * health, key pools, the video autopilot, this machine's hardware fit, and
 * every agent with what it was last asked (Memory Core's GET /api/agents).
 * Read-only by design: it reports what exists and never calls what doesn't.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Radio, RefreshCw, Server, BarChart3, Wifi, WifiOff, KeyRound, HeartPulse, Rocket, Cpu, Bot, Star, Lock } from 'lucide-react';
import { AGENT_SELECT_EVENT } from '../../utils/terminalAgent.js';
import { serverStatus, providerRows, providerCard, hardwareSummary } from './health.js';

const TONE = { ok: '#00ff40', warn: '#ff9800', idle: '#888' };
const DOT = { healthy: '#00ff40', cooling: '#f44336', unconfigured: 'rgba(255,255,255,0.2)' };

export default function FleetControl() {
  const [llm, setLlm] = useState(null);
  const [autopilot, setAutopilot] = useState(null);
  const [health, setHealth] = useState(null);
  // Recent Agent Missions: every agent, most recently active first (Memory
  // Core's GET /api/agents). null = not loaded; a string = why it could not be.
  const [agents, setAgents] = useState(null);
  const [probe, setProbe] = useState(null); // { ok, status, uptime }
  const [hardware, setHardware] = useState(null);
  const [hardwareError, setHardwareError] = useState(null);
  // The connection registry (Settings block). Optional: it only adds
  // configured providers the kernel's health map has not seen fail yet.
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/llm-telemetry');
      if (r.ok) { const d = await r.json(); setLlm(d); setProbe({ ok: true, status: r.status, uptime: d.uptime }); }
      else setProbe({ ok: false, status: r.status });
    } catch { setProbe({ ok: false, status: 0 }); }
    try {
      const r = await fetch('/core/provider-health');
      if (r.ok) setHealth(await r.json());
    } catch {}
    try {
      const r = await fetch('/api/connections', { headers: { 'x-aeon-self-reported': '1' } });
      if (r.ok) { const d = await r.json(); setEndpoints(Array.isArray(d.endpoints) ? d.endpoints : []); }
    } catch {}
    try {
      const r = await fetch('/api/autopilot/status');
      setAutopilot(r.ok ? await r.json() : null);
    } catch { setAutopilot(null); }
    try {
      const r = await fetch('/api/agents', { headers: { 'x-aeon-self-reported': '1' } });
      const d = await r.json().catch(() => null);
      if (r.ok && d) setAgents(d.agents || []);
      else setAgents(r.status === 404 ? 'Agents live in Memory Core, which is not installed.' : (d?.error || `HTTP ${r.status}`));
    } catch {}
    setNow(Date.now());
    setLoading(false);
  }, []);

  // Hardware changes rarely; read it once per visit (and on the refresh button).
  const loadHardware = useCallback(async () => {
    try {
      const r = await fetch('/api/hwfit/models?limit=60', { headers: { 'x-aeon-self-reported': '1' } });
      if (!r.ok) { setHardwareError(`Hardware fit did not load (HTTP ${r.status})`); return; }
      setHardware(await r.json());
      setHardwareError(null);
    } catch { setHardwareError('The AEON server is not answering.'); }
  }, []);

  useEffect(() => { refresh(); loadHardware(); const i = setInterval(refresh, 8000); return () => clearInterval(i); }, [refresh, loadHardware]);

  // A click hands the agent to the Neural Terminal (it listens for this).
  const callAgent = (a) => {
    try { window.dispatchEvent(new CustomEvent(AGENT_SELECT_EVENT, { detail: { id: a.id, name: a.name, self: !!a.self } })); } catch { /* no window */ }
  };
  const ago = (iso) => {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
    const m = Math.round((now - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };

  const models = llm?.models || [];
  const totalCalls = llm?.totalCalls || 0;
  const totalTokens = llm?.totalTokens || 0;
  const totalErrors = models.reduce((n, m) => n + (m.errors || 0), 0);
  const rows = providerRows(health, now, endpoints);
  const provCard = providerCard(rows);
  const server = serverStatus(probe);
  const serverUp = !!probe?.ok;
  const hw = hardwareSummary(hardware);

  return (
    <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Radio size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Fleet Control</h2>
        <span style={{ fontSize: '10px', opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: '4px' }}>
          Live System Telemetry
        </span>
        <button onClick={() => { refresh(); loadHardware(); }} style={tinyBtn} aria-label="Refresh fleet telemetry"><RefreshCw size={12} aria-hidden="true" /></button>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim)', margin: '0 0 20px 0' }}>
        Engines, providers, key pools, the video autopilot, hardware fit and your agents — click an agent to talk to it in the terminal
      </p>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <StatusCard icon={serverUp ? Wifi : WifiOff} label="AEON Server" value={server.value} color={TONE[server.tone]} sub={server.sub} />
        <StatusCard icon={Activity} label="LLM Calls · since start" value={totalCalls.toLocaleString()} color="var(--accent)" sub={`${(totalTokens / 1000).toFixed(1)}K tokens${totalErrors ? ` · ${totalErrors} failed` : ''}`} />
        <StatusCard icon={HeartPulse} label="Providers" value={health ? provCard.value : '?'} color={TONE[health ? provCard.tone : 'idle']} sub={health ? provCard.sub : 'Provider health unavailable'} />
        <StatusCard icon={Server} label="Video Autopilot" value={autopilot?.status || '—'} color={autopilot?.producerRunning ? '#00ff40' : String(autopilot?.status || '').startsWith('ERROR') ? '#f44336' : '#888'} sub={autopilot ? `${autopilot.totalProduced || 0} produced · ${autopilot.totalUploaded || 0} uploaded` : 'Not answering'} />
      </div>

      {/* Provider Health + Key Pools */}
      <div style={cardStyle}>
        <div style={sectionTitle}><KeyRound size={14} style={{ color: 'var(--amber)' }} /> PROVIDER HEALTH & KEY POOLS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          {rows.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-mute)', opacity: p.state === 'unconfigured' ? 0.6 : 1 }}>
                <div role="img" aria-label={p.label} title={p.label} style={{ width: '8px', height: '8px', borderRadius: '50%', background: DOT[p.state], boxShadow: p.state === 'healthy' ? '0 0 6px #00ff40' : 'none', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>{p.id}</div>
                  <div style={{ fontSize: '9px', color: p.state === 'cooling' ? '#f44336' : 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{p.label}</div>
                  {p.detail && <div title={p.detail} style={{ fontSize: '9px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.detail}</div>}
                </div>
              </div>
          ))}
          {rows.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: 8 }}>{loading ? 'Loading…' : 'Provider health unavailable'}</div>}
        </div>
      </div>

      {/* LLM Engine Breakdown */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitle}>
          <BarChart3 size={14} style={{ color: '#8b5cf6' }} /> LLM ENGINES — SINCE SERVER START
          {totalCalls > 0 && <span style={{ fontSize: '10px', color: '#00ff40', marginLeft: 'auto' }}>LIVE</span>}
        </div>
        {models.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '18px', color: 'var(--text-dim)', fontSize: '12px' }}>
            {loading ? 'Loading telemetry...' : serverUp ? 'No LLM calls since the server started. Ask something in the terminal.' : server.sub}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {models.map(m => {
              const engineLabel = m.errors > 0 ? `${m.errors} error${m.errors === 1 ? '' : 's'}` : 'Healthy';
              return (
              <div key={m.engine + '/' + m.model} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
                <div role="img" aria-label={engineLabel} title={engineLabel} style={{ width: '8px', height: '8px', borderRadius: '50%', background: m.errors > 0 ? '#f44336' : '#00ff40', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{m.engine} · {m.avgLatency}ms avg{m.errors > 0 ? ` · ${engineLabel}` : ''}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{m.requests}</div>
                  <div style={{ fontSize: '9px', color: 'var(--text-dim)' }}>{(m.tokens / 1000).toFixed(1)}K tok</div>
                </div>
                <div style={{ width: '60px', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: '2px', background: m.engine === 'groq' ? 'var(--accent)' : m.engine === 'gemini' ? '#f59e0b' : '#4caf50', width: `${totalCalls ? Math.round(m.requests / totalCalls * 100) : 0}%` }} />
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* This machine — what the hardware can run (api/hwfit.cjs; cookbook uses the same routes) */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitle}><Cpu size={14} style={{ color: 'var(--accent)' }} /> THIS MACHINE — MODEL FIT</div>
        {hw ? (
          <div style={{ fontSize: '11px', display: 'grid', gap: '6px' }}>
            <div><strong>{hw.machine}</strong> · {hw.gpu}</div>
            <div style={{ color: 'var(--text-dim)' }}>
              Of {hw.catalog} catalogue models at Q4: {hw.fits.gpu} fit the GPU, {hw.fits.offload} need CPU offload, {hw.fits.cpu} run on CPU/RAM only, {hw.fits.tooLarge} do not fit.
            </div>
            {hw.best.length > 0 && <div style={{ color: 'var(--text-dim)' }}>Largest that fit: {hw.best.join(' · ')}</div>}
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{hardwareError || 'Reading hardware…'}</div>
        )}
      </div>

      {/* Recent Agent Missions — every agent the operator has, most recently
          active first. A click loads the agent into the Neural Terminal;
          /agent <name> does the same from the keyboard. */}
      <div style={{ ...cardStyle, marginTop: '12px', marginBottom: '24px' }}>
        <div style={sectionTitle}><Rocket size={14} style={{ color: 'var(--accent)' }} /> RECENT AGENT MISSIONS</div>
        {agents === null ? (
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Reading agents…</div>
        ) : typeof agents === 'string' ? (
          <div style={{ fontSize: '11px', color: '#ffaa00' }}>{agents}</div>
        ) : agents.map(a => (
          <button key={a.id} type="button" onClick={() => callAgent(a)}
            aria-label={`Talk to ${a.name} in the terminal`}
            title={`Talk to ${a.name} in the Neural Terminal`}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '8px 12px', marginBottom: '6px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', cursor: 'pointer', border: '1px solid var(--border-mute)', color: 'var(--text)', font: 'inherit' }}>
            {a.self ? <Star size={13} aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0 }} /> : <Bot size={13} aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}{a.self ? ' — your AEON' : ''}</span>
                {a.privacy === 'local-only' && <Lock size={10} aria-label="local only" style={{ color: '#3ecf8e', flexShrink: 0 }} />}
              </div>
              <div style={{ fontSize: '9.5px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.lastMission
                  ? `${ago(a.lastMission.at)} · "${a.lastMission.asked}"`
                  : (a.lastActiveAt ? `active ${ago(a.lastActiveAt)}` : 'no missions yet')}
                {' · '}{a.memoryCount ?? '?'} memories
                {a.model?.provider ? ` · ${a.model.model || a.model.provider}` : ''}
              </div>
            </div>
          </button>
        ))}
        {Array.isArray(agents) && agents.length < 2 && (
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px' }}>
            Create agents in Memory Core. Each gets its own memory under <code>Vault/Agents/&lt;name&gt;</code>, appears here, and answers to its name in the terminal.
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCard({ icon: Icon, label, value, color, sub }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: '16px', fontWeight: 800, fontFamily: 'var(--font-mono)', color }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

const cardStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: '10px', padding: '14px',
};

const sectionTitle = {
  fontSize: '12px', fontWeight: 700, marginBottom: '12px',
  display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)',
};

const tinyBtn = {
  background: 'none', border: 'none', color: 'var(--text-dim)',
  cursor: 'pointer', padding: '3px', borderRadius: '4px', display: 'flex',
  alignItems: 'center', gap: '3px', fontSize: '11px',
};
