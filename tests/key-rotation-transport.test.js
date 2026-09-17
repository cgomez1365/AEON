/**
 * Rotation on the wire: a refused key must not end the turn.
 *
 * The unit tests next door prove the pool picks a different account. This one
 * proves the TRANSPORT uses it — that a 429 from key one is answered by key
 * two inside the same call, with no fallback to another provider and nothing
 * for the operator to do. That is the behaviour the feature was always
 * described as having, and the behaviour the registry path never had: before
 * this fix services/ai.js received one apiKey from resolveForRole and had
 * nowhere else to go.
 *
 * Drives the REAL services/ai.js against a fake OpenAI-compatible endpoint
 * that refuses one key and serves the other.
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

// Both the registry and the vault resolve their directory at module scope, so
// this is set before either is required — and never at the operator's install.
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-rotation-wire-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'transport-rotation-suite-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}

// No provider key from the developer's shell may reach the fallback chain.
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

// ── The fake provider: one key is over its limit, the other is fine ──
const EXHAUSTED = 'KEY-EXHAUSTED';
const GOOD = 'KEY-GOOD';
let bearers = [];       // every Authorization this endpoint was shown, in order
let refuseAll = false;

const fake = express();
fake.use(express.json());
fake.post('/v1/chat/completions', (req, res) => {
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  bearers.push(key);
  if (refuseAll || key === EXHAUSTED) {
    return res.status(429).set('retry-after', '30').json({ error: { message: 'rate limit exceeded for this key' } });
  }
  res.json({ choices: [{ message: { content: 'answered' } }], usage: { total_tokens: 7 } });
});

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

let servers = [];
let ai, endpoints, keyPool;

beforeAll(async () => {
  const f = await listen(fake);
  servers.push(f.server);

  const vault = require(VAULT_PATH);
  await vault.setSecret('pool-exhausted', EXHAUSTED);
  await vault.setSecret('pool-good', GOOD);

  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [{
      id: 'pooled', provider: 'custom', base_url: `http://127.0.0.1:${f.port}/v1`,
      auth_ref: 'pool-exhausted', auth_refs: ['pool-exhausted', 'pool-good'],
      reachable_from: ['local'], models: ['fake-model'], rpm_limit: 0,
    }],
    roles: { chat: { endpoint_id: 'pooled', model: 'fake-model' } },
  }, null, 2));

  endpoints = require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };

  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-rotation-ledger-')), 'token_ledger.json'),
    loadSettings: () => ({ models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} }),
    aeonTerminalStream: null,
  });
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
});

describe('a 429 moves the turn to the next key, inside the same call', () => {
  it('answers the operator instead of surfacing the rate limit', async () => {
    keyPool._reset();
    bearers = []; refuseAll = false;

    const text = await ai.kernelLLM('hello', { role: 'chat' });

    // Before the fix: the resolver handed over ONE key and this threw 429.
    expect(text).toBe('answered');
    expect(bearers).toContain(EXHAUSTED);
    expect(bearers).toContain(GOOD);
    expect(bearers.at(-1)).toBe(GOOD);
  });

  it('the refused key is then rested, so the next turn does not spend a request rediscovering it', async () => {
    keyPool._reset();
    bearers = []; refuseAll = false;

    await ai.kernelLLM('first', { role: 'chat' });
    const snap = keyPool.snapshot('pooled', ['pool-exhausted', 'pool-good']);
    expect(snap.available).toBe(1);
    expect(snap.keys.find(k => k.ref === 'pool-exhausted').cooling).toBe(true);
    // Retry-After was 30s and the pool must believe the provider over its own default.
    expect(snap.keys.find(k => k.ref === 'pool-exhausted').retry_in_ms).toBeGreaterThan(20_000);

    bearers = [];
    await ai.kernelLLM('second', { role: 'chat' });
    expect(bearers).toEqual([GOOD]);
  });

  it('when every key is genuinely spent it stops — one attempt per key, no loop', async () => {
    keyPool._reset();
    bearers = []; refuseAll = true;

    await expect(ai.kernelLLM('hello', { role: 'chat' })).rejects.toThrow();
    // Two accounts, two attempts. A retry loop that did not count would hammer
    // a rate-limited provider, which is the opposite of the intent.
    expect(bearers).toHaveLength(2);
    refuseAll = false;
  });
});
