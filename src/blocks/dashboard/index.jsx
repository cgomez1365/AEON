import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { StatCard, Card } from '../../components/aurora';
import { Activity, Zap, Radio, BarChart3, Wifi, WifiOff, Server, Flame, Calendar, LayoutGrid } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useTelemetry } from '../../kernel/contexts/TelemetryContext';
import { BLOCKS, GROUP_META } from '../../kernel/blockRegistry.js';

import { SB_URL, SB_KEY } from '../../config.js';
const CHART_COLORS = ['#00f2ff', '#f59e0b', '#4caf50', '#8b5cf6', '#ec4899', '#ff6b6b', '#00ff40', '#ff9800'];
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function levelColor(count, max) {
  if (!count || !max) return 'rgba(255,255,255,0.03)';
  const r = count / max;
  if (r > 0.75) return 'var(--color-primary, #00f2ff)';
  if (r > 0.5) return 'rgba(0,242,255,0.6)';
  if (r > 0.25) return 'rgba(0,242,255,0.35)';
  return 'rgba(0,242,255,0.15)';
}

function fmt(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function timeAgo(iso) {
  const ms = iso ? Date.now() - new Date(iso).getTime() : NaN;
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Installed blocks, grouped exactly like the sidebar nav (same registry,
// same GROUP_META) — drop a block folder in and it appears here too.
// No hardcoded block list: this IS the block-standard registry.
const INSTALLED_BY_GROUP = (() => {
  const byGroup = {};
  for (const b of BLOCKS) {
    if (b.uiMode === 'headless') continue;
    (byGroup[b.group] ||= []).push(b);
  }
  return Object.entries(byGroup)
    .map(([id, items]) => ({ id, meta: GROUP_META[id] || { label: id.toUpperCase(), icon: '📦', order: 99 }, items }))
    .sort((a, b) => a.meta.order - b.meta.order);
})();

export default function Dashboard({ chatHistory = [], auditLogs = [] }) {
  const { apiUsage } = useTelemetry();
  const [autopilot, setAutopilot] = useState(null);
  const [serverUp, setServerUp] = useState(false);
  const [llmModels, setLlmModels] = useState([]);
  const [heatmapData, setHeatmapData] = useState(null);
  const [heatmapSummary, setHeatmapSummary] = useState(null);
  const [activityRange, setActivityRange] = useState('heatmap');
  const [activityBarRange, setActivityBarRange] = useState('30d');
  const [blockStates, setBlockStates] = useState({});

  // ── Live per-block state (Vault/blocks/*/state.json via vaultSync) ──
  const loadBlockStates = useCallback(async () => {
    try {
      const r = await fetch('/blocks/state');
      if (r.ok) setBlockStates(await r.json());
    } catch {}
  }, []);

  // ── Fleet + Heatmap data polling ──
  const loadFleetData = useCallback(async () => {
    // LLM telemetry
    try {
      const r = await fetch('/api/llm-telemetry');
      if (r.ok) { const d = await r.json(); setLlmModels(d.models || []); setServerUp(true); }
      else throw '';
    } catch { setServerUp(false); }

    // Autopilot
    try {
      const r = await fetch('/api/autopilot/status');
      if (r.ok) setAutopilot(await r.json());
    } catch {}

  }, []);

  const loadHeatmap = useCallback(async () => {
    try {
      const [hRes, sRes] = await Promise.all([
        fetch('/api/token-analytics/heatmap'), fetch('/api/token-analytics/summary'),
      ]);
      if (hRes.ok && sRes.ok) { setHeatmapData(await hRes.json()); setHeatmapSummary(await sRes.json()); return; }
    } catch {}
    try {
      const r = await fetch(`${SB_URL}/rest/v1/aeon_blocks?block_tag=eq.activity&select=payload`, { headers: sbH });
      const rows = await r.json();
      const data = rows?.[0]?.payload || {};
      const days = []; const end = new Date(); const start = new Date(end); start.setDate(start.getDate() - 364);
      const cursor = new Date(start); let maxR = 0, totalR = 0, totalT = 0, active = 0;
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        const e = data[key] || { requests: 0, tokens: 0 };
        days.push({ date: key, requests: e.requests, tokens: e.tokens, weekday: cursor.getDay() });
        if (e.requests > maxR) maxR = e.requests; totalR += e.requests; totalT += e.tokens; if (e.requests > 0) active++;
        cursor.setDate(cursor.getDate() + 1);
      }
      setHeatmapData({ days, maxRequests: maxR, totalRequests: totalR, totalTokens: totalT, activeDays: active });
      setHeatmapSummary({ totalRequests: totalR, totalTokens: totalT, activeDays: active, currentStreak: 0, longestStreak: 0 });
    } catch {}
  }, []);

  useEffect(() => { loadFleetData(); loadHeatmap(); loadBlockStates(); }, []);
  useEffect(() => { const i = setInterval(loadFleetData, 5000); return () => clearInterval(i); }, [loadFleetData]);
  useEffect(() => { const i = setInterval(loadBlockStates, 10000); return () => clearInterval(i); }, [loadBlockStates]);

  const totalCalls = apiUsage?.totalRequests || 0;
  const totalTokens = apiUsage?.totalTokens || 0;
  const currentCost = apiUsage?.totalCost || 0;
  const activeEngines = llmModels.filter(m => m.requests > 0).length;

  // Heatmap weeks
  const weeks = useMemo(() => {
    if (!heatmapData?.days) return [];
    const cols = []; let col = [];
    for (const d of heatmapData.days) {
      if (d.weekday === 0 && col.length > 0) { cols.push(col); col = []; }
      col.push(d);
    }
    if (col.length > 0) cols.push(col);
    return cols;
  }, [heatmapData]);

  const monthLabels = useMemo(() => {
    if (!heatmapData?.days) return [];
    const labels = []; let lastMonth = -1; let dayIdx = 0;
    for (const d of heatmapData.days) {
      const m = new Date(d.date + 'T00:00:00').getMonth();
      if (m !== lastMonth) { labels.push({ month: MONTHS[m], weekIdx: Math.floor(dayIdx / 7) }); lastMonth = m; }
      dayIdx++;
    }
    return labels;
  }, [heatmapData]);

  const hMax = heatmapData?.maxRequests || 1;

  return (
    <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>

      {/* ═══ TOP KPI ROW ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <StatCard label="API Spend" value={`$${(currentCost ?? 0).toFixed(4)}`} accent="amber" sub="$15 daily limit" icon={<Zap size={14} aria-hidden="true" />} />
        <StatCard label="LLM Engines" value={activeEngines || totalCalls > 0 ? activeEngines : '—'} accent="cyan" sub={`${totalCalls} calls | ${fmt(totalTokens)} tok`} icon={<Activity size={14} aria-hidden="true" />} />
        <StatCard label="Server" value={serverUp ? 'ONLINE' : 'CLOUD'} accent={serverUp ? 'emerald' : 'amber'} sub={serverUp ? 'Local kernel' : 'Supabase relay'} icon={serverUp ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />} />
        <StatCard label="Autopilot" value={autopilot?.status || '—'} accent={autopilot?.producerRunning ? 'emerald' : 'cyan'} sub={autopilot ? `${autopilot.totalProduced || 0} produced` : 'Unknown'} icon={<Server size={14} aria-hidden="true" />} />
      </div>

      {/* ═══ INSTALLED BLOCKS — auto-organized from the block registry ═══ */}
      <div style={{ marginBottom: '20px' }}>
        <Card hover={false}>
          <PanelHeader
            icon={<LayoutGrid size={14} style={{ color: '#00f2ff' }} aria-hidden="true" />}
            title={`INSTALLED BLOCKS (${INSTALLED_BY_GROUP.reduce((n, g) => n + g.items.length, 0)})`}
          />
          {INSTALLED_BY_GROUP.map(g => (
            <div key={g.id} style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', color: 'var(--text-dim)', marginBottom: '6px' }}>
                {g.meta.icon} {g.meta.label}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px' }}>
                {g.items.map(b => {
                  const live = blockStates[b.id];
                  const summary = live?.state?._summary;
                  return (
                    <Link key={b.id} to={b.route} style={{ textDecoration: 'none', color: 'inherit' }}>
                      <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '4px', height: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '13px' }} aria-hidden="true">{b.icon}</span>
                          <span style={{ fontSize: '11px', fontWeight: 700 }}>{b.label}</span>
                          <span aria-hidden="true" style={{ width: '5px', height: '5px', borderRadius: '50%', background: live ? '#00ff40' : 'rgba(255,255,255,0.15)', marginLeft: 'auto' }} />
                        </div>
                        <div style={{ fontSize: '9px', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                          {summary || (live ? 'Active — no summary reported' : 'Not reporting activity yet')}
                        </div>
                        {live?.lastSync && <div style={{ fontSize: '8px', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(live.lastSync)}</div>}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* ═══ FLEET: LLM ENGINE TELEMETRY ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px', marginBottom: '20px' }}>
        {/* LLM Engines */}
        <Card hover={false}>
          <PanelHeader icon={<BarChart3 size={14} style={{ color: '#8b5cf6' }} aria-hidden="true" />} title="LLM ENGINE TELEMETRY" live={totalCalls > 0} />
          {llmModels.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-dim)', fontSize: '11px' }}>
              {serverUp ? 'No calls this session' : 'Connect to the local kernel for live data'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '6px' }}>
              {llmModels.slice(0, 6).map(m => (
                <div key={m.engine + m.model} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(255,255,255,0.02)' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: m.errors > 0 ? '#f44336' : '#00ff40', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-dim)' }}>{m.engine} · {m.avgLatency}ms</div>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{m.requests}</div>
                  <div style={{ width: '50px', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: '2px', background: m.engine === 'groq' ? '#00f2ff' : m.engine === 'gemini' ? '#f59e0b' : '#4caf50', width: `${totalCalls ? Math.round(m.requests / totalCalls * 100) : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

      </div>

      {/* ═══ ANALYTICS — TABBED ═══ */}
      <div style={{ marginBottom: '20px' }}>
      <Card hover={false}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div role="group" aria-label="Analytics view" style={{ display: 'flex', gap: '4px' }}>
            {[
              { id: 'heatmap', label: 'Heatmap', icon: <Calendar size={12} aria-hidden="true" /> },
              { id: 'activity', label: 'Activity', icon: <BarChart3 size={12} aria-hidden="true" /> },
              { id: 'models', label: 'Models', icon: <Activity size={12} aria-hidden="true" /> },
            ].map(t => (
              <button key={t.id} onClick={() => setActivityRange(t.id)} aria-pressed={activityRange === t.id} style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '5px 12px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                border: activityRange === t.id ? '1px solid var(--color-primary)' : '1px solid var(--border, #2a2a2a)',
                background: activityRange === t.id ? 'rgba(0,242,255,0.08)' : 'transparent',
                color: activityRange === t.id ? 'var(--color-primary)' : 'var(--text-dim)',
              }}>{t.icon} {t.label}</button>
            ))}
          </div>
          {heatmapSummary && (
            <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>
              <Flame size={10} style={{ verticalAlign: '-2px' }} aria-hidden="true" /> {heatmapSummary.currentStreak || 0}d streak · {heatmapSummary.activeDays || 0} active · {fmt(heatmapSummary.totalTokens)} tok
            </span>
          )}
        </div>

        {/* ── TAB: Heatmap ── */}
        {activityRange === 'heatmap' && (
          weeks.length > 0 ? (
            <>
              <div style={{ display: 'flex', marginLeft: '28px', marginBottom: '2px', position: 'relative', height: '12px' }}>
                {monthLabels.map((ml, i) => <span key={i} style={{ position: 'absolute', left: `${ml.weekIdx * 13}px`, fontSize: '8px', color: 'var(--text-dim)' }}>{ml.month}</span>)}
              </div>
              <div style={{ display: 'flex' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginRight: '4px' }}>
                  {[0,1,2,3,4,5,6].map(d => (
                    <div key={d} style={{ height: '11px', width: '22px', fontSize: '7px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '2px' }}>
                      {d % 2 === 1 ? ['Su','Mo','Tu','We','Th','Fr','Sa'][d] : ''}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '1px' }}>
                  {weeks.map((week, wi) => (
                    <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                      {wi === 0 && week[0] && Array.from({ length: week[0].weekday }).map((_, i) => <div key={`p${i}`} style={{ width: '11px', height: '11px' }} />)}
                      {week.map(d => (
                        <div key={d.date} title={`${d.date}: ${d.requests} req, ${fmt(d.tokens)} tok`}
                          role="img" aria-label={`${d.date}: ${d.requests} requests, ${fmt(d.tokens)} tokens`}
                          style={{ width: '11px', height: '11px', borderRadius: '2px', background: levelColor(d.requests, hMax), cursor: 'pointer', transition: 'transform 0.1s' }}
                          onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.4)'}
                          onMouseLeave={e => e.currentTarget.style.transform = ''} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', marginLeft: '28px', fontSize: '8px', color: 'var(--text-dim)' }}>
                <span>Less</span>
                {[0, 0.15, 0.35, 0.6, 1].map((r, i) => <div key={i} aria-hidden="true" style={{ width: '11px', height: '11px', borderRadius: '2px', background: r === 0 ? 'rgba(255,255,255,0.03)' : `rgba(0,242,255,${r})` }} />)}
                <span>More</span>
              </div>
            </>
          ) : <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-dim)', fontSize: '11px' }}>Loading heatmap...</div>
        )}

        {/* ── TAB: Activity Charts ── */}
        {activityRange === 'activity' && heatmapData?.days && (() => {
          const days = heatmapData.days || [];
          const len = activityBarRange === '7d' ? 7 : activityBarRange === '90d' ? 90 : 30;
          const slice = days.slice(-len).map(d => ({ ...d, date: d.date.slice(5), tok: Math.round(d.tokens / 1000) }));
          const totalR = slice.reduce((s, d) => s + d.requests, 0);
          const totalT = slice.reduce((s, d) => s + d.tokens, 0);
          return (
            <div>
              <div role="group" aria-label="Activity chart range" style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
                {['7d', '30d', '90d'].map(r => (
                  <button key={r} onClick={() => setActivityBarRange(r)} aria-pressed={activityBarRange === r} style={{
                    padding: '3px 10px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, cursor: 'pointer',
                    border: activityBarRange === r ? '1px solid var(--color-primary)' : '1px solid var(--border)', background: activityBarRange === r ? 'rgba(0,242,255,0.08)' : 'transparent', color: activityBarRange === r ? 'var(--color-primary)' : 'var(--text-dim)',
                  }}>{r}</button>
                ))}
                <span style={{ fontSize: '11px', marginLeft: '12px' }}>
                  <strong style={{ color: 'var(--color-primary)' }}>{totalR}</strong> requests · <strong style={{ color: '#8b5cf6' }}>{fmt(totalT)}</strong> tokens · <strong>{slice.filter(d => d.requests > 0).length}</strong> active days
                </span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={slice} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00f2ff" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#00f2ff" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="tokGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#666' }} interval={len <= 7 ? 0 : len <= 30 ? 4 : 14} />
                  <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                  <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '6px', fontSize: '11px' }} />
                  <Area type="monotone" dataKey="requests" stroke="#00f2ff" fill="url(#reqGrad)" strokeWidth={2} name="Requests" />
                  <Area type="monotone" dataKey="tok" stroke="#8b5cf6" fill="url(#tokGrad)" strokeWidth={1.5} name="Tokens (K)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {/* ── TAB: Models (Recharts pie + bar) ── */}
        {activityRange === 'models' && (() => {
          const fallbackModels = Object.entries(apiUsage?.staffUsage || {})
            .filter(([_, v]) => v.requests > 0)
            .map(([k, v]) => ({
              model: k,
              engine: 'historical',
              requests: v.requests,
              tokens: v.tokens,
              avgLatency: 0
            }))
            .sort((a, b) => b.requests - a.requests);
            
          const displayModels = llmModels.length > 0 ? llmModels : fallbackModels;

          if (displayModels.length === 0) {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '200px', color: '#5a6a80', gap: '8px' }}>
                <span style={{ fontSize: '28px' }} aria-hidden="true">📡</span>
                <span style={{ fontSize: '13px' }}>No AI calls yet</span>
                <span style={{ fontSize: '11px' }}>Ask something in the terminal and your model usage will appear here.</span>
              </div>
            );
          }

          const pieData = displayModels.slice(0, 8).map((m, i) => ({
            name: m.model.split('/').pop().slice(0, 20),
            value: m.requests,
            tokens: m.tokens,
            engine: m.engine,
            avgMs: m.avgLatency,
            color: CHART_COLORS[i % CHART_COLORS.length],
          }));
          const barData = displayModels.slice(0, 8).map((m, i) => ({
            name: m.model.split('/').pop().slice(0, 12),
            requests: m.requests,
            tokens: Math.round(m.tokens / 1000),
            color: CHART_COLORS[i % CHART_COLORS.length],
          }));
          return (
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '20px', minHeight: '200px' }}>
              {/* Pie Chart */}
              <div style={{ position: 'relative' }}>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="value"
                      stroke="none" animationBegin={0} animationDuration={800}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '6px', fontSize: '11px' }}
                      formatter={(val, name, props) => [`${val} calls · ${fmt(props.payload.tokens)} tok · ${props.payload.avgMs}ms`, props.payload.name]} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{totalCalls}</div>
                  <div style={{ fontSize: '8px', color: 'var(--text-dim)', letterSpacing: '1px' }}>CALLS</div>
                </div>
              </div>

              {/* Bar Chart + Legend */}
              <div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={barData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#666' }} interval={0} angle={-20} textAnchor="end" height={35} />
                    <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                    <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '6px', fontSize: '11px' }} />
                    <Bar dataKey="requests" name="Requests" radius={[3, 3, 0, 0]}>
                      {barData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                {/* Legend */}
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' }}>
                  {pieData.map(d => (
                    <span key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', color: 'var(--text-dim)' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: d.color, display: 'inline-block' }} />
                      {d.name} ({d.engine})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </Card>
      </div>

      {/* ═══ AUDIT FEED ═══ */}
      <Card hover={false}>
        <PanelHeader icon={<Radio size={14} style={{ color: '#00ff40' }} aria-hidden="true" />} title="LIVE ACTIVITY FEED" live />
        <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
          {auditLogs.slice(-12).reverse().map(log => (
            <div key={log.id} style={{ display: 'flex', gap: '8px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: '10px' }}>
              <span style={{ color: 'var(--color-primary)', fontWeight: 700, minWidth: '70px' }}>{log.agent || 'System'}</span>
              <span style={{ color: 'var(--text-dim)', flex: 1 }}>{log.details || log.action}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: '9px', opacity: 0.5 }}>{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''}</span>
            </div>
          ))}
          {auditLogs.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '11px', textAlign: 'center', padding: '16px' }}>No activity yet</div>}
        </div>
      </Card>
    </div>
  );
}

// ── Shared Components ──
function PanelHeader({ icon, title, live, liveLabel }) {
  return (
    <div style={{ fontSize: '10px', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)', letterSpacing: '0.5px' }}>
      {icon} {title}
      {live && <span style={{ fontSize: '9px', color: '#00ff40', marginLeft: 'auto' }}>{liveLabel || 'LIVE'}</span>}
    </div>
  );
}

