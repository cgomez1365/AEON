/**
 * Fleet Control — live ops for everything that runs: LLM engines, provider
 * health, key pools, the video autopilot, this machine's hardware fit, and VP
 * mission history (read from the Vault).
 * Read-only by design: it reports what exists and never calls what doesn't.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Radio, RefreshCw, Server, BarChart3, Wifi, WifiOff, KeyRound, HeartPulse, Rocket, ChevronDown, Cpu } from 'lucide-react';
import { serverStatus, providerRows, providerCard, hardwareSummary } from './health.js';

const TONE = { ok: '#00ff40', warn: '#ff9800', idle: '#888' };
const DOT = { healthy: '#00ff40', cooling: '#f44336', unconfigured: 'rgba(255,255,255,0.2)' };

export default function FleetControl() {
  const [llm, setLlm] = useState(null);
  const [autopilot, setAutopilot] = useState(null);
  const [health, setHealth] = useState(null);
  const [missions, setMissions] = useState([]);
  const [openMission, setOpenMission] = useState(null); // { id, content }
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
      const r = await fetch('/api/fleet/missions?limit=12');
      if (r.ok) { const d = await r.json(); setMissions(d.missions || []); }
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

  const toggleMission = async (id) => {
    if (openMission?.id === id) { setOpenMission(null); return; }
    try {
      const r = await fetch(`/api/fleet/mission/${id}`);
      const d = await r.json();
      setOpenMission({ id, content: d.content || d.error || '(empty)' });
    } catch (e) { setOpenMission({ id, content: `Failed to load: ${e.message}` }); }
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
        Engines, providers, key pools, the video autopilot, hardware fit and VP missions — read-only; nothing here starts or stops anything
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

      {/* VP Missions (from the Vault — survives any block removal) */}
      <div style={{ ...cardStyle, marginTop: '12px', marginBottom: '24px' }}>
        <div style={sectionTitle}><Rocket size={14} style={{ color: 'var(--accent)' }} /> VP MISSIONS — RECENT</div>
        {missions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '18px', color: 'var(--text-dim)', fontSize: '12px' }}>
            No mission records. This panel lists the <code>*.md</code> files in <code>Vault/Agents/Aeon/missions</code>;
            nothing in this install writes them today (the Mission Runner that did was retired).
          </div>
        ) : missions.map(m => {
          const statusLabel = m.status === 'failed' ? 'Failed' : m.status === 'pending' ? 'Pending' : 'Done';
          const expanded = openMission?.id === m.id;
          return (
          <div key={m.id} style={{ marginBottom: '6px' }}>
            <div
              onClick={() => toggleMission(m.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMission(m.id); } }}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={`Mission: ${m.title}, status ${statusLabel}`}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', cursor: 'pointer', border: '1px solid var(--border-mute)' }}>
              <div role="img" aria-label={statusLabel} title={statusLabel} style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: m.status === 'failed' ? '#f44336' : m.status === 'pending' ? '#ff9800' : '#00ff40' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(m.modified).toLocaleString()} · {m.done} done{m.pending ? ` · ${m.pending} pending` : ''}{m.failed ? ` · ${m.failed} failed` : ''}
                </div>
              </div>
              <ChevronDown size={13} aria-hidden="true" style={{ color: 'var(--text-dim)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            </div>
            {expanded && (
              <pre style={{ margin: '4px 0 0 18px', padding: '12px', borderRadius: '6px', maxHeight: '280px', overflow: 'auto', background: 'var(--surface-1)', border: '1px solid var(--border-mute)', fontSize: '10.5px', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', color: 'var(--text)', lineHeight: 1.55 }}>{openMission.content.slice(0, 20000)}</pre>
            )}
          </div>
          );
        })}
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
