/** Orion Search — unified search UI: web + Second Brain + blocks, links on everything. */
import React, { useState, useEffect } from 'react';
import { Search, Loader, Globe, Brain, Box, History, X } from 'lucide-react';

const SOURCE_META = {
  web:   { icon: Globe, color: '#00f2ff', label: 'WEB' },
  brain: { icon: Brain, color: '#39ff14', label: 'BRAIN' },
  block: { icon: Box,   color: '#f59e0b', label: 'BLOCK' },
};

const HISTORY_KEY = 'aeon_orion_history';

export default function OrionSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sources, setSources] = useState({ web: true, brain: true, block: true });
  const [k, setK] = useState(8);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12))); } catch {}
  }, [history]);

  const run = async (q = query) => {
    if (!q.trim() || loading) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/orion/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, k }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'search failed');
      setResults(d);
      setHistory(prev => [q, ...prev.filter(h => h !== q)].slice(0, 12));
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const visible = results ? results.results.filter(r => sources[r.source] !== false) : [];

  return (
    <div style={{ padding: 24, maxWidth: 860, margin: '0 auto', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
      <h2 style={{ fontSize: 15, letterSpacing: '0.15em', color: 'var(--accent)', marginBottom: 4 }}>🔭 ORION SEARCH</h2>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 18 }}>One query — web, Second Brain, and installed blocks. Every result links.</div>

      {/* Announces loading/result-count transitions to screen readers without
          cluttering the visual UI — mirrors the role="status"/aria-live
          convention used in the Activity block's heatmap loading state. */}
      <div aria-live="polite" className="sr-only">
        {loading ? 'Searching…' : results ? `${visible.length} results shown.` : ''}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <label htmlFor="orion-search-input" className="sr-only">Search web, Second Brain, and installed blocks</label>
        <input
          id="orion-search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && run()}
          placeholder="Search everything…"
          className="orion-focusable"
          style={{ flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 14px', color: 'var(--text)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
        />
        <button onClick={() => run()} disabled={loading} aria-label={loading ? 'Searching…' : 'Run search'}
          className="orion-focusable"
          style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--accent)', padding: '0 18px', cursor: 'pointer' }}>
          {loading ? <Loader size={15} aria-hidden="true" style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={15} aria-hidden="true" />}
        </button>
      </div>

      {/* Source filters + depth */}
      <div role="group" aria-label="Filter results by source" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(SOURCE_META).map(([id, meta]) => {
          const Icon = meta.icon;
          const on = sources[id];
          return (
            <button key={id} onClick={() => setSources(s => ({ ...s, [id]: !s[id] }))}
              aria-pressed={on}
              aria-label={`${meta.label} results ${on ? 'shown, click to hide' : 'hidden, click to show'}`}
              className="orion-focusable"
              style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '4px 11px', borderRadius: 999, fontSize: 9.5, fontWeight: 700, cursor: 'pointer',
              border: on ? `1px solid ${meta.color}` : '1px solid var(--border)',
              background: on ? `${meta.color}18` : 'transparent',
              color: on ? meta.color : 'var(--text-faint)',
            }}><Icon size={11} aria-hidden="true" /> {meta.label}</button>
          );
        })}
        <span role="group" aria-label="Result depth" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          depth
          {[8, 16, 24].map(n => (
            <button key={n} onClick={() => setK(n)}
              aria-pressed={k === n}
              aria-label={`Depth ${n} results`}
              className="orion-focusable"
              style={{
              padding: '2px 8px', borderRadius: 4, fontSize: 9.5, fontWeight: 700, cursor: 'pointer',
              border: k === n ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: k === n ? 'var(--accent-dim)' : 'transparent',
              color: k === n ? 'var(--accent)' : 'var(--text-dim)',
            }}>{n}</button>
          ))}
        </span>
      </div>

      {/* History chips */}
      {!results && history.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9.5, letterSpacing: '0.12em', color: 'var(--text-faint)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <History size={11} aria-hidden="true" /> RECENT
            <button onClick={() => setHistory([])} aria-label="Clear search history" className="orion-focusable" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex' }}><X size={11} aria-hidden="true" /></button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {history.map(h => (
              <button key={h} onClick={() => { setQuery(h); run(h); }} aria-label={`Search again: ${h}`} className="orion-focusable" style={{
                padding: '4px 12px', borderRadius: 999, fontSize: 10.5, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-dim)',
              }}>{h}</button>
            ))}
          </div>
        </div>
      )}

      {error && <div role="alert" style={{ color: 'var(--coral)', fontSize: 12 }}>{error}</div>}

      {results && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>
            {visible.length} shown · web {results.counts.web} · brain {results.counts.brain} · blocks {results.counts.block}
          </div>
          {visible.map((r, i) => {
            const meta = SOURCE_META[r.source] || SOURCE_META.web;
            const Icon = meta.icon;
            return (
              <div key={i} style={{ borderLeft: `3px solid ${meta.color}`, background: 'var(--bg-card)', borderRadius: 3, padding: '10px 14px', marginBottom: 8, border: '1px solid var(--border-mute)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Icon size={12} color={meta.color} aria-hidden="true" />
                  <span style={{ fontSize: 9, letterSpacing: '0.12em', color: meta.color }}>{meta.label}</span>
                  {r.url && (r.source === 'web'
                    ? <a href={r.url} target="_blank" rel="noreferrer" className="orion-focusable" aria-label={`${r.title} (opens in new tab)`} style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.title}</a>
                    : <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.title} <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>({r.url})</span></span>)}
                  {!r.url && <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.title}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{r.excerpt}</div>
              </div>
            );
          })}
        </div>
      )}
      {/* outline: none on the inputs/buttons above removes the default focus
          ring; this restores a visible :focus-visible ring for keyboard users
          (same pattern as the Activity block's heatmap cells). */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .orion-focusable:focus-visible {
          outline: 2px solid var(--accent, #00f2ff);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
