/**
 * Switching a role's provider never leaves the old provider's model behind.
 *
 * RoleCard's Provider <select> called onUpdate(role, 'provider', value) and
 * nothing else, so the model stayed whatever the previous provider had, and
 * updateRole then posted that stale pair to /api/connections/assign-role
 * (2026-10-05, drive audit log: chat -> openrouter-.../gemini-flash-latest, three
 * more of the same shape within 16 minutes).
 *
 * The suite has no DOM, so RoleCard (a hook-free function component) is called
 * directly and the <select>'s onChange invoked on the element it returns.
 */
import { describe, expect, it } from 'vitest';

const { RoleCard } = await import('../src/blocks/settings/index.jsx');

const PROVIDERS = [
  { id: 'gemini', label: 'Gemini', icon: 'G', fallbackModels: ['gemini-2.5-flash', 'gemini-flash-latest'], accounts: [] },
  { id: 'openrouter', label: 'OpenRouter', icon: 'O', fallbackModels: ['openrouter/free', 'google/gemini-2.5-flash'], accounts: [] },
  { id: 'groq', label: 'Groq', icon: 'Q', fallbackModels: ['canopylabs/orpheus-arabic-saudi', 'openai/gpt-oss-20b'], accounts: [] },
  { id: 'custom', label: 'Custom', icon: 'C', fallbackModels: [], accounts: [] },
];

const find = (el, pred) => {
  if (!el || typeof el !== 'object') return null;
  if (pred(el)) return el;
  const kids = el.props && el.props.children;
  for (const k of [].concat(kids || [])) { const hit = find(k, pred); if (hit) return hit; }
  return null;
};

const render = (from, liveModels = {}, roleKey = 'chat') => {
  const calls = [];
  const card = RoleCard({
    role: { key: roleKey, label: roleKey, desc: '', icon: '' },
    config: from,
    providers: { gemini: true, openrouter: true, groq: true, custom: true },
    liveModels, freeModels: {}, providerBlocks: {}, providerRegistry: PROVIDERS,
    onUpdate: (...a) => calls.push(a),
  });
  return { card, calls };
};

// Switch the role to a new provider; return the calls the card made and the config they leave.
// Folds a (field, value) call and a { field: value } call alike, so what a test
// asserts is the outcome, not which of the two shapes the card reports in.
const switchTo = (provider, from, liveModels = {}, roleKey = 'chat') => {
  const { card, calls } = render(from, liveModels, roleKey);
  find(card, (e) => e.type === 'select' && e.props.id === `role-provider-${roleKey}`).props.onChange({ target: { value: provider } });
  const next = calls.reduce((cfg, [, a, b]) => (typeof a === 'object' ? { ...cfg, ...a } : { ...cfg, [a]: b }), from);
  return { calls, next };
};

describe('RoleCard provider switch', () => {
  it('replaces a model the new provider does not list', () => {
    const { next } = switchTo('openrouter', { provider: 'gemini', model: 'gemini-flash-latest' });
    expect(next.provider).toBe('openrouter');
    expect(['openrouter/free', 'google/gemini-2.5-flash']).toContain(next.model);
  });

  it('reports the provider and the model as ONE change, never two racing on a stale config', () => {
    const { calls } = switchTo('openrouter', { provider: 'gemini', model: 'gemini-flash-latest' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('chat');
    expect(calls[0][1]).toMatchObject({ provider: 'openrouter' });
    expect(calls[0][1].model).toBeTruthy();
  });

  it('keeps the model when the new provider lists it', () => {
    const { next } = switchTo('gemini', { provider: 'openrouter', model: 'gemini-2.5-flash' });
    expect(next).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('prefers the live list over the fallback list', () => {
    const { next } = switchTo('openrouter', { provider: 'gemini', model: 'gemini-flash-latest' }, { openrouter: ['live/one', 'live/two'] });
    expect(['live/one', 'live/two']).toContain(next.model);
  });

  it('does not hand a chat role a speech model when the list starts with one', () => {
    const { next } = switchTo('groq', { provider: 'gemini', model: 'gemini-flash-latest' });
    expect(next.model).toBe('openai/gpt-oss-20b');
  });

  it('leaves the model alone when the new provider lists none (unknown is not wrong)', () => {
    const { next } = switchTo('custom', { provider: 'gemini', model: 'gemini-flash-latest' });
    expect(next).toEqual({ provider: 'custom', model: 'gemini-flash-latest' });
  });

  it('changes only the provider for "Same as Chat" (an empty provider)', () => {
    const { calls, next } = switchTo('', { provider: 'gemini', model: 'gemini-flash-latest' }, {}, 'research');
    expect(calls).toHaveLength(1);
    expect(next).toEqual({ provider: '', model: 'gemini-flash-latest' });
  });
});

describe('RoleCard model pick', () => {
  it('reports only the model', () => {
    const { card, calls } = render({ provider: 'gemini', model: 'gemini-2.5-flash' });
    find(card, (e) => e.props && e.props.id === 'role-model-chat').props.onChange('gemini-flash-latest');
    expect(calls).toEqual([['chat', { model: 'gemini-flash-latest' }]]);
  });
});
