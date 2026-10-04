/**
 * Privacy rules for agent tools (3.3). Each was written to FAIL against the
 * code without its guard first (the commit message records the red runs).
 *
 *   - an agent set to Local only never reaches a cloud model: its callOptions
 *     ride on every round and continuation, and on ask_agent / handoffs
 *   - a Local only agent never searches the web, even when a model writes the
 *     call anyway; nor does anyone while Local only is on in Settings → Models
 *   - a Local only agent's search stays local (localOnly reaches retrieve)
 *   - Local only data never enters a Roulette agent's turn: no asking across
 *     the line in either direction, no Local only names in a Roulette prompt,
 *     and no shared memory while the operator's own AEON is Local only
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');

let vault;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const all = () => agents.list(vault, { withStats: false });
const get = (n) => agents.get(vault, n, all());
const block = (obj, content) => `\`\`\`aeon-tool\n${JSON.stringify(obj)}\n${content != null ? `---\n${content}\n` : ''}\`\`\`\n`;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tools-privacy-'));
  agents.create(vault, { name: 'Ledger', persona: 'Keeps the books tidy. Reconciles every month.' });
  agents.create(vault, { name: 'Quill', persona: 'Drafts private letters for the operator.', privacy: 'local-only', model: { provider: 'local', model: 'small-q4' } });
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('Local only: no web search, ever', () => {
  it('a Local only agent is not offered web_search, and a web_search block it writes anyway is refused before the search runs', async () => {
    const quill = get('Quill');
    const search = [];
    const fetchWebSearch = async (...a) => { search.push(a); return '1. result'; };
    const toolbox = agentTools.createToolbox({ vaultRoot: vault, agent: quill, agents: all(), fetchWebSearch, contextTokens: 32768 });
    expect(toolbox.names()).not.toContain('web_search');
    expect(toolbox.promptText()).not.toMatch(/web_search/);

    const f = fakeStream([
      { tokens: [block({ tool: 'web_search', query: 'operator letters' })] },
      { tokens: ['I could not search the web.'] },
    ]);
    const c = collector();
    await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], callOpts: agents.callOptions(quill), toolbox, emit: c.emit });
    expect(search).toHaveLength(0);
    expect(c.of('tool_result')[0]).toMatchObject({ tool: 'web_search', ok: false, status: 'refused', code: 'local-only-web' });
  });

  it('Local only on in Settings → Models: no web search for a Roulette agent either', async () => {
    const search = [];
    const toolbox = agentTools.createToolbox({
      vaultRoot: vault, agent: get('Ledger'), agents: all(), settings: { local_only: true },
      fetchWebSearch: async (...a) => { search.push(a); return 'x'; }, contextTokens: 32768,
    });
    expect(toolbox.names()).not.toContain('web_search');
    const r = await toolbox.run({ ok: true, tool: 'web_search', args: { query: 'anything' } });
    expect(r).toMatchObject({ status: 'refused', code: 'local-only-web' });
    expect(search).toHaveLength(0);
  });
});

describe('Local only: every model call stays local', () => {
  it('every kernelLLM.stream call in a 3-round + 2-continuation turn carries localOnly', async () => {
    const quill = get('Quill');
    const toolbox = agentTools.createToolbox({ vaultRoot: vault, agent: quill, agents: all(), contextTokens: 32768 });
    const f = fakeStream([
      { tokens: [block({ tool: 'vault_list' })] },
      { tokens: [block({ tool: 'scratchpad_write', mode: 'append' }, 'note one')] },
      { tokens: ['Part one '], truncated: true },
      { tokens: ['part two '], truncated: true },
      { tokens: ['part three.'] },
    ], { provider: 'local', model: 'small-q4' });
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], callOpts: agents.callOptions(quill), toolbox, emit: () => {} });
    expect(r).toMatchObject({ toolCalls: 2, parts: 3 });
    expect(f.calls).toHaveLength(5);
    for (const call of f.calls) expect(call.opts).toMatchObject({ localOnly: true, provider: 'local' });
  });

  it('vault_search for a Local only agent asks retrieve to stay local', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ documents: [] }) };
    };
    const quill = agentTools.createToolbox({ vaultRoot: vault, agent: get('Quill'), agents: all(), fetchImpl, contextTokens: 32768 });
    await quill.run({ ok: true, tool: 'vault_search', args: { query: 'letters' } });
    expect(bodies.at(-1)).toMatchObject({ query: 'letters', localOnly: true });
    const ledger = agentTools.createToolbox({ vaultRoot: vault, agent: get('Ledger'), agents: all(), fetchImpl, contextTokens: 32768 });
    await ledger.run({ ok: true, tool: 'vault_search', args: { query: 'books' } });
    expect(bodies.at(-1)).toEqual({ query: 'books' });
  });
});

describe('ask_agent never crosses the Local only line', () => {
  it('a Roulette agent asking a Local only agent is told no such agent exists; the target is never called', async () => {
    const calls = [];
    const kernelLLM = { stream: async (m, o) => { calls.push(o); o.onToken('x'); return { text: 'x', provider: 'local' }; } };
    const tb = agentTools.createToolbox({ vaultRoot: vault, agent: get('Ledger'), agents: all(), kernelLLM, contextTokens: 32768 });
    const r = await tb.run({ ok: true, tool: 'ask_agent', args: { agent: 'Quill', question: 'what did the letter say?' } });
    // A cloud model must not learn a Local only agent's name, so the answer
    // is the one a name that does not exist gets.
    expect(r).toMatchObject({ ok: false, status: 'error', code: 'unknown-agent' });
    expect(r.text).toMatch(/^No agent called "Quill"\./);
    expect(r.text).not.toMatch(/Local only/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(vault, 'Agents', 'Quill', 'missions', 'log.json'))).toBe(false);
  });

  it('a Local only agent asking a Roulette agent is refused; nothing is sent', async () => {
    const calls = [];
    const kernelLLM = { stream: async (m, o) => { calls.push(o); o.onToken('x'); return { text: 'x' }; } };
    const tb = agentTools.createToolbox({ vaultRoot: vault, agent: get('Quill'), agents: all(), kernelLLM, contextTokens: 32768 });
    // Not even offered.
    expect(tb.names()).not.toContain('ask_agent');
    const r = await tb.run({ ok: true, tool: 'ask_agent', args: { agent: 'Ledger', question: 'about the private letter…' } });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const direct = await agentTools.askAgent({ vaultRoot: vault, caller: get('Quill'), target: 'Ledger', agents: all(), question: 'q', kernelLLM });
    expect(direct).toMatchObject({ status: 'refused', code: 'privacy-boundary' });
    expect(direct.text).toMatch(/Quill is set to Local only; asking Ledger would send/);
    expect(calls).toHaveLength(0);
  });

  it('a Roulette prompt lists no Local only agent, by name or persona', () => {
    agents.create(vault, { name: 'Scribe', persona: 'Writes meeting notes.' });
    const tb = agentTools.createToolbox({ vaultRoot: vault, agent: get('Ledger'), agents: all(), kernelLLM: { stream: async () => ({}) }, contextTokens: 32768 });
    const text = tb.promptText();
    expect(text).toContain('ask_agent');
    expect(text).toContain('Scribe (Writes meeting notes.)');
    expect(text).not.toContain('Quill');
    expect(text).not.toContain('private letters');
  });
});

describe('the operator\'s own AEON set to Local only keeps the shared memory out of a Roulette agent\'s turn', () => {
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
      stream: async (messages, opts) => { calls.push({ messages, opts }); opts.onToken('ok'); return { text: 'ok', tokens: 1, provider: 'groq', model: 'role-model' }; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
    base = await listen(app);
    // The operator's own AEON: Local only, holding the shared store.
    agents.update(vault, 'aeon', { privacy: 'local-only' });
    fs.mkdirSync(path.join(vault, 'Agents', 'Aeon', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json'), JSON.stringify([
      { id: 's1', text: 'The operator is planning a private surgery date', timestamp: 1 },
    ]));
    fs.writeFileSync(path.join(vault, 'Agents', 'Ledger', 'memory', 'memories.json'), JSON.stringify([
      { id: 'l1', text: 'Ledger reconciles on the 5th', timestamp: 2 },
    ]));
  });

  it('a Roulette agent with shared memory on does not get the shared store', async () => {
    expect(get('Ledger').sharedMemory).toBe(true);
    const r = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'what is on my plate?', agent: 'ledger' }) });
    await r.text();
    const system = calls[0].messages[0].content;
    expect(system).toContain('Ledger reconciles on the 5th');
    expect(system).not.toContain('private surgery');
    expect(calls[0].opts.localOnly).toBeUndefined();
  });

  it('a Local only agent still reads the shared store (both stay on this computer)', async () => {
    const r = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'what is on my plate?', agent: 'quill' }) });
    await r.text();
    expect(calls[0].messages[0].content).toContain('private surgery');
    expect(calls[0].opts.localOnly).toBe(true);
  });
});
