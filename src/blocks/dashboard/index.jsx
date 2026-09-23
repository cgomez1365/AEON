import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { StatCard, Card } from '../../components/aurora';
import { Activity, Zap, Radio, BarChart3, Wifi, WifiOff, Server, Flame, Calendar, LayoutGrid, Plus, Trash2, Pencil } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { getEffectiveBlockGroups } from '../../kernel/blockRegistry.js';
import { BlockIcon, SectionIcon } from '../../components/BlockIcon.jsx';
import BlockCustomizeModal from '../../components/BlockCustomizeModal.jsx';
import { serverCard, spendCard, callsCard, analyticsProblem, failureLine } from './kpis.js';

import { SB_URL, SB_KEY } from '../../config.js';
const CHART_COLORS = ['#00f2ff', '#f59e0b', '#4caf50', '#8b5cf6', '#ec4899', '#ff6b6b', '#00ff40', '#ff9800'];
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
// Analytics refresh — the ledger-derived numbers on this page (spend, calls
// today, heatmap, models, failures) were loaded once on mount and went stale.
const ANALYTICS_POLL_MS = 30000;

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

export default function Dashboard({ chatHistory = [], auditLogs = [], blockLayout, onBlockLayoutChange, iconOverrides = {}, onIconChanged }) {
  // Icon customization lives HERE and only here — the Home dashboard is the
  // one place a block's icon can be changed. Saving refreshes the shell's
  // icon map, so the sidebar and every other consumer update at once.
  const [iconTarget, setIconTarget] = useState(null); // the block being edited
  const [autopilot, setAutopilot] = useState(null);
  // { ok, status, uptime } from /api/llm-telemetry; status 0 = no answer.
  const [probe, setProbe] = useState(null);
  const serverUp = !!probe?.ok;
  const [llmModels, setLlmModels] = useState([]);
  const [heatmapData, setHeatmapData] = useState(null);
  const [heatmapSummary, setHeatmapSummary] = useState(null);
  // undefined = loading; a number = the HTTP status that stopped analytics
  // (0 = no answer). The activity block owns every analytics route.
  const [analyticsStatus, setAnalyticsStatus] = useState(undefined);
  const [failures, setFailures] = useState([]);
  const [activityRange, setActivityRange] = useState('heatmap');
  const [activityBarRange, setActivityBarRange] = useState('30d');
  const [blockStates, setBlockStates] = useState({});
  const [dragBlockId, setDragBlockId] = useState(null);
  const [dragOverGroup, setDragOverGroup] = useState(null);

  // ── Live per-block state (Vault/blocks/*/state.json via vaultSync) ──
  const loadBlockStates = useCallback(async () => {
    try {
      const r = await fetch('/blocks/state');
      if (r.ok) setBlockStates(await r.json());
    } catch {}
  }, []);

  // Block layout (reclassification/renames/custom sections) is owned by the
  // parent layout (DesktopLayout/MobileLayout) and passed down as a prop —
  // it's the SAME state the sidebar reads, so dragging a block here updates
  // the sidebar instantly instead of only on next reload. Lives in Settings
  // (settings.blockLayout) on the backend, same override pattern the
  // Settings block already uses for blockConfig.
  const layout = blockLayout || { overrides: {}, customGroups: {}, groupOverrides: {} };
  const saveLayout = onBlockLayoutChange || (() => {});

  // Manifest-default groups + the operator's own overrides/custom sections/
  // renames, merged — the exact same computation the sidebar nav uses
  // (getEffectiveBlockGroups), so the two can never disagree.
  const UNSORTED_ID = 'unsorted';
  const effectiveGroups = useMemo(() => getEffectiveBlockGroups(layout), [layout]);

  const addSection = useCallback(() => {
    const name = window.prompt('New section name (e.g. "Payroll")');
    if (!name || !name.trim()) return;
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const gid = 'custom_' + (base || Date.now());
    saveLayout({ ...layout, customGroups: { ...layout.customGroups, [gid]: { label: name.trim(), icon: 'custom', order: 50 } } });
  }, [layout, saveLayout]);

  const renameSection = useCallback((group) => {
    const name = window.prompt(`Rename "${group.meta.label}" to:`, group.meta.label);
    if (!name || !name.trim() || name.trim() === group.meta.label) return;
    saveLayout({ ...layout, groupOverrides: { ...layout.groupOverrides, [group.id]: { ...(layout.groupOverrides?.[group.id]), label: name.trim() } } });
  }, [layout, saveLayout]);

  const deleteSection = useCallback((group) => {
    if (group.custom) {
      if (!window.confirm(`Delete "${group.meta.label}"? Its blocks move back to their default section.`)) return;
      const overrides = { ...layout.overrides };
      for (const b of group.items) delete overrides[b.id];
      const customGroups = { ...layout.customGroups };
      delete customGroups[group.id];
      const groupOverrides = { ...layout.groupOverrides };
      delete groupOverrides[group.id];
      saveLayout({ overrides, customGroups, groupOverrides });
      return;
    }
    // A default (manifest-driven) section can't just "fall back" further —
    // hide it and send its blocks (this one's and any future one sharing
    // this manifest group) to Unsorted instead.
    if (!window.confirm(`Delete "${group.meta.label}"? Its blocks move to Unsorted — this section will reappear if a new block installs into it later.`)) return;
    saveLayout({ ...layout, groupOverrides: { ...layout.groupOverrides, [group.id]: { ...(layout.groupOverrides?.[group.id]), hidden: true } } });
  }, [layout, saveLayout]);

  // Reads the dragged block's id from the native DataTransfer payload, not
  // React state — state set in onDragStart isn't guaranteed to have flushed
  // into this closure by the time drop fires (drag gestures span multiple
  // event-loop ticks outside React's control).
  const dropOnGroup = useCallback((blockId, groupId) => {
    if (!blockId) return;
    saveLayout({ ...layout, overrides: { ...layout.overrides, [blockId]: groupId } });
    setDragBlockId(null);
    setDragOverGroup(null);
  }, [layout, saveLayout]);

  // ── Fleet + Heatmap data polling ──
  const loadFleetData = useCallback(async () => {
    // LLM telemetry — the kernel's in-memory counters since server start.
    try {
      const r = await fetch('/api/llm-telemetry');
      if (r.ok) {
        const d = await r.json();
        setLlmModels(d.models || []);
        setProbe({ ok: true, status: r.status, uptime: d.uptime });
      } else setProbe({ ok: false, status: r.status });
    } catch { setProbe({ ok: false, status: 0 }); }

    // Video autopilot (tools/autopilot-daemon.cjs, mounted by the kernel)
    try {
      const r = await fetch('/api/autopilot/status');
      setAutopilot(r.ok ? await r.json() : null);
    } catch { setAutopilot(null); }

  }, []);

  // Everything below the KPI row that counts calls reads the activity block's
  // ledger-derived routes, so the cards, heatmap, charts and failure list
  // agree with each other and with <db>/llm_calls.jsonl.
  const loadHeatmap = useCallback(async () => {
    let status = 0;
    try {
      // Self-reported: this page renders its own sentence for every failure
      // (AnalyticsState / the KPI subs), so the global [API FAILED] banner
      // would be a second, vaguer copy of it (src/utils/interceptorPolicy.js).
      const own = { headers: { 'x-aeon-self-reported': '1' } };
      const [hRes, sRes, fRes] = await Promise.all([
        fetch('/api/token-analytics/heatmap', own),
        fetch('/api/token-analytics/summary', own),
        fetch('/api/token-analytics/calls?failed=1&limit=5', own),
      ]);
      if (hRes.ok && sRes.ok) {
        setHeatmapData(await hRes.json());
        setHeatmapSummary(await sRes.json());
        if (fRes.ok) { const f = await fRes.json(); setFailures(f.calls || []); }
        setAnalyticsStatus(200);
        return;
      }
      status = hRes.ok ? sRes.status : hRes.status;
    } catch { status = 0; }
    // Supabase mirror — only when this build is configured for one. It used
    // to run unconditionally: with no VITE_SUPABASE_URL it fetched
    // "undefined/rest/v1/…", got the SPA's HTML, threw, and left the heatmap
    // on "Loading heatmap..." forever.
    if (SB_URL) {
      try {
        const r = await fetch(`${SB_URL}/rest/v1/aeon_blocks?block_tag=eq.activity&select=payload`, { headers: sbH });
        const rows = await r.json();
        const data = rows?.[0]?.payload || {};
        const days = []; const now = new Date(); let maxR = 0, totalR = 0, totalT = 0, active = 0;
        for (let i = 364; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const e = data[key] || { requests: 0, tokens: 0 };
          days.push({ date: key, requests: e.requests, tokens: e.tokens, weekday: d.getDay() });
          if (e.requests > maxR) maxR = e.requests; totalR += e.requests; totalT += e.tokens; if (e.requests > 0) active++;
        }
        setHeatmapData({ days, maxRequests: maxR, totalRequests: totalR, totalTokens: totalT, activeDays: active });
        setAnalyticsStatus(200);
        return;
      } catch {}
    }
    setAnalyticsStatus(status);
  }, []);

  useEffect(() => { loadFleetData(); loadHeatmap(); loadBlockStates(); }, []);
  useEffect(() => { const i = setInterval(loadFleetData, 5000); return () => clearInterval(i); }, [loadFleetData]);
  useEffect(() => { const i = setInterval(loadHeatmap, ANALYTICS_POLL_MS); return () => clearInterval(i); }, [loadHeatmap]);
  useEffect(() => { const i = setInterval(loadBlockStates, 10000); return () => clearInterval(i); }, [loadBlockStates]);

  // The kernel's live counters: every engine/model pair called since the
  // server started (they reset on restart). Labelled as exactly that below —
  // this used to be commented "engines reachable right now" and shown as the
  // "LLM Engines" KPI, which it never measured.
  const sessionCalls = llmModels.reduce((n, m) => n + (m.requests || 0), 0);
  const analyticsDown = analyticsStatus !== undefined && analyticsStatus !== 200;
  const spend = spendCard(heatmapSummary, analyticsDown ? analyticsStatus : undefined);
  const callsToday = callsCard(heatmapSummary, analyticsDown ? analyticsStatus : undefined);
  const server = serverCard(probe);
  // All-time model mix from the ledger (the same records as the heatmap).
  const ledgerModels = (heatmapSummary?.modelBreakdown || []).filter(m => m.requests > 0);
  const ledgerCalls = ledgerModels.reduce((n, m) => n + m.requests, 0);

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
        <StatCard label="Spend today" value={spend.value} accent="amber" sub={spend.sub} icon={<Zap size={14} aria-hidden="true" />} />
        <StatCard label="LLM calls today" value={callsToday.value} accent={heatmapSummary?.today?.errors ? 'coral' : 'cyan'} sub={callsToday.sub} icon={<Activity size={14} aria-hidden="true" />} />
        <StatCard label="Server" value={server.value} accent={server.accent} sub={server.sub} icon={serverUp ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />} />
        <StatCard label="Video autopilot" value={autopilot?.status || '—'} accent={autopilot?.producerRunning ? 'emerald' : 'cyan'} sub={autopilot ? `${autopilot.totalProduced || 0} produced · ${autopilot.totalUploaded || 0} uploaded` : 'Not answering'} icon={<Server size={14} aria-hidden="true" />} />
      </div>

      {/* ═══ INSTALLED BLOCKS — auto-organized from the block registry ═══ */}
      <div style={{ marginBottom: '20px' }}>
        <Card hover={false}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <PanelHeader
              icon={<LayoutGrid size={14} style={{ color: '#00f2ff' }} aria-hidden="true" />}
              title={`INSTALLED BLOCKS (${effectiveGroups.reduce((n, g) => n + g.items.length, 0)})`}
            />
            <button onClick={addSection} style={{
              display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '6px',
              fontSize: '9px', fontWeight: 700, cursor: 'pointer', border: '1px solid var(--border, #2a2a2a)',
              background: 'transparent', color: 'var(--text-dim)',
            }}>
              <Plus size={11} aria-hidden="true" /> NEW SECTION
            </button>
          </div>
          <div style={{ fontSize: '9px', color: 'var(--text-dim)', marginBottom: '10px' }}>
            Drag a block onto a different section to reclassify it.
          </div>
          {effectiveGroups.map(g => (
            <div
              key={g.id}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDragEnter={() => setDragOverGroup(g.id)}
              onDragLeave={() => setDragOverGroup(cur => (cur === g.id ? null : cur))}
              onDrop={(e) => { e.preventDefault(); dropOnGroup(e.dataTransfer.getData('text/plain') || dragBlockId, g.id); }}
              style={{
                marginBottom: '14px', padding: '6px', borderRadius: '8px',
                border: dragOverGroup === g.id ? '1px dashed var(--color-primary, #00f2ff)' : '1px solid transparent',
                background: dragOverGroup === g.id ? 'rgba(0,242,255,0.04)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px' }}>
                <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-dim)' }}>
                  <SectionIcon id={g.custom ? (g.meta.icon || 'custom') : g.id} size={11} />
                </span>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', color: 'var(--text-dim)' }}>
                  {g.meta.label}{g.items.length === 0 ? ' (empty — drop a block here)' : ''}
                </span>
                {g.id !== UNSORTED_ID && (
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <button onClick={() => renameSection(g)} aria-label={`Rename ${g.meta.label} section`} title="Rename section" style={{
                      display: 'flex', alignItems: 'center', padding: '2px',
                      background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
                    }}>
                      <Pencil size={11} aria-hidden="true" />
                    </button>
                    <button onClick={() => deleteSection(g)} aria-label={`Delete ${g.meta.label} section`} title="Delete section" style={{
                      display: 'flex', alignItems: 'center', padding: '2px',
                      background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
                    }}>
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px', minHeight: g.items.length === 0 ? '36px' : 0 }}>
                {g.items.map(b => {
                  const live = blockStates[b.id];
                  const summary = live?.state?._summary;
                  // Live icon wins over the build-time manifest snapshot.
                  const iconAsset = iconOverrides[b.id] || b.iconAsset;
                  return (
                    <div key={b.id} style={{ position: 'relative' }}
                      onMouseEnter={e => { const btn = e.currentTarget.querySelector('.block-pencil'); if (btn) btn.style.opacity = '1'; }}
                      onMouseLeave={e => { const btn = e.currentTarget.querySelector('.block-pencil'); if (btn) btn.style.opacity = '0'; }}
                    >
                      <Link
                        to={b.route} style={{ textDecoration: 'none', color: 'inherit' }}
                        draggable
                        onDragStart={(e) => { setDragBlockId(b.id); e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move'; }}
                        onDragEnd={() => { setDragBlockId(null); setDragOverGroup(null); }}
                        onClick={(e) => { if (dragBlockId) e.preventDefault(); }}
                      >
                        <div style={{
                          padding: '8px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)',
                          border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '4px',
                          height: '100%', cursor: 'grab', opacity: dragBlockId === b.id ? 0.4 : 1,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <BlockIcon
                              iconAsset={iconAsset}
                              iconAssetPng={b.iconAssetPng}
                              fallback={b.icon}
                              size={20}
                            />
                            <span style={{ fontSize: '11px', fontWeight: 700 }}>{b.label}</span>
                            <span aria-hidden="true" style={{ width: '5px', height: '5px', borderRadius: '50%', background: live ? '#00ff40' : 'rgba(255,255,255,0.15)', marginLeft: 'auto' }} />
                          </div>
                          <div style={{ fontSize: '9px', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                            {summary || (live ? 'Active — no summary reported' : 'Not reporting activity yet')}
                          </div>
                          {live?.lastSync && <div style={{ fontSize: '8px', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(live.lastSync)}</div>}
                        </div>
                      </Link>
                      {/* Block-declared: only cartridges that allow it get a pencil. */}
                      {b.iconEditable && (
                        <button
                          className="block-pencil"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIconTarget({ ...b, iconAsset }); }}
                          title={`Change ${b.label} icon`}
                          aria-label={`Change ${b.label} icon`}
                          style={{
                            position: 'absolute', top: 6, right: 6, opacity: 0, transition: 'opacity 0.15s',
                            background: 'rgba(0,242,255,0.08)', border: '1px solid rgba(0,242,255,0.2)',
                            borderRadius: 4, padding: '3px', cursor: 'pointer', color: 'var(--color-primary, #00f2ff)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, zIndex: 2,
                          }}
                        >
                          <Pencil size={10} aria-hidden="true" />
                        </button>
                      )}
                    </div>
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
          <PanelHeader icon={<BarChart3 size={14} style={{ color: '#8b5cf6' }} aria-hidden="true" />} title="LLM ENGINES — SINCE SERVER START" live={sessionCalls > 0} />
          {llmModels.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-dim)', fontSize: '11px' }}>
              {serverUp ? 'No LLM calls since the server started' : server.sub}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '6px' }}>
              {llmModels.slice(0, 6).map(m => (
                <div key={m.engine + m.model} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(255,255,255,0.02)' }}>
                  <div role="img" aria-label={m.errors > 0 ? `${m.errors} failed` : 'No failures'} style={{ width: '6px', height: '6px', borderRadius: '50%', background: m.errors > 0 ? '#f44336' : '#00ff40', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-dim)' }}>{m.engine} · {m.avgLatency}ms avg{m.errors > 0 ? ` · ${m.errors} failed` : ''}</div>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{m.requests}</div>
                  <div style={{ width: '50px', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: '2px', background: m.engine === 'groq' ? '#00f2ff' : m.engine === 'gemini' ? '#f59e0b' : '#4caf50', width: `${sessionCalls ? Math.round(m.requests / sessionCalls * 100) : 0}%` }} />
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
          ) : <AnalyticsState status={analyticsStatus} what="heatmap" />
        )}

        {activityRange !== 'heatmap' && !heatmapData?.days && <AnalyticsState status={analyticsStatus} what="analytics" />}

        {/* ── TAB: Activity Charts ── */}
        {activityRange === 'activity' && heatmapData?.days && (() => {
          const days = heatmapData.days || [];
          const len = activityBarRange === '7d' ? 7 : activityBarRange === '90d' ? 90 : 30;
          // The last N calendar days, today included — the heatmap route
          // always ends today now (it dropped today between 02:00 and 02:59
          // local after a spring-forward, and this chart sliced the same array).
          const slice = days.slice(-len).map(d => ({ ...d, date: d.date.slice(5), tok: Math.round(d.tokens / 1000) }));
          const totalR = slice.reduce((s, d) => s + d.requests, 0);
          const totalT = slice.reduce((s, d) => s + d.tokens, 0);
          const totalE = slice.reduce((s, d) => s + (d.errors || 0), 0);
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
                  <strong style={{ color: 'var(--color-primary)' }}>{totalR}</strong> requests{totalE ? <> (<strong style={{ color: '#f44336' }}>{totalE}</strong> failed)</> : null} · <strong style={{ color: '#8b5cf6' }}>{fmt(totalT)}</strong> tokens · <strong>{slice.filter(d => d.requests > 0).length}</strong> active days
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
        {activityRange === 'models' && heatmapSummary && (() => {
          // All-time model mix from the call ledger — the same records as the
          // heatmap and the cards. This mixed two sources before: the
          // since-restart counters when they had data, else /api/telemetry's
          // chat-log guesses (150 tokens per message), with the centre count
          // taken from a third.
          const displayModels = ledgerModels.map(m => ({
            model: m.name, engine: m.provider || 'unknown', requests: m.requests,
            tokens: m.tokens, errors: m.errors || 0, avgLatency: m.avgLatency,
          }));

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
            errors: m.errors,
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
                      formatter={(val, name, props) => [`${val} calls${props.payload.errors ? ` (${props.payload.errors} failed)` : ''} · ${fmt(props.payload.tokens)} tok${props.payload.avgMs != null ? ` · ${props.payload.avgMs}ms avg` : ''}`, props.payload.name]} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{ledgerCalls}</div>
                  <div style={{ fontSize: '8px', color: 'var(--text-dim)', letterSpacing: '1px' }}>CALLS · ALL TIME</div>
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
        <PanelHeader icon={<Radio size={14} style={{ color: '#00ff40' }} aria-hidden="true" />} title="LIVE ACTIVITY FEED" live={!analyticsDown} />
        {/* Failed calls, with the reason. The audit line for a failure only
            says "FAILED" (and status 500 whatever the provider answered); the
            ledger keeps the HTTP status and the error text. */}
        {failures.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', color: '#f44336', marginBottom: '4px' }}>RECENT FAILED CALLS</div>
            {failures.map((c, i) => {
              const l = failureLine(c);
              return (
                <div key={`${c.ts}-${i}`} style={{ display: 'flex', gap: '8px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: '10px' }}>
                  <span style={{ color: '#f44336', fontWeight: 700, minWidth: '70px' }}>{l.code}</span>
                  <span style={{ color: 'var(--text-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${l.who}: ${l.why}`}>
                    <strong style={{ color: 'var(--text)' }}>{l.who}</strong>{l.why ? ` — ${l.why}` : ''}
                  </span>
                  <span style={{ color: 'var(--text-dim)', fontSize: '9px', opacity: 0.5 }}>{l.ago}</span>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
          {auditLogs.slice(-12).reverse().map(log => (
            <div key={log.id} style={{ display: 'flex', gap: '8px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: '10px' }}>
              <span style={{ color: 'var(--color-primary)', fontWeight: 700, minWidth: '70px' }}>{log.agent || 'System'}</span>
              <span style={{ color: 'var(--text-dim)', flex: 1 }}>{log.details || log.action}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: '9px', opacity: 0.5 }}>{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''}</span>
            </div>
          ))}
          {auditLogs.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: '11px', textAlign: 'center', padding: '16px' }}>
              {analyticsStatus === 404
                ? 'The live feed is served by the Activity block, which is not installed.'
                : 'No activity yet'}
            </div>
          )}
        </div>
      </Card>

      {iconTarget && (
        <BlockCustomizeModal
          blockId={iconTarget.id}
          blockLabel={iconTarget.label}
          currentIconAsset={iconTarget.iconAsset}
          onSave={() => { setIconTarget(null); onIconChanged?.(); }}
          onClose={() => setIconTarget(null)}
        />
      )}
    </div>
  );
}

// ── Shared Components ──

// Loading, or the reason analytics did not load — never "Loading…" forever.
function AnalyticsState({ status, what }) {
  const loading = status === undefined || status === 200;
  return (
    <div role={loading ? 'status' : 'alert'} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-dim)', fontSize: '11px' }}>
      {loading ? `Loading ${what}...` : analyticsProblem(status)}
    </div>
  );
}

function PanelHeader({ icon, title, live, liveLabel }) {
  return (
    <div style={{ fontSize: '10px', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)', letterSpacing: '0.5px' }}>
      {icon} {title}
      {live && <span style={{ fontSize: '9px', color: '#00ff40', marginLeft: 'auto' }}>{liveLabel || 'LIVE'}</span>}
    </div>
  );
}

