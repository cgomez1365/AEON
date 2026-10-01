/**
 * A rejected Gemini key reads "key rejected", not "unavailable" (A041).
 *
 * Gemini answers a bad key with HTTP 400 and API_KEY_INVALID in the body, not
 * 401/403. services/ai.js mapped every 400 to "unavailable", so the operator
 * read "No provider could answer right now — gemini unavailable" for a key
 * Google had refused, with nothing pointing at the key.
 *
 * Drives the REAL services/ai.js against a fake Gemini endpoint on 127.0.0.1,
 * registered as a connection the way Settings → Keys adds one. Nothing leaves
 * this machine: any other fetch is answered by a stub.
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
const VAULT_PATH = path.join(ROOT, 'src', 'kernel', 'vault.cjs');
const POOL_PATH = path.join(ROOT, 'src', 'kernel', 'keyPool.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-400-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-400-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'gemini-400-suite-key';
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

// Google's real answer to a bad key (shape read from the live API).
const GOOGLE_400 = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  },
};
let mode = 'badkey';
const fake = express();
fake.use(express.json());
fake.post(/generateContent$/, (_req, res) => {
  if (mode === 'badkey') return res.status(400).json(GOOGLE_400);
  // A 400 that is not about the key keeps its old wording.
  return res.status(400).json({ error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } });
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
const notices = [];

beforeAll(async () => {
  const port = await new Promise((r) => { server = fake.listen(0, '127.0.0.1', () => r(server.address().port)); });
  const vault = require(VAULT_PATH);
  await vault.setSecret('gemini-key', 'test-only-not-a-real-key');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'gem', provider: 'gemini', base_url: `http://127.0.0.1:${port}/v1beta`, auth_ref: 'gemini-key',
        reachable_from: ['local'], models: ['gemini-flash-latest'], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'gem', model: 'gemini-flash-latest' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
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

describe('a Gemini key Google rejects', () => {
  it('is reported as "key rejected" when nothing else can answer', async () => {
    mode = 'badkey';
    const err = await ai.kernelLLM('hello', { role: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/gemini key rejected/);
    expect(err.message).not.toMatch(/gemini unavailable/);
  });

  it('a 400 that does not name the key is not called a rejected key', async () => {
    mode = 'other400';
    ai._resetProviderHealth?.();
    const err = await ai.kernelLLM('hello again', { role: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/gemini unavailable/);
    expect(err.message).not.toMatch(/key rejected/);
  });
});
