/**
 * Panel geometry — the operator's own terminal size, saved where the rest of
 * the UI preferences already live.
 *
 * The terminal shipped at exactly one size: a grid column pinned to
 * `minmax(320px, 380px)` on desktop, and a fixed sheet inset 15px from every
 * edge below 1200px. The operator asked for "a flex field that you can
 * manually do" — a width they set by hand on desktop, a height their thumb
 * can set on the sheet, and for it to still be that size after a reload.
 *
 * Two rules, borrowed from src/kernel/appearance.js because that file was
 * written to close exactly this class of defect:
 *
 *   1. ONE applier. A preference that is saved but never read looks identical
 *      to one that is working. Everything that turns a stored number into a
 *      visible change goes through applyPanelSizes() and nowhere else.
 *   2. The CSS owns the layout. This module writes two custom properties and
 *      the stylesheet decides what they mean, so the bounds, the default and
 *      the reduced-motion behaviour stay next to the rest of the layout
 *      instead of being half here and half there.
 *
 * Where it is stored: `/api/prefs/panel_sizes`, the same GET/PUT pair Settings
 * uses for appearance and theme. The server is the authority. A localStorage
 * mirror exists ONLY so the panel paints at the operator's size on the first
 * frame rather than jumping when the round-trip lands — it is a cache, never
 * the record, and every read and write of it is wrapped because storage throws
 * outright in a locked-down browser profile. If both are unavailable the panel
 * renders at its shipped default, which is the state before this existed.
 */

const PREF_KEY = 'panel_sizes';
const CACHE_KEY = 'aeon_panel_sizes';

/**
 * Bounds are fractions of the viewport, not pixels. A 1200px laptop and a
 * 3840px display disagree about what "380px" is worth, and the operator who
 * drags the terminal wide on one should not find it hugging the edge on the
 * other. Desktop only: below 1200px the panel is display:none and the sheet
 * takes over.
 */
export const TERMINAL_WIDTH = Object.freeze({ min: 20, max: 60, step: 2 });

/**
 * Sheet height, as a fraction of the viewport height. `max: 100` is clamped by
 * the stylesheet to `calc(100dvh - 30px)` — the sheet's existing full size — so
 * "full" means exactly what it meant before, not a new number.
 *
 * The snaps are what a thumb can actually hit: a peek that leaves the page
 * behind it readable, a half, and full.
 */
export const SHEET_HEIGHT = Object.freeze({
  min: 30, max: 100, step: 4,
  snaps: Object.freeze([34, 62, 100]),
});

const root = () => document.documentElement;

/**
 * Clamp to a bounds object, rejecting anything that is not already a number.
 *
 * `typeof`, not `Number()`. Number(null) is 0 and Number('') is 0, so coercing
 * would turn "this field is absent" into "the operator asked for the minimum" —
 * a cleared preference would come back as a 20% panel instead of the shipped
 * default. Rejecting is the honest answer: the caller then falls through to the
 * stylesheet, which is where the default actually lives.
 */
export function clampPct(value, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value * 10) / 10));
}

/** Nearest snap point to a free-dragged height. */
export function snapPct(value, snaps) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return snaps.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), snaps[0]);
}

/**
 * Drop anything that is not a number in range. A stored preference is data
 * from disk: a hand-edited settings file, or a cache written by an older
 * build, must not be able to collapse the layout to zero.
 */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const w = clampPct(raw.terminalWidthPct, TERMINAL_WIDTH);
  const h = clampPct(raw.sheetHeightPct, SHEET_HEIGHT);
  if (w != null) out.terminalWidthPct = w;
  if (h != null) out.sheetHeightPct = h;
  return out;
}

/**
 * The one applier. Absent fields CLEAR their custom property rather than being
 * written as a default, so "the operator never resized this" and "the operator
 * resized it back" both land on the stylesheet's own value — there is no
 * second copy of the default in JavaScript to drift from the first.
 */
export function applyPanelSizes(sizes) {
  let el;
  try { el = root(); } catch { return; }
  if (!el) return;
  const s = sanitize(sizes);

  if (s.terminalWidthPct != null) {
    // clamp() in the value as well as in the arithmetic: the stylesheet stays
    // correct even if this property is set by something that skipped sanitize.
    el.style.setProperty(
      '--terminal-w',
      `clamp(${TERMINAL_WIDTH.min}vw, ${s.terminalWidthPct}vw, ${TERMINAL_WIDTH.max}vw)`,
    );
  } else {
    el.style.removeProperty('--terminal-w');
  }

  if (s.sheetHeightPct != null) {
    el.style.setProperty('--terminal-sheet-h', `${s.sheetHeightPct}dvh`);
  } else {
    el.style.removeProperty('--terminal-sheet-h');
  }
}

/** The cache. Never the record — see the header. */
export function readCachedPanelSizes() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch { return {}; }
}

function writeCache(sizes) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(sizes)); } catch { /* storage is optional */ }
}

/**
 * The record as the SERVER last confirmed it: null until a GET has actually
 * answered, `{}` once the server has said there is nothing stored.
 *
 * The header says the server is the authority, but the write path was merging
 * its patch against browser storage and PUTting the result as the WHOLE value.
 * localStorage throws outright in a locked-down profile and is simply empty in
 * a new one, so saving one field could PUT only that field and delete the other
 * from the record — the terminal width set on a desktop erased by a sheet drag
 * on a tablet that happened to load offline. Anything the server has not
 * answered with is a hint for the first paint, never a base to overwrite the
 * record from.
 */
let record = null;
/** Fields changed here that the server has not taken yet. */
let pending = {};
let putTimer = null;
let hideBound = false;
const listeners = new Set();

