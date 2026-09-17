/**
 * The two handles that let the operator size the terminal by hand.
 *
 * "currently its only one size — then if you make the screen smaller or access
 * on mobile it becomes a floating thing … so i guess a flex field that you can
 * manually do." Two surfaces, two gestures:
 *
 *   • TerminalWidthHandle — desktop. The terminal is the last column of the
 *     .command-center grid, so resizing it means resizing that TRACK, not
 *     lifting the panel out of the layout. The handle sits on the panel's inner
 *     edge and writes --terminal-w; the grid reads it. Nothing is absolutely
 *     positioned except the 8px grab strip itself, and the panel keeps its
 *     place in the grid, its flex column, its overflow and its mount animation.
 *
 *   • TerminalSheetHandle — the floating sheet, which is what the terminal
 *     becomes under 1200px and on mobile. A grabber bar at the top of the
 *     sheet drags its height and lands on peek / half / full, because a thumb
 *     aims within about a centimetre and a free height it cannot reproduce is
 *     worse than three it can.
 *
 * Both are the ARIA window-splitter pattern: role="separator", focusable,
 * arrow keys to move, Home and End for the bounds, and a focus indicator that
 * is actually visible — an INSET one, drawn by .panel-resize-handle:focus-visible
 * in aurora.css, because both handles live inside a box that clips its overflow
 * and an outline outside the element is cut away. A handle only a mouse can
 * reach is a handle half the operators do not have, and a pointer gesture that
 * leaves the handle unfocused is the same handle for anyone who drags roughly
 * and then nudges.
 *
 * Persistence and bounds live in src/kernel/panelSizes.js — one applier, one
 * record. See that file's header for where the number is stored.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TERMINAL_WIDTH, SHEET_HEIGHT,
  clampPct, snapPct, getResolvedPanelSizes, subscribePanelSizes,
  previewTerminalWidth, previewSheetHeight,
  savePanelSizes, setResizing,
} from '../kernel/panelSizes';

/**
 * The shared half of both handles: a clamped percentage, a live preview while
 * the pointer is down, and a commit on release or on a key.
 *
 * `pctRef` shadows the state because a pointerup handler closes over the state
 * it was created with, and committing the value from the START of the drag is
 * exactly the bug where a panel snaps back the moment you let go.
 */
function useHandle({ bounds, field, measure, initial, preview }) {
  const nodeRef = useRef(null);
  const pctRef = useRef(null);
  const draggingRef = useRef(false);
  // Whether the operator has moved this handle themselves. A record that lands
  // after they have already dragged is older than what they just did.
  const touchedRef = useRef(false);
  const [pct, setPct] = useState(null);

  const set = useCallback((next) => {
    const v = clampPct(next, bounds);
    if (v == null) return null;
    touchedRef.current = true;
    pctRef.current = v;
    setPct(v);
    preview(v);
    return v;
  }, [bounds, preview]);

  /**
   * What the panel measures RIGHT NOW, or null when there is nothing to
   * measure. Deliberately UNCLAMPED: this is the panel's actual size, and the
   * shipped default track is `minmax(320px, 380px)` — under TERMINAL_WIDTH.min
   * on any window wider than about 1900px. Clamping the measurement into the
   * bounds is what made the handle announce 20% for a 15% panel on a 2560px
   * display and jump 380px → 563px on the first arrow key. The bounds are what
   * the operator may SET; they are not a claim about what the panel already is.
   */
  const remeasure = useCallback(() => {
    const node = nodeRef.current;
    // offsetParent === null → display:none. Below 1200px the desktop panel is
    // hidden, measures 0, and a 0 clamped to the minimum stayed wrong for the
    // rest of the session even if the window was widened past the breakpoint.
    if (!node || node.offsetParent === null) return null;
    const m = measure(node);
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return null;
    pctRef.current = m;
    setPct(m);
    return m;
  }, [measure]);

  /** The value a key press steps FROM: stored, else measured, else the default. */
  const startValue = useCallback(
    () => pctRef.current ?? remeasure() ?? initial,
    [initial, remeasure],
  );

  // The starting value is STORED if the operator has one and MEASURED
  // otherwise. Before they have ever dragged, the panel's size comes from the
  // stylesheet; announcing a guessed aria-valuenow would be a number no screen
  // reader user could trust.
  useEffect(() => {
    const stored = getResolvedPanelSizes()[field];
    if (stored != null) { pctRef.current = stored; setPct(stored); }
    else remeasure();

    // The record arrives after the first paint (App.jsx: loadPanelSizes().then)
    // and used to reach the CSS and nothing else — a handle mounted in the
    // meantime went on announcing, and stepping from, a cache hit or a
    // measurement for the rest of the session.
    return subscribePanelSizes((sizes) => {
      if (touchedRef.current) return;
      const v = sizes[field];
      if (v == null) return;
      pctRef.current = v;
      setPct(v);
    });
  }, [field, remeasure]);

  // A handle can be unmounted mid-drag: App.jsx swaps MobileLayout for
  // DesktopLayout at the 768px breakpoint on a window resize, and the sheet
  // goes away the moment the chat is closed. The pointerup then never arrives,
  // and data-panel-resizing would stay on <html> for the rest of the session —
  // killing the .command-center and .chat-modal transitions and pinning the
  // desktop handle's accent line visible.
  useEffect(() => () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setResizing(false);
  }, []);

  return { nodeRef, pctRef, draggingRef, pct, set, startValue };
}

