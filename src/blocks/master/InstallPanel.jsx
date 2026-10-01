/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
 * Everything under this panel already existed as kernel routes
 * (src/kernel/routers/store.cjs, mounted at /api/store): POST
 * /api/store/install takes { url } (https only), { name } (from the
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
 * POST /api/store/update swaps a version only if the new one goes live and
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
 * 2026-09-28 — this panel shipped calling /blocks/store/source and
 * /blocks/store/install. Nothing has ever been mounted there: /blocks serves
 * only /registry, /widgets and /state. The GET fell through to the SPA
 * fallback (index.html, 200), so the panel said "the store could not be
 * reached" with AEON_STORE set; every install was an Express 404. The paths
 * below are the ones Settings → Blocks (settings/blockLifecycle.js) and the
 * CLI already use, and tests/sweep-master-install-panel.test.js checks every
 * path this file fetches against what the server mounts.
 *
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
 * It asks for no licence. A key checked in the browser is a key anyone skips
 * with devtools, so a gated store's check belongs on the install route,
 * server-side — and /api/store/install has none (installCartridge reads name,
 * url or base64, nothing else). The key field this panel had went nowhere: it
 * told the operator a key had been judged when nothing read it. It comes back
 * with the server check, not before.
/* AEON-REWRITE[store] 5 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
import { getEffectiveBlockGroups } from '../../kernel/blockRegistry.js';
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
// This panel shows every refusal inline. The header keeps the global
// forensics banner (interceptorPolicy.shouldBannerResponse) from ALSO firing
// on an expected refusal — a lint stop, an already-installed block, an
// unreadable store — the same header Settings → Blocks sends on these routes.
const SELF_REPORTED = { 'x-aeon-self-reported': '1' };
// Said with every install that lands: the block list and nav are compiled into
// the screen bundle (Settings → Blocks says the same).
const UI_NOTE = 'Its screen appears after `npm run build` and a reload of this tab — no restart needed.';
/* AEON-REWRITE[store] 25 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
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
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
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
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  const [result, setResult] = useState(null);   // { ok, id, label, detail, queued, error }
/* AEON-REWRITE[store] 7 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
    fetch('/api/store/source', { headers: SELF_REPORTED })
      .then(async (r) => {
        const d = await r.json();
        // A store that is set but unreadable answers 502 with its reason.
        // That is not "Store connected — 0 blocks".
        if (!r.ok && !d.error) d.error = `HTTP ${r.status}`;
        return d;
      })
/* AEON-REWRITE[store] 16 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
      const r = await fetch('/api/store/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...SELF_REPORTED }, body: JSON.stringify(cls.body),
/* AEON-REWRITE[store] 5 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        const out = installOutcome(d, cls);
        setResult({ ok: true, ...out });
        if (onInstalled) onInstalled(out.id);
/* AEON-REWRITE[store] 4 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  }, [source, onInstalled]);
/* AEON-REWRITE[store] 5 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        AEON downloads it, checks it is what the store said it was, and boots it once to prove it runs.
        It then lands stopped — you start it in Settings → Blocks. If any of that fails, nothing is
        installed and you are told why.
/* AEON-REWRITE[store] 14 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        {store && store.error && (
          <span style={{ ...DIM, flex: 1 }}>
            The store could not be read ({store.error}), so only a direct https link will work.
          </span>
        )}
        {store && !store.error && !store.configured && (
/* AEON-REWRITE[store] 4 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        {store && !store.error && store.configured && (
/* AEON-REWRITE[store] 15 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        <SectionChooser blockId={result.id} label={result.label} detail={result.detail} queued={result.queued}
          onBlockLayoutChange={onBlockLayoutChange} onDone={() => setResult(null)} />
/* AEON-REWRITE[store] 13 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
 * can never delete a key. A full replace is only safe from the full layout,
 * so this writes nothing until it has read the saved one.
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
function SectionChooser({ blockId, label, detail, queued, onBlockLayoutChange, onDone }) {
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  const [readErr, setReadErr] = useState('');
/* AEON-REWRITE[store] 5 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  // Read from the server, not the shell's copy: the shell falls back to an
  // empty layout when its own read fails, and writing from that is the same
  // erasure this reads around.
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
    fetch('/api/settings', { headers: SELF_REPORTED })
      .then((r) => r.json())
      .then((d) => {
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        const bl = layoutFromSettings(d);
        if (bl) setLayout(bl); else setReadErr(d?.error || 'the reply had no settings in it');
      })
      .catch((e) => { if (alive) setReadErr(e.message); });
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  const groups = useMemo(() => (layout ? sectionChoices(layout) : []), [layout]);

/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
    if (!layout) return;
    const next = placeBlock(layout, blockId, groupId, customLabel);
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        method: 'POST', headers: { 'Content-Type': 'application/json', ...SELF_REPORTED }, body: JSON.stringify(next),
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
      // The shell (sidebar + Dashboard) holds its own copy and writes it back
      // whole on the next drag; left stale, that write would drop this
      // placement. `saved` tells it this layout is already on the server:
      // adopt it, do not write it again.
      if (onBlockLayoutChange) onBlockLayoutChange(next, { saved: true });
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
      setErr(`${label} is installed, but its section could not be saved (${e.message}). Drag it on the Home dashboard instead.`);
/* AEON-REWRITE[store] 1 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
  }, [layout, blockId, label, onBlockLayoutChange]);
/* AEON-REWRITE[store] 7 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
        <Check size={14} aria-hidden="true" />
        {queued
          ? `${label} is waiting for your approval — its permissions need a review. Approve it in Settings → Agent, then start it.`
          : `${label} is installed${detail ? ` (${detail})` : ''}. It lands stopped: start it in Settings → Blocks. ${UI_NOTE}`}
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
      {readErr ? (
        <p role="alert" style={{ ...DIM, color: 'var(--warning, #fab219)', margin: '8px 0 0' }}>
          Your sections could not be read ({readErr}), so none were changed. Drag {label} on the Home dashboard instead.
        </p>
      ) : saved ? (
/* AEON-REWRITE[store] 2 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
          You can drag it somewhere else any time on the Home dashboard.{' '}
/* AEON-REWRITE[store] 17 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
                if (e.key !== 'Enter' || !newName.trim() || !layout) return;
/* AEON-REWRITE[store] 3 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
            <button className="btn" disabled={!newName.trim() || !layout}
/* AEON-REWRITE[store] 16 line(s) removed: written on the 2026-09-24 work machine; re-implement from the store spec */
