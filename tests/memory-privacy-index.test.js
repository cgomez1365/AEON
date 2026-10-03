/**
 * "Local only" and "Off" keep a memory out of the Second Brain (audit #2,
 * 2026-10-03).
 *
 * Memory Core said an agent set to Local only "never leaves this computer"
 * and a switched-off memory is "not sent to the model". Neither was true:
 * every memory is mirrored to a Vault .md file (switched-off ones too), the
 * indexer walked Agents/ whole and handed each file to the embedder — a cloud
 * one, by default, when only a cloud key is set — and /recall and /ask quoted
 * the result into a chat call.
 *
 * Drives the REAL ingest, retrieve and memory_core routers against a temp
 * Vault, with an embedder stub that records every text it is given.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');
const retrieveFactory = require('../src/blocks/aeon_matrix/api/retrieve.cjs');
const memoryFactory = require('../src/blocks/memory_core/api/memory.cjs');
const vaultPrivacy = require('../src/kernel/vaultPrivacy.cjs');
const { narrate } = require('../src/kernel/commandNarrator.cjs');
const { buildRecallContext } = require('../src/kernel/context.cjs');
const matrixFactory = require('../src/blocks/aeon_matrix/api/index.cjs');
const createChatRouter = require('../src/blocks/dashboard/api/chat.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');
const agentsKernel = require('../src/kernel/agents.cjs');
const createFsRouter = require('../src/blocks/host_os/api/fs.cjs');
const createAIRouter = require('../src/kernel/routers/ai.cjs');

let root, vault, dataRoot, embedded, servers;
const embed = async (text, opts = {}) => {
  embedded.push({ text: String(text), opts });
  return { vector: [1, 0, 0], model: 'stub' };
};
const scan = () => ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }).runSecondBrainScan();
const indexed = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8')).documents).sort();
const write = (rel, body) => {
  const full = path.join(vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const mirror = (id, text, off = false) => `---\nid: ${id}\ncategory: fact\npinned: false\n${off ? 'active: false\n' : ''}created: 2026-10-03T00:00:00.000Z\n---\n\n${text}\n`;
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}/api`); });
});
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();

const ON_TEXT = 'The operator ships the store packs on Fridays after the gate runbook passes.';
const OFF_TEXT = 'The operator keeps the bank PIN reminder phrase written as blue heron seven.';
const SCOUT_TEXT = 'Scout watches card auctions and the ceiling for a Charizard is four hundred dollars.';

function fixture() {
  write('Notes/plan.md', '# Plan\n\nThe launch plan names three pilot customers and a refund policy draft.\n');
  write('Agents/Aeon/memory/memories.json', [
    { id: 'on1', text: ON_TEXT, category: 'fact', timestamp: 1 },
    { id: 'off1', text: OFF_TEXT, category: 'fact', timestamp: 2, active: false },
  ]);
  write('Agents/Aeon/memory/on1.md', mirror('on1', ON_TEXT));
  write('Agents/Aeon/memory/off1.md', mirror('off1', OFF_TEXT, true));
  write('Agents/Scout/agent.json', { id: 'scout', name: 'Scout', privacy: 'local-only', persona: 'Card auction watcher.' });
  write('Agents/Scout/memory/memories.json', [{ id: 's1', text: SCOUT_TEXT, category: 'fact', timestamp: 3 }]);
  write('Agents/Scout/memory/s1.md', mirror('s1', SCOUT_TEXT));
  write('Agents/Scout/missions/log.json', [{ at: '2026-10-03T00:00:00Z', asked: 'what is the Charizard ceiling today' }]);
}

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-mem-privacy-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  embedded = [];
  servers = [];
  fixture();
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  ingestMod._resetStores();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('vaultPrivacy — what is withheld', () => {
  it('a Local only agent\'s folder, a switched-off memory and a store that holds one; nothing else', () => {
    const p = vaultPrivacy.createScope(vault);
    expect(p.withheld('Agents/Scout')).toBe('local-only-agent');
    expect(p.withheld('Agents/Scout/memory/s1.md')).toBe('local-only-agent');
    expect(p.withheld('Agents/Aeon/memory/off1.md')).toBe('memory-off');
    expect(p.withheld('Agents/Aeon/memory/memories.json')).toBe('memory-store');
    expect(p.withheld('Agents/Aeon/memory/on1.md')).toBeNull();
    expect(p.withheld('Notes/plan.md')).toBeNull();
    expect(p.withheld('Agents/council/debates/x.md')).toBeNull();
  });

  it('a mirror its store does not list is judged by its own front matter', () => {
    write('Agents/Aeon/memory/orphan.md', mirror('orphan', 'An orphaned mirror that was switched off by hand.', true));
    expect(vaultPrivacy.withheld(vault, 'Agents/Aeon/memory/orphan.md')).toBe('memory-off');
  });

  it('an agent.json that cannot be read withholds its folder (fails closed)', () => {
    write('Agents/Broken/agent.json', '{ "privacy": "local-only", ');
    write('Agents/Broken/memory/b1.md', mirror('b1', 'Broken agent memory text.'));
    expect(vaultPrivacy.withheld(vault, 'Agents/Broken/memory/b1.md')).toBe('local-only-agent');
  });
});

describe('the scan never reads, embeds or indexes what is withheld', () => {
  it('Off memories and a Local only agent\'s memory, chats and missions stay out', async () => {
    const r = await scan();
    expect(r.errors).toEqual([]);
    expect(indexed()).toEqual(['Agents/Aeon/memory/on1.md', 'Notes/plan.md']);
    const sent = embedded.map((e) => e.text).join('\n');
    expect(sent).toContain('ships the store packs');
    expect(sent, 'a switched-off memory reached the embedder').not.toContain('blue heron');
    expect(sent, 'a Local only agent\'s memory reached the embedder').not.toContain('Charizard');
  });

  it('a memory switched off after it was indexed leaves the index on the next scan, and comes back when switched on', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    const base = await listen(app);

    await scan();
    expect(indexed()).toContain('Agents/Aeon/memory/on1.md');

    const off = await post(`${base}/memory/on1/active`, { active: false });
    expect(off.active).toBe(false);
    const r = await scan();
    expect(indexed()).not.toContain('Agents/Aeon/memory/on1.md');
    expect(r.withheld).toBe(1);
    expect(r.deleted).toBe(1);

    await post(`${base}/memory/on1/active`, { active: true });
    await scan();
    expect(indexed()).toContain('Agents/Aeon/memory/on1.md');
  });

  it('an agent set to Local only after it was indexed leaves the index on the next scan', async () => {
    write('Agents/Roam/agent.json', { id: 'roam', name: 'Roam', privacy: 'roulette' });
    write('Agents/Roam/memory/memories.json', [{ id: 'r1', text: 'Roam tracks the shipping lanes for the logistics pack pilot.', timestamp: 1 }]);
    write('Agents/Roam/memory/r1.md', mirror('r1', 'Roam tracks the shipping lanes for the logistics pack pilot.'));
    await scan();
    expect(indexed()).toContain('Agents/Roam/memory/r1.md');

    write('Agents/Roam/agent.json', { id: 'roam', name: 'Roam', privacy: 'local-only' });
    await scan();
    expect(indexed().filter((p) => p.startsWith('Agents/Roam/'))).toEqual([]);
  });

  it('a single-document ingest into a withheld path saves nothing to the index', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }));
    const base = await listen(app);
    const out = await post(`${base}/crn/second-brain/ingest/document`, { file_path: 'Agents/Scout/memory/s1.md' });
    expect(out).toMatchObject({ ok: true, ingested: 0, withheld: 'local-only-agent' });
    expect(embedded.map((e) => e.text).join('\n')).not.toContain('Charizard');
  });
});

describe('recall never returns what is withheld', () => {
  // An index written before the switches were flipped: the entries are still
  // in vault_index.json, and recall must not hand them over in the meantime.
  function staleIndex() {
    const doc = (p, title, summary) => ({ path: p, title, summary, tags: [], type: 'md', embedding: [1, 0, 0], embeddingModel: 'stub', chunks: 0 });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'vault_index.json'), JSON.stringify({ documents: {
      'Notes/plan.md': doc('Notes/plan.md', 'Plan', 'launch plan'),
      'Agents/Aeon/memory/on1.md': doc('Agents/Aeon/memory/on1.md', 'on', ON_TEXT),
      'Agents/Aeon/memory/off1.md': doc('Agents/Aeon/memory/off1.md', 'off', OFF_TEXT),
      'Agents/Aeon/memory/memories.json': doc('Agents/Aeon/memory/memories.json', 'store', 'store'),
      'Agents/Scout/memory/s1.md': doc('Agents/Scout/memory/s1.md', 'scout', SCOUT_TEXT),
    } }));
  }

  async function mountRetrieve() {
    const app = express();
    app.use(express.json());
    app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }));
    return listen(app);
  }

  it('/retrieve: a switched-off memory and a Local only agent\'s memory are never candidates', async () => {
    staleIndex();
    const base = await mountRetrieve();
    const out = await post(`${base}/crn/second-brain/retrieve`, { query: 'what does the operator keep and ship', k: 10 });
    const paths = out.documents.map((d) => d.id).sort();
    expect(paths).toEqual(['Agents/Aeon/memory/on1.md', 'Notes/plan.md']);
    expect(JSON.stringify(out)).not.toContain('blue heron');
    expect(JSON.stringify(out)).not.toContain('Charizard');
  });

  it('/retrieve section lookup ("facts") leaves out a switched-off memory', async () => {
    const base = await mountRetrieve();
    const out = await post(`${base}/crn/second-brain/retrieve`, { query: 'facts' });
    expect(out.source).toBe('memory-store');
    expect(out.text).toContain('store packs');
    expect(out.text).not.toContain('blue heron');
  });

  it('localOnly on the request reaches the embedder for the query', async () => {
    staleIndex();
    const base = await mountRetrieve();
    await post(`${base}/crn/second-brain/retrieve`, { query: 'launch plan customers', localOnly: true });
    const q = embedded.find((e) => e.opts.kind === 'query');
    expect(q.opts.localOnly).toBe(true);
    embedded.length = 0;
    await post(`${base}/crn/second-brain/retrieve`, { query: 'launch plan customers' });
    expect(embedded.find((e) => e.opts.kind === 'query').opts.localOnly).toBeUndefined();
  });

  it('an agent set to Local only asks recall with localOnly', async () => {
    const bodies = [];
    const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ documents: [] }), { status: 200 }); };
    await buildRecallContext('/matrix what is the ceiling', { fetchImpl, localOnly: true });
    await buildRecallContext('/matrix what is the ceiling', { fetchImpl });
    expect(bodies).toEqual([{ query: 'what is the ceiling', localOnly: true }, { query: 'what is the ceiling' }]);
  });
});

describe('the terminal never reads a switched-off memory back into the conversation', () => {
  it('/memory carries modelText without the switched-off memories, and the narrator uses only that', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    const base = await listen(app);
    const data = await (await fetch(`${base}/memory`)).json();
    expect(data.text).toContain('blue heron'); // the operator's own chip shows everything
    expect(data.modelText).not.toContain('blue heron');
    expect(data.modelText).toContain('1 switched off');

    let asked = 0;
    const llm = async () => { asked++; return 'should not be called'; };
    const n = await narrate({ cmd: '/memory', ok: true, text: data.text, data }, llm);
    expect(n.narration).not.toContain('blue heron');
    expect(asked).toBe(0);
  });

  it('a Local only agent\'s /memory is not read back at all', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    const base = await listen(app);
    const data = await (await fetch(`${base}/memory?agent=scout`)).json();
    expect(data.modelText).toBeNull();
    const ctx = await (await fetch(`${base}/memory/context?agent=scout`)).json();
    expect(ctx.text).toContain('Charizard');
    expect(ctx.modelText).toBeNull();
    const n = await narrate({ cmd: '/memory', ok: true, text: data.text, data }, async () => 'x');
    expect(n.narration).not.toContain('Charizard');
  });
});

describe('/doc shows a withheld file to the operator and keeps it out of the conversation', () => {
  async function mountMatrix() {
    const app = express();
    app.use(express.json());
    app.use('/api', matrixFactory({ VAULT_ROOT: vault, DATA_ROOT: dataRoot, getDataFile: () => path.join(dataRoot, 'aeon_matrix') }));
    return listen(app);
  }
  const doc = async (base, p) => (await fetch(`${base}/crn/second-brain/document?resolve=1&path=${encodeURIComponent(p)}`)).json();

  it('a switched-off memory and a Local only agent\'s file carry modelText: null; an ordinary file does not', async () => {
    const base = await mountMatrix();
    const off = await doc(base, 'Agents/Aeon/memory/off1.md');
    expect(off.text).toContain('blue heron');
    expect(off.modelText).toBeNull();
    const scout = await doc(base, 'Agents/Scout/memory/s1.md');
    expect(scout.modelText).toBeNull();
    const n = await narrate({ cmd: '/doc', ok: true, text: off.text, data: off }, async () => 'x');
    expect(n.narration).not.toContain('blue heron');

    const plain = await doc(base, 'Notes/plan.md');
    expect(plain.found).toBe(true);
    expect('modelText' in plain).toBe(false);
  });
});

describe('a Local only agent\'s saved chats stay off cloud models', () => {
  const SCOUT_CHAT = [
    { role: 'user', content: 'Scout, what is our private ceiling for the Charizard lot tonight?' },
    { role: 'assistant', content: 'Four hundred.' },
  ];
  const AEON_CHAT = [
    { role: 'user', content: 'Remind me when the store packs gate runbook is due this week.' },
    { role: 'assistant', content: 'Friday.' },
  ];
  const sessionsDir = () => path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
  const saveChat = (id, record) => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), `${id}.json`), JSON.stringify({ id, name: id, ...record }));
  };

  async function mountChat(kernelLLM) {
    const app = express();
    app.use(express.json());
    app.use('/api', createChatRouter({
      isVercel: false, supabase: null, VAULT_ROOT: vault, kernelLLM,
      getLocalFile: () => null, getDailyCost: () => 0, addRunCost: () => {}, KILL_SWITCH_THRESHOLD: 999, writeOSAudit: () => {},
    }));
    return listen(app);
  }

  it('naming a Local only agent\'s chat asks with its privacy (local only); the operator\'s Roulette chat does not', async () => {
    const calls = [];
    const base = await mountChat(async (prompt, opts) => { calls.push({ prompt, opts }); return 'Charizard Ceiling'; });
    saveChat('scout-chat', { agent: 'scout', updatedAt: '2026-10-03T10:00:00Z', messages: SCOUT_CHAT });
    saveChat('aeon-chat', { updatedAt: '2026-10-03T09:00:00Z', messages: AEON_CHAT });

    await post(`${base}/terminal/sessions/scout-chat/name`);
    await post(`${base}/terminal/sessions/aeon-chat/name`);
    expect(calls).toHaveLength(2);
    expect(calls[0].opts).toMatchObject({ role: 'naming', localOnly: true });
    expect(calls[1].opts.localOnly).toBeUndefined();
  });

  it('a Local only agent\'s chat is not added to the indexed record', async () => {
    const base = await mountChat(async () => 'x');
    saveChat('scout-chat', { agent: 'scout', messages: SCOUT_CHAT });
    const r = await fetch(`${base}/terminal/sessions/scout-chat/remember`, { method: 'POST' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('local_only');
    expect(fs.existsSync(path.join(vault, 'Chat_History'))).toBe(false);
  });

  it('distil from the shared memory skips a Local only agent\'s chat, and refuses it by id', async () => {
    const prompts = [];
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null,
      kernelLLM: async (prompt, opts) => { prompts.push({ prompt, opts }); return '[]'; } }));
    const base = await listen(app);
    saveChat('scout-chat', { agent: 'scout', updatedAt: '2026-10-03T10:00:00Z', messages: SCOUT_CHAT });
    saveChat('aeon-chat', { updatedAt: '2026-10-03T09:00:00Z', messages: AEON_CHAT });

    const out = await post(`${base}/memory/distill`, {});
    expect(out.session).toBe('aeon-chat');
    expect(prompts.map((p) => p.prompt).join('\n')).not.toContain('Charizard');

    const r = await fetch(`${base}/memory/distill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'scout-chat' }) });
    expect(r.status).toBe(409);
    expect(prompts).toHaveLength(1);
  });
});

describe('one feed, several agents: a Local only agent\'s turns reach only a Local only model', () => {
  const SCOUT_LINE = 'Scout, keep the Charizard ceiling at four hundred tonight.';
  const feedTurns = [
    { role: 'user', content: SCOUT_LINE, agent: 'scout' },
    { role: 'assistant', content: 'Holding the Charizard ceiling.', agent: 'scout' },
    { role: 'user', content: 'Back to you: when is the store packs gate due?', agent: 'aeon' },
    { role: 'assistant', content: 'Friday.', agent: 'aeon' },
    { role: 'user', content: 'An untagged line from a chat saved before tags existed.' },
  ];

  it('shareableTurns drops the tagged turns of a Local only agent, unless the call is Local only', () => {
    const agents = agentsKernel.list(vault, { withStats: false });
    const scout = agents.find((a) => a.id === 'scout');
    expect(scout.privacy).toBe('local-only');
    const toCloud = agentsKernel.shareableTurns(feedTurns, agents.find((a) => a.self), agents);
    expect(toCloud.map((m) => m.content).join('\n')).not.toContain('Charizard');
    expect(toCloud).toHaveLength(3);
    expect(agentsKernel.shareableTurns(feedTurns, null, agents)).toHaveLength(3);
    expect(agentsKernel.shareableTurns(feedTurns, scout, agents)).toHaveLength(5);
  });

  it('the terminal tags each turn it sends with its agent', async () => {
    const { chatHistory, liveTurns } = await import('../src/components/Terminal2.jsx');
    const feed = [
      { id: 1, type: 'msg', role: 'system', content: 'boot' },
      { id: 2, type: 'msg', role: 'user', content: SCOUT_LINE, agent: 'scout' },
      { id: 3, type: 'msg', role: 'assistant', content: 'x'.repeat(500), agent: 'scout' },
      { id: 4, type: 'msg', role: 'user', content: 'untagged' },
    ];
    expect(chatHistory(feed)).toEqual([
      { role: 'user', content: SCOUT_LINE, agent: 'scout' },
      { role: 'assistant', content: 'x'.repeat(500), agent: 'scout' },
      { role: 'user', content: 'untagged' },
    ]);
    expect(liveTurns(feed)[1].content).toHaveLength(400);
  });

  it('the chat stream leaves them out of the history it sends a Roulette agent\'s model, and keeps them for Scout', async () => {
    const sent = [];
    const kernelLLM = {
      describeRole: async () => ({ provider: 'stub', model: 'stub-model', contextTokens: 8192 }),
      stream: async (messages, { onToken }) => { sent.push(messages); onToken('ok'); return { text: 'ok', tokens: 1, latencyMs: 1, provider: 'stub', model: 'stub-model' }; },
    };
    const kernel = express();
    kernel.use(express.json());
    kernel.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
    const kernelBase = await listen(kernel);
    const saved = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = kernelBase.replace(/\/api$/, '');
    try {
      const app = express();
      app.use(express.json());
      app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
      const base = await listen(app);
      const ask = async (agent) => {
        const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'what did we settle?', history: feedTurns, ...(agent ? { agent } : {}) }) });
        await r.text();
      };
      await ask(null);
      expect(JSON.stringify(sent[0])).not.toContain('Charizard');
      expect(JSON.stringify(sent[0])).toContain('store packs gate');
      await ask('scout');
      expect(JSON.stringify(sent[1])).toContain('Charizard');
    } finally {
      if (saved === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = saved;
    }
  });

  it('distil of the live turns leaves a Local only agent\'s turns out', async () => {
    const prompts = [];
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null,
      kernelLLM: async (prompt) => { prompts.push(prompt); return '[]'; } }));
    const base = await listen(app);
    await post(`${base}/memory/distill`, { messages: feedTurns });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Charizard');
    expect(prompts[0]).toContain('store packs gate');

    const r = await fetch(`${base}/memory/distill`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: feedTurns.slice(0, 2) }) });
    expect(r.status).toBe(400);
    expect(prompts).toHaveLength(1);
  });

  it('a saved chat that switched agents is titled and remembered without the Local only turns', async () => {
    const calls = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createChatRouter({
      isVercel: false, supabase: null, VAULT_ROOT: vault,
      kernelLLM: async (prompt, opts) => { calls.push({ prompt, opts }); return 'Gate Dates'; },
      getLocalFile: () => null, getDailyCost: () => 0, addRunCost: () => {}, KILL_SWITCH_THRESHOLD: 999, writeOSAudit: () => {},
    }));
    const base = await listen(app);
    const ingested = [];
    const matrix = express();
    matrix.use(express.json());
    matrix.post('/api/crn/second-brain/ingest/chat', (req, res) => { ingested.push(req.body); res.json({ ok: true, ingested: 1 }); });
    const matrixBase = await listen(matrix);
    const saved = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = matrixBase.replace(/\/api$/, '');
    try {
      const dir = path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mixed.json'), JSON.stringify({ id: 'mixed', name: 'mixed', messages: feedTurns }));

      await post(`${base}/terminal/sessions/mixed/name`);
      expect(calls[0].prompt).not.toContain('Charizard');
      expect(calls[0].opts.localOnly).toBeUndefined();

      const r = await post(`${base}/terminal/sessions/mixed/remember`);
      expect(r.ok).toBe(true);
      expect(JSON.stringify(ingested)).not.toContain('Charizard');
      expect(JSON.stringify(ingested)).toContain('store packs gate');
    } finally {
      if (saved === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = saved;
    }
  });
});

describe('/read does not summarise a withheld Vault file with a model', () => {
  it('a Local only agent\'s memory and a switched-off memory are shown, not summarised or read back; other files are', async () => {
    const asked = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createFsRouter({ isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: vault,
      kernelLLM: async (prompt) => { asked.push(prompt); return 'A summary.'; }, getDataFile: (n) => path.join(root, n) }));
    const base = await listen(app);
    for (const rel of ['Agents/Scout/memory/s1.md', 'Agents/Aeon/memory/off1.md']) {
      const out = await post(`${base}/fs/read`, { filePath: path.join(vault, ...rel.split('/')) });
      expect(out.summary, rel).toBeNull();
      expect(out.modelText, rel).toBeNull();
    }
    expect(asked).toEqual([]);
    const plain = await post(`${base}/fs/read`, { filePath: path.join(vault, 'Notes', 'plan.md') });
    expect(plain.summary).toBe('A summary.');
    expect('modelText' in plain).toBe(false);
  });
});

describe('an image in a Local only agent\'s chat is not sent to a vision model', () => {
  it('refuses for Scout, reads it for the operator\'s Roulette AEON', async () => {
    const seen = [];
    const app = express();
    app.use(express.json());
    app.use('/api/ai', createAIRouter({ VAULT_ROOT: vault, kernelVision: async (image, prompt) => { seen.push(prompt); return 'a chart'; } }));
    const base = await listen(app);
    const ask = (agent) => fetch(`${base}/ai/vision`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/png;base64,AAAA', prompt: 'What is the Charizard ceiling here?', ...(agent ? { agent } : {}) }) });
    const r = await ask('scout');
    expect(r.status).toBe(409);
    expect(seen).toEqual([]);
    const ok = await ask(null);
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe('a path is judged as the disk resolves it, not as it was typed', () => {
  // macOS (APFS), Windows and the exFAT drive ignore case: "agents/scout/…"
  // opens Scout's file there. Mis-cased paths are withheld on every disk.
  const MIS = 'agents/scout/memory/s1.md';

  it('vaultPrivacy: mis-cased, "..", and a symlink into Agents/', () => {
    const p = vaultPrivacy.createScope(vault);
    expect(p.withheld(MIS)).toBe('local-only-agent');
    expect(p.withheld('AGENTS/Scout')).toBe('local-only-agent');
    expect(p.withheld('Agents/aeon/MEMORY/off1.md')).toBe('memory-off');
    expect(p.withheld('Notes/../Agents/Scout/memory/s1.md')).toBe('local-only-agent');
    expect(p.withheldAt(path.join(vault, 'agents', 'scout', 'memory', 's1.md'))).toBe('local-only-agent');
    let linked = false;
    try { fs.symlinkSync(path.join(vault, 'Agents', 'Scout'), path.join(vault, 'Notes', 'scout-link'), 'dir'); linked = true; } catch { /* no symlinks here (Windows without the privilege) */ }
    if (linked) expect(p.withheld('Notes/scout-link/memory/s1.md')).toBe('local-only-agent');
  });

  it('/read of a mis-cased Local only path is shown, not summarised or read back', async () => {
    const asked = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createFsRouter({ isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: vault,
      kernelLLM: async (prompt) => { asked.push(prompt); return 'A summary.'; }, getDataFile: (n) => path.join(root, n) }));
    const base = await listen(app);
    const out = await post(`${base}/fs/read`, { filePath: path.join(vault, ...MIS.split('/')) });
    if (out.success) {
      // A disk that ignores case opened the file: it must not reach a model.
      expect(out.summary).toBeNull();
      expect(out.modelText).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it('a mis-cased single-document ingest indexes and embeds nothing', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }));
    const base = await listen(app);
    const out = await post(`${base}/crn/second-brain/ingest/document`, { file_path: MIS });
    expect(out.ingested ?? 0).toBe(0);
    expect(embedded.map((e) => e.text).join('\n')).not.toContain('Charizard');
  });
});

