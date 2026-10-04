/**
 * 3.3.0 review round 3 — privacy holes found by the final review, each a
 * regression test that failed before its fix:
 *
 *   A  a memory store reached through a link (an agent's memory/ linked to a
 *      Local only agent's) was read into a cloud-eligible prompt — on a chat
 *      turn and through ask_agent — and Memory Core wrote through it
 *   B  shareableTurns failed open: turns tagged with a Local only agent the
 *      operator had since removed went to the next Roulette turn
 *   C  memory_save told the model that a switched-off memory with those words
 *      existed, and its stored wording
 *   D  plainError left file:// URLs and quoted paths with spaces in errors a
 *      model reads
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const ws = require('../src/kernel/agentWorkspace.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const kernelContext = require('../src/kernel/context.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const all = () => agents.list(vault, { withStats: false });
const get = (n) => agents.get(vault, n, all());
const SECRET = 'PRIVATE-MARKER-7731';
const OFFTEXT = 'The operator keeps the spare key in the blue binder';

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-links-removed-'));
  agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
  agents.create(vault, { name: 'Quill', persona: 'Drafts letters.', privacy: 'local-only', model: { provider: 'local', model: 'q4' } });
  const qmem = path.join(vault, 'Agents', 'Quill', 'memory');
  fs.mkdirSync(qmem, { recursive: true });
  fs.writeFileSync(path.join(qmem, 'memories.json'), JSON.stringify([{ id: 'q1', text: `${SECRET} the operator's private letter`, category: 'fact', active: true, pinned: true, timestamp: Date.now() }]));
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

async function streamApp() {
  const calls = [];
  const kernelLLM = {
    describeRole: async () => ({ provider: 'groq', model: 'm', contextTokens: 32768 }),
    stream: async (messages, opts) => { calls.push({ messages: messages.map((m) => ({ ...m })), opts }); return fakeStream([{ tokens: ['ok'] }]).stream(messages, opts); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
  return { base: await listen(app), calls };
}
const post = (base, body) => fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
const linkLedgerToQuill = () => {
  fs.rmSync(path.join(vault, 'Agents', 'Ledger', 'memory'), { recursive: true, force: true });
  fs.symlinkSync(path.join(vault, 'Agents', 'Quill', 'memory'), path.join(vault, 'Agents', 'Ledger', 'memory'), 'dir');
};

describe('A — a memory store is never read or written through a link', () => {
  it.skipIf(process.platform === 'win32')('a Roulette agent whose memory/ links to a Local only agent\'s gets none of it in a cloud-eligible prompt', async () => {
    linkLedgerToQuill();
    const { base, calls } = await streamApp();
    await post(base, { message: 'what do you remember?', agent: 'ledger' });
    expect(calls[0].opts.localOnly).toBeFalsy();
    expect(calls[0].messages[0].content).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('ask_agent to that agent does not carry the linked memory either', async () => {
    linkLedgerToQuill();
    const seen = [];
    const kernelLLM = { stream: async (messages, opts) => { seen.push({ messages, opts }); opts.onToken('fine'); return { text: 'fine', provider: 'groq', model: 'm' }; } };
    const r = await agentTools.askAgent({ vaultRoot: vault, caller: get('Aeon'), target: 'Ledger', agents: all(), question: 'what do you remember', kernelLLM });
    expect(r.status).toBe('ok');
    expect(seen[0].opts.localOnly).toBeFalsy();
    expect(seen[0].messages[0].content).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('the store reader says why, by a Vault path, and the shared store follows the same rule', () => {
    linkLedgerToQuill();
    const r = kernelContext.readMemoryStore(vault, get('Ledger'));
    expect(r.memories).toEqual([]);
    expect(r.error).toMatch(/^Agents\/Ledger\/memory is a link/);
    expect(r.error).not.toContain(vault);
    fs.mkdirSync(path.join(vault, 'Agents', 'Aeon'), { recursive: true });
    fs.symlinkSync(path.join(vault, 'Agents', 'Quill', 'memory'), path.join(vault, 'Agents', 'Aeon', 'memory'), 'dir');
    const shared = kernelContext.readMemoryStore(vault);
    expect(shared.memories).toEqual([]);
    expect(shared.error).toMatch(/^Agents\/Aeon\/memory is a link/);
  });

  it.skipIf(process.platform === 'win32')('Memory Core neither lists nor writes a linked store', async () => {
    linkLedgerToQuill();
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null, requestIndex: () => {} }));
    const base = await listen(app);
    const list = await fetch(`${base}/api/memory?agent=ledger`);
    expect(list.status).toBe(409);
    expect(JSON.stringify(await list.json())).not.toContain(SECRET);
    const before = fs.readFileSync(path.join(vault, 'Agents', 'Quill', 'memory', 'memories.json'), 'utf8');
    const add = await fetch(`${base}/api/memory/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'ledger', text: 'The books close on Fridays' }) });
    expect(add.status).toBe(409);
    expect(fs.readFileSync(path.join(vault, 'Agents', 'Quill', 'memory', 'memories.json'), 'utf8')).toBe(before);
  });
});

describe('B — turns of an agent that is no longer listed', () => {
  const quillTurns = [
    { role: 'user', content: `draft my letter about ${SECRET}`, agent: 'quill' },
    { role: 'assistant', content: `Here is the letter: ${SECRET}`, agent: 'quill' },
  ];

  it('a Roulette turn does not get a removed Local only agent\'s turns', async () => {
    agents.remove(vault, 'Quill');
    const { base, calls } = await streamApp();
    await post(base, { message: 'hello', agent: 'ledger', history: quillTurns });
    expect(calls[0].opts.localOnly).toBeFalsy();
    expect(calls[0].messages.map((m) => m.content).join('\n')).not.toContain(SECRET);
  });

  it('shareableTurns keeps untagged turns and turns of listed agents that are not Local only', () => {
    const list = all();
    const feed = [
      { role: 'user', content: 'untagged' },
      { role: 'user', content: 'to aeon', agent: 'aeon' },
      { role: 'user', content: 'to ledger', agent: 'ledger' },
      { role: 'user', content: 'to quill', agent: 'quill' },
      { role: 'user', content: 'to a removed one', agent: 'gone' },
    ];
    expect(agents.shareableTurns(feed, get('Ledger'), list).map((t) => t.content)).toEqual(['untagged', 'to aeon', 'to ledger']);
    expect(agents.shareableTurns(feed, null, list).map((t) => t.content)).toEqual(['untagged', 'to aeon', 'to ledger']);
    expect(agents.shareableTurns(feed, get('Quill'), list)).toHaveLength(5);
  });
});

describe('C — memory_save does not reveal a switched-off memory', () => {
  it('saving the words of an Off memory reads to the model like a new save, and keeps the save spent', async () => {
    const shared = path.join(vault, 'Agents', 'Aeon', 'memory');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'memories.json'), JSON.stringify([{ id: 'o1', text: OFFTEXT, category: 'fact', active: false, timestamp: Date.now() }]));
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null, requestIndex: () => {} }));
    const saved = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = await listen(app);
    try {
      const tb = agentTools.createToolbox({ vaultRoot: vault, agent: get('Aeon'), agents: all(), contextTokens: 32768 });
      const asked = OFFTEXT.toUpperCase();
      const hit = await tb.run({ ok: true, tool: 'memory_save', args: { text: asked } });
      expect(hit.status).toBe('ok');
      expect(hit.text).not.toMatch(/Already in memory|switched off/);
      expect(hit.text).not.toContain(OFFTEXT); // the stored wording
      expect(hit.text).toBe(`Saved to memory (fact): ${asked}`);
      expect(tb.writesLeft()).toBe(2);
      // The operator's terminal says what really happened.
      expect(hit.notice).toMatch(/Already in .* memory, switched off/);
      expect(hit.saved).toBe(false);
      const store = JSON.parse(fs.readFileSync(path.join(shared, 'memories.json'), 'utf8'));
      expect(store).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = saved;
    }
  });
});

describe('D — host paths in errors a model reads', () => {
  it('a file:// URL is redacted', () => {
    const e = new Error('Cannot load file:///Users/someone/Desktop/AEON/node_modules/pdfjs-dist/build/pdf.worker.mjs');
    expect(ws.plainError(e, vault)).toBe('Cannot load <path>');
  });
  it('a quoted absolute path with spaces is redacted whole', () => {
    const e = new Error("open '/Users/some one/AEON Data/secrets/aeon-keyslots.json' failed");
    expect(ws.plainError(e, vault)).toBe("open '<path>' failed");
    const w = new Error('open "C:\\Users\\some one\\AEON Data\\x.json" failed');
    expect(ws.plainError(w, vault)).toBe('open "<path>" failed');
  });
  it('ordinary quoted words and Vault paths are left alone', () => {
    expect(ws.plainError(new Error("Unexpected token 'a' in JSON at Notes/a.md"), vault)).toBe("Unexpected token 'a' in JSON at Notes/a.md");
  });
});
