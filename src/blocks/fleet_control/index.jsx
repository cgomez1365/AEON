/**
 * Fleet Control — live ops for everything that runs: LLM engines, provider
 * health, key pools, autopilot, and VP mission history (read from the Vault).
 * Read-only by design: it reports what exists and never calls what doesn't.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Radio, RefreshCw, Server, BarChart3, Wifi, WifiOff, KeyRound, HeartPulse, Rocket, ChevronDown } from 'lucide-react';

export default function FleetControl() {
  const [llm, setLlm] = useState(null);
  const [autopilot, setAutopilot] = useState(null);
  const [health, setHealth] = useState(null);
  const [missions, setMissions] = useState([]);
  const [openMission, setOpenMission] = useState(null); // { id, content }
  const [serverUp, setServerUp] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/llm-telemetry');
      if (r.ok) { setLlm(await r.json()); setServerUp(true); } else throw '';
    } catch { setServerUp(false); }
    try {
      const r = await fetch('/core/provider-health');
      if (r.ok) setHealth(await r.json());
    } catch {}
    try {
      const r = await fetch('/api/autopilot/status');
      if (r.ok) setAutopilot(await r.json());
    } catch {}
    try {
      const r = await fetch('/api/fleet/missions?limit=12');
      if (r.ok) { const d = await r.json(); setMissions(d.missions || []); }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const i = setInterval(refresh, 8000); return () => clearInterval(i); }, [refresh]);

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
  const providers = health?.providers || {};
  const keyPools = health?.keyPools || {};
  const healthyCount = Object.values(providers).filter(p => p.healthy).length;

  return (
    <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Radio size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Fleet Control</h2>
        <span style={{ fontSize: '10px', opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: '4px' }}>
          Live System Telemetry
        </span>
        <button onClick={refresh} style={tinyBtn} aria-label="Refresh fleet telemetry"><RefreshCw size={12} aria-hidden="true" /></button>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim)', margin: '0 0 20px 0' }}>
        Engines, providers, key pools, autopilot, and VP missions — the ops view of everything that runs
      </p>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <StatusCard icon={serverUp ? Wifi : WifiOff} label="AEON Server" value={serverUp ? 'ONLINE' : 'CLOUD MODE'} color={serverUp ? '#00ff40' : '#ff9800'} sub={serverUp ? `Uptime: ${llm?.uptime ? Math.floor(llm.uptime / 60) + 'm' : '?'}` : 'Supabase relay'} />
        <StatusCard icon={Activity} label="LLM Calls" value={totalCalls.toLocaleString()} color="var(--accent)" sub={`${(totalTokens / 1000).toFixed(1)}K tokens`} />
        <StatusCard icon={HeartPulse} label="Providers" value={`${healthyCount}/${Object.keys(providers).length || '?'}`} color={healthyCount === Object.keys(providers).length ? '#00ff40' : '#ff9800'} sub="healthy engines" />
        <StatusCard icon={Server} label="Autopilot" value={autopilot?.status || 'UNKNOWN'} color={autopilot?.producerRunning ? '#00ff40' : '#888'} sub={autopilot?.totalProduced ? `${autopilot.totalProduced} produced` : 'Idle'} />
      </div>

      {/* Provider Health + Key Pools */}
      <div style={cardStyle}>
        <div style={sectionTitle}><KeyRound size={14} style={{ color: 'var(--amber)' }} /> PROVIDER HEALTH & KEY POOLS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          {Object.entries(providers).map(([id, p]) => {
            const pool = keyPools[id];
            const healthLabel = p.healthy ? 'Healthy' : 'Unhealthy — cooling down';
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-mute)' }}>
                <div role="img" aria-label={healthLabel} title={healthLabel} style={{ width: '8px', height: '8px', borderRadius: '50%', background: p.healthy ? '#00ff40' : '#f44336', boxShadow: p.healthy ? '0 0 6px #00ff40' : 'none', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>{id}</div>
                  <div style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {healthLabel}{pool ? ` · ${pool.count} key${pool.count === 1 ? '' : 's'} · slot ${pool.activeIndex}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
          {Object.keys(providers).length === 0 && <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: 8 }}>{loading ? 'Loading…' : 'Provider health unavailable'}</div>}
        </div>
      </div>

      {/* LLM Engine Breakdown */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitle}>
          <BarChart3 size={14} style={{ color: '#8b5cf6' }} /> LLM ENGINE TELEMETRY
          {totalCalls > 0 && <span style={{ fontSize: '10px', color: '#00ff40', marginLeft: 'auto' }}>LIVE</span>}
        </div>
        {models.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '18px', color: 'var(--text-dim)', fontSize: '12px' }}>
            {loading ? 'Loading telemetry...' : 'No LLM calls recorded this session. Run a mission or use the terminal.'}
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

      {/* VP Missions (from the Vault — survives any block removal) */}
      <div style={{ ...cardStyle, marginTop: '12px', marginBottom: '24px' }}>
        <div style={sectionTitle}><Rocket size={14} style={{ color: 'var(--accent)' }} /> VP MISSIONS — RECENT</div>
        {missions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '18px', color: 'var(--text-dim)', fontSize: '12px' }}>
            No mission records in the Vault yet. Run one with /vp in the terminal.
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
