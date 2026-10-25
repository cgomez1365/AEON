/**
 * The Gemini fallbacks ask for gemini-2.5-flash, not a moving "-latest" alias (a16).
 *
 * The .env Gemini path (geminiRequest), the legacy chain inside kernelLLM, and
 * the streaming fallback all defaulted to 'gemini-flash-latest'. That alias
 * moves with Google's releases and may already resolve to a 3.x model, which
 * the CEO's own key failed on (see gemini-thinking-responses.test.js). House
 * rule: stay on gemini-2.5-flash until a 3.x repro exists.
 *
 * Drives the REAL services/ai.js with only a GEMINI_API_KEY in the env and no
 * model configured. Every outbound fetch is answered in-process and recorded;
 * nothing leaves this machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-default-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-default-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = tempSecrets;

const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}
process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';

const savedCache = {};
for (const p of [AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }

const models = [];
const realFetch = globalThis.fetch;
const candidate = { candidates: [{ content: { role: 'model', parts: [{ text: 'answered' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { totalTokenCount: 9 } };
globalThis.fetch = (url) => {
  const u = new URL(typeof url === 'string' ? url : (url.url || String(url)));
  if (u.hostname !== 'generativelanguage.googleapis.com') {
    return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
  }
  const m = u.pathname.match(/\/models\/([^/:]+):(stream)?[gG]enerateContent$/);
  if (m) models.push(m[1]);
  if (m && m[2]) {
    return Promise.resolve(new Response(`data: ${JSON.stringify(candidate)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  }
  return Promise.resolve(new Response(JSON.stringify(candidate), { status: 200, headers: { 'content-type': 'application/json' } }));
};

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

let ai;
beforeAll(async () => {
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    // Gemini named for chat, with NO model: the fallback default decides.
    loadSettings: () => ({ models: { chat: { provider: 'gemini' } }, prefs: {} }),
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
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => { models.length = 0; ai._resetProviderHealth?.(); });

describe('no model configured: the Gemini fallback asks for gemini-2.5-flash', () => {
  it('geminiRequest with no model argument', async () => {
    expect(await ai.geminiRequest('hello')).toBe('answered');
    expect(models).toEqual(['gemini-2.5-flash']);
  });

  it('kernelLLM, chat role set to Gemini with no model', async () => {
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('answered');
    expect(models).toEqual(['gemini-2.5-flash']);
  });

  it('kernelLLMStream, chat role set to Gemini with no model', async () => {
    let text = '';
    await ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken: (t) => { text += t; } });
    expect(text).toBe('answered');
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(['gemini-2.5-flash']));
  });

  it('no Gemini "-latest" alias is a default anywhere in services/ai.js', () => {
    const src = fs.readFileSync(AI_PATH, 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(src.match(/['"`]gemini-[a-z0-9.-]*latest['"`]/g) || []).toEqual([]);
  });
});