describe('a memory with no <id>.md mirror can still be recalled', () => {
  const LOST_TEXT = 'The warehouse alarm code changes on the first Monday of every quarter.';

  it('a store with every memory on is indexed; one with a memory switched off is not', async () => {
    write('Agents/Aeon/memory/memories.json', [
      { id: 'on1', text: ON_TEXT, category: 'fact', timestamp: 1 },
      { id: 'lost1', text: LOST_TEXT, category: 'fact', timestamp: 2 },
    ]);
    fs.rmSync(path.join(vault, 'Agents', 'Aeon', 'memory', 'off1.md'));
    expect(vaultPrivacy.withheld(vault, 'Agents/Aeon/memory/memories.json')).toBeNull();
    await scan();
    expect(indexed()).toContain('Agents/Aeon/memory/memories.json');
    expect(embedded.map((e) => e.text).join('\n')).toContain('warehouse alarm');

    // Switched off: the whole store leaves the index on the next scan, and
    // recall drops it before that.
    write('Agents/Aeon/memory/memories.json', [
      { id: 'on1', text: ON_TEXT, category: 'fact', timestamp: 1 },
      { id: 'lost1', text: LOST_TEXT, category: 'fact', timestamp: 2, active: false },
    ]);
    expect(vaultPrivacy.withheld(vault, 'Agents/Aeon/memory/memories.json')).toBe('memory-store');
    await scan();
    expect(indexed()).not.toContain('Agents/Aeon/memory/memories.json');
  });

  it('Memory Core writes the mirror a memory is missing when it reads the store', async () => {
    write('Agents/Aeon/memory/memories.json', [
      { id: 'on1', text: ON_TEXT, category: 'fact', timestamp: 1 },
      { id: 'lost1', text: LOST_TEXT, category: 'fact', timestamp: 2 },
    ]);
    const mirrorFile = path.join(vault, 'Agents', 'Aeon', 'memory', 'lost1.md');
    expect(fs.existsSync(mirrorFile)).toBe(false);
    const app = express();
    app.use(express.json());
    app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    const base = await listen(app);
    await (await fetch(`${base}/memory`)).json();
    expect(fs.readFileSync(mirrorFile, 'utf8')).toContain('warehouse alarm');
  });
});

