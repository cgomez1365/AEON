/**
 * 3.3.0 review round 8 — after an unresolved agent's turn.
 *
 * A turn whose stored agent no longer resolves is answered by the operator's
 * own AEON on local models (round 7). The terminal then tagged both sides of
 * that turn with the operator's own AEON, so the next Roulette turn shared
 * them with a cloud model, and the message went into the operator's own
 * (indexed) mission log. Now the turn keeps the reference it came with
 * (meta.tag), and no mission is recorded. Also: a removed agent's bin entry
 * matches only remove()'s exact "<Folder>-<time>" form.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');

let vault;
let base;
let calls;
let savedKernelUrl;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const parse = (text) => text.split('\n\n').filter(Boolean).map((b) => ({
  event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] || 'null'),
}));

beforeAll(async () => {
  const kernel = express();
  kernel.use(express.json());
  kernel.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
  savedKernelUrl = process.env.AEON_KERNEL_URL;
  process.env.AEON_KERNEL_URL = await listen(kernel);
});
afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl;
});
beforeEach(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-privacy-r7-'));
  calls = [];
  const script = fakeStream([{ tokens: ['Answered here.'] }]);
  const kernelLLM = {
    describeRole: async () => ({ provider: 'local', model: 'phi4-mini-q4', contextTokens: 8192 }),
    stream: async (messages, opts) => { calls.push({ messages: [...messages], opts }); return script.stream(messages, opts); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => ({ prefs: {} }), VAULT_ROOT: vault, writeOSAudit: () => {} }));
  base = await listen(app);
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

const chat = async (body) => {
  const r = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const events = parse(await r.text());
  return { of: (n) => events.filter((e) => e.event === n).map((e) => e.data) };
};

describe('a turn for an agent AEON no longer has', () => {
  it('is local, tagged with the reference it came with, and not logged as a mission', async () => {
    agents.create(vault, { name: 'Quill', privacy: 'local-only' });
    agents.remove(vault, 'quill');
    const r = await chat({ message: 'PRIVATE-R7 question for quill', agent: 'quill' });
    const meta = r.of('meta')[0];
    expect(meta.agent).toMatchObject({ self: true });
    expect(meta.tag).toBe('quill');
    expect(meta.notice).toMatch(/No agent called "quill" any more/);
    expect(calls[0].opts.localOnly).toBe(true);
    const log = path.join(vault, 'Agents', 'Aeon', 'missions', 'log.json');
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').not.toContain('PRIVATE-R7');
    // The turn tagged "quill" stays out of the next cloud turn.
    const next = agents.shareableTurns([{ role: 'user', content: 'PRIVATE-R7', agent: meta.tag }], null, agents.list(vault, { withStats: false }));
    expect(next).toEqual([]);
  });

  it('control: a known agent gets no tag, and its mission is logged as before', async () => {
    agents.create(vault, { name: 'Ledger' });
    const r = await chat({ message: 'what is due this week?', agent: 'ledger' });
    const meta = r.of('meta')[0];
    expect(meta.agent).toMatchObject({ id: 'ledger', self: false });
    expect(meta.tag).toBeUndefined();
    const log = path.join(vault, 'Agents', 'Ledger', 'missions', 'log.json');
    expect(fs.readFileSync(log, 'utf8')).toContain('what is due this week?');
  });
});

describe('the removed-agent check matches remove()\'s own bin names only', () => {
  it('a removed "Quill-Pen" does not move a new "Quill" to another folder', () => {
    agents.create(vault, { name: 'Quill-Pen' });
    agents.remove(vault, 'quill-pen');
    expect(agents.create(vault, { name: 'Quill' }).folder).toBe('Quill');
  });
});
