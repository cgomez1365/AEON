/**
 * Sweep C34 — removing ONE key in Settings must leave the provider's other
 * keys serving.
 *
 * forgetKey deleted every env name holding the removed key, including the base
 * OPENROUTER_API_KEY when that key sat there. A pool of one is read through the
 * base name (nextKey steps aside below two keys), so openRouterRequest, the
 * stream path and vision all said "OPENROUTER_API_KEY missing" with a good key
 * still loaded — until a restart. Drives the REAL services/ai.js; the provider
 * calls go to a stubbed fetch, never the network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-forget-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-forget-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = tempSecrets;

const savedCache = {};
for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

const KEY_A = 'sk-or-v1-first-key-in-the-base-slot';
const KEY_B = 'sk-or-v1-second-key-still-good';
const authSeen = [];
let fetchSpy;
let ai;
let settingsNow = { models: {}, roulette: false, prefs: {} };

beforeAll(async () => {
  // Two OpenRouter keys: the one about to be removed sits in the base slot.
  process.env.OPENROUTER_API_KEY = KEY_A;
  process.env.OPENROUTER_API_KEY_2 = KEY_B;
  require.cache[LR_PATH] = {
    id: LR_PATH, filename: LR_PATH, loaded: true,
    exports: { isAvailable: () => false, defaultModel: () => null, status: () => ({ readyModels: [] }), cancelAll: () => 0 },
  };
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    authSeen.push({ url: String(url), auth: init?.headers?.Authorization || null });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => settingsNow,
    aeonTerminalStream: { emit: () => {} },
  });
  await ai.envHydrated;
});

afterAll(() => {
  fetchSpy?.mockRestore();
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe('C34 — the key that is left keeps serving', () => {
  it('removing the base-slot key leaves the other key in the base slot and the pool', () => {
    expect(ai.getKeyPoolInfo().openrouter.count).toBe(2);
    ai.forgetKey(KEY_A);
    expect(ai.getKeyPoolInfo().openrouter.count).toBe(1);
    expect(process.env.OPENROUTER_API_KEY).toBe(KEY_B);
    expect(Object.values(process.env)).not.toContain(KEY_A);
  });

  it('OpenRouter still answers, with the remaining key', async () => {
    authSeen.length = 0;
    await expect(ai.openRouterRequest('hello', 'openai/gpt-4o-mini')).resolves.toBe('ok');
    expect(authSeen).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', auth: `Bearer ${KEY_B}` }]);
  });

  it('vision on OpenRouter still reads images, with the remaining key', async () => {
    authSeen.length = 0;
    settingsNow = { models: { vision: { provider: 'openrouter', model: 'openrouter/free' } }, roulette: false, prefs: {} };
    await expect(ai.kernelVision('data:image/png;base64,iVBORw0KGgo=', 'what is this?')).resolves.toBe('ok');
    expect(authSeen.map((a) => a.auth)).toEqual([`Bearer ${KEY_B}`]);
  });

  it('removing the last key still leaves nothing behind', () => {
    ai.forgetKey(KEY_B);
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(ai.getKeyPoolInfo().openrouter).toBeUndefined();
  });
});