describe('slash commands run for a Local only agent stay on local models', () => {
  const registryFactory = require('../src/kernel/commandRegistry.cjs');

  it('dispatch adds localOnly to a command that declares takesLocalOnly, for that agent only', async () => {
    const seen = [];
    const app = express();
    app.use(express.json());
    app.post('/api/crn/second-brain/ask', (req, res) => { seen.push(req.body); res.json({ ok: true, text: 'answer' }); });
    app.use('/api', registryFactory({ vaultRoot: vault, hasEmbedding: () => true }).router);
    const base = await listen(app);
    const savedPort = process.env.PORT;
    process.env.PORT = new URL(base).port;
    try {
      await post(`${base}/commands/dispatch`, { cmd: '/ask', arg: 'what is the ceiling', agent: 'scout' });
      await post(`${base}/commands/dispatch`, { cmd: '/ask', arg: 'what is the ceiling' });
    } finally { if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; }
    expect(seen).toEqual([{ query: 'what is the ceiling', localOnly: true }, { query: 'what is the ceiling' }]);
  });

  it('the operator\'s own AEON set to Local only counts too (no agent named)', async () => {
    write('Agents/Aeon/agent.json', { name: 'Aeon', privacy: 'local-only' });
    const seen = [];
    const app = express();
    app.use(express.json());
    app.post('/api/crn/second-brain/ask', (req, res) => { seen.push(req.body); res.json({ ok: true, text: 'answer' }); });
    app.use('/api', registryFactory({ vaultRoot: vault, hasEmbedding: () => true }).router);
    const base = await listen(app);
    const savedPort = process.env.PORT;
    process.env.PORT = new URL(base).port;
    try { await post(`${base}/commands/dispatch`, { cmd: '/ask', arg: 'q' }); }
    finally { if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; }
    expect(seen).toEqual([{ query: 'q', localOnly: true }]);
  });

  it('narration of a Local only agent\'s result asks the model with localOnly', async () => {
    const calls = [];
    const kernelLLM = async (prompt, opts) => { calls.push(opts); return 'A sentence.'; };
    const app = express();
    app.use(express.json());
    app.use('/api', registryFactory({ vaultRoot: vault, kernelLLM }).router);
    const base = await listen(app);
    const long = 'x'.repeat(600);
    await post(`${base}/commands/narrate`, { cmd: '/ask', ok: true, text: long, agent: 'scout' });
    await post(`${base}/commands/narrate`, { cmd: '/ask', ok: true, text: long });
    expect(calls[0]).toMatchObject({ role: 'chat', localOnly: true });
    expect(calls[1].localOnly).toBeUndefined();
  });

  it('/ask-doc and /read honour localOnly', async () => {
    const llmOpts = [];
    const kernelLLM = async (_p, opts) => { llmOpts.push(opts); return 'An answer.'; };
    await scan();
    const app = express();
    app.use(express.json());
    app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed, kernelLLM }));
    app.use('/api', createFsRouter({ isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: vault, kernelLLM, getDataFile: (n) => path.join(root, n) }));
    const base = await listen(app);
    embedded.length = 0;
    await post(`${base}/crn/second-brain/ask-doc`, { path: 'Notes/plan.md', query: 'who are the pilots', localOnly: true });
    expect(embedded.find((e) => e.opts.kind === 'query').opts.localOnly).toBe(true);
    await post(`${base}/fs/read`, { filePath: path.join(vault, 'Notes', 'plan.md'), localOnly: true });
    expect(llmOpts.length).toBeGreaterThanOrEqual(2);
    for (const o of llmOpts) expect(o.localOnly).toBe(true);
  });
});

describe('a narration that fails never reads a withheld result back', () => {
  it('readBackText honours modelText, and command turns carry their agent', async () => {
    const { readBackText } = await import('../src/components/Terminal2.jsx');
    const { turnAgentId, SELF_AGENT_ID } = await import('../src/utils/terminalAgent.js');
    expect(readBackText({ data: { modelText: null } }, 'Scout: the Charizard ceiling is $400')).toBeNull();
    expect(readBackText({ data: { modelText: '3 memories, 1 switched off.' } }, 'full list')).toBe('3 memories, 1 switched off.');
    expect(readBackText({ data: { files: [] } }, 'plain result')).toBe('plain result');
    expect(readBackText({}, '')).toBeNull();
    expect(SELF_AGENT_ID).toBe(agentsKernel.SELF_ID);
    expect(turnAgentId(null)).toBe(agentsKernel.SELF_ID);
    expect(turnAgentId({ id: 'scout', name: 'Scout' })).toBe('scout');
  });
});
