/**
 * No Gemini request carries the API key in its URL (a14 follow-up).
 *
 * Five call sites built `...?key=${apiKey}`: the env-key fallback
 * (geminiRequest), the registry transport (genericGeminiRequest), the
 * streaming transport (streamGemini), the Gemini branch of kernelVision, and
 * the model-context catalogue lookup. A key in a query string lands in proxy
 * and access logs and in any error that quotes the URL back. Google accepts
 * it as the `x-goog-api-key` header; every site now sends it that way.
 *
 * Drives the REAL services/ai.js and src/kernel/modelContext.cjs. Every
 * outbound fetch is answered in-process and recorded; nothing leaves this
 * machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const VAULT_PATH = path.join(ROOT, 'src', 'kernel', 'vault.cjs');
const POOL_PATH = path.join(ROOT, 'src', 'kernel', 'keyPool.cjs');
const MC_PATH = path.join(ROOT, 'src', 'kernel', 'modelContext.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-url-'));
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-url-data-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-url-ledger-'));
const saved = {
  AEON_SECRETS_DIR: process.env.AEON_SECRETS_DIR,
  AEON_VAULT_MASTER_KEY: process.env.AEON_VAULT_MASTER_KEY,
  DATA_PATH: process.env.DATA_PATH,
};
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'gemini-url-suite-key';
process.env.DATA_PATH = tempData;
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}
// Two different keys, so a test can tell which path sent which.
const ENV_KEY = 'test-only-env-key-a14';
const VAULT_KEY = 'test-only-vault-key-a14';
process.env.GEMINI_API_KEY = ENV_KEY; // the env pool is read when ai.js loads

const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, MC_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}

// Every outbound request, recorded; Google answered in-process.
const calls = [];
const realFetch = globalThis.fetch;
const candidate = { candidates: [{ content: { role: 'model', parts: [{ text: 'answered' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { totalTokenCount: 9 } };
globalThis.fetch = (url, init = {}) => {
  const href = typeof url === 'string' ? url : (url.url || String(url));
  const u = new URL(href);
  calls.push({ href, key: new Headers(init.headers || {}).get('x-goog-api-key') });
  if (u.hostname !== 'generativelanguage.googleapis.com') {
    return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
  }
  if (/streamGenerateContent$/.test(u.pathname)) {
    return Promise.resolve(new Response(`data: ${JSON.stringify(candidate)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  }
  if (/generateContent$/.test(u.pathname)) {
    return Promise.resolve(new Response(JSON.stringify(candidate), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', inputTokenLimit: 1048576 }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
};

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

let ai;
let keyPool;
let mc;

beforeAll(async () => {
  const vault = require(VAULT_PATH);
  await vault.setSecret('gemini-key', VAULT_KEY);
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'gem', provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', auth_ref: 'gemini-key',
        reachable_from: ['local'], models: ['gemini-3.8-flash'], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'gem', model: 'gemini-3.8-flash' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  mc = require(MC_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => ({ models: { chat: { provider: 'gemini', model: 'gemini-3.8-flash' } }, prefs: {} }),
    aeonTerminalStream: null,
  });
  await ai.envHydrated;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [tempSecrets, tempData, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => { calls.length = 0; keyPool._reset(); ai._resetProviderHealth?.(); });

/** Every Google request: no key in the URL, the expected key in the header. */
function expectKeyInHeaderOnly(expectedKey, pathRe) {
  const google = calls.filter((c) => new URL(c.href).hostname === 'generativelanguage.googleapis.com');
  const hit = google.filter((c) => pathRe.test(new URL(c.href).pathname));
  expect(hit.length, JSON.stringify(calls.map((c) => c.href.replace(/key=[^&]*/g, 'key=<redacted>')))).toBeGreaterThan(0);
  for (const c of google) {
    const u = new URL(c.href);
    expect(u.searchParams.has('key'), `key= in ${u.pathname}`).toBe(false);
    expect(c.href.includes(ENV_KEY) || c.href.includes(VAULT_KEY), `a key value in ${u.pathname}`).toBe(false);
  }
  for (const c of hit) expect(c.key).toBe(expectedKey);
}

describe('no Gemini request carries the key in its URL', () => {
  it('geminiRequest (env-key fallback)', async () => {
    expect(await ai.geminiRequest('hello', 'gemini-flash-latest')).toBe('answered');
    expectKeyInHeaderOnly(ENV_KEY, /:generateContent$/);
  });

  it('kernelVision, Gemini branch', async () => {
    const out = await ai.kernelVision('data:image/png;base64,AAAA', 'what is this', { provider: 'gemini', model: 'gemini-3.8-flash' });
    expect(out).toBe('answered');
    expectKeyInHeaderOnly(ENV_KEY, /:generateContent$/);
  });

  it('kernelLLM over a registry Gemini endpoint (genericGeminiRequest)', async () => {
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('answered');
    expectKeyInHeaderOnly(VAULT_KEY, /:generateContent$/);
  });

  it('kernelLLMStream over a registry Gemini endpoint (streamGemini)', async () => {
    let text = '';
    await ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken: (t) => { text += t; } });
    expect(text).toBe('answered');
    expectKeyInHeaderOnly(VAULT_KEY, /:streamGenerateContent$/);
  });

  it('modelContext catalogue lookup', async () => {
    await mc.lookup({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: VAULT_KEY });
    expectKeyInHeaderOnly(VAULT_KEY, /\/models$/);
  });
});
