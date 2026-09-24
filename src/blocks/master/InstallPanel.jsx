/**
 * Master → Install. Paste a link, get a block, choose where it lives.
 *
 * Everything under this panel already existed as kernel routes: POST
 * /blocks/store/install takes { url } (https only), { name } (from the
 * configured store, verified against its catalog's SHA-256) or { base64 };
 * POST /blocks/store/update swaps a version only if the new one goes live and
 * rolls back if it does not. What was missing was a surface. This is the
 * surface, and nothing more — the kernel decides, this reports.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It does not validate a licence. A key checked in the browser is a key anyone
 * skips with devtools, so when the store is gated the check belongs on the
 * install route, against the store, server-side. The field below carries a key
 * to the kernel and takes the kernel's word for the answer.
 *
 * It does not decide where a block goes. It asks, because the operator is the
 * only one who knows whether a thing is a tool or an agent, and a block that
 * silently lands in Unsorted is a block they have to go hunting for.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Download, FolderInput, Check, AlertTriangle, Loader } from 'lucide-react';

const DIM = { fontSize: 12.5, color: 'var(--dim, #9aa3b2)' };
const FIELD = {
  width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 13,
  background: 'rgba(255,255,255,0.04)', color: 'var(--fg, #e8f0fa)',
  border: '1px solid var(--line, #272d39)', fontFamily: 'inherit',
};

/**
 * A store link, a catalog id, or a .aeon file — whichever the operator has.
 *
 * Exported because the https rule is a safety property, not a convenience: a
 * cartridge is executable code, and fetching one over http invites whoever is
 * between here and the store to choose what gets installed. The kernel refuses
 * it too. This refuses earlier, and says why.
 */
export function classifySource(raw) {
  const v = String(raw || '').trim();
  if (!v) return { kind: 'empty' };
  if (/^https:\/\//i.test(v)) return { kind: 'url', body: { url: v } };
  // http:// is refused by the kernel too, but saying so here costs one
  // round-trip less and explains why rather than showing a rejection.
  if (/^http:\/\//i.test(v)) return { kind: 'insecure' };
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(v)) return { kind: 'name', body: { name: v } };
  return { kind: 'unknown' };
}

export default function InstallPanel({ onInstalled }) {
  const [source, setSource] = useState('');
  const [licence, setLicence] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { ok, id, label, error }
  const [store, setStore] = useState(null);     // configured store catalog

  // What the configured store offers, if one is configured at all. A panel
  // that cannot say "no store is set up" is a panel that looks broken when
  // AEON_STORE is simply unset.
  useEffect(() => {
    let alive = true;
    fetch('/blocks/store/source')
      .then((r) => r.json())
      .then((d) => { if (alive) setStore(d); })
      .catch(() => { if (alive) setStore({ configured: false, items: [], hint: 'The store could not be reached.' }); });
    return () => { alive = false; };
  }, []);

  const install = useCallback(async () => {
    const cls = classifySource(source);
    if (cls.kind === 'empty') return setResult({ ok: false, error: 'Nothing to install yet — paste a store link, or type a block name.' });
    // A block is a program. Fetching one over a link that is not encrypted lets
    // anyone between here and the store swap what arrives, so this is refused
    // rather than warned about.
    if (cls.kind === 'insecure') return setResult({ ok: false, error: 'That link is not secure — it starts with http:// instead of https://. A block is a program, so AEON will not download one over a link that could be tampered with on the way. Ask the store for an https link.' });
    if (cls.kind === 'unknown') return setResult({ ok: false, error: 'That does not look like a store link or a block name. A link starts with https:// ; a name is a single word like "reports".' });

    setBusy(true); setResult(null);
    try {
      const body = { ...cls.body };
      // The key travels to the kernel and is judged there. Nothing about it is
      // decided in this page.
      if (licence.trim()) body.licenceKey = licence.trim();
      const r = await fetch('/blocks/store/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) {
        setResult({ ok: false, error: d.error || `The install was refused (HTTP ${r.status}).` });
      } else {
        const id = d.id || d.block?.id || cls.body.name || null;
        setResult({ ok: true, id, label: d.label || d.block?.label || id, detail: d.version ? `v${d.version}` : '' });
        if (onInstalled) onInstalled(id);
      }
    } catch (e) {
      setResult({ ok: false, error: `The install could not run: ${e.message}` });
    } finally { setBusy(false); }
  }, [source, licence, onInstalled]);

  return (
    <div>
      <p style={{ ...DIM, marginTop: 0 }}>
        Paste a link from the AEON block store, or type the name of a block the store offers.
        AEON downloads it, checks it is what the store said it was, starts it, and opens its screens
        to confirm they work. If any of that fails, nothing is installed and you are told why.
      </p>

      <label style={{ ...DIM, display: 'block', marginBottom: 4 }} htmlFor="ip-src">Store link or block name</label>
      <input id="ip-src" style={FIELD} value={source} spellCheck={false}
        placeholder="https://store.example/reports-0.1.0.aeon   ·   or just:  reports"
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !busy) install(); }} />

      <label style={{ ...DIM, display: 'block', margin: '10px 0 4px' }} htmlFor="ip-key">
        Licence key <span style={{ opacity: 0.7 }}>— only if the store asks for one</span>
      </label>
      <input id="ip-key" style={FIELD} value={licence} spellCheck={false} autoComplete="off"
        placeholder="leave empty for a free or local block"
        onChange={(e) => setLicence(e.target.value)} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button className="btn primary" onClick={install} disabled={busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <Loader size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          {busy ? 'Installing…' : 'Install'}
        </button>
        {store && !store.configured && (
          <span style={{ ...DIM, flex: 1 }}>
            No store is set up yet, so only a direct https link will work. {store.hint}
          </span>
        )}
        {store && store.configured && (
          <span style={{ ...DIM, flex: 1 }}>
            Store connected — {store.items?.length || 0} block{(store.items?.length || 0) === 1 ? '' : 's'} available by name.
          </span>
        )}
      </div>

      {result && !result.ok && (
        <div role="alert" style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'rgba(208,59,59,0.10)', border: '1px solid rgba(208,59,59,0.40)' }}>
          <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />
          {result.error}
        </div>
      )}

      {result && result.ok && (
        <SectionChooser blockId={result.id} label={result.label} detail={result.detail}
          onDone={() => setResult(null)} />
      )}
    </div>
  );
}

