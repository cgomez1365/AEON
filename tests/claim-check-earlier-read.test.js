/**
 * claimCheck follow-up to A7 — a reply that cites an EARLIER read is not a false claim.
 *
 * A7 (2026-10-21) puts a bounded record of each reply's tool results into the
 * history, so a follow-up turn can say "I read that file last turn". claimCheck
 * (kernel/toolProtocol.cjs) only knew this reply's tools, so the very sentence
 * A7 makes possible drew "No read tool succeeded in this reply" under it.
 * Measured on 2026-10-21 (build record, follow-up 1): both sentences below came
 * back as `unbacked-claim`.
 *
 * The record the model was shown backs a claim of reading, searching the Vault
 * or searching the web. It never backs a save or an ask: those change something,
 * and an old one must not hide a made-up new one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const p = require('../src/kernel/toolProtocol.cjs');
const chatHist = require('../src/kernel/chatHistory.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');

// The two sentences measured on 2026-10-21.
const EARLIER_CLAIMS = [
  'Yes, I read the file earlier and it lists 12 entries.',
  'I have read the file; it says 12.',
];
const earlierRead = [{ tool: 'vault_read', ok: true }];

describe('claimCheck: a claim of an earlier read is backed by the history record', () => {
  it.each(EARLIER_CLAIMS)('"%s" is not flagged when an earlier reply read a file', (text) => {
    expect(p.claimCheck(text, [], { earlier: earlierRead })).toEqual([]);
  });

  it.each(EARLIER_CLAIMS)('"%s" is still flagged when nothing, here or earlier, read a file', (text) => {
    const out = p.claimCheck(text, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'warn', code: 'unbacked-claim' });
    expect(p.claimCheck(text, [], { earlier: [] })).toHaveLength(1);
    expect(p.claimCheck(text, [], { earlier: undefined })).toHaveLength(1);
  });

  it('a read that FAILED earlier does not back the claim', () => {
    expect(p.claimCheck(EARLIER_CLAIMS[1], [], { earlier: [{ tool: 'vault_read', ok: false }] })).toHaveLength(1);
  });

  it('vault_list backs "I read the file" as it does within a reply', () => {
    expect(p.claimCheck(EARLIER_CLAIMS[1], [], { earlier: [{ tool: 'vault_list', ok: true }] })).toEqual([]);
  });

  it('this reply\'s own tools still back a claim, as before', () => {
    expect(p.claimCheck(EARLIER_CLAIMS[1], [{ tool: 'vault_read', ok: true }])).toEqual([]);
    expect(p.claimCheck(EARLIER_CLAIMS[1], [{ tool: 'vault_read', ok: true }], { earlier: [] })).toEqual([]);
  });

  it('the kind of evidence still has to match: a read does not back a search, nor a search a web search', () => {
    const vault = 'I searched your vault and found nothing about it.';
    const web = 'I searched the web and found three reviews.';
    expect(p.claimCheck(vault, [], { earlier: earlierRead })).toHaveLength(1);
    expect(p.claimCheck(vault, [], { earlier: [{ tool: 'vault_search', ok: true }] })).toEqual([]);
    expect(p.claimCheck(web, [], { earlier: [{ tool: 'vault_search', ok: true }] })).toHaveLength(1);
    expect(p.claimCheck(web, [], { earlier: [{ tool: 'web_search', ok: true }] })).toEqual([]);
  });

  it('a save or an ask is NEVER backed by an earlier reply, only by this one', () => {
    const earlier = [{ tool: 'memory_save', ok: true }, { tool: 'artifact_save', ok: true }, { tool: 'scratchpad_write', ok: true }, { tool: 'ask_agent', ok: true }];
    expect(p.claimCheck('I have saved it to my memory.', [], { earlier })).toHaveLength(1);
    expect(p.claimCheck('I asked Ledger about it.', [], { agentNames: ['Ledger'], earlier })).toHaveLength(1);
    expect(p.claimCheck('I have saved it to my memory.', [{ tool: 'memory_save', ok: true }], { earlier: [] })).toEqual([]);
  });
});

describe('earlierTools: the evidence is what the model was actually shown', () => {
  const agents = [
    { id: 'aeon', name: 'Aeon', self: true, privacy: 'roulette' },
    { id: 'scout', name: 'Scout', privacy: 'local-only' },
    { id: 'quill', name: 'Quill', privacy: 'roulette' },
  ];

  it('names the tool from the chip label and keeps its ok flag, assistant turns only', () => {
    const history = [
      { role: 'user', content: 'q', tools: [{ label: 'vault_read user-turn.md', ok: true }] },
      { role: 'assistant', content: 'a', tools: [{ label: 'vault_read Notes/plan.md', ok: true, out: 'x' }, { label: 'vault_search budget', ok: false, out: 'boom' }] },
    ];
    expect(chatHist.earlierTools(history, null, agents)).toEqual([
      { tool: 'vault_read', ok: true },
      { tool: 'vault_search', ok: false },
    ]);
  });

  it('counts only the last MAX_TOOLS tools of a turn (the rest are not in what the model saw)', () => {
    const tools = [{ label: 'web_search first', ok: true }];
    for (let i = 0; i < chatHist.MAX_TOOLS; i++) tools.push({ label: `vault_list d${i}`, ok: true });
    const got = chatHist.earlierTools([{ role: 'assistant', content: 'a', tools }], null, agents);
    expect(got).toHaveLength(chatHist.MAX_TOOLS);
    expect(got.some((t) => t.tool === 'web_search')).toBe(false);
  });

  it('ignores names that are not tools, and anything that is not a list of chips', () => {
    const history = [
      { role: 'assistant', content: 'a', tools: [{ label: 'rm_rf /', ok: true }, { label: '  ', ok: true }, null, 'vault_read x'] },
      { role: 'assistant', content: 'b', tools: 'vault_read' },
      { role: 'assistant', content: 'c' },
    ];
    expect(chatHist.earlierTools(history, null, agents)).toEqual([]);
    expect(chatHist.earlierTools(undefined, null, agents)).toEqual([]);
  });

  it('a Local only agent\'s reads do not back another agent\'s claim, and do back its own', () => {
    const history = [
      { role: 'user', content: 'q', agent: 'scout' },
      { role: 'assistant', content: 'a', agent: 'scout', tools: [{ label: 'vault_read secret.md', ok: true, out: 'LARKSPUR' }] },
    ];
    expect(chatHist.earlierTools(history, agents[2], agents)).toEqual([]);
    expect(chatHist.earlierTools(history, null, agents)).toEqual([]);
    expect(chatHist.earlierTools(history, agents[1], agents)).toEqual([{ tool: 'vault_read', ok: true }]);
  });

  it('end to end on the two sentences: the record in the history clears them, no record does not', () => {
    const withRead = [{ role: 'assistant', content: '12 are on.', tools: [{ label: 'vault_read Agents/Aeon/memory/index.md', ok: true, out: '12 active' }] }];
    const without = [{ role: 'assistant', content: '12 are on.' }];
    for (const text of EARLIER_CLAIMS) {
      expect(p.claimCheck(text, [], { earlier: chatHist.earlierTools(withRead, null, agents) })).toEqual([]);
      expect(p.claimCheck(text, [], { earlier: chatHist.earlierTools(without, null, agents) })).toHaveLength(1);
    }
  });
});

describe('POST /chat/stream: the notice under a reply follows the record', () => {
  const servers = [];
  let vault;
  const listen = (app) => new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); });
  });
  beforeAll(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-claimcheck-')); });
  afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } fs.rmSync(vault, { recursive: true, force: true }); });

  // One chat turn against a stub model that always answers `reply`; returns the SSE text.
  async function ask(reply, history) {
    const kernelLLM = {
      describeRole: async () => ({ provider: 'stub', model: 'stub-model', contextTokens: 8192 }),
      stream: async (_messages, { onToken }) => { onToken(reply); return { text: reply, tokens: 1, latencyMs: 1, provider: 'stub', model: 'stub-model' }; },
    };
    const kernel = express();
    kernel.use(express.json());
    kernel.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
    const kernelPort = await listen(kernel);
    const savedUrl = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = `http://127.0.0.1:${kernelPort}`;
    try {
      const app = express();
      app.use(express.json());
      app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault }));
      const port = await listen(app);
      const r = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'did you actually read that file?', history }),
      });
      return await r.text();
    } finally {
      if (savedUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedUrl;
    }
  }

  const readTurn = { role: 'assistant', content: '12 are on, 3 are off.', tools: [{ label: 'vault_read Agents/Aeon/memory/index.md', ok: true, out: '12 active, 3 off' }] };

  it('a reply citing the earlier read gets no unbacked-claim notice', async () => {
    const sse = await ask('Yes, I read the file earlier and it lists 12 entries.', [{ role: 'user', content: 'how many?' }, readTurn]);
    expect(sse).toContain('event: done');
    expect(sse).not.toContain('unbacked-claim');
  });

  it('the same reply with no read in the history still gets the notice', async () => {
    const sse = await ask('Yes, I read the file earlier and it lists 12 entries.', [{ role: 'user', content: 'how many?' }, { role: 'assistant', content: '12 are on.' }]);
    expect(sse).toContain('unbacked-claim');
  });

  it('a failed read in the history does not clear it', async () => {
    const failed = { ...readTurn, tools: [{ label: 'vault_read Agents/Aeon/memory/index.md', ok: false, out: 'not found' }] };
    const sse = await ask('I have read the file; it says 12.', [{ role: 'user', content: 'how many?' }, failed]);
    expect(sse).toContain('unbacked-claim');
  });
});
