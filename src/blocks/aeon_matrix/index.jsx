/**
 * Aeon Matrix — the memory layer every agent searches.
 * Search-first UI over the whole Vault (skills, projects, memories, library,
 * artifacts) with facet chips; the 3D knowledge graph is one toggle away.
 * Server routes stay in the /crn/second-brain/* namespace (URLs ≠ names).
 */
import React, { lazy, Suspense, useState, useCallback } from 'react';
import { Search, Loader, Network, FileText, Brain, Wrench, FolderKanban, BookOpen, Archive } from 'lucide-react';

const Visualizer = lazy(() =>
  import('./components/SecondBrainVisualizer').catch(() => ({
    default: () => (
      <div style={{ padding: 40, color: '#ffaa00', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🧠</div>
        Graph visualizer failed to load.
      </div>
    ),
  }))
);

// Facet = where the file lives in the Vault. This IS the organization:
// one memory surface, sliced by what agents actually look for.
const FACETS = [
  { id: 'all',       label: 'All',       icon: Search,       test: () => true },
  { id: 'skills',    label: 'Skills',    icon: Wrench,       test: p => /skills?[\\/]/i.test(p) || /\.agents/i.test(p) },
  { id: 'projects',  label: 'Projects',  icon: FolderKanban, test: p => /projects[\\/]/i.test(p) },
  { id: 'memory',    label: 'Memory',    icon: Brain,        test: p => /claude_intelligence|memor/i.test(p) },
  { id: 'library',   label: 'Library',   icon: BookOpen,     test: p => /reading_library/i.test(p) },
  { id: 'artifacts', label: 'Artifacts', icon: Archive,      test: p => /saved_artifacts/i.test(p) },
];

export default function AeonMatrix() {
  const [view, setView] = useState('search'); // 'search' | 'graph'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [facet, setFacet] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openDoc, setOpenDoc] = useState(null); // { path, content }

  const run = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true); setError(null); setOpenDoc(null);
    try {
      const r = await fetch(`/api/crn/second-brain/search?q=${encodeURIComponent(query.trim())}`);
      let d = null;
      try { d = await r.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
      if (!r.ok) throw new Error(`Server unreachable or errored (${r.status || 'no response'})`);
      if (d?.error) throw new Error(d.error);
      setResults(d?.results || []);
    } catch (e) { setError(e.message); setResults(null); }
    setLoading(false);
  }, [query, loading]);

  const openDocument = async (file) => {
    if (openDoc?.path === file) { setOpenDoc(null); return; }
    try {
      const r = await fetch(`/api/crn/second-brain/document?path=${encodeURIComponent(file)}`);
      let d = null;
      try { d = await r.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
      if (!r.ok) throw new Error(`Server unreachable or errored (${r.status || 'no response'})`);
      setOpenDoc({ path: file, content: d?.content || d?.error || '(empty)' });
    } catch (e) { setOpenDoc({ path: file, content: `Failed to load: ${e.message}` }); }
  };

  const filtered = (results || []).filter(r => FACETS.find(f => f.id === facet)?.test(r.file));
  const facetCount = (id) => (results || []).filter(r => FACETS.find(f => f.id === id)?.test(r.file)).length;

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', maxWidth: view === 'search' ? 900 : 'none', margin: view === 'search' ? '0 auto' : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Brain size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Aeon Matrix</h2>
        <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 4 }}>
          AGENT MEMORY LAYER
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {[['search', 'Search', Search], ['graph', 'Graph', Network]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setView(id)} style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              border: view === id ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: view === id ? 'var(--accent-dim)' : 'transparent',
              color: view === id ? 'var(--accent)' : 'var(--text-dim)',
            }}><Icon size={12} /> {label}</button>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 16px' }}>
        Every skill, project, memory, and document the agents can reach — one keyword away.
      </p>

      {view === 'graph' ? (
        <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-dim)', textAlign: 'center' }}>Loading graph…</div>}>
          <Visualizer />
        </Suspense>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && run()}
              placeholder="Search the Matrix — filenames and content…"
              aria-label="Search the Matrix — filenames and content"
              className="input"
              style={{ flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px', color: 'var(--text)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
            />
            <button onClick={run} disabled={loading} aria-label={loading ? 'Searching…' : 'Run search'} style={{
              background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 6, color: 'var(--accent)', padding: '0 18px', cursor: 'pointer',
            }}>
              {loading ? <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={15} />}
            </button>
          </div>

          {results && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {FACETS.map(f => {
                const n = facetCount(f.id);
                const Icon = f.icon;
                return (
                  <button key={f.id} onClick={() => setFacet(f.id)} disabled={n === 0 && f.id !== 'all'} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, cursor: n || f.id === 'all' ? 'pointer' : 'default',
                    border: facet === f.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: facet === f.id ? 'var(--accent-dim)' : 'transparent',
                    color: facet === f.id ? 'var(--accent)' : n ? 'var(--text-dim)' : 'var(--text-faint)',
                  }}><Icon size={11} /> {f.label} {f.id !== 'all' && n > 0 && <span style={{ opacity: 0.6 }}>{n}</span>}</button>
                );
              })}
            </div>
          )}

          {error && <div style={{ color: 'var(--coral)', fontSize: 12 }}>{error}</div>}

          {results && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-dim)', fontSize: 12 }}>No matches in this facet.</div>
          )}

          {filtered.map((r, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div
                onClick={() => openDocument(r.file)}
                role="button"
                tabIndex={0}
                aria-expanded={openDoc?.path === r.file}
                aria-label={`${openDoc?.path === r.file ? 'Collapse' : 'Open'} ${r.file.split(/[\\/]/).pop()}`}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDocument(r.file); } }}
                style={{
                borderLeft: `3px solid ${r.match === 'filename' ? 'var(--accent)' : 'var(--accent2)'}`,
                background: 'var(--bg-card)', borderRadius: 4, padding: '10px 14px', cursor: 'pointer',
                border: '1px solid var(--border-mute)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FileText size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.file.split(/[\\/]/).pop()}</span>
                  <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.file}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, letterSpacing: '0.1em', color: r.match === 'filename' ? 'var(--accent)' : 'var(--accent2)', flexShrink: 0 }}>{r.match.toUpperCase()}</span>
                </div>
                {r.snippet && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>{r.snippet}</div>}
              </div>
              {openDoc?.path === r.file && (
                <pre style={{
                  margin: '4px 0 0 16px', padding: 14, borderRadius: 6, maxHeight: 320, overflow: 'auto',
                  background: 'var(--surface-1)', border: '1px solid var(--border-mute)',
                  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.55,
                }}>{openDoc.content.slice(0, 20000)}</pre>
              )}
            </div>
          ))}

          {!results && !error && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)', fontSize: 12 }}>
              Type a keyword and hit Enter — searches every filename and document in the Vault.
            </div>
          )}
        </>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
