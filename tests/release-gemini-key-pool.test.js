/**
 * A rejected Gemini key hands the turn to the next key on the connection.
 *
 * Gemini refuses a bad key with HTTP 400 and API_KEY_INVALID in the body, not
 * 401. The credential pool rotates on 401/402/403/429, so a 400 read as the
 * provider's fault: with two keys and the first one rejected, the turns went
 * A (error), B (ok), A (error), B (ok) — every other turn failed and the bad
 * key was never rested. The README says a rejected key fails over to the next.
 *
 * Drives the REAL services/ai.js against a fake Gemini on 127.0.0.1, with a
 * two-key connection registered the way Settings → Keys adds one. Nothing
 * leaves this machine: any other fetch is answered by a stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const VAULT_PATH = path.join(ROOT, 'src', 'kernel', 'vault.cjs');
const POOL_PATH = path.join(ROOT, 'src', 'kernel', 'keyPool.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-pool-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-pool-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'gemini-pool-suite-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
  return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
};

const BAD = 'test-only-key-A';
const GOOD = 'test-only-key-B';
// Google's real answer to a bad key (shape read from the live API).
const GOOGLE_400 = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  },
};
const OTHER_400 = { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } };

let keysSeen = [];
let badAnswer = GOOGLE_400;
const fake = express();
fake.use(express.json());
fake.post(/:(stream)?[gG]enerateContent$/, (req, res) => {
  const key = String(req.query.key || '');
  keysSeen.push(key);
  if (key !== GOOD) return res.status(400).json(badAnswer);
  if (/streamGenerateContent$/.test(req.path)) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok from B' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } })}\n\n`);
    return res.end();
  }
  return res.json({ candidates: [{ content: { parts: [{ text: 'ok from B' }] } }], usageMetadata: { totalTokenCount: 5 } });
});

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

let server;
let ai;
let keyPool;
const notices = [];

beforeAll(async () => {
  const port = await new Promise((r) => { server = fake.listen(0, '127.0.0.1', () => r(server.address().port)); });
  const vault = require(VAULT_PATH);
  await vault.setSecret('gem-a', BAD);
  await vault.setSecret('gem-b', GOOD);
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'gem', provider: 'gemini', base_url: `http://127.0.0.1:${port}/v1beta`, auth_refs: ['gem-a', 'gem-b'],
        reachable_from: ['local'], models: ['gemini-flash-latest'], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'gem', model: 'gemini-flash-latest' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => ({ models: {}, prefs: {} }),
    aeonTerminalStream: { emit: (_t, e) => notices.push(e?.message || '') },
  });
  await ai.envHydrated;
});

beforeEach(() => {
  keyPool._reset();
  ai._resetProviderHealth?.();
  keysSeen = [];
  notices.length = 0;
  badAnswer = GOOGLE_400;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  try { server?.close(); } catch {}
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe('a two-key Gemini connection whose first key Google rejects', () => {
  it('answers every turn from the second key and rests the rejected one', async () => {
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await ai.kernelLLM(`turn ${i}`, { role: 'chat' }));
    expect(answers).toEqual(['ok from B', 'ok from B', 'ok from B', 'ok from B']);
    // The bad key is tried once, then sits out; it does not take every other turn.
    expect(keysSeen.filter((k) => k === BAD)).toHaveLength(1);
    expect(keysSeen[0]).toBe(BAD);
    expect(keysSeen[1]).toBe(GOOD);
    expect(notices.join('\n')).toMatch(/key gem-a was rejected — switching to key 2 of 2/);
  });

  it('a streamed turn moves to the second key the same way', async () => {
    const tokens = [];
    const r = await ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken: (t) => tokens.push(t) });
    expect(String(r?.text ?? r)).toMatch(/ok from B/);
    expect(tokens.join('')).toBe('ok from B');
    expect(keysSeen).toEqual([BAD, GOOD]);
  });

  it('a 400 that does not name the key stays the provider\'s fault and does not rotate', async () => {
    badAnswer = OTHER_400;
    const err = await ai.kernelLLM('hello', { role: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/gemini unavailable/);
    expect(keysSeen).toEqual([BAD]);
  });
});
