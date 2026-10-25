/**
 * A8 — auto-extract no longer floods memory.
 *
 * First Claude Sonnet 5.5 session (2026-10-21): after every reply chat-stream
 * asks a model for up to three facts and saves them as source 'auto-extract'.
 * 123 of the operator's 152 memories (81%) came from it; one session added 27,
 * including text from a pasted web page and an unverified claim about which
 * model was answering. Three rules, each with its own red test:
 *
 *   1. no extraction for a pasted document or a reply that is mostly tool output
 *   2. a candidate already said by a memory of the same store is dropped
 *   3. at most MAX_PER_HOUR auto-extracted memories per store per hour
 *
 * The pure rules are held in src/kernel/autoExtract.cjs; the wiring is held
 * through the real chat-stream and memory routers over HTTP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const ex = require('../src/kernel/autoExtract.cjs');
const agentsKernel = require('../src/kernel/agents.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

// ── Rule 1 ──────────────────────────────────────────────────────────────

describe('rule 1 — a paste, or a reply made of tool output, is not the operator speaking', () => {
  it('an ordinary message and reply are extracted from', () => {
    expect(ex.skipReason({ message: 'Keep answers short from now on.', reply: 'Noted.' })).toBeNull();
    expect(ex.skipReason({ message: 'hi', reply: 'hello', toolChars: 0 })).toBeNull();
  });

  it('a message over PASTE_MAX_CHARS is a paste: skipped, and the reason names the size', () => {
    expect(ex.skipReason({ message: 'x'.repeat(ex.PASTE_MAX_CHARS), reply: 'ok' })).toBeNull();
    const why = ex.skipReason({ message: 'x'.repeat(ex.PASTE_MAX_CHARS + 1), reply: 'ok' });
    expect(why).toMatch(/paste/i);
    expect(why).toContain((ex.PASTE_MAX_CHARS + 1).toLocaleString('en-US'));
    expect(ex.skipReason({ message: `Here is the page:\n${'Lorem ipsum dolor sit amet. '.repeat(120)}`, reply: 'ok' })).toMatch(/paste/i);
  });

  it('a reply built from far more tool output than it says is skipped', () => {
    const why = ex.skipReason({ message: 'read the plan', reply: 'r'.repeat(200), toolChars: 4000 });
    expect(why).toMatch(/tool output/i);
    expect(why).toContain('4,000');
  });

  it('a small lookup is not "mostly tool output", nor is a long reply that quotes a little', () => {
    expect(ex.skipReason({ message: 'q', reply: 'r'.repeat(20), toolChars: ex.TOOL_OUTPUT_MIN_CHARS - 1 })).toBeNull();
    expect(ex.skipReason({ message: 'q', reply: 'r'.repeat(2000), toolChars: 1200 })).toBeNull();
  });

  it('exactly half is not "mostly"; one character over is', () => {
    expect(ex.skipReason({ message: 'q', reply: 'r'.repeat(1000), toolChars: 1000 })).toBeNull();
    expect(ex.skipReason({ message: 'q', reply: 'r'.repeat(999), toolChars: 1000 })).toMatch(/tool output/i);
  });

  it('toolOutputChars adds up what the tools returned, not what they refused', () => {
    expect(ex.toolOutputChars([
      { ok: true, text: 'a'.repeat(300) }, { ok: false, text: 'b'.repeat(900) }, { ok: true, text: 'c'.repeat(200) }, null, {},
    ])).toBe(500);
    expect(ex.toolOutputChars(undefined)).toBe(0);
  });
});

// ── Rule 2 ──────────────────────────────────────────────────────────────

// [candidate, an existing memory]. These sets are the evidence for
// NEAR_DUPLICATE_AT; the facts are invented, in the shape the extractor writes.
//
// REPEATS must be dropped: nothing in the candidate that the memory lacks, or
// (the last-but-one) one reworded word in ten.
const REPEATS = [
  ['The operator prefers terse output', 'The operator prefers terse, direct output'],
  ["The operator's laptop had a disk error on March 3", "The operator's laptop had a SMART disk error on March 3"],
  ['The operator is building Atlas, a local-first notes app', "The operator is building Atlas, a local-first notes app that runs on the user's computer"],
  ['The operator sells the Atlas plugin on Shopify for $50', 'The operator sells the Atlas plugin on Shopify at $50'],
  ['The operator stores encrypted nightly backups of the project folder on an external drive in the office safe',
    'The operator keeps encrypted nightly backups of the project folder on an external drive in the office safe'],
  ['THE OPERATOR PREFERS TERSE OUTPUT!!', 'the operator prefers terse output'],
];
// KEPT must be saved. Some are plainly new facts; the last is a paraphrase
// this word-level rule does not claim to catch (it costs one extra memory,
// which is today's behaviour). The top of this list is the ceiling the
// threshold must stay above.
const KEPT = [
  ['The operator prefers terse output', 'The operator prefers dark mode'],
  ['The operator keeps a nightly backup of the project folder', 'The operator keeps a weekly backup of the project folder'],
  ['The operator uses Python for the scraper at the card shop', 'The operator uses Python'],
  ["The operator's notes app sends mail through Gmail", "The operator's notes app shows a 24 hour grid"],
  ["The operator's laptop had a disk error on March 3", "The operator's laptop is used for field testing"],
  ['The operator runs a nightly backup of the project folder to the external drive', 'The operator keeps a nightly backup of the project folder on the external drive'],
];
// The words match (each scores at or above the threshold), the fact does not:
// only a guard keeps these from being dropped.
const OPPOSED = [
  ["The operator's main development laptop runs the Atlas notes app with 16 GB RAM", "The operator's main development laptop runs the Atlas notes app with 32 GB RAM"],
  ['The operator keeps encrypted nightly backups of the project folder on the external drive named Alpha',
    'The operator keeps encrypted nightly backups of the project folder on the external drive named Bravo'],
  ['The operator likes dark mode', "The operator doesn't like dark mode"],
  ['The operator uses Ollama', 'The operator never uses Ollama'],
];

describe('rule 2 — a candidate that a memory already says is dropped', () => {
  const score = ([cand, have]) => ex.isNearDuplicate(cand, [have], 0);

  it('the threshold sits in the gap between the labelled repeats and the facts that must be kept', () => {
    const lowestRepeat = Math.min(...REPEATS.map((p) => score(p).score));
    const highestKept = Math.max(...KEPT.map((p) => score(p).score));
    expect(highestKept).toBeLessThan(ex.NEAR_DUPLICATE_AT);
    expect(lowestRepeat).toBeGreaterThanOrEqual(ex.NEAR_DUPLICATE_AT);
    // ...and the gap is the one the source comment states.
    expect(lowestRepeat).toBeCloseTo(0.9, 3);
    expect(highestKept).toBeCloseTo(0.857, 3);
  });

  it.each(REPEATS)('repeat: "%s" ≈ "%s"', (cand, have) => {
    expect(ex.isNearDuplicate(cand, ['Something else entirely about invoices', have]).duplicate).toBe(true);
    expect(ex.isNearDuplicate(cand, ['Something else entirely about invoices', have]).match).toBe(have);
  });

  it.each(KEPT)('kept: "%s" vs "%s"', (cand, have) => {
    expect(ex.isNearDuplicate(cand, [have]).duplicate).toBe(false);
  });

  it.each(OPPOSED)('opposed: "%s" vs "%s" — the words match, the fact does not', (cand, have) => {
    const r = ex.isNearDuplicate(cand, [have]);
    expect(r.score).toBeGreaterThanOrEqual(ex.NEAR_DUPLICATE_AT);   // the score alone would have dropped it
    expect(r.duplicate).toBe(false);                                 // a changed name or number, or a negation, keeps it
  });

  it('is directional: a candidate that ADDS to a memory is new, a candidate inside a memory is not', () => {
    expect(ex.isNearDuplicate('The operator uses Python', ['The operator uses Python for the scraper at the card shop']).duplicate).toBe(true);
    expect(ex.isNearDuplicate('The operator uses Python for the scraper at the card shop', ['The operator uses Python']).duplicate).toBe(false);
  });

  it('a one-word candidate is covered only by a memory that says nothing else', () => {
    expect(ex.isNearDuplicate('The operator is Cristian', ["The operator's name is Cristian Gomez"]).duplicate).toBe(false);
    expect(ex.isNearDuplicate('The operator is Cristian', ['Cristian']).duplicate).toBe(true);
  });

  it('nothing to compare is not a duplicate, and bad input does not throw', () => {
    expect(ex.isNearDuplicate('The operator prefers terse output', []).duplicate).toBe(false);
    expect(ex.isNearDuplicate('The operator prefers terse output', undefined).duplicate).toBe(false);
    expect(ex.isNearDuplicate('', ['anything']).duplicate).toBe(false);
    expect(ex.isNearDuplicate(undefined, [null, 5, {}]).duplicate).toBe(false);
  });
});

describe('rule 2 on the route — POST /memory/add with source auto-extract', () => {
  let vault;
  let base;
  const servers = [];
  const add = async (body, query = '') => {
    const r = await fetch(`${base}/memory/add${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const list = async (agent) => (await (await fetch(`${base}/memory${agent ? `?agent=${agent}` : ''}`)).json()).memories;

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-a8-mem-'));
    const app = express();
    app.use(express.json());
    app.use('/', createMemoryRouter({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); base = `http://127.0.0.1:${s.address().port}`; resolve(); }); });
  });
  afterEach(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } fs.rmSync(vault, { recursive: true, force: true }); });

  it('a repeat from the extractor is answered as already remembered and nothing is saved', async () => {
    await add({ text: 'The operator prefers terse, direct output', source: 'api' });
    const r = await add({ text: 'The operator prefers terse output', source: 'auto-extract' });
    expect(r).toMatchObject({ ok: true, deduped: true, near: true });
    expect(r.text).toMatch(/already/i);
    expect(await list()).toHaveLength(1);
  });

  it('the same words typed by the operator (/remember) are saved: only the extractor is held to this', async () => {
    await add({ text: 'The operator prefers terse, direct output', source: 'api' });
    const r = await add({ text: 'The operator prefers terse output', source: 'api' });
    expect(r.deduped).toBeUndefined();
    expect(await list()).toHaveLength(2);
  });

  it('a new fact from the extractor is saved', async () => {
    await add({ text: 'The operator prefers terse, direct output', source: 'api' });
    const r = await add({ text: 'The operator sells the Atlas plugin on Shopify for $50', source: 'auto-extract' });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();
    expect(await list()).toHaveLength(2);
  });

  it('a memory switched Off still counts: the extractor does not bring it back', async () => {
    const { memory } = await add({ text: 'The operator prefers terse, direct output', source: 'api' });
    await fetch(`${base}/memory/${memory.id}/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
    const r = await add({ text: 'The operator prefers terse output', source: 'auto-extract' });
    expect(r).toMatchObject({ deduped: true, near: true });
    expect(await list()).toHaveLength(1);
  });

  it('is per store: an agent\'s memory is not held against the shared one, nor the reverse', async () => {
    agentsKernel.create(vault, { name: 'Scout' });
    await add({ text: 'The operator prefers terse, direct output', source: 'api' });
    const own = await add({ text: 'The operator prefers terse output', source: 'auto-extract', agent: 'scout' });
    expect(own.deduped).toBeUndefined();
    expect(await list('scout')).toHaveLength(1);
    const again = await add({ text: 'The operator prefers terse output!', source: 'auto-extract', agent: 'scout' });
    expect(again).toMatchObject({ deduped: true, near: true });
    expect(await list('scout')).toHaveLength(1);
    expect(await list()).toHaveLength(1);
  });
});

// ── Rule 3 ──────────────────────────────────────────────────────────────

describe('rule 3 — the hourly allowance', () => {
  it('spends down, refuses at zero, and gives slots back as the hour passes', () => {
    let t = 1_000_000;
    const b = ex.createBudget({ max: 3, windowMs: 60_000, now: () => t });
    expect(b.remaining('k')).toBe(3);
    b.record('k', 2);
    expect(b.remaining('k')).toBe(1);
    t += 30_000; b.record('k', 1);
    expect(b.remaining('k')).toBe(0);
    expect(b.minutesToRoom('k')).toBe(1);
    t += 31_000;                       // the first two saves are now 61 s old
    expect(b.remaining('k')).toBe(2);
    t += 60_000;
    expect(b.remaining('k')).toBe(3);
    expect(b.minutesToRoom('k')).toBe(0);
  });

  it('keeps one allowance per key', () => {
    const b = ex.createBudget({ max: 2 });
    b.record('vault|shared', 2);
    expect(b.remaining('vault|shared')).toBe(0);
    expect(b.remaining('vault|scout')).toBe(2);
    expect(b.remaining('other-vault|shared')).toBe(2);
  });

  it('the shipped defaults are the ones the record states', () => {
    expect(ex.MAX_FACTS_PER_REPLY).toBe(3);
    expect(ex.MAX_PER_HOUR).toBe(6);
    expect(ex.budget.max).toBe(ex.MAX_PER_HOUR);
  });
});

// ── The wiring, through the real chat-stream router ─────────────────────

describe('chat-stream applies the three rules', () => {
  let vault;
  let apiBase;
  let seen;
  let aiReplies;       // what /api/ai returns, call by call
  let addReply;        // what /api/memory/add returns
  let script;          // the model's rounds
  let logs;
  const servers = [];
  let savedKernelUrl;
  const listen = (app) => new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
  });
  const facts = (n, tag = 'f') => JSON.stringify(Array.from({ length: n }, (_, i) => ({ text: `The operator has distinct fact ${tag}${i} about project ${tag}${i}`, category: 'fact' })));
  const waitFor = async (check, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (check()) return true; await new Promise((r) => setTimeout(r, 15)); }
    return false;
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));      // the extraction runs after the response ends
  const said = () => logs.map((a) => a.join(' ')).join('\n');

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-a8-chat-'));   // a fresh vault is a fresh allowance
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'big.md'), `# Big\n${'The plan has many details. '.repeat(150)}`);
    fs.writeFileSync(path.join(vault, 'Notes', 'small.md'), '# Small\nShip on Friday.');
    seen = { ai: 0, add: [] };
    aiReplies = [];
    addReply = () => ({ ok: true });
    script = fakeStream([{ tokens: ['Noted.'] }]);
    logs = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a));
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a));

    const kernel = express();
    kernel.use(express.json());
    kernel.post('/api/ai', (req, res) => { seen.ai++; res.json({ text: aiReplies.length ? aiReplies.shift() : '[]' }); });
    kernel.post('/api/memory/add', (req, res) => { seen.add.push(req.body); res.json(addReply(req.body)); });
    kernel.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
    savedKernelUrl = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = await listen(kernel);

    const kernelLLM = {
      describeRole: async () => ({ provider: 'stub', model: 'stub-model', contextTokens: 32768 }),
      stream: (messages, opts) => script.stream(messages, opts),
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createStreamRouter({
      kernelLLM, VAULT_ROOT: vault,
      loadSettings: () => ({ prefs: {}, blockSettings: { memory_core: { auto_memory: true } } }),
    }));
    apiBase = await listen(app);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of servers.splice(0)) { try { s.close(); } catch {} }
    if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl;
    fs.rmSync(vault, { recursive: true, force: true });
  });

  const chat = async (message) => {
    const r = await fetch(`${apiBase}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    expect(await r.text()).toMatch(/event: done/);
  };
  const toolRound = (file) => [
    { tokens: ['Let me look. ', `\`\`\`aeon-tool\n${JSON.stringify({ tool: 'vault_read', path: file })}\n\`\`\`\n`] },
    { tokens: ['Noted.'] },
  ];

  it('control: an ordinary message still gets its facts extracted and saved', async () => {
    aiReplies = [facts(2)];
    await chat('Keep answers short from now on.');
    expect(await waitFor(() => seen.add.length === 2)).toBe(true);
    expect(seen.ai).toBe(1);
    expect(seen.add[0]).toMatchObject({ source: 'auto-extract' });
  });

  it('rule 1: a pasted page makes no extraction call and says why', async () => {
    aiReplies = [facts(3)];
    await chat(`Here is the page I copied:\n${'Lorem ipsum dolor sit amet. '.repeat(120)}`);
    await settle();
    expect(seen.ai).toBe(0);
    expect(seen.add).toHaveLength(0);
    expect(said()).toMatch(/\[AUTO-MEMORY\] skipped.*paste/i);
  });

  it('rule 1: a reply built from a big tool result makes no extraction call and says why', async () => {
    script = fakeStream(toolRound('Notes/big.md'));
    aiReplies = [facts(3)];
    await chat('what does the big note say?');
    await settle();
    expect(seen.ai).toBe(0);
    expect(said()).toMatch(/\[AUTO-MEMORY\] skipped.*tool output/i);
  });

  it('rule 1, control: a small lookup is still extracted from', async () => {
    script = fakeStream(toolRound('Notes/small.md'));
    aiReplies = [facts(1)];
    await chat('what does the small note say?');
    expect(await waitFor(() => seen.add.length === 1)).toBe(true);
    expect(seen.ai).toBe(1);
  });

  it('rule 2: a fact the store already has is counted as remembered, not saved, and does not spend the allowance', async () => {
    addReply = () => ({ ok: true, deduped: true, near: true, text: 'Already in memory' });
    for (let i = 0; i < ex.MAX_PER_HOUR + 1; i++) {
      aiReplies = [facts(3, `d${i}`)];
      await chat(`message ${i}`);
      expect(await waitFor(() => seen.add.length === (i + 1) * 3)).toBe(true);
      await settle();
    }
    expect(seen.ai).toBe(ex.MAX_PER_HOUR + 1);          // none of them was refused for the cap
    expect(said()).toMatch(/\[AUTO-MEMORY\].*already/i);
  });

  it('rule 3: after MAX_PER_HOUR saves the next reply makes no extraction call, and the log says the cap', async () => {
    for (let i = 0; i < 2; i++) {
      aiReplies = [facts(3, `c${i}`)];
      await chat(`message ${i}`);
      expect(await waitFor(() => seen.add.length === (i + 1) * 3)).toBe(true);
      await settle();
    }
    expect(seen.add).toHaveLength(ex.MAX_PER_HOUR);
    const callsBefore = seen.ai;
    aiReplies = [facts(3, 'late')];
    await chat('one more thing');
    await settle();
    expect(seen.ai).toBe(callsBefore);
    expect(seen.add).toHaveLength(ex.MAX_PER_HOUR);
    expect(said()).toMatch(/\[AUTO-MEMORY\] skipped.*(per hour|hourly)/i);
  });

  it('rule 3: the last slots are filled, not overshot', async () => {
    aiReplies = [facts(3, 'a')];
    await chat('first'); expect(await waitFor(() => seen.add.length === 3)).toBe(true); await settle();
    aiReplies = [facts(2, 'b')];
    await chat('second'); expect(await waitFor(() => seen.add.length === 5)).toBe(true); await settle();
    aiReplies = [facts(3, 'c')];          // one slot left
    await chat('third'); expect(await waitFor(() => seen.add.length === 6)).toBe(true); await settle();
    expect(seen.add).toHaveLength(ex.MAX_PER_HOUR);
  });

  it('the 3-facts-per-reply cap still holds', async () => {
    aiReplies = [facts(5)];
    await chat('lots of facts');
    expect(await waitFor(() => seen.add.length >= 3)).toBe(true);
    await settle();
    expect(seen.add).toHaveLength(3);
  });
});
