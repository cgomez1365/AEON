/**
 * C40 — auto-memory carries the operator's session onto the routes it calls.
 *
 * With "Save memories automatically" on, every chat turn fires a loopback
 * fetch to /api/ai (extract) and then /api/memory/add (store). Both are
 * guarded. Neither call forwarded the Cookie or Authorization header, so with
 * the guard on /api/ai answered 401, the 401 body has no `text`, and the whole
 * block was skipped without a warning — the one step in the pipeline that was
 * never logged. Memory Core sat at 0 auto-extracted memories indefinitely.
 *
 * The real chat-stream router is driven over HTTP against a stand-in kernel
 * that enforces a session exactly where the real guard does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createStreamRouter = require('../src/blocks/dashboard/api/chat-stream.cjs');

const SESSION = 'aeon_session=sweep-terminal-token';
const BEARER = 'Bearer sweep-terminal-bearer';
let seen;           // { ai: [headers of every /api/ai attempt], add: [{ headers, body }] }
const servers = [];
let apiPort;
let tmpVault;
let savedKernelUrl;

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); });
});

// Poll for an outcome of the fire-and-forget extraction, which runs after the
// response has ended.
const waitFor = async (check, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
};

beforeAll(async () => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-automem-'));

  // The kernel's guard, reduced to its rule: a session cookie or a bearer
  // token, or no route.
  const kernel = express();
  kernel.use(express.json());
  const guard = (req, res, next) => (String(req.headers.cookie || '').includes(SESSION) || req.headers.authorization === BEARER
    ? next()
    : res.status(401).json({ success: false, error: 'UNAUTHORIZED_SESSION' }));
  kernel.post('/api/ai', (req, res, next) => { seen.ai.push(req.headers); next(); }, guard, (req, res) => {
    res.json({ text: '[{"text":"The operator prefers terse output","category":"preference"}]' });
  });
  kernel.post('/api/memory/add', guard, (req, res) => {
    seen.add.push({ headers: req.headers, body: req.body });
    res.json({ ok: true });
  });
  kernel.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [] }));
  const kernelPort = await listen(kernel);
  savedKernelUrl = process.env.AEON_KERNEL_URL;
  process.env.AEON_KERNEL_URL = `http://127.0.0.1:${kernelPort}`;

  const kernelLLM = {
    describeRole: async () => ({ provider: 'stub', model: 'stub-model', contextTokens: 8192 }),
    stream: async (messages, { onToken }) => {
      onToken('Noted.');
      return { text: 'Noted.', tokens: 1, latencyMs: 1, provider: 'stub', model: 'stub-model', truncated: false, cancelled: false };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createStreamRouter({
    kernelLLM,
    loadSettings: () => ({ prefs: {}, blockSettings: { memory_core: { auto_memory: true } } }),
    VAULT_ROOT: tmpVault,
  }));
  apiPort = await listen(app);
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl;
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

beforeEach(() => {
  seen = { ai: [], add: [] };
  vi.restoreAllMocks();
});

const chat = async (headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ message: 'Keep answers short from now on.' }),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toMatch(/event: done/);
};

describe('auto-memory with the guard on', () => {
  it('forwards the operator session to /api/ai and /api/memory/add, so the fact is saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chat({ Cookie: SESSION });
    expect(await waitFor(() => seen.add.length > 0), 'no memory reached /api/memory/add').toBe(true);
    expect(seen.ai).toHaveLength(1);
    expect(seen.ai[0].cookie).toContain(SESSION);
    expect(seen.add[0].headers.cookie).toContain(SESSION);
    expect(seen.add[0].body).toMatchObject({ text: 'The operator prefers terse output', source: 'auto-extract' });
  });

  it('forwards a bearer token the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chat({ Authorization: BEARER });
    expect(await waitFor(() => seen.add.length > 0), 'no memory reached /api/memory/add').toBe(true);
    expect(seen.ai[0].authorization).toBe(BEARER);
    expect(seen.add[0].headers.authorization).toBe(BEARER);
  });

  it('says so when /api/ai refuses, instead of skipping in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chat(); // no session at all — the guard refuses
    expect(await waitFor(() => warn.mock.calls.some(c => String(c[0]).includes('[AUTO-MEMORY]'))),
      'the refused extraction left no trace').toBe(true);
    const line = warn.mock.calls.find(c => String(c[0]).includes('[AUTO-MEMORY]')).join(' ');
    expect(line).toMatch(/401/);
    expect(line).toMatch(/UNAUTHORIZED_SESSION/);
    expect(seen.ai).toHaveLength(1);   // it was attempted, and refused
    expect(seen.add).toHaveLength(0);
  });
});
