/**
 * Master → Install from the store: paste a link (or type a name), get a
 * block, choose where it lives.
 *
 * Everything under this panel already existed as kernel routes
 * (src/kernel/routers/store.cjs, mounted at /api/store): POST
 * /api/store/install takes { url } (https only), { name } (from the
 * configured store, checked against its catalog's SHA-256) or { base64 } (an
 * uploaded .aeon file);
 * POST /api/store/update swaps a version only if the new one goes live and
 * rolls back if it does not. This panel is only the surface for that
 * machinery: it sends the request and reports what the server answered. It
 * never decides for itself whether an install worked.
 *
 * 2026-09-28 — this panel shipped calling /blocks/store/source and
 * /blocks/store/install. Nothing has ever been mounted there: /blocks serves
 * only /registry, /widgets and /state. The GET fell through to the SPA
 * fallback (index.html, 200), so the panel said "the store could not be
 * reached" with AEON_STORE set; every install was an Express 404. The paths
 * below are the ones Settings → Blocks (settings/blockLifecycle.js) and the
 * CLI already use, and tests/sweep-master-install-panel.test.js checks every
 * path this file fetches against what the server mounts.
 *
 * Two things it deliberately does not do.
 *
 * It asks for no licence. A key checked in the browser is a key anyone skips
 * with devtools, so a gated store's check belongs on the install route,
 * server-side — and /api/store/install has none (installCartridge reads name,
 * url or base64, nothing else). The key field this panel had went nowhere: it
 * told the operator a key had been judged when nothing read it. It comes back
 * with the server check, not before.
 *
 * It does not decide where the block goes. After an install it asks: only
 * the operator knows whether the block is a tool, an agent or something else,
 * and a block filed silently under Unsorted is one they have to go looking for.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Download, FolderInput, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { getEffectiveBlockGroups } from '../../kernel/blockRegistry.js';

const DIM = { fontSize: 12.5, color: 'var(--dim, #9aa3b2)' };
// This panel shows every refusal inline. The header keeps the global
// forensics banner (interceptorPolicy.shouldBannerResponse) from ALSO firing
// on an expected refusal — a lint stop, an already-installed block, an
// unreadable store — the same header Settings → Blocks sends on these routes.
const SELF_REPORTED = { 'x-aeon-self-reported': '1' };
// Said with every install that lands: the block list and nav are compiled into
// the screen bundle (Settings → Blocks says the same).
const UI_NOTE = 'Its screen appears after `npm run build` and a reload of this tab — no restart needed.';
const FIELD = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
  background: 'rgba(0,0,0,0.25)', color: 'var(--text, #e6edf3)', border: '1px solid var(--line, #272d39)',
};
const LINK = { background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent, #00f2ff)', textDecoration: 'underline', cursor: 'pointer' };

/**
 * What the operator typed or pasted, as one of five kinds, with the request
 * body when an install is possible:
 *
 *   empty     nothing there yet
 *   url       an https link → { url }
 *   insecure  an http:// link — refused here, no body
 *   name      one bare block id (letter or digit first, then letters, digits,
 *             _ or -) → { name }
 *   unknown   anything else: a file path, file://, text with spaces or dots
 *
 * http:// is a safety rule, not a nicety. A block is a program; fetched over
 * an unencrypted link, whoever sits on the network path chooses what gets
 * installed. The server refuses it too — refusing here saves the round trip
 * and lets the panel say why. empty and unknown stay apart because the
 * operator needs a different sentence for each.
 */
