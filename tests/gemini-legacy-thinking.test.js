/**
 * The env-key Gemini paths read a thinking reply the way the registry
 * transports do (see gemini-thinking-responses.test.js).
 *
 * `geminiRequest` (the GEMINI_*_KEY fallback behind kernelLLM) and the Gemini
 * branch of `kernelVision` read parts[0].text: a thinking model that leads with
 * a `thought: true` part handed the operator its thinking as the answer, and a
 * budget spent thinking came back as '' reported as success.
 *
 * Drives the REAL services/ai.js; the fetch to Google is answered in-process.
 * Nothing leaves this machine.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-legacy-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini-legacy-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = tempSecrets;

const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}
// The pool is read when the module loads: one throwaway key joins it.
process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';

const savedCache = {};
for (const p of [AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }

const realFetch = globalThis.fetch;
let reply = null;
let hits = 0;
globalThis.fetch = (url) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname === 'generativelanguage.googleapis.com') {
    hits++;
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status || 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
};

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

const cand = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), index: 0 }] });
const THOUGHT = { text: 'Let me think about this carefully.', thought: true };
const IMG = 'data:image/png;base64,AAAA';

let ai;
beforeAll(() => {
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => ({ models: {}, prefs: {} }),
    aeonTerminalStream: null,
  });
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

beforeEach(() => { hits = 0; reply = null; });

describe('geminiRequest (env-key path)', () => {
  it('returns the text part after a leading thought, not the thought', async () => {
    reply = { body: cand([THOUGHT, { text: 'answered' }], 'STOP') };
    expect(await ai.geminiRequest('hello', 'gemini-flash-latest')).toBe('answered');
  });

  it('joins an answer split over several parts', async () => {
    reply = { body: cand([{ text: 'answer' }, { text: 'ed' }], 'STOP') };
    expect(await ai.geminiRequest('hello', 'gemini-flash-latest')).toBe('answered');
  });

  it('a budget spent thinking is an error naming the budget, never an empty string', async () => {
    reply = { body: { candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }] } };
    const out = await ai.geminiRequest('hello', 'gemini-flash-latest').then((t) => ({ t }), (e) => ({ e }));
    expect(out.e).toBeInstanceOf(Error);
    expect(out.e.message).toMatch(/whole output budget/);
    expect(hits).toBe(1);
  });

  it('a reply with no text is not retried into a loop', async () => {
    reply = { body: cand([{ text: '' }], 'STOP') };
    await ai.geminiRequest('hello', 'gemini-flash-latest').catch(() => {});
    expect(hits).toBe(1);
  });
});

describe('kernelVision (Gemini)', () => {
  const vision = () => ai.kernelVision(IMG, 'what is this', { provider: 'gemini', model: 'gemini-3.8-flash' });

  it('returns the text part after a leading thought, not the thought', async () => {
    reply = { body: cand([THOUGHT, { text: 'a cat' }], 'STOP') };
    expect(await vision()).toBe('a cat');
  });

  it('a budget spent thinking is an error naming the budget, never an empty string', async () => {
    reply = { body: { candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }] } };
    const out = await vision().then((t) => ({ t }), (e) => ({ e }));
    expect(out.e).toBeInstanceOf(Error);
    expect(out.e.message).toMatch(/whole output budget/);
  });
});
