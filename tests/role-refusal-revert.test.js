/**
 * A role the server refuses goes back to what it was.
 *
 * updateRole puts the new pair in the page's unsaved settings and in the patch
 * the Save button posts, then asks assign-role to accept it. A 400 only showed
 * a toast, so the refused pair stayed in both and the next Save carried it.
 * snapshotRole / revertRefusedRole are the pure part of the fix (the suite has
 * no DOM): the snapshot is taken before the change, the revert after the 400.
 */
import { describe, expect, it } from 'vitest';
import { snapshotRole, revertRefusedRole, refusedRoleNotice, saveFailureNotice } from '../src/kernel/modelQuery.js';

const OLD = { provider: 'gemini', model: 'gemini-2.5-flash' };
const REFUSED = { provider: 'openrouter', model: 'gemini-flash-latest' };

// What updateRole does before it asks the server: snapshot, then apply.
const apply = (patch, models, role, change) => {
  const snap = snapshotRole(patch, models, role);
  return {
    snap,
    patch: { ...patch, models: { ...(patch.models || {}), [role]: { ...((patch.models || {})[role] || {}), ...change } } },
    models: { ...models, [role]: { ...models[role], ...change } },
  };
};

describe('revertRefusedRole', () => {
  it('puts the role back in the page settings and takes it out of the unsaved patch', () => {
    const models = { chat: OLD, grading: OLD };
    const a = apply({}, models, 'chat', REFUSED);
    expect(a.models.chat).toEqual(REFUSED);
    const r = revertRefusedRole(a.patch, a.models, 'chat', REFUSED, a.snap);
    expect(r.reverted).toBe(true);
    expect(r.models).toEqual(models);
    expect(r.patch).toEqual({});
  });

  it('keeps an earlier unsaved change to the same role, and other roles in the patch', () => {
    const models = { chat: { provider: 'gemini', model: 'gemini-2.5-flash' }, grading: OLD };
    const first = apply({ models: { grading: { model: 'g2' } }, prefs: { a: 1 } }, models, 'chat', { model: 'gemini-flash-latest' });
    const second = apply(first.patch, first.models, 'chat', { provider: 'openrouter' });
    const refused = { provider: 'openrouter', model: 'gemini-flash-latest' };
    const r = revertRefusedRole(second.patch, second.models, 'chat', refused, second.snap);
    expect(r.models.chat).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
    expect(r.patch).toEqual({ models: { grading: { model: 'g2' }, chat: { model: 'gemini-flash-latest' } }, prefs: { a: 1 } });
  });

  it('removes a role the page did not have before, and an emptied models patch', () => {
    const a = apply({}, {}, 'vision', REFUSED);
    const r = revertRefusedRole(a.patch, a.models, 'vision', REFUSED, a.snap);
    expect(r.models).toEqual({});
    expect(r.patch).toEqual({});
  });

  it('leaves a role alone that the operator has changed again since', () => {
    const a = apply({}, { chat: OLD }, 'chat', REFUSED);
    const later = apply(a.patch, a.models, 'chat', { provider: 'gemini', model: 'gemini-flash-latest' });
    const r = revertRefusedRole(later.patch, later.models, 'chat', REFUSED, a.snap);
    expect(r.reverted).toBe(false);
    expect(r.models).toEqual(later.models);
    expect(r.patch).toEqual(later.patch);
  });

  it('does not mutate what it is given', () => {
    const a = apply({}, { chat: OLD }, 'chat', REFUSED);
    const patchCopy = JSON.parse(JSON.stringify(a.patch));
    revertRefusedRole(a.patch, a.models, 'chat', REFUSED, a.snap);
    expect(a.patch).toEqual(patchCopy);
    expect(a.models.chat).toEqual(REFUSED);
  });
});

describe('refusedRoleNotice', () => {
  it('keeps the server sentence (it names the remedy) and says what the role went back to', () => {
    const msg = refusedRoleNotice('chat', OLD, 'openrouter does not serve "x". Pick a model this provider offers in Settings → Model Assignment.');
    expect(msg).toMatch(/Settings → Model Assignment/);
    expect(msg).toMatch(/chat is back on gemini \/ gemini-2\.5-flash/);
  });

  it('still names the remedy when the server sent no sentence or the role had no earlier pair', () => {
    expect(refusedRoleNotice('chat', OLD, '')).toMatch(/Model Assignment/);
    expect(refusedRoleNotice('vision', undefined, 'no')).toMatch(/vision was put back as it was/);
  });
});

describe('saveFailureNotice', () => {
  // The refusal the route really sends is checked in settings-save-model-guard
  // (the page shows that sentence through this function).
  it('shows the sentence the server answered with', () => {
    const why = 'openrouter does not serve "gemini-flash-latest". Pick another model, or re-scan the provider\'s model list. Nothing was saved.';
    expect(saveFailureNotice(400, { error: why })).toBe(why);
  });

  it('still says something, with the status, when the answer has no sentence', () => {
    expect(saveFailureNotice(500, {})).toBe('Failed to save settings (HTTP 500)');
    expect(saveFailureNotice(502, null)).toBe('Failed to save settings (HTTP 502)');
    expect(saveFailureNotice(400, { error: '   ' })).toBe('Failed to save settings (HTTP 400)');
  });
});
