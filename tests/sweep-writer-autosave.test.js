/**
 * Writer autosave: "unsaved" clears only when the save was kept (sweep C19, C38).
 *
 * silentSave called setDirty(false) after any answer that parsed as JSON — a
 * 401 once the session was locked (every restart, with lockEveryLaunch), a 503
 * with the block stopped from Settings → Blocks. The draft looked saved, both
 * autosave timers stopped (they only run while dirty), and closing the tab
 * lost the edits. Nothing stopped a second save starting while the first was
 * out either, so a new document's first write that outlasted the 500 ms
 * debounce tick minted one more doc-<ts> per tick.
 *
 * These drive the save rules the editor uses (createSaveGate). The suite has
 * no DOM, so the component's wiring of them is not rendered here.
 */
import { describe, expect, it } from 'vitest';
import { createSaveGate } from '../src/blocks/writer/index.jsx';

const ok = (id = 'doc-a') => ({ httpOk: true, status: 200, body: { ok: true, id } });
const locked = { httpOk: false, status: 401, body: { success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true, reason: 'stale-boot' } };
const stopped = { httpOk: false, status: 503, body: { error: 'block "writer" is stopped (manual-start block)' } };

function editedGate() {
  const g = createSaveGate();
  g.edited();
  return g;
}

describe('a save the server refused keeps the draft unsaved', () => {
  it('401 after a restart: still unsaved, and it says to sign in', () => {
    const g = editedGate();
    const out = g.end(g.begin('doc-a'), locked);
    expect(out.saved).toBe(false);
    expect(out.clearDirty).toBe(false);
    expect(out.error).toMatch(/sign in/);
  });

  it('503 with Writer stopped: still unsaved, with the server\'s reason', () => {
    const g = editedGate();
    const out = g.end(g.begin('doc-a'), stopped);
    expect(out.clearDirty).toBe(false);
    expect(out.error).toMatch(/stopped/);
  });

  it('a 200 that does not say ok is not a save', () => {
    const g = editedGate();
    const out = g.end(g.begin('doc-a'), { httpOk: true, status: 200, body: { error: 'nope' } });
    expect(out.saved).toBe(false);
    expect(out.clearDirty).toBe(false);
  });

  it('no answer at all: still unsaved, and the next save can start', () => {
    const g = editedGate();
    const out = g.end(g.begin('doc-a'), { thrown: new TypeError('Failed to fetch') });
    expect(out.clearDirty).toBe(false);
    expect(out.error).toMatch(/could not reach/);
    expect(g.begin('doc-a')).not.toBeNull();
  });

  it('after a failure the debounce waits for a new edit; the 30 s interval is the retry', () => {
    const g = editedGate();
    g.end(g.begin('doc-a'), locked);
    expect(g.hasUntriedEdits()).toBe(false); // no 500 ms loop against a locked session
    const retry = g.begin('doc-a');          // the periodic net still may
    expect(retry).not.toBeNull();
    g.end(retry, ok());
    g.edited();
    expect(g.hasUntriedEdits()).toBe(true);
  });

  it('a save the server kept clears it', () => {
    const g = editedGate();
    const out = g.end(g.begin('doc-a'), ok());
    expect(out).toMatchObject({ saved: true, clearDirty: true, error: '' });
  });
});

describe('one save at a time', () => {
  it('a new document is created once, however many ticks fire while its first save is out', () => {
    const g = editedGate();
    const first = g.begin(undefined);
    expect(first.id).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(g.begin(undefined)).toBeNull();

    const out = g.end(first, ok('doc-new'));
    expect(out.adoptId).toBe('doc-new');
    // A timer still holding the render from before the id arrived asks with
    // none: it gets the id the server minted, not a second document.
    expect(g.begin(undefined).id).toBe('doc-new');
  });

  it('edits made while the save was out stay unsaved', () => {
    const g = editedGate();
    const t = g.begin('doc-a');
    g.edited();
    const out = g.end(t, ok());
    expect(out.saved).toBe(true);
    expect(out.clearDirty).toBe(false);
    expect(g.hasUntriedEdits()).toBe(true);
  });

  it('an answer for the previous document does not touch the one now open', () => {
    const g = editedGate();
    const t = g.begin(undefined);
    g.switched(); // New, or another document opened, before the answer came
    const out = g.end(t, ok('doc-old'));
    expect(out).toMatchObject({ saved: true, sameDoc: false, adoptId: null, clearDirty: false });
    // The new document must not inherit the old one's id.
    expect(g.begin(undefined).id).toBeUndefined();
  });
});