/** The best value we can stand behind right now: the record, else the cache. */
export function getResolvedPanelSizes() {
  return record ? { ...record } : readCachedPanelSizes();
}

/**
 * Hear when the record lands. App.jsx reads it AFTER the first paint, so a
 * component that mounted in the meantime is holding a cached number or a
 * measurement and has no other way to learn that the real one arrived.
 */
export function subscribePanelSizes(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function publish(sizes) {
  for (const fn of [...listeners]) {
    try { fn({ ...sizes }); } catch { /* one listener must not break a load or a save */ }
  }
}

/**
 * One GET, with its three answers kept apart, because they mean different
 * things to the NEXT write:
 *
 *   • a value        → that is the record
 *   • 404 / no value → there is no record yet, and {} is a truthful base
 *   • anything else  → we do not know what is stored, and a PUT built on a
 *                      guess would delete it
 */
async function fetchRecord() {
  try {
    const r = await fetch(`/api/prefs/${PREF_KEY}`);
    if (r.status === 404) return {};
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.value == null) return {};
    return sanitize(d.value);
  } catch { return null; }
}

/**
 * Read the record. Falls back to the cache when the server cannot be reached,
 * because a terminal that still answers offline should still be the size the
 * operator left it.
 */
export async function loadPanelSizes() {
  const fetched = await fetchRecord();
  if (fetched) {
    // A save made while this was in flight is newer than what came back.
    record = sanitize({ ...fetched, ...pending });
    writeCache(record);
    if (Object.keys(pending).length) schedulePut();
  }
  const out = getResolvedPanelSizes();
  publish(out);
  return out;
}

/**
 * Coalesce the network half of a save.
 *
 * A held arrow key autorepeats at roughly 30/s and every repeat went out as its
 * own unordered PUT — the heaviest traffic came from the gesture the operator
 * uses most, holding a key for a large adjustment. Applying and caching stay
 * synchronous on every keypress, because both are cheap and the panel must not
 * lag the key; only the write waits for the key to settle.
 */
const PUT_DEBOUNCE_MS = 300;

function schedulePut() {
  bindFlushOnHide();
  if (putTimer) clearTimeout(putTimer);
  putTimer = setTimeout(() => { putTimer = null; flushPut(); }, PUT_DEBOUNCE_MS);
  // Node's timers keep the process alive; a browser's do not. Nothing should
  // wait 300ms on a preference.
  if (typeof putTimer === 'object' && putTimer?.unref) putTimer.unref();
}

/**
 * A debounce a closing tab eats is a preference the operator watched
 * themselves set and then lost. Bound on the first save rather than at module
 * load, because this module is imported where there is no window.
 */
function bindFlushOnHide() {
  if (hideBound || typeof window === 'undefined' || !window.addEventListener) return;
  hideBound = true;
  window.addEventListener('pagehide', () => {
    if (putTimer) { clearTimeout(putTimer); putTimer = null; }
    flushPut();
  });
}

async function flushPut() {
  if (!Object.keys(pending).length) return;
  // Never overwrite a record we have not read: without a confirmed base, ask
  // for one first, and if the answer is "unknown" keep the fields pending and
  // try again on the next save or the next load rather than PUTting a record
  // with the other field missing.
  const base = record || await fetchRecord();
  if (!base) return;

  const sent = pending;
  const next = sanitize({ ...base, ...sent });
  pending = {};
  record = next;
  writeCache(next);

  try {
    const r = await fetch(`/api/prefs/${PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
      // The tab may be going away — see bindFlushOnHide.
      keepalive: true,
    });
    if (!r?.ok) throw new Error(`panel_sizes PUT ${r?.status}`);
  } catch {
    // The write did not land, so what the server holds is unknown again and
    // these fields still need to go. The operator has already seen the panel
    // move and the cache already holds it; this only affects the next machine.
    pending = { ...sent, ...pending };
    record = null;
  }
}

/**
 * Write one field of the record, applying it first.
 *
 * Fire-and-forget on the network half: the operator has already seen the panel
 * move, and a failed PUT must not undo it in front of them. The cache is
 * written synchronously, so a failed PUT still survives a reload — it is the
 * record on the next machine that will be stale, and that is visible as the
 * panel being the wrong size there rather than as a silent lie here.
 */
export function savePanelSizes(patch) {
  const p = sanitize(patch || {});
  const next = sanitize({ ...getResolvedPanelSizes(), ...p });
  applyPanelSizes(next);
  writeCache(next);
  if (record) record = next;
  pending = { ...pending, ...p };
  schedulePut();
  return next;
}

/** Live value during a drag: the CSS property only, no storage, no network. */
export function previewTerminalWidth(pct) {
  const v = clampPct(pct, TERMINAL_WIDTH);
  if (v == null) return null;
  try {
    root().style.setProperty('--terminal-w', `clamp(${TERMINAL_WIDTH.min}vw, ${v}vw, ${TERMINAL_WIDTH.max}vw)`);
  } catch { return null; }
  return v;
}

/** Live value during a drag: the CSS property only. */
export function previewSheetHeight(pct) {
  const v = clampPct(pct, SHEET_HEIGHT);
  if (v == null) return null;
  try { root().style.setProperty('--terminal-sheet-h', `${v}dvh`); } catch { return null; }
  return v;
}

/**
 * Mark a drag in progress so the stylesheet can suppress its own size
 * transition. A 140ms ease on every pointermove is a panel that lags the
 * cursor, which reads as the app being slow rather than as motion design.
 */
export function setResizing(on) {
  try {
    if (on) root().setAttribute('data-panel-resizing', '');
    else root().removeAttribute('data-panel-resizing');
  } catch { /* nothing to mark */ }
}
