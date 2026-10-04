/**
 * F4 — an agent's scratchpad and handoffs (src/kernel/agentWorkspace.cjs),
 * the memory_core routes the operator's UI uses, "Write a handoff when you
 * save a chat", and the Second Brain leaving both out of the index (R09: they
 * are a model's own words). Artifacts stay indexed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const ws = require('../src/kernel/agentWorkspace.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');
const createChatRouter = require('../src/blocks/dashboard/api/chat.cjs');
const ingestFactory = require('../src/blocks/aeon_matrix/api/ingest.cjs');

let vault;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const all = () => agents.list(vault, { withStats: false });
const get = (n) => agents.get(vault, n, all());
const ledgerDir = () => path.join(vault, 'Agents', 'Ledger');

// A kernelLLM whose stream writes a fixed handoff and records the call.
function handoffModel(text = 'Working on: the April close.\nNext step: chase two receipts.') {
  const calls = [];
  const stream = async (messages, opts) => { calls.push({ messages, opts }); opts.onToken(text); return { text, provider: opts.provider || 'groq', model: opts.model || 'm' }; };
  return { stream, calls };
}
const history = [
  { role: 'user', content: 'Close April for me', agent: 'ledger' },
  { role: 'assistant', content: 'Two receipts are missing.', agent: 'ledger' },
];

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-workspace-'));
  agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
  agents.create(vault, { name: 'Quill', persona: 'Drafts letters.', privacy: 'local-only', model: { provider: 'local', model: 'q4' } });
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('scratchpad', () => {
  it('reads empty, writes atomically, appends, refuses over 2,000 (never cuts)', () => {
    const a = get('Ledger');
    expect(ws.readScratchpad(vault, a)).toMatchObject({ content: '', chars: 0, path: 'Agents/Ledger/scratchpad.md', max: 2000 });
    ws.writeScratchpad(vault, a, 'line one');
    ws.writeScratchpad(vault, a, 'line two', { mode: 'append' });
    expect(ws.readScratchpad(vault, a).content).toBe('line one\nline two');
    expect(() => ws.writeScratchpad(vault, a, 'z'.repeat(2001))).toThrow(/at most 2,000 characters; this is 2,001/);
    expect(ws.readScratchpad(vault, a).content).toBe('line one\nline two');
    expect(fs.readdirSync(ledgerDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('the operator\'s own AEON uses Agents/Aeon', () => {
    ws.writeScratchpad(vault, get('aeon'), 'mine');
    expect(fs.readFileSync(path.join(vault, 'Agents', 'Aeon', 'scratchpad.md'), 'utf8')).toBe('mine');
  });
});

describe('handoffs', () => {
  it('the handoff prompt does not double a persona\'s closing period', async () => {
    const k = handoffModel();
    await ws.writeHandoff({ vaultRoot: vault, agent: get('Ledger'), history, kernelLLM: k });
    const first = k.calls[0].messages[0].content.split('\n')[0];
    expect(first).toBe('You are Ledger. Keeps the books.');
    const plain = agents.create(vault, { name: 'Scout', persona: 'Answers trivia' });
    const k2 = handoffModel();
    await ws.writeHandoff({ vaultRoot: vault, agent: plain, history: [{ role: 'user', content: 'hi', agent: 'scout' }], kernelLLM: k2 });
    expect(k2.calls[0].messages[0].content.split('\n')[0]).toBe('You are Scout. Answers trivia.');
  });

  it('saved under handoffs/, the newest injected, older kept, nothing overwritten', async () => {
    const a = get('Ledger');
    const k1 = handoffModel('First handoff.');
    const one = await ws.writeHandoff({ vaultRoot: vault, agent: a, history, kernelLLM: k1 });
    expect(one.rel).toMatch(/^Agents\/Ledger\/handoffs\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.md$/);
    const k2 = handoffModel('Second handoff.');
    const two = await ws.writeHandoff({ vaultRoot: vault, agent: a, history, kernelLLM: k2, note: 'focus on receipts' });
    expect(two.rel).not.toBe(one.rel);
    expect(fs.readdirSync(path.join(ledgerDir(), 'handoffs'))).toHaveLength(2);
    const block = ws.promptBlock(vault, a);
    expect(block.text).toContain('## YOUR LAST HANDOFF');
    expect(block.text).toContain('Second handoff.');
    expect(block.text).not.toContain('First handoff.');
    const list = ws.listHandoffs(vault, a);
    expect(list.handoffs.map((h) => h.preview)).toEqual(['Second handoff.', 'First handoff.']);
    expect(list.latest.text).toBe('Second handoff.');
    // The prompt had the transcript, the scratchpad slot and the note.
    expect(k2.calls[0].messages[0].content).toContain('Operator: Close April for me');
    expect(k2.calls[0].messages[0].content).toContain('focus on receipts');
    expect(k2.calls[0].opts.max_tokens).toBe(700);
    const raw = fs.readFileSync(path.join(vault, two.rel), 'utf8');
    expect(raw).toMatch(/^---\nagent: ledger\ncreated: .+\nsource: \/handoff\nmodel: groq\/m\n---/);
  });

  it('a Local only agent\'s handoff call is Local only', async () => {
    const k = handoffModel();
    await ws.writeHandoff({ vaultRoot: vault, agent: get('Quill'), history: [{ role: 'user', content: 'draft it', agent: 'quill' }], kernelLLM: k });
    expect(k.calls[0].opts).toMatchObject({ localOnly: true, provider: 'local', model: 'q4' });
  });

  it('a Roulette agent\'s handoff never carries a Local only agent\'s turns', async () => {
    const k = handoffModel();
    await ws.writeHandoff({
      vaultRoot: vault, agent: get('Ledger'), kernelLLM: k,
      history: [...history, { role: 'user', content: 'Quill, my private letter text', agent: 'quill' }],
    });
    expect(k.calls[0].messages[0].content).not.toContain('private letter');
  });

  it('nothing to hand off: 400; a model failure: 502 with nothing written; Local only refusal: 409', async () => {
    await expect(ws.writeHandoff({ vaultRoot: vault, agent: get('Ledger'), history: [], kernelLLM: handoffModel() }))
      .rejects.toMatchObject({ status: 400, message: 'Nothing to hand off: this chat has no turns with Ledger.' });
    const broken = { stream: async () => { throw new Error('provider down'); } };
    await expect(ws.writeHandoff({ vaultRoot: vault, agent: get('Ledger'), history, kernelLLM: broken })).rejects.toMatchObject({ status: 502 });
    expect(fs.existsSync(path.join(ledgerDir(), 'handoffs'))).toBe(false);
    const refused = { stream: async () => { const e = new Error('Quill is set to Local only, so nothing it is asked is sent to a cloud model.'); e.localOnly = true; throw e; } };
    await expect(ws.writeHandoff({ vaultRoot: vault, agent: get('Quill'), history: [{ role: 'user', content: 'x', agent: 'quill' }], kernelLLM: refused }))
      .rejects.toMatchObject({ status: 409, message: 'Quill is set to Local only, so nothing it is asked is sent to a cloud model.' });
  });
});

describe('memory_core routes', () => {
  let base;
  let k;
  beforeEach(async () => {
    k = handoffModel();
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, kernelLLM: k, loadSettings: () => ({}) }));
    base = await listen(app);
  });
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  it('GET/PUT scratchpad; 413 over the cap with the file unchanged; 404 for an unknown agent', async () => {
    expect((await call('GET', '/api/agents/ledger/scratchpad')).body).toMatchObject({ ok: true, agent: { id: 'ledger', name: 'Ledger' }, content: '', chars: 0, max: 2000, path: 'Agents/Ledger/scratchpad.md', updatedAt: null });
    const put = await call('PUT', '/api/agents/ledger/scratchpad', { content: 'Open: April' });
    expect(put.body).toMatchObject({ ok: true, chars: 11, max: 2000, text: 'Ledger\'s scratchpad saved (11 / 2,000 characters).' });
    const over = await call('PUT', '/api/agents/ledger/scratchpad', { content: 'x'.repeat(2500) });
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ ok: false, error: 'The scratchpad holds at most 2,000 characters; this is 2,500. Shorten it.' });
    expect((await call('GET', '/api/agents/ledger/scratchpad')).body.content).toBe('Open: April');
    expect((await call('GET', '/api/agents/nobody/scratchpad')).status).toBe(404);
  });

  it('POST /agents/handoff writes, GET /agents/:id/handoffs lists newest first', async () => {
    const r = await call('POST', '/api/agents/handoff', { agent: 'ledger', history, note: '' });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/^Handoff saved to Agents\/Ledger\/handoffs\/.+\.md\n\nWorking on: the April close\./);
    const list = await call('GET', '/api/agents/ledger/handoffs');
    expect(list.body).toMatchObject({ ok: true, latest: { path: r.body.path, text: 'Working on: the April close.\nNext step: chase two receipts.' } });
    expect(list.body.handoffs).toHaveLength(1);
    expect((await call('POST', '/api/agents/handoff', { agent: 'ledger', history: [] })).status).toBe(400);
    expect((await call('POST', '/api/agents/handoff', { agent: 'ghost', history })).status).toBe(404);
  });

  it('no agent named: the operator\'s own AEON writes it', async () => {
    const r = await call('POST', '/api/agents/handoff', { history: [{ role: 'user', content: 'plan the week' }] });
    expect(r.body.path).toMatch(/^Agents\/Aeon\/handoffs\//);
  });
});

describe('"Write a handoff when you save a chat"', () => {
  let base;
  let k;
  let settings;
  beforeEach(async () => {
    k = handoffModel();
    settings = { blockSettings: { memory_core: { handoff_on_save: true } } };
    const app = express();
    app.use(express.json());
    app.use('/api', createChatRouter({ VAULT_ROOT: vault, kernelLLM: k, loadSettings: () => settings, writeOSAudit: () => {} }));
    base = await listen(app);
  });
  const save = (body) => fetch(`${base}/api/terminal/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const handoffs = () => { try { return fs.readdirSync(path.join(ledgerDir(), 'handoffs')); } catch { return []; } };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('an explicit save writes one; an automatic save does not', async () => {
    await save({ messages: history, autoSaved: true, agent: 'ledger' });
    await settle();
    expect(handoffs()).toHaveLength(0);
    expect(k.calls).toHaveLength(0);
    await save({ messages: history, agent: 'ledger' });
    await settle();
    expect(handoffs()).toHaveLength(1);
  });

  it('off (the default): an explicit save writes none', async () => {
    settings = {};
    await save({ messages: history, agent: 'ledger' });
    await settle();
    expect(handoffs()).toHaveLength(0);
  });
});

describe('the Second Brain leaves scratchpads and handoffs out, keeps artifacts', () => {
  beforeEach(() => { ingestFactory._resetStores(); });
  it('a scan indexes Agents/<X>/artifacts but not scratchpad.md or handoffs/', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-workspace-data-'));
    try {
      ws.writeScratchpad(vault, get('Ledger'), 'Scratchpad: the model\'s own working notes about the April close.');
      fs.mkdirSync(path.join(ledgerDir(), 'handoffs'), { recursive: true });
      fs.writeFileSync(path.join(ledgerDir(), 'handoffs', '2026-10-03T10-00-00Z.md'), 'Working on: the April close, written by the model as its handoff.');
      ws.saveArtifact(vault, get('Ledger'), 'April summary', '# April\nAll reconciled against the bank statement.');
      fs.writeFileSync(path.join(vault, 'notes.md'), '# Notes\nA normal document.');
      const router = ingestFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: async () => ({ vector: [0.1, 0.2, 0.3], model: 'stub-embed' }) });
      await router.runSecondBrainScan();
      const docs = Object.keys(JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8')).documents || {});
      expect(docs).toContain('notes.md');
      expect(docs).toContain('Agents/Ledger/artifacts/april_summary.md');
      expect(docs.filter((d) => /scratchpad|handoffs/.test(d))).toEqual([]);
      // The scan did walk the agent's folder (its artifact is there), so
      // their absence is the skip, not a short file.
      expect(docs.some((d) => d.startsWith('Agents/Ledger/'))).toBe(true);
    } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  });

  it('isAgentWorkingFile', () => {
    expect(ws.isAgentWorkingFile('Agents/Ledger/scratchpad.md')).toBe(true);
    expect(ws.isAgentWorkingFile('agents/ledger/Handoffs')).toBe(true);
    expect(ws.isAgentWorkingFile('Agents/Ledger/handoffs/x.md')).toBe(true);
    expect(ws.isAgentWorkingFile('Agents/Ledger/artifacts/x.md')).toBe(false);
    expect(ws.isAgentWorkingFile('Notes/scratchpad.md')).toBe(false);
  });
});