export function classifySource(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { kind: 'empty' };
  if (/^https:\/\//i.test(v)) return { kind: 'url', body: { url: v } };
  if (/^http:\/\//i.test(v)) return { kind: 'insecure' };
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(v)) return { kind: 'name', body: { name: v } };
  return { kind: 'unknown' };
}

/**
 * What an accepted POST /api/store/install answered, in the panel's terms.
 *
 * The route returns the pipeline's verdict plus { blockId, purchase:
 * { id, label, version } } (store.cjs installCartridge). The panel used to read
 * d.id / d.label / d.version, none of which exist, so an install by link
 * reported id null and never asked where the block should live. A queued
 * install is not an installed block — it waits for the operator's approval.
 */
export function installOutcome(d, cls) {
  const p = (d && d.purchase) || {};
  const id = d?.blockId || p.id || cls?.body?.name || null;
  return { id, label: p.label || id, detail: p.version ? `v${p.version}` : '', queued: d?.stage === 'queued' };
}

/**
 * The operator's saved block layout from a GET /api/settings reply, or null
 * when the reply is not one.
 *
 * The route answers { settings, envKeys, cloudProviders }; the layout is
 * settings.blockLayout (DesktopLayout and MobileLayout read it there). This
 * read body.blockLayout, always undefined, so it started from an empty layout
 * and the save below — a full replace — erased every section the operator had
 * made. null is the answer for anything else (a 401, a failed read), and a
 * null layout is never written back.
 */
export function layoutFromSettings(body) {
  const s = body && typeof body === 'object' ? body.settings : null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const bl = s.blockLayout || {};
  return {
    overrides: { ...(bl.overrides || {}) },
    customGroups: { ...(bl.customGroups || {}) },
    groupOverrides: { ...(bl.groupOverrides || {}) },
  };
}

/**
 * The whole layout with one block filed under one section. POST
 * /api/settings/block-layout replaces the layout outright, so everything the
 * operator already had is carried over here — this adds, it never drops. A
 * section named here that already exists is reused, not reset.
 */
export function placeBlock(layout, blockId, groupId, customLabel) {
  const next = {
    overrides: { ...(layout?.overrides || {}), [blockId]: groupId },
    customGroups: { ...(layout?.customGroups || {}) },
    groupOverrides: { ...(layout?.groupOverrides || {}) },
  };
  // A section the operator hid (Delete on a default section hides it) and
  // now names again is shown again. Left hidden, getEffectiveBlockGroups sent
  // the block to Unsorted while this card said "Filed under" that section.
  const ov = next.groupOverrides[groupId];
  if (ov && ov.hidden) {
    const rest = { ...ov };
    delete rest.hidden;
    if (Object.keys(rest).length) next.groupOverrides[groupId] = rest; else delete next.groupOverrides[groupId];
  }
  if (customLabel && !next.customGroups[groupId]) next.customGroups[groupId] = { label: customLabel, icon: 'custom', order: 50 };
  return next;
}

/**
 * The sections to offer: the sidebar's own (getEffectiveBlockGroups, the
 * computation the sidebar and the Dashboard share), so renames and custom
 * sections appear and hidden ones do not. This used to read `group` off
 * /blocks/registry entries — raw manifests, whose group is nav.group — so no
 * default section was ever offered. Unsorted is the safety net, not a choice.
 */
export function sectionChoices(layout) {
  return getEffectiveBlockGroups(layout)
    .filter((g) => !g.safetyNet)
    .map((g) => ({ id: g.id, name: g.meta.label || labelise(g.id) }));
}

export default function InstallPanel({ onInstalled, onBlockLayoutChange }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { ok, id, label, detail, queued, error }
  const [store, setStore] = useState(null);     // what GET /api/store/source said, once

  // Read once on mount. Not refreshed after an install: the count is a hint
  // about what a bare name can reach, not a live catalog.
  useEffect(() => {
    let alive = true;
    fetch('/api/store/source', { headers: SELF_REPORTED })
      .then(async (r) => {
        const d = await r.json();
        // A store that is set but unreadable answers 502 with its reason.
        // That is not "Store connected — 0 blocks".
        if (!r.ok && !d.error) d.error = `HTTP ${r.status}`;
        return d;
      })
      .then((d) => { if (alive) setStore(d); })
      // A network failure, or the SPA fallback's HTML where JSON was expected.
      .catch(() => { if (alive) setStore({ configured: false, items: [], hint: 'The store could not be reached.' }); });
    return () => { alive = false; };
  }, []);

  const install = useCallback(async () => {
    const cls = classifySource(source);
    if (cls.kind === 'empty') {
      setResult({ ok: false, error: 'There is nothing to install yet. Paste a store link or type a block name.' });
      return;
    }
    if (cls.kind === 'insecure') {
      setResult({ ok: false, error: 'That link is not secure: it starts with http:// instead of https://. A block is a program, so AEON will not download one over a link that could be tampered with on the way. Ask the store for an https link.' });
      return;
    }
    if (cls.kind === 'unknown') {
      setResult({ ok: false, error: 'That does not look like a store link or a block name. A link starts with https://, and a name is a single word, like reports.' });
      return;
    }
    setBusy(true);
    setResult(null);   // also takes down the last section chooser, so the next starts fresh
    try {
      const r = await fetch('/api/store/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...SELF_REPORTED }, body: JSON.stringify(cls.body),
      });
      const d = (await r.json().catch(() => null)) || {};
      if (!r.ok || d.ok === false) {
        setResult({ ok: false, error: d.error || `The install was refused (HTTP ${r.status}).` });
      } else {
        const out = installOutcome(d, cls);
        setResult({ ok: true, ...out });
        if (onInstalled) onInstalled(out.id);
      }
    } catch (e) {
      setResult({ ok: false, error: `The install could not run: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }, [source, onInstalled]);

  const count = Array.isArray(store?.items) ? store.items.length : 0;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ ...DIM, margin: 0, lineHeight: 1.6 }}>
        Paste a link from the AEON block store, or type the name of a block the store offers.
        AEON downloads it, checks it is what the store said it was, and boots it once to prove it runs.
        It then lands stopped — you start it in Settings → Blocks. If any of that fails, nothing is
        installed and you are told why.
      </p>
      <div>
        <label htmlFor="master-install-source" style={{ ...DIM, display: 'block', marginBottom: 6 }}>Store link or block name</label>
        <input id="master-install-source" type="text" spellCheck={false} value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) install(); }}
          placeholder="https://store.example/reports-1.0.0.aeon — or just a name, like reports"
          style={FIELD} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn" onClick={install} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Loader2 size={14} aria-hidden="true" className="spin" /> : <Download size={14} aria-hidden="true" />}
          {busy ? 'Installing…' : 'Install'}
        </button>
        {store && store.error && (
          <span style={{ ...DIM, flex: 1 }}>
            The store could not be read ({store.error}), so only a direct https link will work.
          </span>
        )}
        {store && !store.error && !store.configured && (
          <span style={{ ...DIM, flex: 1 }}>
            No store is set up yet, so only a direct https link will work. {store.hint}
          </span>
        )}
        {store && !store.error && store.configured && (
          <span style={{ ...DIM, flex: 1 }}>
            Store connected — {count} {count === 1 ? 'block' : 'blocks'} available by name.
          </span>
        )}
      </div>
      {result && !result.ok && (
        <p role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, margin: 0, padding: '10px 12px', borderRadius: 6, fontSize: 13,
          background: 'rgba(255,68,85,0.08)', border: '1px solid rgba(255,68,85,0.35)', color: 'var(--danger, #ff4455)',
        }}>
          <AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{result.error}</span>
        </p>
      )}
      {result && result.ok && (
        <SectionChooser blockId={result.id} label={result.label} detail={result.detail} queued={result.queued}
          onBlockLayoutChange={onBlockLayoutChange} onDone={() => setResult(null)} />
      )}
    </div>
  );
}

/**
 * Where should the new block live? Asked once, right after an install, and
 * never decided here. The sections are the operator's own — renamed, custom,
 * hidden — so they are read from the server, and the write that files the
 * block replaces the whole saved layout: anything it leaves out is gone.
 * That is why placeBlock carries every existing entry across and
 * can never delete a key. A full replace is only safe from the full layout,
 * so this writes nothing until it has read the saved one.
 */
function SectionChooser({ blockId, label, detail, queued, onBlockLayoutChange, onDone }) {
  const [layout, setLayout] = useState(null);   // null until the saved layout is read
  const [readErr, setReadErr] = useState('');
  const [chosen, setChosen] = useState(null);    // the section id picked or created
  const [newName, setNewName] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  // Read from the server, not the shell's copy: the shell falls back to an
  // empty layout when its own read fails, and writing from that is the same
  // erasure this reads around.
  useEffect(() => {
    let alive = true;
    fetch('/api/settings', { headers: SELF_REPORTED })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const bl = layoutFromSettings(d);
        if (bl) setLayout(bl); else setReadErr(d?.error || 'the reply had no settings in it');
      })
      .catch((e) => { if (alive) setReadErr(e.message); });
    return () => { alive = false; };
  }, []);

  const groups = useMemo(() => (layout ? sectionChoices(layout) : []), [layout]);

  const save = useCallback(async (groupId, customLabel) => {
    setErr('');
    if (!layout) return;
    const next = placeBlock(layout, blockId, groupId, customLabel);
    try {
      const r = await fetch('/api/settings/block-layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...SELF_REPORTED }, body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setLayout(next);
      setSaved(true);
      // The shell (sidebar + Dashboard) holds its own copy and writes it back
      // whole on the next drag; left stale, that write would drop this
      // placement. `saved` tells it this layout is already on the server:
      // adopt it, do not write it again.
      if (onBlockLayoutChange) onBlockLayoutChange(next, { saved: true });
    } catch (e) {
      // The block IS installed; only its place in the sidebar was not saved.
      // Wording that suggested otherwise would send the operator to install
      // it a second time. The choices stay up, so they can simply try again.
      setErr(`${label} is installed, but its section could not be saved (${e.message}). Drag it on the Home dashboard instead.`);
    }
  }, [layout, blockId, label, onBlockLayoutChange]);

  if (!blockId) return null;
  const shownName = groups.find((g) => g.id === chosen)?.name || newName.trim() || chosen;
  return (
    <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(63,185,80,0.07)', border: '1px solid rgba(63,185,80,0.35)' }}>
      <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: 0, fontWeight: 600, fontSize: 13 }}>
        <Check size={14} aria-hidden="true" />
        {queued
          ? `${label} is waiting for your approval — its permissions need a review. Approve it in Settings → Agent, then start it.`
          : `${label} is installed${detail ? ` (${detail})` : ''}. It lands stopped: start it in Settings → Blocks. ${UI_NOTE}`}
      </p>
      {readErr ? (
        <p role="alert" style={{ ...DIM, color: 'var(--warning, #fab219)', margin: '8px 0 0' }}>
          Your sections could not be read ({readErr}), so none were changed. Drag {label} on the Home dashboard instead.
        </p>
      ) : saved ? (
        <p style={{ ...DIM, margin: '8px 0 0' }}>
          Filed under <b>{shownName}</b>.{' '}
          You can drag it somewhere else any time on the Home dashboard.{' '}
          <button type="button" onClick={onDone} style={LINK}>Install another</button>
        </p>
      ) : (
        <div style={{ marginTop: 10 }}>
          <p style={{ ...DIM, display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 8px' }}>
            <FolderInput size={14} aria-hidden="true" /> Where should we nest this block?
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {groups.map((g) => (
              <button key={g.id} type="button" className="btn" style={{ fontSize: 12 }}
                onClick={() => { setChosen(g.id); save(g.id); }}>{g.name}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" value={newName} placeholder="…or name a new section" aria-label="New section name"
              onChange={(e) => setNewName(e.target.value)} style={{ ...FIELD, flex: 1 }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !newName.trim() || !layout) return;
                const id = slug(newName);
                setChosen(id);
                save(id, newName.trim());
              }} />
            <button className="btn" disabled={!newName.trim() || !layout}
              onClick={() => {
                if (!newName.trim() || !layout) return;
                const id = slug(newName);
                setChosen(id);
                save(id, newName.trim());
              }}>
              Create
            </button>
          </div>
        </div>
      )}
      {err && <p role="alert" style={{ ...DIM, color: 'var(--warning, #fab219)', margin: '8px 0 0' }}>{err}</p>}
    </div>
  );
}

/** A stored section id as a readable name: file_manager → "File Manager". */
export const labelise = (id) => String(id).replace(/[_-]+/g, ' ').replace(/(^|\s)(\S)/g, (_, gap, c) => gap + c.toUpperCase());

/**
 * A typed section name as a stored id that survives settings: lower-case,
 * every run of anything but a–z/0–9 one underscore, none at either end.
 * Never empty — "custom" when nothing usable was typed.
 */
export const slug = (text) => String(text ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom';
