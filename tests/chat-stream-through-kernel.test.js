/**
 * The streaming chat route goes through the kernel LLM layer.
 *
 * "One LLM layer that routes every AI call by role" was false for the one
 * route the operator actually talks to. dashboard/api/chat-stream.cjs carried
 * its own Groq/Gemini/local streamers, its own vault key lookup and its own
 * fallback chain — and its Claude and OpenAI branches posted to Groq's URL.
 * The endpoint registry, which Settings writes and every other call honours,
 * was never consulted: a role pointed at a custom endpoint streamed from
 * whatever aeon-settings.json said instead.
 *
 * These tests drive the REAL block against the REAL services/ai.js, with a
 * fake OpenAI-compatible endpoint registered for the chat role and the local
 * runtime stubbed, and assert on the SSE the terminal would receive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const STREAM_PATH = path.join(ROOT, 'src', 'blocks', 'dashboard', 'api', 'chat-stream.cjs');

// AEON_SECRETS_DIR must be set BEFORE endpoints.cjs is loaded — it resolves
// its registry path at module scope. Another file in this worker may already
// have loaded it against the suite-wide root, so a fresh copy is loaded here
// and the previous one restored afterwards.
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chat-stream-kernel-'));
process.env.AEON_SECRETS_DIR = tempSecrets;
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const savedCache = {};
for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH, STREAM_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}

// No cloud keys may leak in from the developer's shell: the fallback chain
// under test must be exactly [registry endpoint, local].
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

// ── The fake OpenAI-compatible endpoint ─────────────────────────────
let mode = 'ok';             // 'ok' | '503' | 'hang'
const seen = [];             // request bodies the fake received
let hungClosed = null;       // resolves when the hanging request's socket closes
let hungArrived = null;      // resolves when the hanging request arrives

const fake = express();
fake.use(express.json());
fake.post('/v1/chat/completions', (req, res) => {
  seen.push(req.body);
  if (mode === '503') return res.status(503).json({ error: { message: 'fake endpoint is down' } });
  if (mode === 'hang') {
    hungArrived.resolve();
    req.on('close', () => hungClosed.resolve());
    return; // never answers
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

// ── Local runtime stub ───────────────────────────────────────────────
const localCalls = [];
const lrStub = {
  isAvailable: () => true,
  defaultModel: () => 'stub-model',
  listReadyModels: () => [{ id: 'stub-model' }],
  status: () => ({ available: true, readyModels: [{ id: 'stub-model', capabilities: ['chat'] }] }),
  plannedContext: async () => ({ contextTokens: 32768 }),
  cancelAll: () => 0,
  infer: async () => ({ text: 'local-', tokens: 1, model: 'stub-model', complete: true }),
  inferStream: async (prompt, opts, onToken) => {
    localCalls.push(opts);
    onToken?.('local-');
    return { text: 'local-', tokens: 1, model: 'stub-model', complete: true };
  },
};

// Parse a text/event-stream body into [{event, data}].
const parseSSE = (text) => text.split('\n\n').filter(Boolean).map((block) => {
  const out = { event: 'message', data: null };
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) out.event = line.slice(7).trim();
    else if (line.startsWith('data: ')) { try { out.data = JSON.parse(line.slice(6)); } catch { out.data = line.slice(6); } }
  }
  return out;
});

let servers = [];
let apiPort;
let tmpVault;

beforeAll(async () => {
  const f = await listen(fake);
  servers.push(f.server);

  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [{
      id: 'fake', provider: 'custom', base_url: `http://127.0.0.1:${f.port}/v1`,
      auth_ref: null, reachable_from: ['local'], models: ['fake-model'],
    }],
    roles: { chat: { endpoint_id: 'fake', model: 'fake-model' } },
  }, null, 2));

  require(ENDPOINTS_PATH); // bound to tempSecrets — ai.js picks this instance up
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };

  const loadSettings = () => ({ models: { chat: { provider: 'local', model: 'stub-model' } }, prefs: {} });
  const ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chat-stream-ledger-')), 'token_ledger.json'),
    loadSettings,
    aeonTerminalStream: null,
  });

  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chat-stream-vault-'));
  const app = express();
  app.use(express.json());
  // Stand in for the Aeon Matrix retrieve route the kernel's recall calls.
  app.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [] }));
  app.use('/api', require(STREAM_PATH)({
    kernelLLM: ai.kernelLLM, loadSettings, VAULT_ROOT: tmpVault, writeOSAudit() {}, _trackLLM() {},
  }));
  const a = await listen(app);
  servers.push(a.server);
  apiPort = a.port;
  process.env.AEON_KERNEL_URL = `http://127.0.0.1:${apiPort}`;
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  delete process.env.AEON_KERNEL_URL;
  for (const p of Object.keys(savedCache)) {
    if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
});

const stream = async (body) => {
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
  return parseSSE(await r.text());
};

describe('POST /api/chat/stream streams through kernelLLM.stream', () => {
  it('routes the chat role to the registry endpoint and relays its tokens', async () => {
    mode = 'ok';
    seen.length = 0;
    const events = await stream({ message: 'hi' });
    const names = events.map(e => e.event);

    // The order the terminal relies on: announce, memory report, tokens, done.
    expect(names.slice(0, 2)).toEqual(['meta', 'meta']);
    expect(events[0].data).toMatchObject({ provider: 'custom', model: 'fake-model', role: 'chat' });
    expect(typeof events[0].data.streamId).toBe('string');
    expect(events[1].data).toHaveProperty('memory');
    expect(events[1].data).toHaveProperty('recallRan');

    const tokens = events.filter(e => e.event === 'token').map(e => e.data.t);
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(names.filter(n => n === 'warning' || n === 'error')).toEqual([]);

    const done = events.find(e => e.event === 'done');
    expect(done.data).toMatchObject({ text: 'Hello', provider: 'custom', model: 'fake-model', cancelled: false });
    expect(typeof done.data.tokens).toBe('number');
    expect(typeof done.data.latencyMs).toBe('number');
    expect(names.indexOf('done')).toBeGreaterThan(names.lastIndexOf('token'));

    // The fake saw a real streaming request with the assembled turn.
    expect(seen).toHaveLength(1);
    expect(seen[0].stream).toBe(true);
    expect(seen[0].model).toBe('fake-model');
    expect(seen[0].messages[0].role).toBe('system');
    expect(seen[0].messages[0].content).toMatch(/You are AEON/);
    expect(seen[0].messages[seen[0].messages.length - 1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('falls back to the local runtime when the endpoint fails before its first token, and says so', async () => {
    mode = '503';
    seen.length = 0;
    localCalls.length = 0;
    const events = await stream({ message: 'hi again' });
    const names = events.map(e => e.event);

    expect(events[0].data).toMatchObject({ provider: 'custom', model: 'fake-model' });
    const warning = events.find(e => e.event === 'warning');
    expect(warning.data.message).toMatch(/custom unavailable — falling back to local/);
    const corrected = events.find(e => e.event === 'meta' && e.data.fallbackFrom);
    expect(corrected.data).toMatchObject({ provider: 'local' });
    expect(corrected.data.fallbackFrom).toMatch(/^custom: /);
    // The warning precedes the corrected label, which precedes any token.
    expect(names.indexOf('warning')).toBeLessThan(events.indexOf(corrected));
    expect(events.indexOf(corrected)).toBeLessThan(names.indexOf('token'));

    expect(events.filter(e => e.event === 'token').map(e => e.data.t)).toEqual(['local-']);
    const done = events.find(e => e.event === 'done');
    expect(done.data).toMatchObject({ text: 'local-', provider: 'local', model: 'stub-model' });
    expect(names).not.toContain('error');

    // The endpoint was tried first, and the local runtime got the same
    // messages array — a system turn is a system turn there too.
    expect(seen).toHaveLength(1);
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0].messages[0].role).toBe('system');
    expect(localCalls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('POST /api/chat/stop aborts the upstream request and ends the stream as cancelled', async () => {
    mode = 'hang';
    seen.length = 0;
    hungArrived = deferred();
    hungClosed = deferred();

    const r = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hang', streamId: 'stop-me' }),
    });
    expect(r.status).toBe(200);
    const bodyText = r.text();

    await hungArrived.promise; // the kernel's request reached the endpoint

    const stop = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'stop-me' }),
    });
    expect(await stop.json()).toMatchObject({ ok: true, stopped: 1, streamId: 'stop-me' });

    // The upstream socket is torn down, not left generating into nothing.
    await hungClosed.promise;

    const events = parseSSE(await bodyText);
    const names = events.map(e => e.event);
    // No fallback on a deliberate stop: the operator asked for silence, not
    // for a different provider's answer.
    expect(names).not.toContain('warning');
    expect(events.filter(e => e.event === 'token')).toEqual([]);
    const done = events.find(e => e.event === 'done');
    expect(done, `expected a done event, got: ${names.join(',')}`).toBeDefined();
    expect(done.data).toMatchObject({ cancelled: true, provider: 'custom', text: '' });

    // And the stream is gone: a second stop says so instead of claiming success.
    const again = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'stop-me' }),
    });
    expect(again.status).toBe(404);
  });

  it('kernelLLM.describeRole reports what the registry would serve', async () => {
    const ai = require(AI_PATH)({
      supabase: null, writeOSAudit: () => {},
      TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chat-stream-ledger2-')), 'token_ledger.json'),
      loadSettings: () => ({ models: { chat: { provider: 'local', model: 'stub-model' } }, prefs: {} }),
      aeonTerminalStream: null,
    });
    expect(await ai.kernelLLM.describeRole('chat')).toEqual({ provider: 'custom', model: 'fake-model', contextTokens: 8192 });
    expect(typeof ai.kernelLLM.cancelAll()).toBe('number');
  });
});
