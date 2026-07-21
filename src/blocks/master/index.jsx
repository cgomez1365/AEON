/**
 * Master — the block standard, made physical.
 * This is the parent every block copies from. Its UI doubles as living
 * documentation: the anatomy, the naming rule, the widget contract, and a
 * live view of every installed cartridge.
 *
 * Accessibility patterns demonstrated here (copy these, not just the JSX):
 *   - Every fetch() call is relative ('/blocks/registry', never a hardcoded
 *     host:port) — Vite proxies /blocks, /core, /api, etc. to the kernel in
 *     dev, and same-origin already works in every deployed target. Any
 *     "which host am I on" display text reads window.location, never a
 *     literal string — a literal 'localhost:3001' is a lie on Vercel/Docker.
 *   - Icons placed next to visible text get aria-hidden="true": the icon is
 *     decorative, the adjacent text is already the accessible name, so a
 *     screen reader should not announce the glyph a second time.
 *   - Section labels use real <h3> elements (not styled <div>s) so screen
 *     reader users can jump between sections with heading navigation.
 *   - Repeated item groups (ANATOMY, RULES, the cartridge grid) render as
 *     <ul role="list">/<li> — role="list" is required because list-style:
 *     none strips list semantics in Safari/VoiceOver otherwise.
 *   - Async-loaded values (kernel status, registry count) sit in an
 *     aria-live="polite" region so screen readers announce the update
 *     instead of staying silent after the initial render.
 *   - The one icon-only control (refresh) gets aria-label + keeps the
 *     browser's default focus ring (no `outline: none` — WCAG 2.4.7).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Card, StatCard } from '../../components/aurora';
import { Dna, FolderTree, Radio, LayoutGrid, RefreshCw } from 'lucide-react';

const ANATOMY = [
  ['block.manifest.json', 'Identity + contract. nav, permissions, commands, widget. Manifest is truth.'],
  ['index.jsx', 'The UI. Default-export one component. Use aurora primitives (Card, StatCard).'],
  ['api/<id>.cjs', 'Optional backend: module.exports = (app, deps) => router. Auto-mounted at /api/*.'],
  ['README.md', 'One paragraph: what it owns, what it reads, what it writes.'],
];

const RULES = [
  ['Folder is truth', 'The displayed name is derived from the folder name (my_block → "My Block"). To rename a block, rename its folder.'],
  ['Never call what does not exist', 'Fetch only endpoints your own api/ provides or the kernel guarantees (/core, /api/ai, /blocks/registry).'],
  ['Declare a widget', 'Expose GET /api/<id>/widget + a manifest widget section, and the dashboard shows your quick-view automatically.'],
  ['Ask for nothing extra', 'Set permissions minimally — the sandbox strips deps you did not declare.'],
];

export default function Master() {
  const [registry, setRegistry] = useState([]);
  const [serverUp, setServerUp] = useState(false);
  const [loading, setLoading] = useState(false);

  // Relative fetch — no host/port baked in. Vite proxies this in dev; every
  // deployed target (Vercel, Docker, bare node) serves the API same-origin.
  const loadRegistry = useCallback(() => {
    setLoading(true);
    fetch('/blocks/registry')
      .then(r => r.json())
      .then(d => { setRegistry(d.blocks || d.list || (Array.isArray(d) ? d : [])); setServerUp(true); })
      .catch(() => setServerUp(false))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadRegistry(); }, [loadRegistry]);

  // Host the page is actually being served from — never a literal string,
  // since that would be wrong on every target except one developer's laptop.
  const host = typeof window !== 'undefined' ? window.location.host : 'kernel';

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        {/* Decorative icon beside visible text — hidden from the accessibility
            tree so screen readers announce "Master" once, not "dna Master". */}
        <Dna size={20} aria-hidden="true" style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Master</h2>
        <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 4 }}>
          THE BLOCK STANDARD
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 20px' }}>
        Every new block starts as a copy of <code style={{ fontFamily: 'var(--font-mono)' }}>src/blocks/master/</code>.
        Rename the folder, edit the manifest, ship.
      </p>

      {/* aria-live: these two values change after the initial render (the
          fetch above resolves async) — without this, a screen reader that
          already announced the page never learns the numbers updated. */}
      <div
        role="group"
        aria-live="polite"
        aria-label="Live kernel status"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 20 }}
      >
        <StatCard label="Installed Blocks" value={registry.length || '—'} accent="cyan" sub="live from /blocks/registry" icon={<LayoutGrid size={14} aria-hidden="true" />} />
        <StatCard label="Kernel" value={serverUp ? 'ONLINE' : 'OFFLINE'} accent={serverUp ? 'emerald' : 'coral'} sub={serverUp ? host : 'unreachable'} icon={<Radio size={14} aria-hidden="true" />} />
      </div>

      <Card hover={false} style={{ marginBottom: 12 }}>
        {/* Real heading (not a styled div) so heading-navigation in a screen
            reader can jump straight to this section. */}
        <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-dim)', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <FolderTree size={13} aria-hidden="true" /> ANATOMY OF A BLOCK
        </h3>
        {/* role="list" is belt-and-suspenders: Safari/VoiceOver drop implicit
            list semantics once list-style is set to none. */}
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {ANATOMY.map(([file, desc]) => (
            <li key={file} style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border-mute)', fontSize: 12 }}>
              <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', minWidth: 190 }}>{file}</code>
              <span style={{ color: 'var(--text-dim)' }}>{desc}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card hover={false} style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-dim)', margin: '0 0 10px' }}>THE FOUR RULES</h3>
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {RULES.map(([rule, desc], i) => (
            <li key={rule} style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border-mute)', fontSize: 12 }}>
              <span aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent2)', minWidth: 24 }}>{i + 1}.</span>
              <div>
                <span style={{ fontWeight: 600 }}>{rule}</span>
                <span style={{ color: 'var(--text-dim)' }}> — {desc}</span>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card hover={false}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-dim)', margin: 0 }}>INSTALLED CARTRIDGES</h3>
          {/* Icon-only button — the accessible name comes entirely from
              aria-label (there is no visible text label next to it), and the
              browser's default focus ring is left alone so keyboard users can
              see where focus is (WCAG 2.4.7 — never set outline: none without
              drawing a replacement focus style). */}
          <button
            type="button"
            onClick={loadRegistry}
            disabled={loading}
            aria-label="Refresh installed block registry"
            title="Refresh"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 6,
              background: 'transparent', border: '1px solid var(--border-mute)',
              color: 'var(--text-dim)', cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            <RefreshCw size={12} aria-hidden="true" style={loading ? { animation: 'spin 0.7s linear infinite' } : undefined} />
          </button>
        </div>
        {registry.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-dim)', fontSize: 12 }}>
            {serverUp ? 'Registry is empty' : 'Kernel offline — start the server to see the registry'}
          </div>
        ) : (
          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {registry.map(b => (
              <li key={b.id || b.folder} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-mute)', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{b.label || b.id || b.folder}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                  {b.id || b.folder} · {b.ready === false ? 'not ready' : 'ready'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
