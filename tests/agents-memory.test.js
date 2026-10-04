/**
 * Agents with memory of their own (operator, 2026-10-02).
 *
 * "memory core — we need to make it agentic … a shared 'all agents memory' …
 * and an agent-specific memory tab … tie the memory block to Vault/Agents for
 * every agent created (shared memories keep their current path) … each memory
 * needs a manual toggle that solves memory capture + context size."
 *
 * Covered here, against real files in a temporary Vault:
 *   - src/kernel/agents.cjs: create / list / rename / remove, the folder
 *     layout, the reserved names, what a model call carries for an agent
 *   - memory_core's routes: ?agent= scoping, the on/off switch (one and many),
 *     what /memory/context gives an agent, "New memories start on"
 *   - memory-policy: a switched-off memory is never injected and is reported
 *     apart from "dropped"
 *   - the streaming chat: the agent's memory, name, model and privacy reach
 *     the model call; a wake that names an agent hands it the turn
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const memoryPolicy = require('../src/kernel/memory-policy.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');

let vault;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(vault, ...p), 'utf8'));

beforeEach(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-agents-')); });
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('agents.cjs — one folder per agent under Vault/Agents', () => {
  it('a fresh Vault has exactly one agent: the operator\'s own AEON', () => {
    const list = agents.list(vault);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'aeon', name: 'Aeon', folder: 'Aeon', self: true, sharedMemory: true });
  });

  it('creates an agent with its own folder, agent.json and memory folder', () => {
    const a = agents.create(vault, { name: 'Ledger Scout', persona: 'Tracks supplier invoices.', privacy: 'local-only' });
    expect(a).toMatchObject({ id: 'ledger_scout', name: 'Ledger Scout', folder: 'Ledger_Scout', self: false, privacy: 'local-only', sharedMemory: true, capture: false });
    expect(readJson('Agents', 'Ledger_Scout', 'agent.json')).toMatchObject({ name: 'Ledger Scout', persona: 'Tracks supplier invoices.' });
    expect(fs.existsSync(path.join(vault, 'Agents', 'Ledger_Scout', 'memory'))).toBe(true);
    expect(agents.list(vault).map((x) => x.name)).toEqual(['Aeon', 'Ledger Scout']);
  });

  it('refuses a taken name, a reserved word and a name that is not a name', () => {
    agents.create(vault, { name: 'Scout' });
    expect(() => agents.create(vault, { name: 'scout' })).toThrow(/already taken/);
    for (const n of ['council', 'Aeon', 'vp']) expect(() => agents.create(vault, { name: n })).toThrow(/taken|reserved/);
    expect(() => agents.create(vault, { name: '' })).toThrow(/needs a name/);
    expect(() => agents.create(vault, { name: '7up' })).toThrow(/starts with a letter/);
    expect(() => agents.create(vault, { name: 'x'.repeat(40) })).toThrow(/at most 32/);
    expect(() => agents.create(vault, { name: 'Bad/Name' })).toThrow(/may use/);
    expect(() => agents.create(vault, { name: 'Ok', privacy: 'cloud-please' })).toThrow(/privacy/);
  });

  it('a folder without agent.json (Agents/council) and OS junk are not agents', () => {
    fs.mkdirSync(path.join(vault, 'Agents', 'council', 'debates'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Agents', 'Scout'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', '._Scout'), Buffer.from([0, 5, 22, 7]));
    expect(agents.list(vault).map((x) => x.id)).toEqual(['aeon']);
  });

  it('the operator can rename their own AEON; its folder (the shared memory) never moves', () => {
    const me = agents.update(vault, 'aeon', { name: 'Jarvis', persona: 'Dry wit.' });
    expect(me).toMatchObject({ id: 'aeon', name: 'Jarvis', folder: 'Aeon', self: true });
    expect(readJson('Agents', 'Aeon', 'agent.json')).toMatchObject({ name: 'Jarvis', persona: 'Dry wit.' });
    expect(agents.get(vault, 'jarvis').self).toBe(true);
    expect(agents.get(vault, 'aeon').self).toBe(true);
  });

  it('remove moves the folder to Agents/.removed — nothing is deleted — and never removes your AEON', () => {
    agents.create(vault, { name: 'Scout' });
    fs.writeFileSync(path.join(vault, 'Agents', 'Scout', 'memory', 'memories.json'), '[{"id":"m","text":"kept"}]');
    const out = agents.remove(vault, 'scout');
    expect(out.movedTo).toMatch(/^Agents[\\/]\.removed[\\/]Scout-/);
    expect(fs.readFileSync(path.join(vault, out.movedTo, 'memory', 'memories.json'), 'utf8')).toContain('kept');
    expect(agents.list(vault).map((x) => x.id)).toEqual(['aeon']);
    expect(() => agents.remove(vault, 'aeon')).toThrow(/cannot be removed/);
  });

  it('a model call for an agent carries its model, and Local only with its own words', () => {
    expect(agents.callOptions(null)).toEqual({});
    expect(agents.callOptions({ name: 'A', model: { provider: 'groq', model: 'openai/gpt-oss-20b' }, privacy: 'roulette' }))
      .toEqual({ provider: 'groq', model: 'openai/gpt-oss-20b' });
    const priv = agents.callOptions({ name: 'Vault Keeper', model: null, privacy: 'local-only' });
    expect(priv.localOnly).toBe(true);
    expect(priv.localOnlyReason).toMatch(/Vault Keeper is set to Local only/);
    expect(priv.localOnlyRemedy).toMatch(/Memory Core/);
  });

  it('the identity line names the agent, and leaves a stock AEON exactly as it was', () => {
    const base = 'You are AEON, a private AI workspace built by Broken Gear Industries. Be concise. ';
    expect(agents.identityFor({ self: true, name: 'Aeon', persona: '' }, base)).toBe(base);
    expect(agents.identityFor({ self: true, name: 'Jarvis', persona: '' }, base)).toMatch(/^You are Jarvis, the operator's own AEON/);
    const scout = agents.identityFor({ self: false, name: 'Scout', persona: 'Finds cards.' }, base);
    expect(scout).toMatch(/^You are Scout, an agent the operator created inside AEON/);
    expect(scout).toContain('Finds cards. Be concise.');
  });
});

describe('memory-policy — the manual switch', () => {
  it('a switched-off memory is never injected, and is counted apart from "dropped"', () => {
    const mem = [
      { id: 'a', text: 'on by default', timestamp: 1 },
      { id: 'b', text: 'switched off', active: false, timestamp: 2 },
      { id: 'c', text: 'pinned but off', pinned: true, active: false, timestamp: 3 },
    ];
    const r = memoryPolicy.selectForInjection({ memories: mem, budgetTokens: 2000 });
    expect(r.text).toContain('on by default');
    expect(r.text).not.toContain('switched off');
    expect(r.text).not.toContain('pinned but off');
    expect(r).toMatchObject({ injected: 1, considered: 1, dropped: 0, disabled: 2 });
  });

  it('an agent\'s own memory outranks the shared pool', () => {
    const mem = [
      { id: 's', text: 'shared fact', _scope: 'shared', timestamp: 2 },
      { id: 'o', text: 'own fact', _scope: 'agent', timestamp: 1 },
    ];
    const r = memoryPolicy.selectForInjection({ memories: mem, budgetTokens: 2000 });
    expect(r.lines[0]).toContain('own fact');
  });
});

describe('memory_core routes — ?agent= scopes every store', () => {
  let base;
  let settings;
  beforeEach(async () => {
    settings = {};
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, loadSettings: () => settings }));
    base = await listen(app);
    agents.create(vault, { name: 'Scout' });
  });
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  it('a memory saved for an agent lands in that agent\'s folder, not the shared one', async () => {
    const r = await call('POST', '/api/memory/add', { agent: 'scout', text: 'Scout tracks Larkspur invoices' });
    expect(r.status).toBe(200);
    expect(readJson('Agents', 'Scout', 'memory', 'memories.json')).toHaveLength(1);
    expect(fs.existsSync(path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json'))).toBe(false);
    const own = await call('GET', '/api/memory?agent=scout');
    expect(own.body.memories.map((m) => m.text)).toEqual(['Scout tracks Larkspur invoices']);
    expect(own.body.agent).toEqual({ id: 'scout', name: 'Scout' });
    const shared = await call('GET', '/api/memory');
    expect(shared.body.count).toBe(0);
  });

  it('an agent nobody has is a 404 that says so, never the shared store', async () => {
    const r = await call('POST', '/api/memory/add', { agent: 'ghost', text: 'should not land anywhere' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/No agent called "ghost"/);
    expect(fs.existsSync(path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json'))).toBe(false);
  });

  it('the switch: one memory, many, and what it adds up to', async () => {
    const a = (await call('POST', '/api/memory/add', { text: 'first shared memory' })).body.memory;
    const b = (await call('POST', '/api/memory/add', { text: 'second shared memory' })).body.memory;
    expect(a.active).toBe(true);
    let r = await call('POST', `/api/memory/${a.id}/active`, { active: false });
    expect(r.body).toMatchObject({ ok: true, active: false });
    expect(readJson('Agents', 'Aeon', 'memory', 'memories.json').find((m) => m.id === a.id).active).toBe(false);
    expect(fs.readFileSync(path.join(vault, 'Agents', 'Aeon', 'memory', `${a.id}.md`), 'utf8')).toContain('active: false');
    r = await call('POST', `/api/memory/${a.id}/active`);           // no body: flip
    expect(r.body.active).toBe(true);
    r = await call('POST', '/api/memory/active', { all: true, active: false });
    expect(r.body).toMatchObject({ ok: true, changed: 2 });
    r = await call('POST', '/api/memory/active', { ids: [b.id], active: true });
    expect(r.body.changed).toBe(1);
    const list = await call('GET', '/api/memory');
    expect(list.body.summary).toMatchObject({ total: 2, active: 1, inactive: 1 });
    expect(list.body.summary.activeTokens).toBeGreaterThan(0);
    expect(list.body.memories.every((m) => typeof m.tokens === 'number')).toBe(true);
    expect((await call('POST', '/api/memory/active', { active: false })).status).toBe(400);
  });

  it('/memory/context for an agent: its own first, then the shared ones it may read', async () => {
    await call('POST', '/api/memory/add', { text: 'shared: the operator runs a bike shop' });
    await call('POST', '/api/memory/add', { agent: 'scout', text: 'own: spend limit is 400 dollars' });
    let r = await call('GET', '/api/memory/context?agent=scout');
    expect(r.body.count).toBe(2);
    expect(r.body.text.indexOf('spend limit')).toBeLessThan(r.body.text.indexOf('bike shop'));
    agents.update(vault, 'scout', { sharedMemory: false });
    r = await call('GET', '/api/memory/context?agent=scout');
    expect(r.body.count).toBe(1);
    expect(r.body.text).not.toContain('bike shop');
  });

  it('"New memories start on" off: new memories are saved switched off', async () => {
    settings = { blockSettings: { memory_core: { new_memories_on: false } } };
    const m = (await call('POST', '/api/memory/add', { text: 'saved but not sent' })).body.memory;
    expect(m.active).toBe(false);
  });

  it('agent routes: list (with text for the terminal), create, update, remove', async () => {
    let r = await call('POST', '/api/agents', { name: 'Ledger', privacy: 'local-only' });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/ledger come online/);
    r = await call('POST', '/api/agents', { name: 'ledger' });
    expect(r.status).toBe(409);
    r = await call('GET', '/api/agents');
    expect(r.body.agents.map((a) => a.name)).toEqual(expect.arrayContaining(['Aeon', 'Scout', 'Ledger']));
    expect(r.body.text).toMatch(/★ Aeon \(your AEON\)/);
    expect(r.body.text).toMatch(/Ledger — Settings decides · local only/);
    r = await call('PUT', '/api/agents/ledger', { model: { provider: 'local', model: 'phi4-mini-q4' } });
    expect(r.body.agent.model).toEqual({ provider: 'local', model: 'phi4-mini-q4' });
    r = await call('DELETE', '/api/agents/ledger');
    expect(r.body.text).toMatch(/moved to .*\.removed/);
    expect((await call('DELETE', '/api/agents/aeon')).status).toBe(409);
  });
});

describe('the streaming chat — the agent speaks with its own memory, name, model and privacy', () => {
  let base;
  let calls;
  let savedKernelUrl;
  beforeAll(async () => {
    const kernel = express();
    kernel.use(express.json());
    kernel.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
    savedKernelUrl = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = await listen(kernel);
  });
  afterAll(() => { if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl; });
  beforeEach(async () => {
    calls = [];
    const kernelLLM = {
      describeRole: async () => ({ provider: 'groq', model: 'role-model', contextTokens: 8192 }),
      stream: async (messages, opts) => {
        calls.push({ messages, opts });
        opts.onToken('ok');
        return { text: 'ok', tokens: 1, latencyMs: 1, provider: opts.provider || 'groq', model: opts.model || 'role-model' };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
    base = await listen(app);
    agents.create(vault, { name: 'Scout', persona: 'Tracks supplier invoices.', privacy: 'local-only', model: { provider: 'local', model: 'phi4-mini-q4' } });
    fs.mkdirSync(path.join(vault, 'Agents', 'Aeon', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json'), JSON.stringify([
      { id: 's1', text: 'The operator runs a bike shop', timestamp: 1 },
      { id: 's2', text: 'A switched-off shared memory', active: false, timestamp: 2 },
    ]));
    fs.writeFileSync(path.join(vault, 'Agents', 'Scout', 'memory', 'memories.json'), JSON.stringify([
      { id: 'o1', text: 'Scout spend limit is 400 dollars', timestamp: 3 },
    ]));
  });
  const chat = async (body) => {
    const r = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const events = (await r.text()).split('\n\n').filter(Boolean).map((b) => {
      const ev = /event: (.*)/.exec(b)?.[1]; const data = /data: (.*)/.exec(b)?.[1];
      return { ev, data: data ? JSON.parse(data) : null };
    });
    return { status: r.status, metas: events.filter((e) => e.ev === 'meta').map((e) => e.data) };
  };

  it('agent: scout — its persona, its memory plus the shared, its model, Local only', async () => {
    const { status, metas } = await chat({ message: 'what is my ceiling?', agent: 'scout' });
    expect(status).toBe(200);
    const { messages, opts } = calls[0];
    expect(messages[0].content).toMatch(/^You are Scout, an agent the operator created inside AEON/);
    expect(messages[0].content).toContain('Tracks supplier invoices.');
    expect(messages[0].content).toContain('Scout spend limit is 400 dollars');
    expect(messages[0].content).toContain('The operator runs a bike shop');
    expect(messages[0].content).not.toContain('switched-off shared memory');
    expect(opts).toMatchObject({ provider: 'local', model: 'phi4-mini-q4', localOnly: true });
    expect(metas[0]).toMatchObject({ provider: 'local', model: 'phi4-mini-q4', agent: { id: 'scout', name: 'Scout', self: false } });
    expect(metas.find((m) => 'memory' in m)).toMatchObject({ memory: 2, memoryDisabled: 1 });
  });

  it('no agent: the stock AEON, Settings decides the model, nothing forced', async () => {
    const { metas } = await chat({ message: 'hello' });
    const { messages, opts } = calls[0];
    expect(messages[0].content).toMatch(/^You are AEON, a private AI workspace/);
    expect(messages[0].content).not.toContain('Scout spend limit');
    expect(opts.provider).toBeUndefined();
    expect(opts.localOnly).toBeUndefined();
    expect(metas[0].agent).toMatchObject({ id: 'aeon', self: true });
  });

  it('"scout - come online" hands Scout the turn and wakes it, with no agent sent', async () => {
    const { metas } = await chat({ message: 'scout - come online' });
    expect(metas[0].agent).toMatchObject({ id: 'scout' });
    expect(metas.find((m) => 'wake' in m).wake).toBe(true);
    expect(calls[0].messages[0].content).toMatch(/## WAKE\nThe operator just woke you, Scout\./);
    expect(calls[0].messages[0].content).not.toMatch(/You are VP|prime directive/);
  });

  it('each call builds its own router — a reloaded block never answers with the old Vault', () => {
    const one = createStreamRouter({ kernelLLM: {}, VAULT_ROOT: vault });
    const two = createStreamRouter({ kernelLLM: {}, VAULT_ROOT: vault });
    expect(one).not.toBe(two);
    expect(two.stack.filter((l) => l.route?.path === '/chat/stream')).toHaveLength(1);
  });

  it('an agent the Vault no longer has: AEON answers, and says so', async () => {
    const { metas } = await chat({ message: 'hello', agent: 'ghost' });
    expect(metas[0].agent).toMatchObject({ id: 'aeon' });
    expect(metas[0].notice).toMatch(/No agent called "ghost" any more/);
  });
});
