/**
 * The memory a chat turn carries follows the model's real window.
 *
 * Measured on the operator's vault (33 memories, "tell me about emily"): with
 * the window reported as 8,192 only 7 memories fit and the answer was missing;
 * with the real 1,000,000 all 33 went in. The token budget — not a count of
 * 25 — is what limits now, and the default count cap is 200.
 *
 * The real chat-stream router, a stub kernelLLM, a temp vault.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');
const kernelContext = require('../src/kernel/context.cjs');

const servers = [];
let tmpVault;
let savedKernelUrl;
let window = 8192;
let settings = { prefs: {} };
let apiPort;

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); });
});

const parseSSE = (text) => text.split('\n\n').filter(Boolean).map((block) => {
  const out = { event: 'message', data: null };
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) out.event = line.slice(7).trim();
    else if (line.startsWith('data: ')) { try { out.data = JSON.parse(line.slice(6)); } catch { out.data = line.slice(6); } }
  }
  return out;
});

beforeAll(async () => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-memory-window-'));
  const dir = path.join(tmpVault, 'Agents', 'Aeon', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  // 33 memories of roughly 210 tokens each: ~7,000 tokens in all.
  const memories = Array.from({ length: 33 }, (_, i) => ({
    id: `mem-${i}`,
    category: 'fact',
    timestamp: Date.now() - i * 1000,
    text: `Fact ${i} about Emily and the operations team: ` + 'she reviews the vendor rota every week and keeps notes. '.repeat(15),
  }));
  fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify(memories));

  const kernel = express();
  kernel.use(express.json());
  kernel.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [] }));
  const kernelPort = await listen(kernel);
  savedKernelUrl = process.env.AEON_KERNEL_URL;
  process.env.AEON_KERNEL_URL = `http://127.0.0.1:${kernelPort}`;

  const kernelLLM = {
    describeRole: async () => ({ provider: 'stub', model: 'stub-model', contextTokens: window }),
    stream: async (messages, { onToken }) => {
      onToken('ok');
      return { text: 'ok', tokens: 1, latencyMs: 1, provider: 'stub', model: 'stub-model', truncated: false, cancelled: false };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createStreamRouter({ kernelLLM, loadSettings: () => settings, VAULT_ROOT: tmpVault }));
  apiPort = await listen(app);
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl;
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

async function memoryMeta(message) {
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  expect(r.status).toBe(200);
  const events = parseSSE(await r.text());
  const meta = events.filter(e => e.event === 'meta').find(e => e.data && 'memory' in e.data);
  expect(meta, 'no memory meta event').toBeDefined();
  return meta.data;
}

describe('the memory budget comes from the reported window', () => {
  it('a 1,000,000-token window carries every memory', async () => {
    window = 1000000;
    settings = { prefs: {} };
    const m = await memoryMeta('tell me about emily');
    expect(m.memory).toBe(33);
    expect(m.memoryDropped).toBe(0);
  });

  it('an 8,192-token window carries fewer, and says how many were dropped', async () => {
    window = 8192;
    settings = { prefs: {} };
    const m = await memoryMeta('tell me about emily');
    expect(m.memory).toBeLessThan(33);
    expect(m.memoryDropped).toBeGreaterThan(0);
  });
});

describe('the memory count cap', () => {
  const capFor = async (message, s) => {
    settings = s;
    window = 8192;
    const spy = vi.spyOn(kernelContext, 'buildMemoryContext');
    try {
      await memoryMeta(message);
      expect(spy).toHaveBeenCalled();
      return spy.mock.calls.at(-1)[1].maxCount;
    } finally {
      spy.mockRestore();
    }
  };

  it('defaults to 200', async () => {
    expect(await capFor('tell me about emily', { prefs: {} })).toBe(200);
  });

  it('is the operator\'s own setting when set', async () => {
    expect(await capFor('tell me about emily', { prefs: { brain_settings: { memory_max_context: 40 } } })).toBe(40);
  });

  it('is lifted entirely on a wake turn', async () => {
    expect(await capFor('aeon come online', { prefs: {} })).toBe(0);
  });
});