const commit = (field, value) => { if (value != null) savePanelSizes({ [field]: value }); };

/**
 * preventDefault stops the text selection that would otherwise smear across the
 * app during a drag — and it also suppresses the browser's own focus. Without
 * putting that back, the arrow keys do nothing after a drag until the operator
 * finds an invisible 8px strip with Tab, at the end of the tab order inside the
 * last grid column. Drag roughly, then nudge, is most of how a resize handle is
 * actually used.
 */
const beginPointer = (e) => {
  e.preventDefault();
  try { e.currentTarget.focus({ preventScroll: true }); } catch { /* not focusable here */ }
};

// ── Desktop: the terminal column's width ─────────────────────────────────
export function TerminalWidthHandle() {
  const measure = useCallback((node) => {
    const panel = node?.parentElement;
    if (!panel || !window.innerWidth) return null;
    return (panel.getBoundingClientRect().width / window.innerWidth) * 100;
  }, []);

  const { nodeRef, pctRef, draggingRef, pct, set, startValue } = useHandle({
    bounds: TERMINAL_WIDTH,
    field: 'terminalWidthPct',
    measure,
    initial: 30,
    preview: previewTerminalWidth,
  });

  // The panel's RIGHT edge does not move while its width changes, so it is the
  // fixed point to measure from — and reading it from the DOM keeps the grid's
  // own padding out of this file, where it would be a second copy of a number
  // the stylesheet owns.
  const fromPointer = (clientX) => {
    const panel = nodeRef.current?.parentElement;
    if (!panel || !window.innerWidth) return null;
    return ((panel.getBoundingClientRect().right - clientX) / window.innerWidth) * 100;
  };

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    beginPointer(e);
    draggingRef.current = true;
    setResizing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is an optimisation */ }
  };
  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setResizing(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    commit('terminalWidthPct', pctRef.current);
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    // Nothing is held down, so the drag ended somewhere we did not hear about.
    // setPointerCapture is wrapped in a try because it is an optimisation — but
    // it is also the only thing that guarantees the pointerup, so when it fails
    // or the event is eaten, this is the fallback. Without it the panel follows
    // the bare cursor every time it crosses the strip and the only way out is
    // another click.
    if (e.buttons === 0) { endDrag(e); return; }
    set(fromPointer(e.clientX));
  };

  const onKeyDown = (e) => {
    const at = startValue();
    let next = null;
    // The separator moves, not the panel: dragging it left makes the terminal
    // wider, so ArrowLeft does too.
    if (e.key === 'ArrowLeft') next = at + TERMINAL_WIDTH.step;
    else if (e.key === 'ArrowRight') next = at - TERMINAL_WIDTH.step;
    else if (e.key === 'Home') next = TERMINAL_WIDTH.min;
    else if (e.key === 'End') next = TERMINAL_WIDTH.max;
    else return;
    e.preventDefault();
    commit('terminalWidthPct', set(next));
  };

  // aria-valuetext is what an assistive technology reads when it is present, so
  // it carries the panel's REAL width even when that is outside the bounds;
  // aria-valuenow stays inside valuemin/valuemax, where a value outside the
  // range it declares would mean nothing.
  const shown = Math.round(pct ?? 30);
  const now = Math.min(TERMINAL_WIDTH.max, Math.max(TERMINAL_WIDTH.min, shown));
  return (
    <div
      ref={nodeRef}
      // This strip covers 8px of the terminal, which is a file drop target.
      // Without these two, a file dropped on the strip is handled by the
      // BROWSER — which navigates away to display it and takes the session
      // with it. Swallowing the drop loses an 8px-wide gesture; not swallowing
      // it loses the conversation.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      className="panel-resize-handle panel-resize-handle--v"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the terminal panel"
      aria-valuenow={now}
      aria-valuemin={TERMINAL_WIDTH.min}
      aria-valuemax={TERMINAL_WIDTH.max}
      aria-valuetext={`Terminal is ${shown}% of the window`}
      title="Drag to resize the terminal — arrow keys when focused"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

// ── Narrow / mobile: the floating sheet's height ─────────────────────────
export function TerminalSheetHandle() {
  const measure = useCallback((node) => {
    const sheet = node?.parentElement;
    if (!sheet || !window.innerHeight) return null;
    return (sheet.getBoundingClientRect().height / window.innerHeight) * 100;
  }, []);

  const { nodeRef, pctRef, draggingRef, pct, set, startValue } = useHandle({
    bounds: SHEET_HEIGHT,
    field: 'sheetHeightPct',
    measure,
    initial: SHEET_HEIGHT.max,
    preview: previewSheetHeight,
  });

  const fromPointer = (clientY) => {
    const sheet = nodeRef.current?.parentElement;
    if (!sheet || !window.innerHeight) return null;
    return ((sheet.getBoundingClientRect().bottom - clientY) / window.innerHeight) * 100;
  };

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    beginPointer(e);
    draggingRef.current = true;
    setResizing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is an optimisation */ }
  };
  // A thumb aims within about a centimetre, so the pointer lands on the
  // nearest snap. The keyboard does not snap — a key press is exact, and
  // rounding an exact instruction away is the opposite of helping.
  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setResizing(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    commit('sheetHeightPct', set(snapPct(pctRef.current, SHEET_HEIGHT.snaps)));
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    // See the width handle: a drag that ended without a pointerup would
    // otherwise leave the sheet following a bare finger or cursor.
    if (e.buttons === 0) { endDrag(e); return; }
    set(fromPointer(e.clientY));
  };

  const onKeyDown = (e) => {
    const at = startValue();
    let next = null;
    if (e.key === 'ArrowUp') next = at + SHEET_HEIGHT.step;
    else if (e.key === 'ArrowDown') next = at - SHEET_HEIGHT.step;
    else if (e.key === 'Home') next = SHEET_HEIGHT.min;
    else if (e.key === 'End') next = SHEET_HEIGHT.max;
    else return;
    e.preventDefault();
    commit('sheetHeightPct', set(next));
  };

  const shown = Math.round(pct ?? SHEET_HEIGHT.max);
  const now = Math.min(SHEET_HEIGHT.max, Math.max(SHEET_HEIGHT.min, shown));
  return (
    <div
      ref={nodeRef}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      className="panel-resize-handle panel-resize-handle--h"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal sheet"
      aria-valuenow={now}
      aria-valuemin={SHEET_HEIGHT.min}
      aria-valuemax={SHEET_HEIGHT.max}
      aria-valuetext={`Sheet is ${shown}% of the screen height`}
      title="Drag to resize the terminal — arrow keys when focused"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
