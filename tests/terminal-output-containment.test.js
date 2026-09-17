/**
 * The terminal is a narrow column, and an answer may not leave it.
 *
 * react-markdown was handed a components map with exactly one entry — the
 * anchor — so every other element rendered at browser defaults. An unstyled
 * <table> sizes to its content, and in a 380px panel the operator got a table
 * whose right-hand column wrapped to one character per line and ran off the
 * edge: "responses will sometimes leak out of confinement" (2026-09-17).
 *
 * Eyeballing this does not hold. The defect is invisible until a model happens
 * to answer with a wide table, which is exactly the answer nobody types into a
 * smoke test — so the contract is asserted here instead: every element that can
 * be wider than the panel carries its own containment, and the two prompt
 * paths ask for the same shape in the same words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import { MD } from '../src/components/Terminal2.jsx';
import {
  TERMINAL_WIDTH, SHEET_HEIGHT, clampPct, snapPct, sanitize,
} from '../src/kernel/panelSizes.js';
import { TerminalWidthHandle, TerminalSheetHandle } from '../src/components/PanelResizer.jsx';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const kernelContext = require('../src/kernel/context.cjs');

const render = (md) =>
  renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: MD }, md),
  );

const TABLE = [
  '| Block | Status | Reason |',
  '|---|---:|---|',
  '| aeon_matrix | READY | indexed 412 documents from the operator vault |',
  '| cookbook | BLOCKED | no embedding model is installed on this machine |',
].join('\n');

describe('a wide answer scrolls inside the terminal instead of pushing it', () => {
  it('a table is wrapped in its own horizontal scroller', () => {
    const html = render(TABLE);
    // The wrapper comes BEFORE the table, and it is the thing that scrolls.
    const wrapper = html.slice(0, html.indexOf('<table'));
    expect(wrapper, 'the table has no scrolling container').toMatch(/overflow-x:\s*auto/);
    expect(wrapper).toMatch(/max-width:\s*100%/);
  });

  it('cells wrap as a unit, not one character per line', () => {
    const html = render(TABLE);
    // (?=[\s>]) so <thead> is not mistaken for a cell.
    const cells = html.match(/<t[dh](?=[\s>])[^>]*>/g) || [];
    expect(cells.length, 'no cells rendered').toBeGreaterThan(4);
    for (const cell of cells) {
      expect(cell, `cell has no nowrap: ${cell}`).toMatch(/white-space:\s*nowrap/);
    }
  });

  it('the table keeps the alignment remark-gfm gave it', () => {
    // Regression guard on the merge order: spreading our own style AFTER the
    // incoming props would silently drop the operator's `---:` column.
    expect(render(TABLE)).toMatch(/text-align:\s*right/);
  });

  it('a fenced block gets its own scroller and its own face', () => {
    const html = render('```js\nconst averyLongIdentifierThatWillNotFitInThePanel = 1;\n```');
    const pre = html.match(/<pre[^>]*>/)?.[0] || '';
    expect(pre, 'no <pre> rendered').not.toBe('');
    expect(pre).toMatch(/overflow-x:\s*auto/);
    expect(pre).toMatch(/max-width:\s*100%/);
    // The <code> inside must not repeat the block's padding or background.
    const code = html.match(/<code[^>]*>/)?.[0] || '';
    expect(code).toMatch(/background:\s*none/);
  });

  it('inline code is styled, and is not the same thing as a fenced block', () => {
    const html = render('run `npm run dev` first');
    expect(html).not.toMatch(/<pre/);
    const code = html.match(/<code[^>]*>/)?.[0] || '';
    // A subtle background, and a token wider than the whole column breaks
    // rather than leaving the panel.
    expect(code).toMatch(/background:\s*rgba\(0,\s*242,\s*255/);
    expect(code).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('an image can never be wider than the panel', () => {
    expect(render('![a](/brand/aeon-mark/aeon-mark.svg)')).toMatch(/max-width:\s*100%/);
  });

  it('lists, headings and quotes are styled rather than left at browser defaults', () => {
    const html = render('# Title\n\n## Section\n\n- one\n- two\n\n> quoted\n\n---\n');
    for (const tag of ['h1', 'h2', 'ul', 'li', 'blockquote', 'hr']) {
      expect(html, `<${tag}> has no style — it is at browser defaults`)
        .toMatch(new RegExp(`<${tag}[^>]*style=`));
    }
  });

  it('prose can break a token wider than the column', () => {
    const html = render('see https://example.com/a/very/long/path/that/never/breaks/anywhere');
    expect(html).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the panel holds the line in the layout, not just in the markdown', () => {
  const terminal = fs.readFileSync(path.join(ROOT, 'src/components/Terminal2.jsx'), 'utf8');

  it('the transcript scroller does not scroll sideways — each wide thing does', () => {
    // With overflow-y:auto and overflow-x left at `visible`, CSS computes the
    // x axis to `auto` too, so one wide answer dragged the WHOLE transcript
    // sideways. Each table and code block carries its own scroller instead.
    expect(terminal).toMatch(/overflowY: 'auto', overflowX: 'hidden'/);
  });

  it('the flex child that holds an answer can be narrower than its content', () => {
    // min-width:0 is the declaration that actually lets a flex item shrink; a
    // long URL or hash is what breaks a flex row, not a long sentence.
    const row = terminal.match(/const roleColor[\s\S]{0,1400}?ReactMarkdown/)?.[0] || '';
    expect(row, 'the message row was not found').not.toBe('');
    expect(row).toMatch(/flex: 1, minWidth: 0/);
  });
});

describe('the prompt asks for structure, once, without weakening the truth rules', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('the directive is short enough to ride on every turn', () => {
    expect(typeof kernelContext.FORMATTING).toBe('string');
    const sentences = kernelContext.FORMATTING.split('.').filter((s) => s.trim()).length;
    expect(sentences, 'the formatting directive has grown past a few sentences')
      .toBeLessThanOrEqual(3);
    expect(kernelContext.FORMATTING.length).toBeLessThan(420);
  });

  it('it governs shape only, and says so', () => {
    // Without this clause "be brief" is the licence a model needs to drop the
    // caveat, the citation, or the admission that it found nothing.
    expect(kernelContext.FORMATTING).toMatch(/never drop a caveat, a citation, or an admission of uncertainty/i);
  });

  it('both conversational paths use the same string, not two copies', () => {
    for (const file of ['src/kernel/routers/ai.cjs', 'src/blocks/dashboard/api/chat-stream.cjs']) {
      const src = read(file);
      expect(src, `${file} does not carry the shared formatting directive`)
        .toMatch(/kernelContext\.FORMATTING/);
      expect(src, `${file} inlines its own copy of the directive`)
        .not.toMatch(/narrow terminal panel/);
    }
  });

  it('it never outranks the memory rules on the same system turn', () => {
    // mem.text ends with the MEMORY RULES block; the directive must come
    // before it so the memory policy stays the last word.
    const src = read('src/blocks/dashboard/api/chat-stream.cjs');
    const line = src.match(/role: 'system', content:[\s\S]*?mem\.text/)?.[0] || '';
    expect(line, 'the system turn was not found').not.toBe('');
    expect(line.indexOf('kernelContext.FORMATTING')).toBeLessThan(line.indexOf('mem.text'));
  });
});

describe('the size the operator chose is the size that comes back', () => {
  it('bounds are fractions of the viewport, not pixels', () => {
    // A number that is right on a 1280px laptop is wrong on a 3840px display.
    // Percentages are the only form that survives both.
    expect(TERMINAL_WIDTH.min).toBeGreaterThan(0);
    expect(TERMINAL_WIDTH.max).toBeLessThanOrEqual(100);
    expect(TERMINAL_WIDTH.min).toBeLessThan(TERMINAL_WIDTH.max);
    expect(SHEET_HEIGHT.snaps.length).toBeGreaterThanOrEqual(3);
    for (const snap of SHEET_HEIGHT.snaps) {
      expect(snap, `snap ${snap} is outside its own bounds`)
        .toBeGreaterThanOrEqual(SHEET_HEIGHT.min);
      expect(snap).toBeLessThanOrEqual(SHEET_HEIGHT.max);
    }
  });

  it('a stored value can never collapse the panel', () => {
    // The record is a file on disk and the cache is browser storage: both can
    // be hand-edited, and both can be written by an older build.
    expect(clampPct(-400, TERMINAL_WIDTH)).toBe(TERMINAL_WIDTH.min);
    expect(clampPct(9000, TERMINAL_WIDTH)).toBe(TERMINAL_WIDTH.max);
    expect(clampPct('wide', TERMINAL_WIDTH)).toBeNull();
    expect(clampPct(null, TERMINAL_WIDTH)).toBeNull();
    expect(sanitize({ terminalWidthPct: 'nonsense' })).toEqual({});
    expect(sanitize(null)).toEqual({});
    expect(sanitize({ terminalWidthPct: 34, junk: 1 })).toEqual({ terminalWidthPct: 34 });
  });

  it('a thumb lands on a snap point', () => {
    const [peek, half, full] = SHEET_HEIGHT.snaps;
    expect(snapPct(peek + 3, SHEET_HEIGHT.snaps)).toBe(peek);
    expect(snapPct(half - 4, SHEET_HEIGHT.snaps)).toBe(half);
    expect(snapPct(full - 2, SHEET_HEIGHT.snaps)).toBe(full);
  });
});

describe('the handle is reachable without a mouse', () => {
  // A handle only a mouse can reach is a handle half the operators do not
  // have. This also renders both components, which is the cheapest way to
  // catch a hook or an identifier that only fails when the thing is drawn.
  const cases = [
    ['width', TerminalWidthHandle, 'vertical', TERMINAL_WIDTH],
    ['sheet height', TerminalSheetHandle, 'horizontal', SHEET_HEIGHT],
  ];

  it.each(cases)('the %s handle is a focusable ARIA separator', (_name, Handle, orientation, bounds) => {
    const html = renderToStaticMarkup(React.createElement(Handle));
    expect(html).toMatch(/role="separator"/);
    expect(html).toMatch(new RegExp(`aria-orientation="${orientation}"`));
    expect(html).toMatch(/tabindex="0"/i);
    expect(html).toMatch(/aria-label="[^"]+"/);
    expect(html).toMatch(new RegExp(`aria-valuemin="${bounds.min}"`));
    expect(html).toMatch(new RegExp(`aria-valuemax="${bounds.max}"`));
    // aria-valuenow is what a screen reader actually announces; without it the
    // other three say a slider exists and refuse to say where it is.
    expect(html).toMatch(/aria-valuenow="\d+"/);
  });
});

describe('the attachment strip keeps its own remove control', () => {
  const terminal = fs.readFileSync(path.join(ROOT, 'src/components/Terminal2.jsx'), 'utf8');
  const strip = terminal.match(/\{pendingImage && \([\s\S]*?\n      \)\}/)?.[0] || '';

  it('the strip was found at all', () => {
    expect(strip, 'the pending-attachment strip is not where this test expects it').not.toBe('');
  });

  it('the filename shrinks and the icons do not', () => {
    // A bare text node is an anonymous flex item whose automatic minimum size
    // is its min-content width: in a 400px panel the row measured 1282px wide
    // and the ✕ landed ~880px outside the clip, where it cannot be clicked.
    // Roughly 50 characters was the whole budget, which a screenshot filename
    // already spends.
    expect(strip, 'the filename is not in a shrinkable element')
      .toMatch(/flex: 1, minWidth: 0[\s\S]*?textOverflow: 'ellipsis'/);
    expect(strip, 'the whole name is not recoverable').toMatch(/title=\{pendingImage\.name\}/);
    // Both icons: the paperclip in front of the name and the ✕ behind it.
    expect((strip.match(/flexShrink: 0/g) || []).length,
      'an icon on this row can still be squeezed').toBeGreaterThanOrEqual(2);
  });
});

describe('the resize handle cannot be stranded mid-drag', () => {
  const resizer = fs.readFileSync(path.join(ROOT, 'src/components/PanelResizer.jsx'), 'utf8');
  const moves = resizer.match(/const onPointerMove = \(e\) => \{[\s\S]*?\n  \};/g) || [];

  it('both handles have a pointermove handler to check', () => {
    expect(moves.length).toBe(2);
  });

  it('a move with no button down ends the drag instead of resizing', () => {
    // setPointerCapture is the only thing that guarantees the pointerup, and it
    // is wrapped in a try because it can fail. Without this check a missed
    // pointerup leaves draggingRef true, and the panel then follows the BARE
    // cursor every time it crosses the strip.
    for (const move of moves) {
      expect(move, `a pointermove that never checks e.buttons:\n${move}`)
        .toMatch(/e\.buttons === 0/);
    }
  });

  it('losing the capture ends the drag too', () => {
    expect((resizer.match(/onLostPointerCapture=\{endDrag\}/g) || []).length).toBe(2);
  });

  it('a handle unmounted mid-drag clears the global resizing flag', () => {
    // App.jsx swaps the layouts at 768px and the sheet unmounts when the chat
    // closes. data-panel-resizing left on <html> kills the .command-center and
    // .chat-modal transitions for the rest of the session.
    expect(resizer, 'useHandle registers no unmount cleanup')
      .toMatch(/useEffect\(\(\) => \(\) => \{[\s\S]*?setResizing\(false\);/);
  });

  it('a pointer gesture focuses the handle it grabbed', () => {
    // preventDefault stops the text selection AND the browser's own focus, so
    // without this the arrow keys do nothing after a drag until the operator
    // finds an invisible 8px strip with Tab.
    const begin = resizer.match(/const beginPointer[\s\S]*?\n\};/)?.[0] || '';
    expect(begin, 'beginPointer was not found').not.toBe('');
    expect(begin).toMatch(/preventDefault\(\)/);
    expect(begin).toMatch(/\.focus\(/);
    expect((resizer.match(/beginPointer\(e\)/g) || []).length,
      'a handle still calls preventDefault without restoring focus').toBe(2);
  });
});

describe('the handle announces the panel it actually has', () => {
  const resizer = fs.readFileSync(path.join(ROOT, 'src/components/PanelResizer.jsx'), 'utf8');

  it('a measurement outside the bounds is kept, not clamped at mount', () => {
    // The shipped track is minmax(320px, 380px): on a 2560px display that is
    // 14.8%, under TERMINAL_WIDTH.min. Clamping the MEASUREMENT made the handle
    // announce 20% and jump 380px → 563px on the first ArrowLeft. The bounds
    // are what the operator may SET, not a claim about what the panel is.
    const remeasure = resizer.match(/const remeasure = useCallback[\s\S]*?\}, \[measure\]\);/)?.[0] || '';
    expect(remeasure, 'remeasure was not found').not.toBe('');
    expect(remeasure, 'the measurement is still being clamped into the bounds')
      .not.toMatch(/clampPct/);
    // display:none measures 0, and a 0 clamped to the minimum stayed wrong.
    expect(remeasure).toMatch(/offsetParent === null/);
  });

  it('the record reaches the handle when it lands after the first paint', () => {
    expect(resizer, 'nothing re-syncs the handle when loadPanelSizes resolves')
      .toMatch(/subscribePanelSizes\(/);
  });

  it.each([
    ['width', TerminalWidthHandle, TERMINAL_WIDTH],
    ['sheet height', TerminalSheetHandle, SHEET_HEIGHT],
  ])('the %s handle keeps aria-valuenow inside the range it declares', (_n, Handle, bounds) => {
    // aria-valuetext is what an AT reads when it is present, so the honest
    // number lives there; valuenow outside its own valuemin/valuemax would mean
    // nothing to anything that computes a position from it.
    const html = renderToStaticMarkup(React.createElement(Handle));
    const now = Number(html.match(/aria-valuenow="(\d+)"/)?.[1]);
    expect(Number.isFinite(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(bounds.min);
    expect(now).toBeLessThanOrEqual(bounds.max);
    expect(html).toMatch(/aria-valuetext="[^"]*\d+%[^"]*"/);
  });
});

describe('the focus indicator survives the panel that clips it', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/aurora.css'), 'utf8');

  it('the handles draw their own inset ring', () => {
    // The global :focus-visible rule is `outline: 2px solid` with a 2px offset,
    // and both handles sit inside overflow:hidden boxes — .module-panel and
    // .chat-modal — so three of its four edges are clipped away.
    const rule = css.match(/\.panel-resize-handle:focus-visible \{[^}]*\}/)?.[0] || '';
    expect(rule, 'the handles have no focus rule of their own').not.toBe('');
    expect(rule).toMatch(/box-shadow:\s*inset/);
    // The global rule carries !important, so anything less is ignored.
    expect(rule).toMatch(/outline:\s*none\s*!important/);
  });

  it('a focused handle does not look identical to a hovered one', () => {
    // Both were `opacity: 0.75`, so a keyboard operator saw exactly what a
    // mouse operator gets by hovering — not the distinguishable indicator
    // WCAG 2.4.7 asks for.
    for (const v of ['v', 'h']) {
      const focus = css.match(new RegExp(`\\.panel-resize-handle--${v}:focus-visible::before \\{[^}]*\\}`))?.[0] || '';
      expect(focus, `the --${v} handle has no focused state of its own`).not.toBe('');
      const hoverIdx = css.indexOf(`.panel-resize-handle--${v}:hover::before`);
      expect(css.indexOf(focus), 'the focus rule is overridden by the hover rule above it')
        .toBeGreaterThan(hoverIdx);
    }
  });
});

describe('a save cannot delete the field it is not writing', () => {
  const fresh = async () => { vi.resetModules(); return import('../src/kernel/panelSizes.js'); };

  // The record the "server" holds, plus a switch for a server that cannot be
  // reached at all — which is the case that used to cause the data loss.
  const stubFetch = (state) => {
    const calls = { gets: 0, puts: [] };
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PUT') { calls.puts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }
      calls.gets += 1;
      if (state.offline) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ value: state.value }) };
    };
    return calls;
  };

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

  it('the write merges against the record, not against browser storage', async () => {
    vi.useFakeTimers();
    const state = { value: { terminalWidthPct: 45 } };
    const calls = stubFetch(state);
    const { loadPanelSizes, savePanelSizes } = await fresh();

    await loadPanelSizes();
    savePanelSizes({ sheetHeightPct: 62 });
    await vi.advanceTimersByTimeAsync(400);

    // localStorage does not exist in this environment, which is exactly the
    // locked-down profile the header warns about: the old write path would
    // have PUT { sheetHeightPct: 62 } and dropped the width from the record.
    expect(calls.puts.length).toBe(1);
    expect(calls.puts[0].value).toEqual({ terminalWidthPct: 45, sheetHeightPct: 62 });
  });

  it('a record we could not read is never overwritten, and the change is not lost', async () => {
    vi.useFakeTimers();
    const state = { offline: true, value: { terminalWidthPct: 45 } };
    const calls = stubFetch(state);
    const { loadPanelSizes, savePanelSizes } = await fresh();

    await loadPanelSizes();              // fails: we do not know what is stored
    savePanelSizes({ sheetHeightPct: 62 });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.puts.length, 'a partial record was PUT over one we never read').toBe(0);

    // …and when the server comes back the change goes out on top of the record
    // it could not read before.
    state.offline = false;
    await loadPanelSizes();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.puts.length).toBe(1);
    expect(calls.puts[0].value).toEqual({ terminalWidthPct: 45, sheetHeightPct: 62 });
  });

  it('a held arrow key is one write, not thirty', async () => {
    vi.useFakeTimers();
    const calls = stubFetch({ value: { terminalWidthPct: 30 } });
    const { loadPanelSizes, savePanelSizes } = await fresh();
    await loadPanelSizes();

    // Autorepeat is roughly 30/s, and every repeat used to be its own unordered
    // PUT — the heaviest traffic came from the gesture the operator uses most.
    for (let i = 0; i < 30; i += 1) {
      savePanelSizes({ terminalWidthPct: 30 + i });
      await vi.advanceTimersByTimeAsync(33);
    }
    await vi.advanceTimersByTimeAsync(400);

    expect(calls.puts.length).toBe(1);
    expect(calls.puts[0].value.terminalWidthPct).toBe(59);
  });
});
