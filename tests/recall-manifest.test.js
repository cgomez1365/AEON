/**
 * Recall lists before it reads, and the wake phrase says "aeon".
 *
 *   - `/matrix list <query>` returns a MANIFEST: titles, paths and scores of
 *     what matched, never a word of content. A passage costs hundreds of
 *     tokens; a title line costs tens. The operator sees what is there, then
 *     opens one document with /ask-doc.
 *   - When passages were wanted but none fit the budget, recall hands over the
 *     same list instead of an apology that named nothing.
 *   - The persona was renamed vp → Aeon and the trigger was not, so
 *     "aeon come online" silently did nothing. Both words wake now, with an
 *     optional spoken agent name.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ctx = require('../src/kernel/context.cjs');

function stubFetch(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return response; };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notOk = (status, body = {}) => ({ ok: false, status, json: async () => body });

describe('parseRecallInput — only "list" opens the manifest', () => {
  it.each([
    ['/matrix list phishing', { query: 'phishing', forced: true, manifest: true }],
    ['/MATRIX LIST Phishing', { query: 'Phishing', forced: true, manifest: true }],
    ['/matrix list "phishing lures"', { query: 'phishing lures', forced: true, manifest: true }],
    ['/matrix "list phishing"', { query: 'phishing', forced: true, manifest: true }],
    ['/matrix  list x', { query: 'x', forced: true, manifest: true }],
    ['/matrix list\n foo bar', { query: 'foo bar', forced: true, manifest: true }],
    ['/matrix list', { query: 'list', forced: true, manifest: false }],
    ['/matrix list   ', { query: 'list', forced: true, manifest: false }],
    ['/matrix listing x', { query: 'listing x', forced: true, manifest: false }],
    ['/matrix list: x', { query: 'list: x', forced: true, manifest: false }],
    ['/matrix which docs', { query: 'which docs', forced: true, manifest: false }],
    ['/matrix what changed', { query: 'what changed', forced: true, manifest: false }],
    ['list phishing', { query: 'list phishing', forced: false, manifest: false }],
  ])('%j', (input, expected) => {
    expect(ctx.parseRecallInput(input)).toEqual(expected);
  });

  it('treats null and undefined as an empty, unforced line', () => {
    expect(ctx.parseRecallInput(null)).toEqual({ query: '', forced: false, manifest: false });
    expect(ctx.parseRecallInput(undefined)).toEqual({ query: '', forced: false, manifest: false });
  });
});

describe('manifest mode — titles only', () => {
  const BODY = 'CONFIDENTIAL BODY TEXT '.repeat(400);
  const docs = [
    { id: 'org.pdf', content: BODY, similarity: 0.81234, metadata: { source: 'Org Behaviour', path: 'Reading_Library/org-behaviour.pdf' } },
    { id: 'same', content: 'SECOND BODY', similarity: 0.5, metadata: { source: 'Notes.md', path: 'Notes.md' } },
    { id: 'only-an-id.md', content: 'THIRD BODY' },
  ];

  it('lists every match with no passage text, and searches without the keyword', async () => {
    const fetchImpl = stubFetch(ok({ documents: docs, matched: 9 }));
    const r = await ctx.buildRecallContext('/matrix list phishing', { fetchImpl, budgetTokens: 100 });

    expect(fetchImpl.calls).toHaveLength(1);
    expect(JSON.parse(fetchImpl.calls[0].init.body).query).toBe('phishing');
    expect(r).toMatchObject({ query: 'phishing', forced: true, ran: true, ok: true, manifest: true, count: 3, dropped: 0, matched: 9 });
    expect(r).not.toHaveProperty('tokensUsed');
    expect(r.citations.map(c => c.n)).toEqual([1, 2, 3]);
    expect(r.citations.map(c => c.similarity)).toEqual([0.812, 0.5, null]);
    expect(r.citations[2]).toMatchObject({ title: 'only-an-id.md', path: 'only-an-id.md' });

    expect(r.context).toContain('SECOND BRAIN CONTEXT');
    expect(r.context).toContain('SEARCH RESULTS ONLY');
    expect(r.context).toContain('TITLES ONLY');
    expect(r.context).toContain('9 documents');
    expect(r.context).toContain('"phishing"');
    expect(r.context).toContain('Showing 3');
    const lines = r.context.split('\n');
    const first = lines.find(l => l.startsWith('1. '));
    const second = lines.find(l => l.startsWith('2. '));
    expect(first).toContain('Org Behaviour');
    expect(first).toContain('Reading_Library/org-behaviour.pdf');
    expect(first).toContain('0.81');
    expect(second).toBe('2. Notes.md · 0.50');
    for (const d of docs) expect(r.context).not.toContain(d.content.slice(0, 20));
  });

  it('the option asks for the shape, never for a search', async () => {
    const fetchImpl = stubFetch(ok({ documents: docs }));
    const r = await ctx.buildRecallContext('write a haiku', { fetchImpl, manifest: true });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    expect(r.context).toBe('');

    const gated = await ctx.buildRecallContext('search my notes', { fetchImpl, manifest: true });
    expect(gated.manifest).toBe(true);
    expect(gated.query).toBe('search my notes');
    expect(JSON.parse(fetchImpl.calls[0].init.body).query).toBe('search my notes');
  });

  it('a list that matched nothing is exactly a forced search that matched nothing', async () => {
    const listed = await ctx.buildRecallContext('/matrix list x', { fetchImpl: stubFetch(ok({ documents: [] })) });
    const plain = await ctx.buildRecallContext('/matrix x', { fetchImpl: stubFetch(ok({ documents: [] })) });
    expect(listed).toEqual(plain);
    expect(listed).not.toHaveProperty('manifest');
  });

  it('a refused list is refused like any /matrix search', async () => {
    const r = await ctx.buildRecallContext('/matrix list x', { fetchImpl: stubFetch(notOk(401)) });
    expect(r.error).toBe('recall_unauthorized');
    expect(r).not.toHaveProperty('manifest');
  });

  it('a matched total that is not a real number falls back to what came back', async () => {
    const r = await ctx.buildRecallContext('/matrix list x', { fetchImpl: stubFetch(ok({ documents: docs.slice(0, 2), matched: '5' })) });
    expect(r.matched).toBe(2);
  });
});

describe('none fit — the list instead of an apology', () => {
  it('returns the titles, names the budget, and loads no passage', async () => {
    const big = { id: 'big.md', content: 'y'.repeat(20000), similarity: 0.7, metadata: { source: 'big.md' } };
    const r = await ctx.buildRecallContext('/matrix recall my notes', { fetchImpl: stubFetch(ok({ documents: [big] })), budgetTokens: 50 });
    expect(r).toMatchObject({ ran: true, ok: true, manifest: true, count: 0, dropped: 1, matched: 1, tokensUsed: 0 });
    expect(r.citations).toEqual([{ n: 1, title: 'big.md', path: 'big.md', similarity: 0.7 }]);
    expect(r.context).toMatch(/none fit/i);
    expect(r.context).toContain('50');
    expect(r.context).toContain('SEARCH RESULTS ONLY');
    expect(r.context).not.toContain('yyyy');
  });

  it('passages that fit do not set manifest', async () => {
    const small = [{ id: 'a.md', content: 'short body', metadata: { source: 'a.md' } }];
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl: stubFetch(ok({ documents: small })) });
    expect(r.manifest).toBeFalsy();
    expect(r.context).toContain('Answer ONLY from these passages');
  });
});

// The wake phrase moved to src/kernel/agents.cjs (detectWake) on 2026-10-02,
// when agents got names of their own. Operator: "any wake up call should be
// good". So any spaces or punctuation may separate the words ("aeon - come
// online" did not wake before), "wake up" wakes, and a bare "online" counts
// only at the start of a message — "the aeon matrix is online" is a sentence.
describe('the wake phrase', () => {
  const WAKES = [
    ['vp come online', null],
    ['VP, come online', null],
    ['vp online', null],
    ['vp! online', null],
    ['aeon come online', null],
    ['Aeon, come online!', null],
    ['aeon online', null],
    ['hello aeon come online please', null],
    ['aeon come come online', null],
    ['aeon shield come online', 'shield'],
    ['aeon shield online', 'shield'],
    ['AEON Shield come online', 'shield'],
    ['aeon shield, come online', 'shield'],
    ['aeon protocol forensics come online', 'protocol forensics'],
    ['aeon m1 come online', 'm1'],
    ['aeon agent_7-b come online', 'agent_7-b'],
    ['aeon\ncome online', null],
    ['aeon come online.', null],
    ['aeon is online', 'is'],
    // Any separator (the operator's own "aeon - come online please" did nothing).
    ['aeon - come online please', null],
    ['aeon: come online', null],
    ['aeon — come online', null],
    ['vp,come online', null],
    ['aeon , come online', null],
    // The verb said, anywhere in the line.
    ['please, aeon come online', null],
    // Wake up.
    ['wake up aeon', null],
    ['aeon, wake up', null],
    ['wake up', null],
    ['come online', null],
  ];
  const NOT = [
    'aeonic come online',
    'vpn come online',
    'aeon comeonline',
    'aeon come onlineX',
    'aeon 7 come online',
    'aeon protocol and header forensics specialist come online',
    'is aeon online?',
    'the aeon matrix is online',
    'my vp online form',
    'what is online banking',
  ];

  it.each(WAKES)('%j wakes, naming %j', (msg, agent) => {
    expect(ctx.parseWake(msg)).toEqual({ wake: true, agent });
  });

  it.each(NOT)('%j does not wake', (msg) => {
    expect(ctx.parseWake(msg)).toEqual({ wake: false, agent: null });
  });

  it('an agent\'s own name wakes it, and null or empty never wakes', () => {
    const agents = [{ id: 'aeon', name: 'Jarvis', folder: 'Aeon', self: true }, { id: 'card_scout', name: 'Card Scout', folder: 'Card_Scout' }];
    expect(ctx.parseWake('card scout come online', agents)).toEqual({ wake: true, agent: 'card scout' });
    expect(ctx.parseWake('jarvis - online', agents)).toEqual({ wake: true, agent: 'jarvis' });
    expect(ctx.parseWake(null)).toEqual({ wake: false, agent: null });
    expect(ctx.parseWake('')).toEqual({ wake: false, agent: null });
  });
});