/**
 * "Where should this live?" — asked once, immediately after an install.
 *
 * The sections are the operator's own (settings.blockLayout), the same truth
 * the sidebar and the Dashboard's grid read, so a choice made here is the
 * choice they see everywhere. Writing it is a full replace of blockLayout,
 * which is what POST /api/settings/block-layout expects: the Dashboard needs
 * real removal when a block is dragged back to its default, and a deep merge
 * can never delete a key.
 */
function SectionChooser({ blockId, label, detail, onDone }) {
  const [layout, setLayout] = useState(null);
  const [groups, setGroups] = useState([]);
  const [chosen, setChosen] = useState('');
  const [newName, setNewName] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/settings').then((r) => r.json()).catch(() => ({})),
      fetch('/blocks/registry').then((r) => r.json()).catch(() => []),
    ]).then(([settings, reg]) => {
      if (!alive) return;
      const bl = settings?.blockLayout || { overrides: {}, customGroups: {}, groupOverrides: {} };
      setLayout(bl);
      // Every section a block currently sits in, plus the operator's custom
      // ones. Derived rather than hardcoded: a list of sections that does not
      // include the ones they made is a list they will not recognise.
      const blocks = Array.isArray(reg) ? reg : (reg.blocks || []);
      const seen = new Map();
      for (const b of blocks) {
        const g = bl.overrides?.[b.id] || b.group;
        if (g && !seen.has(g)) seen.set(g, bl.groupOverrides?.[g]?.label || labelise(g));
      }
      for (const [gid, cg] of Object.entries(bl.customGroups || {})) {
        if (!seen.has(gid)) seen.set(gid, bl.groupOverrides?.[gid]?.label || cg.label || labelise(gid));
      }
      setGroups([...seen].map(([id, name]) => ({ id, name })));
    });
    return () => { alive = false; };
  }, []);

  const save = useCallback(async (groupId, customLabel) => {
    setErr('');
    const next = {
      overrides: { ...(layout?.overrides || {}) },
      customGroups: { ...(layout?.customGroups || {}) },
      groupOverrides: { ...(layout?.groupOverrides || {}) },
    };
    next.overrides[blockId] = groupId;
    if (customLabel) next.customGroups[groupId] = { label: customLabel, icon: 'custom', order: 50 };
    try {
      const r = await fetch('/api/settings/block-layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setLayout(next); setSaved(true);
    } catch (e) {
      // The block IS installed. Only its placement failed, and saying
      // otherwise would send the operator looking for a block that is there.
      setErr(`${label} is installed, but its section could not be saved (${e.message}). Drag it in Settings → Blocks instead.`);
    }
  }, [layout, blockId, label]);

  if (!blockId) return null;

  return (
    <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 8,
      background: 'rgba(12,163,12,0.08)', border: '1px solid rgba(12,163,12,0.38)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Check size={14} aria-hidden="true" /> {label} is installed{detail ? ` (${detail})` : ''}.
      </div>

      {saved ? (
        <p style={{ ...DIM, margin: '8px 0 0' }}>
          Filed under <strong>{groups.find((g) => g.id === chosen)?.name || newName || chosen}</strong>.
          You can drag it somewhere else any time from Settings → Blocks.{' '}
          <button className="link" onClick={onDone} style={{ padding: 0 }}>Install another</button>
        </p>
      ) : (
        <>
          <p style={{ ...DIM, margin: '6px 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <FolderInput size={13} aria-hidden="true" /> Where should we nest this block?
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {groups.map((g) => (
              <button key={g.id} className="btn" onClick={() => { setChosen(g.id); save(g.id); }}
                style={{ fontSize: 12 }}>{g.name}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input style={{ ...FIELD, flex: 1 }} value={newName} placeholder="…or name a new section"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !newName.trim()) return;
                const id = slug(newName);
                setChosen(id); save(id, newName.trim());
              }} />
            <button className="btn" disabled={!newName.trim()}
              onClick={() => { const id = slug(newName); setChosen(id); save(id, newName.trim()); }}>
              Create
            </button>
          </div>
        </>
      )}

      {err && (
        <p role="alert" style={{ ...DIM, color: 'var(--warning, #fab219)', margin: '8px 0 0' }}>{err}</p>
      )}
    </div>
  );
}

export const labelise = (id) => String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom';
