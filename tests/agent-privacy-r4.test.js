/**
 * 3.3.0 review round 4 — privacy holes found by the security review, each a
 * regression test that failed before its fix:
 *
 *   R4-1  a removed Local only agent's folder (Agents/.removed/<Folder>-<time>)
 *         reached through a link, or moved out of the bin by hand, was read by
 *         a Roulette agent's tools and indexed (embedded). A folder is now
 *         judged by its own agent.json, wherever it is.
 *   R4-2  saved chats reached through a link were indexed, so vault_search
 *         could return what vault_read refuses
 *   R4-3  vault_list around memory_save told a model whether a guessed
 *         sentence is a switched-off memory; vault_read named a store "that
 *         holds a switched-off memory"
 *   R4-14 the claim check missed "I asked <agent>" for an agent the caller
 *         may not ask (a Local only one, or with tools off)
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
const agentTools = require('../src/kernel/agentTools.cjs');
const vaultPrivacy = require('../src/kernel/vaultPrivacy.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');

let root;
let vault;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const all = () => agents.list(vault, { withStats: false });
const get = (n) => agents.get(vault, n, all());
const SECRET = 'PRIVATE-MARKER-4412';
const OFFTEXT = 'The operator keeps the spare key in the blue binder';
const noLinks = process.platform === 'win32';

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-privacy-r4-'));
  vault = path.join(root, 'Vault');
  fs.mkdirSync(vault, { recursive: true });
  agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
  agents.create(vault, { name: 'Quill', persona: 'Drafts letters.', privacy: 'local-only', model: { provider: 'local', model: 'q4' } });
  const qmem = path.join(vault, 'Agents', 'Quill', 'memory');
  fs.mkdirSync(qmem, { recursive: true });
  fs.writeFileSync(path.join(qmem, 'memories.json'), JSON.stringify([{ id: 'q1', text: `${SECRET} the operator's private letter`, category: 'fact', active: true, pinned: true, timestamp: Date.now() }]));
  fs.writeFileSync(path.join(qmem, 'q1.md'), `---\nid: q1\ncategory: fact\n---\n\n${SECRET} the operator's private letter\n`);
  fs.writeFileSync(path.join(vault, 'Agents', 'Quill', 'scratchpad.md'), `Quill notes: ${SECRET}`);
});
afterEach(() => { ingestMod._resetStores(); fs.rmSync(root, { recursive: true, force: true }); });
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

const toolbox = (name) => agentTools.createToolbox({ vaultRoot: vault, agent: get(name), agents: all(), contextTokens: 32768 });
const call = (tb, tool, args) => tb.run({ ok: true, tool, args });

async function scan() {
  const embedded = [];
  const embed = async (text) => { embedded.push(String(text)); return { vector: [1, 0, 0], model: 'stub' }; };
  await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: path.join(root, 'data'), embed }).runSecondBrainScan();
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'data', 'vault_index.json'), 'utf8'));
  return { embedded: embedded.join('\n'), indexed: Object.keys(idx.documents) };
}

describe('R4-1 a removed Local only agent\'s folder stays withheld wherever it goes', () => {
  it.skipIf(noLinks)('reached through a link: vaultPrivacy withholds it', () => {
    const moved = agents.remove(vault, 'Quill').movedTo;
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(path.join(vault, moved), path.join(vault, 'Notes', 'old-letters'));
    for (const rel of ['Notes/old-letters', 'Notes/old-letters/memory/memories.json', 'Notes/old-letters/scratchpad.md', `${moved}/scratchpad.md`]) {
      expect(vaultPrivacy.withheld(vault, rel)).toBe('local-only-agent');
    }
  });

  it.skipIf(noLinks)('reached through a link: a Roulette AEON\'s vault_read and vault_list get "not there"', async () => {
    const moved = agents.remove(vault, 'Quill').movedTo;
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(path.join(vault, moved), path.join(vault, 'Notes', 'old-letters'));
    const tb = toolbox('Aeon');
    const l = await call(tb, 'vault_list', { path: 'Notes/old-letters' });
    const r = await call(tb, 'vault_read', { path: 'Notes/old-letters/memory/memories.json' });
    const s = await call(tb, 'vault_read', { path: 'Notes/old-letters/scratchpad.md' });
    const n = await call(tb, 'vault_list', { path: 'Notes' });
    for (const o of [l, r, s]) {
      expect(o.status).toBe('error');
      expect(o.text).toMatch(/^Nothing at /);
      expect(o.text).not.toContain(SECRET);
    }
    expect(n.text).not.toContain('old-letters');
  });

  it.skipIf(noLinks)('reached through a link: the scan neither indexes nor embeds it', async () => {
    const moved = agents.remove(vault, 'Quill').movedTo;
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(path.join(vault, moved), path.join(vault, 'Notes', 'old-letters'));
    const { embedded, indexed } = await scan();
    expect(indexed.some((p) => p.startsWith('Notes/old-letters'))).toBe(false);
    expect(embedded).not.toContain(SECRET);
  });

  it('moved out of the bin by hand (Archive/Quill): not read, not listed, not indexed', async () => {
    const moved = agents.remove(vault, 'Quill').movedTo;
    fs.mkdirSync(path.join(vault, 'Archive'), { recursive: true });
    fs.renameSync(path.join(vault, moved), path.join(vault, 'Archive', 'Quill'));
    expect(vaultPrivacy.withheld(vault, 'Archive/Quill/scratchpad.md')).toBe('local-only-agent');
    const tb = toolbox('Ledger');
    const r = await call(tb, 'vault_read', { path: 'Archive/Quill/scratchpad.md' });
    const l = await call(tb, 'vault_list', { path: 'Archive' });
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toMatch(/^Nothing at /);
    expect(l.text).not.toContain('Quill');
    const { embedded, indexed } = await scan();
    expect(indexed.some((p) => p.startsWith('Archive/Quill'))).toBe(false);
    expect(embedded).not.toContain(SECRET);
  });

  it('an unreadable agent.json withholds its folder; one in the bin with none is withheld too', () => {
    fs.mkdirSync(path.join(vault, 'Archive', 'Old'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Archive', 'Old', 'agent.json'), '{ not json');
    fs.writeFileSync(path.join(vault, 'Archive', 'Old', 'notes.md'), 'x');
    expect(vaultPrivacy.withheld(vault, 'Archive/Old/notes.md')).toBe('local-only-agent');
    fs.mkdirSync(path.join(vault, 'Agents', '.removed', 'Nameless-1'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', '.removed', 'Nameless-1', 'notes.md'), 'x');
    expect(vaultPrivacy.withheld(vault, 'Agents/.removed/Nameless-1/notes.md')).toBe('local-only-agent');
  });

  it('a removed Roulette agent and ordinary folders are not withheld', () => {
    const moved = agents.remove(vault, 'Ledger').movedTo;
    fs.writeFileSync(path.join(vault, moved, 'notes.md'), 'x');
    expect(vaultPrivacy.withheld(vault, `${moved}/notes.md`)).toBeNull();
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'plan.md'), 'x');
    expect(vaultPrivacy.withheld(vault, 'Notes/plan.md')).toBeNull();
  });
});

describe('R4-2 saved chats stay out of vault_search, under any name', () => {
  it.skipIf(noLinks)('a link to Agents/Aeon/chat_sessions is refused by vault_read and never indexed or recalled', async () => {
    const sess = path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 's1.json'), JSON.stringify({ id: 's1', messages: [{ role: 'assistant', agent: 'quill', content: `letter: ${SECRET}` }] }));
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(sess, path.join(vault, 'Notes', 'chats'));
    const r = await call(toolbox('Aeon'), 'vault_read', { path: 'Notes/chats/s1.json' });
    expect(r.status).toBe('refused');
    const { embedded, indexed } = await scan();
    expect(indexed.some((p) => /chats|chat_sessions/i.test(p))).toBe(false);
    expect(embedded).not.toContain(SECRET);
  });

  it.skipIf(noLinks)('a link to blocks/security is never indexed', async () => {
    const sec = path.join(vault, 'blocks', 'security');
    fs.mkdirSync(sec, { recursive: true });
    fs.writeFileSync(path.join(sec, 'log.md'), `audit ${SECRET}`);
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(sec, path.join(vault, 'Notes', 'sec'));
    const { embedded, indexed } = await scan();
    expect(indexed.some((p) => /Notes\/sec|blocks\/security/i.test(p))).toBe(false);
    expect(embedded).not.toContain(SECRET);
  });

  it.skipIf(noLinks)('an index entry made before the rule is never a recall candidate', () => {
    const sess = path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 's1.json'), '{}');
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(sess, path.join(vault, 'Notes', 'chats'));
    const sc = vaultPrivacy.createScope(vault);
    expect(sc.neverShared('Notes/chats/s1.json')).toBe(true);
    expect(sc.neverShared('agents/aeon/CHAT_SESSIONS/s1.json')).toBe(true);
    expect(sc.neverShared('Notes/plan.md')).toBe(false);
  });
});

describe('R4-3 a model cannot learn that a switched-off memory exists', () => {
  async function withMemoryCore(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null, requestIndex: () => {} }));
    const saved = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = await listen(app);
    try { return await fn(); } finally {
      if (saved === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = saved;
    }
  }

  beforeEach(() => {
    const lm = path.join(vault, 'Agents', 'Ledger', 'memory');
    fs.mkdirSync(lm, { recursive: true });
    fs.writeFileSync(path.join(lm, 'memories.json'), JSON.stringify([
      { id: 'l0', text: 'The operator closes the books on the 5th', category: 'fact', active: true, timestamp: 1 },
      { id: 'l1', text: OFFTEXT, category: 'fact', active: false, timestamp: 2 },
    ]));
    fs.writeFileSync(path.join(lm, 'l0.md'), '---\nid: l0\ncategory: fact\n---\n\nThe operator closes the books on the 5th\n');
    fs.writeFileSync(path.join(lm, 'l1.md'), `---\nid: l1\ncategory: fact\nactive: false\n---\n\n${OFFTEXT}\n`);
  });

  it('vault_list, memory_save, vault_list: the same trace for an Off match and for new text', async () => {
    await withMemoryCore(async () => {
      const trace = async (text) => {
        const tb = toolbox('Ledger');
        const before = (await call(tb, 'vault_list', { path: 'Agents/Ledger/memory' })).text;
        const saved = (await call(tb, 'memory_save', { text })).text;
        const after = (await call(tb, 'vault_list', { path: 'Agents/Ledger/memory' })).text;
        const folder = (await call(tb, 'vault_list', { path: 'Agents/Ledger' })).text;
        return { before, saved: saved.replace(text, 'X'), after, folder };
      };
      const hit = await trace(OFFTEXT.toLowerCase());
      const miss = await trace('The operator pays rent on the first Monday');
      expect(hit).toEqual(miss);
      expect(hit.folder).not.toMatch(/memory/);
    });
  });

  it('a memory file reads the same whether or not it holds an Off memory, and never says one exists', async () => {
    const tb = toolbox('Ledger');
    const store = await call(tb, 'vault_read', { path: 'Agents/Ledger/memory/memories.json' });
    const off = await call(tb, 'vault_read', { path: 'Agents/Ledger/memory/l1.md' });
    const on = await call(tb, 'vault_read', { path: 'Agents/Ledger/memory/l0.md' });
    for (const o of [store, off, on]) {
      expect(o.status).toBe('refused');
      expect(o.text).not.toMatch(/switched.off/i);
      expect(o.text).not.toContain(OFFTEXT);
    }
    expect(store.text.replace('memories.json', 'F')).toBe(on.text.replace('l0.md', 'F'));
    expect(off.text.replace('l1.md', 'F')).toBe(on.text.replace('l0.md', 'F'));
  });

  it('a Local only agent\'s memory folder and a missing one answer alike to a Roulette caller', async () => {
    const tb = toolbox('Ledger');
    const quill = await call(tb, 'vault_list', { path: 'Agents/Quill/memory' });
    const none = await call(tb, 'vault_list', { path: 'Agents/Nobody/memory' });
    expect(quill.text.replace('Quill', 'X')).toBe(none.text.replace('Nobody', 'X'));
    const qc = await call(tb, 'vault_read', { path: 'Agents/Quill/chat_sessions/a.json' });
    const nc = await call(tb, 'vault_read', { path: 'Agents/Nobody/chat_sessions/a.json' });
    expect(qc.text.replace('Quill', 'X')).toBe(nc.text.replace('Nobody', 'X'));
  });
});

describe('R4-14 the claim check knows every agent', () => {
  async function chat(body, answer) {
    const kernelLLM = {
      describeRole: async () => ({ provider: 'groq', model: 'm', contextTokens: 32768 }),
      stream: (messages, opts) => fakeStream([{ tokens: [answer] }]).stream(messages, opts),
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
    const base = await listen(app);
    return fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
  }

  it('"I asked Quill" from a Roulette agent (it may not ask Quill) is flagged', async () => {
    const sse = await chat({ message: 'what does Quill think?', agent: 'ledger' }, 'I asked Quill and it agrees.');
    expect(sse).toMatch(/unbacked-claim[^\n]*I asked Quill/);
  });

  it('a name that is no agent is not', async () => {
    const sse = await chat({ message: 'hi', agent: 'ledger' }, 'I asked Bob and he agrees.');
    expect(sse).not.toMatch(/unbacked-claim[^\n]*I asked Bob/);
  });
});
