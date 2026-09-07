/**
 * BO-MEM M1b — the terminal's conversational turn.
 *
 * The CLI had no conversational path: free text either resolved to a registered
 * command or died with "nothing matched", and its only model seam was POST
 * /api/ai — a bare prompt, no memory, no vault. So the same question answered
 * with sources in the browser was answered from training data at the command
 * line. That is the gap that made the Second Brain claim untrue.
 *
 * POST /api/ai/converse serves the turn from the kernel so the terminal never
 * assembles memory itself (Doctrine R04 — it holds session state, never memory
 * of record) and both surfaces get one recall policy from one place (R05).
 * Every answer carries what it consulted (R01, R03).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createAIRouter = require('../src/kernel/routers/ai.cjs');
const client = require('../tools/terminal/client.cjs');

let tmp, servers, kernelLLM, retrieveCalls, retrieveResponse;

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const seedMemory = (vault, memories) => {
  const f = path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(memories), 'utf8');
};

async function mountConverse({ llm = kernelLLM, settings = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', createAIRouter({ kernelLLM: llm, VAULT_ROOT: tmp, _loadSettings: settings ? () => settings : null }));
  const h = await listen(app);
  servers.push(h.server);
  return h.port;
}

const post = async (port, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ai/converse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-converse-'));
  servers = [];
  retrieveCalls = [];
  retrieveResponse = { status: 200, body: { documents: [] } };
  kernelLLM = vi.fn(async (prompt) => `answer to: ${prompt.slice(-60)}`);

  // Stand in for the Aeon Matrix retrieve route the kernel's recall calls.
  const matrix = express();
  matrix.use(express.json());
  matrix.post('/api/crn/second-brain/retrieve', (req, res) => {
    retrieveCalls.push({ body: req.body, headers: req.headers });
    res.status(retrieveResponse.status).json(retrieveResponse.body);
  });
  const m = await listen(matrix);
  servers.push(m.server);
  process.env.AEON_KERNEL_URL = `http://127.0.0.1:${m.port}`;
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.AEON_KERNEL_URL;
  delete process.env.AEON_URL;
});

describe('a conversational turn carries both tiers', () => {
  it('injects working memory into the prompt and reports the count', async () => {
    seedMemory(tmp, [
      { text: 'Cristian is the CEO of Broken Gear Industries', type: 'identity', pinned: true, timestamp: 1 },
      { text: 'The vault master key and the keyslot file are two halves', type: 'fact', timestamp: 2 },
    ]);
    const port = await mountConverse();
    const r = await post(port, { message: 'who am I' });

    expect(r.status).toBe(200);
    expect(r.body.meta.memory).toBe(2);
    expect(r.body.meta.memoryConsidered).toBe(2);
    const prompt = kernelLLM.mock.calls[0][0];
    expect(prompt).toMatch(/Broken Gear Industries/);
    expect(prompt).toMatch(/## MEMORY/);
  });

  it('retrieves from the vault when the line warrants it, and cites what it used', async () => {
    retrieveResponse = { status: 200, body: { documents: [
      { id: 'phishing-2026-03.md', content: 'DocuSign lure, credential harvest landing page', similarity: 0.81, metadata: { source: 'phishing-2026-03.md' } },
    ] } };
    const port = await mountConverse();
    const r = await post(port, { message: 'what did I record about the DocuSign lure' });

    expect(retrieveCalls).toHaveLength(1);
    expect(r.body.meta.recallRan).toBe(true);
    expect(r.body.meta.recall).toBe(1);
    expect(r.body.citations).toEqual([{ n: 1, title: 'phishing-2026-03.md', similarity: 0.81 }]);
    expect(kernelLLM.mock.calls[0][0]).toMatch(/SECOND BRAIN CONTEXT/);
    expect(kernelLLM.mock.calls[0][0]).toMatch(/credential harvest/);
  });

  it('does not pay for a vault round-trip on an ordinary line', async () => {
    const port = await mountConverse();
    await post(port, { message: 'write me a haiku about tuesday' });
    expect(retrieveCalls).toHaveLength(0);
  });

  it('forwards the caller’s credentials onto the recall call', async () => {
    const port = await mountConverse();
    await post(port, { message: 'search my notes for keyslots' }, { Authorization: 'Bearer tok-123', Cookie: 'aeon=s' });
    expect(retrieveCalls[0].headers.authorization).toBe('Bearer tok-123');
    expect(retrieveCalls[0].headers.cookie).toBe('aeon=s');
  });

  it('reports a refused recall as refused, never as an empty vault', async () => {
    retrieveResponse = { status: 401, body: { error: 'UNAUTHORIZED_SESSION' } };
    const port = await mountConverse();
    const r = await post(port, { message: 'what do my notes say about the vault' });

    expect(r.status).toBe(200);
    expect(r.body.meta.recallRan).toBe(false);
    expect(r.body.meta.recallError).toBe('recall_unauthorized');
    // The model was told the documents were NOT searched, so it cannot claim
    // they were irrelevant.
    expect(kernelLLM.mock.calls[0][0]).toMatch(/never searched/i);
    expect(kernelLLM.mock.calls[0][0]).not.toMatch(/no relevant indexed documents were found/i);
  });

  it('carries the session’s recent turns, and nothing older than the caller sent', async () => {
    // R04 — the terminal holds session state; the kernel does not remember
    // prior turns for it. What the caller sends is what the model sees.
    const port = await mountConverse();
    await post(port, {
      message: 'and on a USB install?',
      history: [
        { role: 'user', content: 'how do the keyslots recover' },
        { role: 'assistant', content: 'through the recovery slot' },
      ],
    });
    const prompt = kernelLLM.mock.calls[0][0];
    expect(prompt).toMatch(/RECENT TURNS/);
    expect(prompt).toMatch(/Operator: how do the keyslots recover/);
    expect(prompt).toMatch(/AEON: through the recovery slot/);
  });

  it('honours the wake phrase with the count it actually injected', async () => {
    seedMemory(tmp, Array.from({ length: 3 }, (_, i) => ({ text: `fact ${i} about the operator`, type: 'fact', timestamp: i })));
    const port = await mountConverse();
    const r = await post(port, { message: 'vp come online' });
    expect(r.body.meta.wake).toBe(true);
    expect(kernelLLM.mock.calls[0][0]).toMatch(/3 of 3 stored memories are loaded/);
  });
});

describe('failure is named, with a remedy', () => {
  it('503s with the cheapest remedy when no model is assigned', async () => {
    const port = await mountConverse({ llm: null });
    const r = await post(port, { message: 'hello' });
    expect(r.status).toBe(503);
    expect(r.body.noProviderAvailable).toBe(true);
    expect(r.body.remedy).toMatch(/Cookbook/);
  });

  it('a provider failure still returns what was consulted', async () => {
    const failing = vi.fn(async () => { const e = new Error('no provider'); e.noProviderAvailable = true; throw e; });
    const port = await mountConverse({ llm: failing });
    const r = await post(port, { message: 'hello' });
    expect(r.status).toBe(503);
    expect(r.body.meta).toBeDefined();
  });

  it('rejects an empty line', async () => {
    const port = await mountConverse();
    expect((await post(port, { message: '   ' })).status).toBe(400);
  });
});

describe('the terminal client', () => {
  it('posts the line and its own recent turns to /api/ai/converse', async () => {
    const app = express();
    app.use(express.json());
    let seen = null;
    app.post('/api/ai/converse', (req, res) => { seen = req.body; res.json({ text: 'ok', meta: {}, citations: [] }); });
    const h = await listen(app);
    servers.push(h.server);
    process.env.AEON_URL = `http://127.0.0.1:${h.port}`;

    const r = await client.converse('and on USB?', { history: [{ role: 'user', content: 'keyslots?' }] });
    expect(r.ok).toBe(true);
    expect(r.data.text).toBe('ok');
    expect(seen.message).toBe('and on USB?');
    expect(seen.history).toEqual([{ role: 'user', content: 'keyslots?' }]);
  });
});

describe('R05 — one wake phrase', () => {
  it('the dashboard no longer declares its own', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/blocks/dashboard/api/chat-stream.cjs'), 'utf8');
    expect(src).not.toMatch(/const WAKE_RE = \//);
    expect(src).toMatch(/WAKE_RE\s*\}\s*=\s*kernelContext/);
  });
});
