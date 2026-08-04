/**
 * Aeon Matrix — the memory layer every agent searches.
 * Search-first UI over the whole Vault (skills, projects, memories, library,
 * artifacts) with facet chips; the 3D knowledge graph is one toggle away.
 * Server routes stay in the /crn/second-brain/* namespace (URLs ≠ names).
 */
import React, { lazy, Suspense, useState, useCallback } from 'react';
import { Search, Loader, Network, FileText, Brain, Wrench, FolderKanban, BookOpen, Archive, HelpCircle } from 'lucide-react';

// ── What the Matrix needs, and what it only *prefers* ──────────────────────
//
// Written after a real question: "is the embedding model still necessary?"
// Nothing in the UI answered it, so the honest answer lived only in a source
// comment. Same idea as Cookbook's guide — one short idea per card, no ML
// background assumed, and every claim states whether the thing DEGRADES or
// BREAKS without it. Those are different, and conflating them is how people
// end up installing things they don't need or skipping things they do.
const HELP_CARDS = [
  {
    title: 'What the Matrix actually is',
    need: 'core',
    body: [
      "Your Vault is a folder of ordinary files — notes, PDFs, documents. The Matrix is the layer that reads them so the rest of AEON can find things inside them.",
      "It keeps a Table of Contents (vault_index.json): one small entry per file with a title, a summary, and tags. That file is the whole trick — it means AEON can find the right document without ever reading your entire Vault.",
    ],
  },
  {
    title: 'Why that keeps your costs down',
    need: 'core',
    body: [
      "Searching happens against those small summaries, not the full documents. A search costs you nothing — no provider is contacted, no tokens are billed.",
      "Only once the right few files are identified does anything read them in full. So a question touches three documents, not three thousand.",
    ],
    callout: "This is why a small model on your own machine can answer well: it only ever has to read what matters.",
  },
  {
    title: 'The embedding model — helpful, not required',
    need: 'optional',
    body: [
      "An embedding model turns text into numbers that capture meaning, so \"how do I rotate credentials\" can match a note titled \"key lifecycle\" — different words, same idea.",
      "Without it, search still works: it falls back to matching words instead of meaning. You will find things, as long as you remember roughly what you wrote.",
    ],
    callout: "Absent, it degrades quality. It never breaks anything. Install nomic-embed-text (0.15 GB) in Cookbook if you want meaning-based recall.",
  },
  {
    title: 'Links — [[wikilinks]] and refs',
    need: 'optional',
    body: [
      "Write [[Another Note]] inside a markdown file and the Matrix draws a real connection between them in the graph. Memories saved by AEON already record their own refs the same way.",
      "Before this existed the graph only showed which folder a file lived in. Useful, but it told you nothing about how your ideas relate.",
    ],
    callout: "Nothing to install. Write links if you want them; the graph works either way.",
  },
  {
    title: 'Asking questions instead of searching',
    need: 'core',
    body: [
      "Search hands you documents. Ask reads them and answers, citing which document each part came from.",
      "If nothing in your Vault is relevant, it says so rather than guessing — and it does not contact a model at all, so a bad question costs nothing.",
    ],
    callout: "Terminal: /recall finds documents. Ask goes one step further and answers from them.",
  },
  {
    title: 'If recall finds nothing',
    need: 'core',
    body: [
      "Most often the index is simply stale — run /index-brain after adding files.",
      "If you added files before installing an embedding model, those entries have no vector and meaning-based search skips them. Re-indexing backfills them automatically.",
    ],
  },
];

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
    <div style={{
      padding: view === 'graph' ? '24px 24px 0' : 24,
      height: '100%',
      overflowY: view === 'graph' ? 'hidden' : 'auto',
      maxWidth: view === 'search' ? 900 : 'none',
      margin: view === 'search' ? '0 auto' : 0,
      display: view === 'graph' ? 'flex' : 'block',
      flexDirection: 'column',
      minHeight: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Brain size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Aeon Matrix</h2>
        <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 4 }}>
          AGENT MEMORY LAYER
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {[['search', 'Search', Search], ['graph', 'Graph', Network], ['help', 'Help', HelpCircle]].map(([id, label, Icon]) => (
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

      {view === 'help' ? (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', paddingBottom: 24 }}>
          {HELP_CARDS.map(card => (
            <div key={card.title} style={{
              border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px',
              background: 'var(--surface-1)',
              borderLeft: card.need === 'core' ? '3px solid var(--accent)' : '3px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>{card.title}</h3>
                <span style={{
                  marginLeft: 'auto', fontSize: 9, letterSpacing: '.1em', padding: '2px 7px',
                  borderRadius: 999, fontFamily: 'var(--font-mono)',
                  border: '1px solid var(--border)',
                  color: card.need === 'core' ? 'var(--accent)' : 'var(--text-faint)',
                }}>
                  {card.need === 'core' ? 'ALWAYS ON' : 'OPTIONAL'}
                </span>
              </div>
              {card.body.map((p, i) => (
                <p key={i} style={{ margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-dim)' }}>{p}</p>
              ))}
              {card.callout && (
                <div style={{
                  marginTop: 4, paddingTop: 9, borderTop: '1px dashed var(--border)',
                  fontSize: 11.5, lineHeight: 1.55, color: 'var(--text)',
                }}>
                  {card.callout}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : view === 'graph' ? (
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
