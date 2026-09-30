/**
 * Sweep, routing group — the kernel's provider choice, driven through the REAL
 * services/ai.js against fake endpoints registered the way Settings registers
 * them. Nothing here reaches the network: every endpoint is 127.0.0.1, the
 * provider env keys are cleared, and the one hosted call (vision's default)
 * goes to a stubbed fetch.
 *
 *   C09 — failover to a registry provider asked for the first model it lists
 *         (Groq lists a text-to-speech model first).
 *   C10 — the non-stream chain tried Local last even when Local was declared
 *         or requested.
 *   C35 — a caller that named Claude got another provider's text as Claude's.
 *   C33 — Vision saved as "Same as Chat" ({provider: ''}) failed every upload.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-routing-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-routing-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
const savedPortable = process.env.AEON_PORTABLE;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'sweep-routing-suite-key';
delete process.env.AEON_PORTABLE;
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

// Groq's list, in the order Groq serves it: speech models first.
const GROQ_MODELS = ['canopylabs/orpheus-arabic-saudi', 'playai-tts', 'whisper-large-v3', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'];

const modes = { primary: 'ok' };
const hits = { primary: 0, groq: 0 };
const groqModels = [];
const makeFake = (name) => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    hits[name]++;
    if (name === 'groq') groqModels.push(req.body.model);
    if (name === 'primary' && modes.primary === '402') {
      return res.status(402).json({ error: { code: 402, message: 'Insufficient credits' } });
    }
    // What Groq answers when asked to chat with a speech model.
    if (name === 'groq' && /orpheus|tts|whisper/.test(req.body.model)) {
      return res.status(400).json({ error: { message: `The model \`${req.body.model}\` does not support chat completions` } });
    }
    const text = `from-${name}`;
    if (req.body.stream) {
      res.status(200).set('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: 5 } });
  });
  return app;
};

let localOn = false;
let localFails = false;
const localCalls = [];
const lrStub = {
  isAvailable: () => localOn,
  defaultModel: () => (localOn ? 'qwen-local' : null),
  listReadyModels: () => (localOn ? [{ id: 'qwen-local', capabilities: ['chat'] }] : []),
  status: () => ({ available: localOn, readyModels: localOn ? [{ id: 'qwen-local', capabilities: ['chat'] }] : [] }),
  plannedContext: async () => ({ contextTokens: 8192 }),
  cancelAll: () => 0,
  infer: async (_prompt, o) => {
    localCalls.push(o.model);
    if (localFails) throw new Error('local model crashed');
    return { text: 'from-local', model: o.model || 'qwen-local', tokens: 3 };
  },
  inferStream: async () => { throw new Error('not used here'); },
};

const servers = [];
let ai;
let keyPool;
let settingsNow;
const notices = [];

beforeAll(async () => {
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
  const pPort = await listen(makeFake('primary'));
  const gPort = await listen(makeFake('groq'));
  const vault = require(VAULT_PATH);
  await vault.setSecret('primary-key', 'sk-primary-stub');
  await vault.setSecret('groq-key', 'gsk_groq_stub_0000');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'primary', provider: 'custom', base_url: `http://127.0.0.1:${pPort}/v1`, auth_ref: 'primary-key',
        reachable_from: ['local'], models: ['primary-model'], rpm_limit: 0 },
      { id: 'groq-fake', provider: 'groq', base_url: `http://127.0.0.1:${gPort}/v1`, auth_ref: 'groq-key',
        reachable_from: ['local'], models: GROQ_MODELS, preferred_model: GROQ_MODELS[0], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'primary', model: 'primary-model' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => settingsNow,
    aeonTerminalStream: { emit: (_e, ev) => notices.push(ev.message) },
  });
  await ai.envHydrated;
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  if (savedPortable !== undefined) process.env.AEON_PORTABLE = savedPortable;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => {
  keyPool._reset(); ai._resetProviderHealth();
  modes.primary = 'ok'; hits.primary = 0; hits.groq = 0; groqModels.length = 0;
  localOn = false; localFails = false; localCalls.length = 0; notices.length = 0;
  settingsNow = { models: { chat: { provider: 'custom', model: 'primary-model' } }, roulette: false, prefs: {} };
});

const stream = (extra = {}) => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken() {}, ...extra });

describe('C09 — failover asks a registry provider for a model that can chat', () => {
  it('stream: the primary is out of credits → Groq is asked for its chat model, not the first one it lists', async () => {
    modes.primary = '402';
    const r = await stream();
    expect(r).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', text: 'from-groq' });
    expect(groqModels).toEqual(['openai/gpt-oss-120b']);
  });

  it('non-stream: the same', async () => {
    modes.primary = '402';
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
    expect(groqModels).toEqual(['openai/gpt-oss-120b']);
  });

  it('a Groq model Settings declares (for any role) wins over the chain default', async () => {
    modes.primary = '402';
    settingsNow.models.naming = { provider: 'groq', model: 'qwen/qwen3-32b' };
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
    expect(groqModels).toEqual(['qwen/qwen3-32b']);
  });

  it('the auto-pick itself skips Orpheus, Groq\'s text-to-speech family', () => {
    const { pickChatModel } = require(ENDPOINTS_PATH);
    expect(pickChatModel(GROQ_MODELS)).toBe('openai/gpt-oss-120b');
    expect(pickChatModel(['canopylabs/orpheus-v1-english', 'allam-2-7b'])).toBe('allam-2-7b');
  });
});

describe('C10 — Local declared or requested is tried first, not last', () => {
  it('a role set to Local in Settings is answered by Local while cloud is healthy', async () => {
    localOn = true;
    settingsNow.models.grading = { provider: 'local', model: 'qwen-local' };
    const r = await ai.kernelLLM('grade this', { role: 'grading', returnMeta: true });
    expect(r).toMatchObject({ provider: 'local', model: 'qwen-local', text: 'from-local' });
    expect(hits).toEqual({ primary: 0, groq: 0 });
  });

  it('a caller that names Local (a Council seat, the kill-switch) gets Local — as text, not a wrapped object', async () => {
    localOn = true;
    const r = await ai.kernelLLM('hello', { provider: 'local', model: 'qwen-local', returnMeta: true });
    expect(r).toMatchObject({ provider: 'local', text: 'from-local' });
    expect(typeof r.text).toBe('string');
    expect(await ai.kernelLLM('hello', { provider: 'local', model: 'qwen-local' })).toBe('from-local');
    expect(hits.primary).toBe(0);
  });

  it('Local that fails still hands over to the cloud, and is tried once', async () => {
    localOn = true;
    localFails = true;
    settingsNow.models.grading = { provider: 'local', model: 'qwen-local' };
    const r = await ai.kernelLLM('grade this', { role: 'grading', returnMeta: true });
    expect(r.provider).not.toBe('local');
    expect(localCalls).toEqual(['qwen-local']);
  });

  it('portable (every role resolves to Local through the registry path): the answer is text, wrapped once', async () => {
    localOn = true;
    process.env.AEON_PORTABLE = 'true';
    try {
      const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
      expect(r).toMatchObject({ provider: 'local', model: 'qwen-local', text: 'from-local' });
      expect(typeof r.text).toBe('string');
    } finally { delete process.env.AEON_PORTABLE; }
    expect(hits).toEqual({ primary: 0, groq: 0 });
  });

  it('Local nobody chose stays the floor: a cloud role is still answered by the cloud first', async () => {
    localOn = true;
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ provider: 'custom', text: 'from-primary' });
    expect(localCalls).toEqual([]);
  });
});

describe('C35 — a caller that names Claude gets Claude or an error', () => {
  it('a named Claude that cannot answer throws; nobody else\'s text comes back as Claude\'s', async () => {
    const err = await ai.kernelLLM('hello', { provider: 'claude', model: 'claude-sonnet-5' }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ANTHROPIC_API_KEY missing/);
    expect(hits).toEqual({ primary: 0, groq: 0 });
  });

  it('Claude assigned in Settings still hands over to the chain (602ff12 kept)', async () => {
    settingsNow.models.chat = { provider: 'claude', model: 'claude-sonnet-5' };
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r.provider).not.toBe('claude');
    expect(typeof r.text).toBe('string');
  });
});

describe('C33 — Vision never borrows Chat; unset means its own default', () => {
  it('vision saved with an empty provider reads the image through the vision default', async () => {
    settingsNow.models.vision = { provider: '', model: 'openrouter/free' };
    process.env.GROQ_API_KEY = 'gsk_vision_stub_0000';
    const seen = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://api.groq.com/')) return realFetch(url, init);
      seen.push({ url: String(url), model: JSON.parse(init.body).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'a cat' } }], usage: { total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const text = await ai.kernelVision('data:image/png;base64,iVBORw0KGgo=', 'what is this?');
      expect(text).toBe('a cat');
      expect(seen).toEqual([{ url: 'https://api.groq.com/openai/v1/chat/completions', model: 'meta-llama/llama-4-scout-17b-16e-instruct' }]);
    } finally {
      spy.mockRestore();
      delete process.env.GROQ_API_KEY;
    }
  });
});
