import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, Flame, Calendar, BarChart3, Zap, Clock, TrendingUp,
  RefreshCw, ChevronDown, Info,
} from 'lucide-react';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function levelColor(count, max) {
  if (!count || !max) return 'rgba(255,255,255,0.03)';
  const ratio = count / max;
  if (ratio > 0.75) return 'var(--color-primary, #00f2ff)';
  if (ratio > 0.5) return 'rgba(0,242,255,0.6)';
  if (ratio > 0.25) return 'rgba(0,242,255,0.35)';
  return 'rgba(0,242,255,0.15)';
}

export default function TokenHeatmap() {
  const [heatmapData, setHeatmapData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDetail, setDayDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch('/api/token-analytics/heatmap'),
        fetch('/api/token-analytics/summary'),
      ]);
      if (hRes.ok && sRes.ok) {
        setHeatmapData(await hRes.json());
        setSummary(await sRes.json());
        setLoading(false);
        return;
      }
    } catch {}
    // Supabase fallback
    try {
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const r = await fetch(`${sbUrl}/rest/v1/aeon_blocks?block_tag=eq.activity&select=payload`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
      const rows = await r.json();
      const data = rows?.[0]?.payload || {};
      // Build heatmap from stored daily data
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
      setSummary({ totalRequests: totalR, totalTokens: totalT, activeDays: active, currentStreak: 0, longestStreak: 0, last7: { requests: 0, tokens: 0 }, last30: { requests: 0, tokens: 0 }, modelBreakdown: [] });
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, []);

  async function loadDayDetail(date) {
    setSelectedDay(date);
    try {
      const res = await fetch(`/api/token-analytics/daily/${date}`);
      setDayDetail(await res.json());
    } catch { setDayDetail(null); }
  }

  // Build week columns for heatmap grid
  const weeks = useMemo(() => {
    if (!heatmapData?.days) return [];
    const cols = [];
    let col = [];
    for (const d of heatmapData.days) {
      if (d.weekday === 0 && col.length > 0) {
        cols.push(col);
        col = [];
      }
      col.push(d);
    }
    if (col.length > 0) cols.push(col);
    return cols;
  }, [heatmapData]);

  // Month labels for top of heatmap
  const monthLabels = useMemo(() => {
    if (!heatmapData?.days) return [];
    const labels = [];
    let lastMonth = -1;
    let weekIdx = 0;
    let dayIdx = 0;
    for (const d of heatmapData.days) {
      const m = new Date(d.date + 'T00:00:00').getMonth();
      if (m !== lastMonth) {
        labels.push({ month: MONTHS[m], weekIdx: Math.floor(dayIdx / 7) });
        lastMonth = m;
      }
      dayIdx++;
    }
    return labels;
  }, [heatmapData]);

  if (loading) {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }} role="status" aria-live="polite" aria-label="Loading activity data">
        <RefreshCw size={20} aria-hidden="true" style={{ animation: 'spin 1s linear infinite', margin: '40px auto', display: 'block' }} />
      </div>
    );
  }

  const max = heatmapData?.maxRequests || 1;

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Keyboard focus indicator for the heatmap day cells — inline styles
          set outline:'none' for the unselected state below, so a plain CSS
          rule is needed to restore a visible focus ring for keyboard users. */}
      <style>{`
        .aeon-activity-cell:focus-visible {
          outline: 2px solid var(--color-primary, #00f2ff);
          outline-offset: 2px;
        }
      `}</style>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Activity size={20} aria-hidden="true" style={{ color: 'var(--color-primary, #00f2ff)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em', fontFamily: 'var(--font-headline, inherit)' }}>Activity</h2>
        <span style={{
          fontSize: '10px', opacity: 0.5, fontFamily: 'var(--font-mono, monospace)',
          border: '1px solid rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px',
        }}>Token Analytics & Heatmap</span>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim, #888)', margin: '0 0 20px 0' }}>
        {summary?.totalRequests?.toLocaleString() || 0} requests across {summary?.activeDays || 0} active days
      </p>

      {/* Stats Cards */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '20px' }}>
          <StatCard icon={Zap} label="Total Requests" value={fmt(summary.totalRequests)} color="#00f2ff" />
          <StatCard icon={BarChart3} label="Total Tokens" value={fmt(summary.totalTokens)} color="#8b5cf6" />
          <StatCard icon={Flame} label="Current Streak" value={`${summary.currentStreak}d`} color="#f59e0b" />
          <StatCard icon={TrendingUp} label="Longest Streak" value={`${summary.longestStreak}d`} color="#4caf50" />
          <StatCard icon={Calendar} label="Active Days" value={String(summary.activeDays)} color="#2196f3" />
          <StatCard icon={Clock} label="Last 7 Days" value={fmt(summary.last7?.requests)} sub={`${fmt(summary.last7?.tokens)} tok`} color="#ec4899" />
        </div>
      )}

      {/* Heatmap Grid */}
      <div style={{ ...cardStyle, marginBottom: '16px', overflow: 'auto' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Calendar size={13} aria-hidden="true" style={{ color: 'var(--color-primary)' }} />
          365-Day Activity
          <button onClick={loadData} style={tinyBtn} aria-label="Refresh activity data">
            <RefreshCw size={10} aria-hidden="true" />
          </button>
        </div>

        {/* Month labels */}
        <div style={{ display: 'flex', marginLeft: '28px', marginBottom: '2px', position: 'relative', height: '14px' }}>
          {monthLabels.map((ml, i) => (
            <span key={i} style={{
              position: 'absolute', left: `${ml.weekIdx * 13}px`,
              fontSize: '9px', color: 'var(--text-dim)', whiteSpace: 'nowrap',
            }}>{ml.month}</span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0px' }}>
          {/* Day labels */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginRight: '4px', paddingTop: '0' }}>
            {[0,1,2,3,4,5,6].map(d => (
              <div key={d} style={{
                height: '11px', width: '22px', fontSize: '8px', color: 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '2px',
              }}>
                {d % 2 === 1 ? DAYS[d].slice(0, 3) : ''}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div style={{ display: 'flex', gap: '1px' }}>
            {weeks.map((week, wi) => (
              <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                {/* Pad first week */}
                {wi === 0 && week[0] && Array.from({ length: week[0].weekday }).map((_, i) => (
                  <div key={`pad-${i}`} style={{ width: '11px', height: '11px' }} />
                ))}
                {week.map(d => (
                  <div key={d.date}
                    className="aeon-activity-cell"
                    role="button"
                    tabIndex={0}
                    onClick={() => loadDayDetail(d.date)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        loadDayDetail(d.date);
                      }
                    }}
                    title={`${d.date}: ${d.requests} requests, ${fmt(d.tokens)} tokens`}
                    aria-label={`${d.date}: ${d.requests} requests, ${fmt(d.tokens)} tokens`}
                    aria-pressed={selectedDay === d.date}
                    style={{
                      width: '11px', height: '11px', borderRadius: '2px',
                      background: levelColor(d.requests, max),
                      cursor: 'pointer', transition: 'transform 0.1s',
                      boxShadow: selectedDay === d.date ? '0 0 0 1px var(--color-primary, #00f2ff)' : 'none',
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.3)'}
                    onMouseLeave={e => e.currentTarget.style.transform = ''}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', marginLeft: '28px', fontSize: '9px', color: 'var(--text-dim)' }}>
          <span>Less</span>
          {[0, 0.15, 0.35, 0.6, 1].map((r, i) => (
            <div key={i} style={{
              width: '11px', height: '11px', borderRadius: '2px',
              background: r === 0 ? 'rgba(255,255,255,0.03)' : `rgba(0,242,255,${r})`,
            }} />
          ))}
          <span>More</span>
        </div>
      </div>

      {/* Day Detail */}
      {selectedDay && dayDetail && (
        <div style={{ ...cardStyle, marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>
              {new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
            <button onClick={() => { setSelectedDay(null); setDayDetail(null); }} style={tinyBtn}>Close</button>
          </div>
          <div style={{ display: 'flex', gap: '16px', fontSize: '12px', marginBottom: '8px' }}>
            <span><strong>{dayDetail.requests}</strong> requests</span>
            <span><strong>{fmt(dayDetail.tokens)}</strong> tokens</span>
          </div>
          {dayDetail.models && Object.keys(dayDetail.models).length > 0 && (
            <div style={{ display: 'grid', gap: '4px' }}>
              {Object.entries(dayDetail.models).sort((a, b) => b[1].requests - a[1].requests).map(([model, m]) => (
                <div key={model} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '4px 8px', borderRadius: '4px', fontSize: '11px',
                  background: 'rgba(255,255,255,0.02)',
                }}>
                  <span style={{ fontWeight: 600 }}>{model}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{m.requests} req · {fmt(m.tokens)} tok</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Model Breakdown */}
      {summary?.modelBreakdown?.length > 0 && (
        <div style={{ ...cardStyle }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <BarChart3 size={13} aria-hidden="true" style={{ color: '#8b5cf6' }} /> Model Usage
          </div>
          <div style={{ display: 'grid', gap: '6px' }}>
            {summary.modelBreakdown.slice(0, 12).map(m => {
              const pct = summary.totalRequests ? Math.round(m.requests / summary.totalRequests * 100) : 0;
              return (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                  <span style={{ width: '140px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </span>
                  <div style={{ flex: 1, height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: '3px', transition: 'width 0.3s',
                      width: `${pct}%`, background: 'var(--color-primary, #00f2ff)',
                    }} />
                  </div>
                  <span style={{ color: 'var(--text-dim)', width: '80px', textAlign: 'right' }}>
                    {m.requests} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stat Card ──
function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div style={{
      ...cardStyle, padding: '10px 14px',
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <Icon size={13} aria-hidden="true" style={{ color, flexShrink: 0 }} />
        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</span>
      </div>
      <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono, monospace)' }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '1px' }}>{sub}</div>}
    </div>
  );
}

function fmt(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Styles ──
const cardStyle = {
  background: 'var(--color-surface, #1a1a1a)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: '10px', padding: '12px',
};

const tinyBtn = {
  background: 'none', border: 'none', color: 'var(--text-dim, #888)',
  cursor: 'pointer', padding: '3px', borderRadius: '4px', display: 'flex',
  alignItems: 'center', gap: '3px', fontSize: '11px',
};
