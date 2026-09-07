/**
 * BO-MEM M1 — the one recall policy, and the failures it must never repeat.
 *
 * Three defects are pinned here because each was invisible in normal use: every
 * step succeeded, the operator got a confident answer, and nothing in the logs
 * said otherwise.
 *
 *   1. The recall call carried no credentials onto a route declaring auth:true.
 *      With the guard on it 401'd; a 401 body has neither `documents` nor
 *      `unavailable`, so the caller fell through every branch and reported
 *      "no relevant indexed documents were found" — a negative answer for a
 *      search that never ran. A locked install reported an empty vault.
 *   2. Retrieved documents were the only context block outside the token
 *      budget — up to four times the memory allowance, unaccounted.
 *   3. The gate existed three times and had drifted in eight ways.
 *
 * Doctrine: R01 (a claim carries its source), R03 (say what was dropped),
 * R05 (one recall policy in one place), §08 (no silent failure; an error names
 * its remedy).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ctx = require('../src/kernel/context.cjs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A fetch stand-in that records what it was called with. */
function stubFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  fn.calls = calls;
  return fn;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notOk = (status, body = {}) => ({ ok: false, status, json: async () => body });

const doc = (source, content = 'a document body', similarity = 0.72) => ({
  id: source, content, similarity, metadata: { source },
});

describe('a refused search is never reported as an empty vault', () => {
  it('401 reports not-ran, and tells the model the documents were NOT searched', async () => {
    const fetchImpl = stubFetch(notOk(401, { success: false, error: 'UNAUTHORIZED_SESSION' }));
    const r = await ctx.buildRecallContext('what did I say about the vault', { fetchImpl });

    expect(r.ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('recall_unauthorized');
    // The exact sentence the old code produced, which must never appear here.
    expect(r.context).not.toMatch(/no relevant indexed documents were found/i);
    expect(r.context).toMatch(/never searched/i);
    // §08 — an error names its remedy.
    expect(r.context).toMatch(/unlock/i);
  });

  it('a 500 is also not an empty result', async () => {
    const fetchImpl = stubFetch(notOk(500));
    const r = await ctx.buildRecallContext('search my notes for X', { fetchImpl });
    expect(r.ran).toBe(false);
    expect(r.error).toBe('recall_failed_500');
    expect(r.context).toMatch(/never searched/i);
  });

  it('an unreachable index is reported, not swallowed', async () => {
    const fetchImpl = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await ctx.buildRecallContext('/matrix phishing lures', { fetchImpl });
    expect(r.ran).toBe(false);
    expect(r.error).toBe('recall_unreachable');
    // Forced: the operator asked out loud, so silence would read as an answer.
    expect(r.context).toMatch(/could not be reached/i);
  });

  it('survives a 200 whose body is not an object', async () => {
    // Valid JSON, not an object. Reading `.documents` off null threw into the
    // catch and reported the index as unreachable — a different claim.
    for (const body of [null, [], 'ok', 42]) {
      const fetchImpl = stubFetch(ok(body));
      const r = await ctx.buildRecallContext('/matrix anything', { fetchImpl });
      expect(r.ok, `body ${JSON.stringify(body)}`).toBe(true);
      expect(r.ran).toBe(true);
      expect(r.count).toBe(0);
    }
  });

  it('distinguishes a search that ran and found nothing from one that never ran', async () => {
    const fetchImpl = stubFetch(ok({ documents: [] }));
    const r = await ctx.buildRecallContext('/matrix anything', { fetchImpl });
    expect(r.ran).toBe(true);
    expect(r.count).toBe(0);
    expect(r.context).toMatch(/No relevant indexed documents were found/i);
  });
});

describe('credentials are forwarded onto the internal call', () => {
  it('sends Authorization and Cookie when the caller had them', async () => {
    const fetchImpl = stubFetch(ok({ documents: [] }));
    await ctx.buildRecallContext('search my vault', {
      fetchImpl,
      auth: { authorization: 'Bearer session-token', cookie: 'aeon=abc' },
    });
    const headers = fetchImpl.calls[0].init.headers;
    expect(headers.Authorization).toBe('Bearer session-token');
    expect(headers.Cookie).toBe('aeon=abc');
  });

  it('omits them cleanly when the caller had none', () => {
    expect(ctx.forwardedAuth(null)).toEqual({ 'Content-Type': 'application/json' });
    expect(ctx.forwardedAuth({})).toEqual({ 'Content-Type': 'application/json' });
  });

  it('addresses itself by loopback, never by a caller-supplied host', async () => {
    // A Host header could otherwise send the operator's query — and their
    // vault content — to an address the caller chose.
    const fetchImpl = stubFetch(ok({ documents: [] }));
    await ctx.buildRecallContext('search my vault', { fetchImpl });
    expect(fetchImpl.calls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

describe('the gate', () => {
  it('does not search on an ordinary message', async () => {
    const fetchImpl = stubFetch(ok({ documents: [doc('a.md')] }));
    const r = await ctx.buildRecallContext('write me a haiku about tuesday', { fetchImpl });
    expect(fetchImpl.calls.length).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.context).toBe('');
  });

  it('searches when the message asks about the operator’s own record', async () => {
    const fetchImpl = stubFetch(ok({ documents: [doc('a.md')] }));
    const r = await ctx.buildRecallContext('what did I say about the vault last time', { fetchImpl });
    expect(fetchImpl.calls.length).toBe(1);
    expect(r.ran).toBe(true);
  });

  it('gates and queries the SAME string', async () => {
    // One old copy gated on `content` and queried with `prompt`; its real
    // callers sent only `prompt`, so its gate could never fire.
    const fetchImpl = stubFetch(ok({ documents: [] }));
    await ctx.buildRecallContext('/matrix "phishing lures"', { fetchImpl });
    expect(JSON.parse(fetchImpl.calls[0].init.body).query).toBe('phishing lures');
  });

  it('strips the force prefix so the model never sees the command', () => {
    expect(ctx.parseRecallInput('/matrix what changed')).toEqual({ query: 'what changed', forced: true });
    expect(ctx.parseRecallInput('ordinary text')).toEqual({ query: 'ordinary text', forced: false });
  });
});

describe('retrieved documents are budgeted, and truncation is stated', () => {
  it('keeps what fits and reports the rest', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => doc(`d${i}.md`, 'y'.repeat(1200)));
    const fetchImpl = stubFetch(ok({ documents: docs }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl, budgetTokens: 700 });

    expect(r.ran).toBe(true);
    expect(r.count).toBeGreaterThan(0);
    expect(r.count).toBeLessThan(6);
    expect(r.dropped).toBe(6 - r.count);
    // R03 — the model is told, so it cannot present a partial read as complete.
    expect(r.context).toMatch(/did not fit/i);
  });

  it('drops whole documents rather than cutting one mid-sentence', async () => {
    const docs = [doc('big.md', 'y'.repeat(20000)), doc('small.md', 'short')];
    const fetchImpl = stubFetch(ok({ documents: docs }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl, budgetTokens: 400 });
    // `continue`, not `break` — the small document behind the big one survives.
    expect(r.count).toBe(1);
    expect(r.citations[0].title).toBe('small.md');
  });

  it('says matches were found but none fit, rather than implying an empty vault', async () => {
    const docs = [doc('big.md', 'y'.repeat(20000))];
    const fetchImpl = stubFetch(ok({ documents: docs }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl, budgetTokens: 50 });
    expect(r.count).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.context).toMatch(/none fit/i);
    expect(r.context).not.toMatch(/No relevant indexed documents were found/i);
  });

  it('carries citations for every document it did include (R01)', async () => {
    const fetchImpl = stubFetch(ok({ documents: [doc('notes.md'), doc('log.md')] }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl });
    expect(r.citations.map(c => c.title)).toEqual(['notes.md', 'log.md']);
    expect(r.citations[0].similarity).toBe(0.72);
  });

  it('survives a document with no metadata', async () => {
    // The drifted copy read `d.metadata.source` unguarded and threw into a
    // bare catch, so recall silently produced nothing.
    const fetchImpl = stubFetch(ok({ documents: [{ id: 'x', content: 'body' }] }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl });
    expect(r.count).toBe(1);
    expect(r.citations[0].title).toBe('x');
  });

  it('passes an index that could not be searched straight through with its remedy', async () => {
    const fetchImpl = stubFetch(ok({
      documents: [],
      unavailable: { reason: 'no_embedding_model', message: 'No embedder.', action: 'Install one in Cookbook.' },
    }));
    const r = await ctx.buildRecallContext('recall my notes', { fetchImpl });
    expect(r.ran).toBe(false);
    expect(r.unavailable).toBe('no_embedding_model');
    expect(r.context).toMatch(/Install one in Cookbook/);
    expect(r.context).toMatch(/never searched/i);
  });
});

describe('working memory', () => {
  const memories = [
    { text: 'Cristian is the CEO of Broken Gear Industries', type: 'identity', pinned: true },
    { text: 'Revenue-first: every decision carries financial weight', type: 'decision' },
  ];

  it('reports injected, considered and dropped', () => {
    const m = ctx.buildMemoryContext('who am i', { memories, budgetTokens: 900 });
    expect(m.count).toBe(2);
    expect(m.considered).toBe(2);
    expect(m.dropped).toBe(0);
    expect(m.text).toMatch(/Broken Gear/);
  });

  it('wake states the count it actually injected, not the store size', () => {
    // The old wake block announced `all.length` and then appended the real
    // numbers two lines later — two contradictory counts in one system prompt,
    // with the model explicitly ordered to state one of them.
    const many = Array.from({ length: 40 }, (_, i) => ({ text: `fact ${i} ${'x'.repeat(200)}`, type: 'fact' }));
    const m = ctx.buildMemoryContext('vp come online', { memories: many, budgetTokens: 300, wake: true });
    expect(m.count).toBeLessThan(40);
    expect(m.text).toMatch(new RegExp(`${m.count} of 40 stored memories`));
    expect(m.text).not.toMatch(/All 40 memories are loaded/);
  });

  it('injects nothing, and says so, when disabled', () => {
    const m = ctx.buildMemoryContext('who am i', { memories, enabled: false });
    expect(m.text).toBe('');
    expect(m.count).toBe(0);
  });

  it('caps skills by budget and reports what was dropped', () => {
    const skills = [
      { title: 'A', body: 'x'.repeat(40) },
      { title: 'B', body: 'y'.repeat(4000) },
    ];
    const m = ctx.buildMemoryContext('go', { memories, budgetTokens: 900, skills, skillTokens: 60 });
    expect(m.text).toMatch(/SKILLS/);
    expect(m.skillsDropped).toBe(1);
  });
});

describe('assembleContext reports what the turn actually consulted', () => {
  it('carries both tiers and an honest meta block', async () => {
    const fetchImpl = stubFetch(ok({ documents: [doc('notes.md')] }));
    const out = await ctx.assembleContext('what did I say about the vault', {
      memories: [{ text: 'the vault holds two halves', type: 'fact' }],
      fetchImpl,
      contextTokens: 8192,
    });
    expect(out.meta.memory).toBe(1);
    expect(out.meta.recall).toBe(1);
    expect(out.meta.recallRan).toBe(true);
    expect(out.meta.recallOk).toBe(true);
    expect(out.meta.citations).toHaveLength(1);
    expect(out.combined).toMatch(/MEMORY/);
    expect(out.combined).toMatch(/SECOND BRAIN CONTEXT/);
  });

  it('gives recall its own share of the window', async () => {
    const fetchImpl = stubFetch(ok({ documents: [] }));
    const out = await ctx.assembleContext('search my vault', { fetchImpl, contextTokens: 8192, memories: [] });
    expect(out.budgets.recallTokens).toBeGreaterThan(0);
    expect(out.budgets.memoryTokens).toBeGreaterThan(0);
  });

  it('meta distinguishes refused from empty', async () => {
    const fetchImpl = stubFetch(notOk(401));
    const out = await ctx.assembleContext('search my vault', { fetchImpl, memories: [] });
    expect(out.meta.recallRan).toBe(false);
    expect(out.meta.recallOk).toBe(false);
    expect(out.meta.recallError).toBe('recall_unauthorized');
  });
});

describe('R05 — one recall policy, in one place', () => {
  // A ratchet. The gate lived in three files and drifted in eight ways; the
  // point of the kernel module is that it cannot happen again silently.
  const OFFENDERS = [
    'src/blocks/dashboard/api/chat-stream.cjs',
    'src/blocks/dashboard/api/chat.cjs',
  ];

  it('no block re-declares the recall pattern list', () => {
    const guilty = [];
    for (const rel of OFFENDERS) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      // The signature of a local copy: the pattern list itself.
      if (/second brain\|brain\|knowledge base/i.test(src)) guilty.push(rel);
    }
    expect(guilty, `these re-declare the recall gate instead of importing src/kernel/context.cjs: ${guilty.join(', ')}`).toEqual([]);
  });

  it('the streaming path imports the kernel module', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/dashboard/api/chat-stream.cjs'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\.\/\.\.\/\.\.\/kernel\/context\.cjs['"]\)/);
  });

  it('no block re-implements memory selection either', () => {
    // Recall was unified first and memory was left behind, which put two memory
    // builders in the tree — R05 broken again, one tier later. A block supplies
    // its own prefs, wake phrase and window; ranking and budget accounting come
    // from the kernel.
    const guilty = [];
    for (const rel of OFFENDERS) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      if (/selectForInjection\s*\(/.test(fs.readFileSync(full, 'utf8'))) guilty.push(rel);
    }
    expect(guilty, `these call memory-policy directly instead of src/kernel/context.cjs: ${guilty.join(', ')}`).toEqual([]);
  });

  it('the streaming path no longer reads an undeclared SETTINGS_FILE', () => {
    // It threw ReferenceError into a bare catch, so the entire auto-memory
    // extraction path had never executed once on the route the operator uses.
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/dashboard/api/chat-stream.cjs'), 'utf8');
    const uses = src.split('\n').filter(l => /SETTINGS_FILE/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(uses).toEqual([]);
  });
});
