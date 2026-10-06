/**
 * The operator's requests-per-minute limit holds when the caller NAMES the
 * provider, and on the image-reading transports.
 *
 * Calls routed by role resolve their connection from the registry and carry
 * its limit. A caller that names groq, gemini, openrouter or claude (a Council
 * seat, an agent's first streamed round on its own provider) skips the
 * registry and runs on the environment key pool, and kernelVision always does:
 * neither carried the limit, so a Council burst of ~8 concurrent seats went
 * out at full speed against the limit the operator set, and the next chat turn
 * met the 429 the setting exists to prevent.
 *
 * These drive the REAL services/ai.js with a stubbed fetch for the four hosted
 * hosts (nothing leaves this machine). Only the clock is faked, so a
 * per-minute limit is proved without a minute passing. The limit used (1)
 * belongs to no provider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const PACING_PATH = path.join(ROOT, 'src', 'kernel', 'pacing.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pacing-named-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pacing-named-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'pacing-named-suite-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, PACING_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}
// The keys a caller-named provider runs on. Test values only.
process.env.GROQ_API_KEY = 'test-only-env-groq';
process.env.OPENROUTER_API_KEY = 'test-only-env-openrouter';
process.env.ANTHROPIC_API_KEY = 'test-only-env-claude';
process.env.GEMINI_API_KEY = 'test-only-env-gemini';

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const hits = { groq: 0, openrouter: 0, gemini: 0, claude: 0 };
const sse = (events) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
globalThis.fetch = (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  const body = init?.body ? JSON.parse(init.body) : {};
  const stream = (text) => Promise.resolve(new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const json = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200 }));
  if (u.hostname === 'api.groq.com' || u.hostname === 'openrouter.ai') {
    const which = u.hostname === 'api.groq.com' ? 'groq' : 'openrouter';
    hits[which]++;
    if (body.stream) return stream(sse([{ choices: [{ delta: { content: `${which} streamed` }, finish_reason: 'stop' }], usage: { total_tokens: 4 } }, '[DONE]']));
    return json({ choices: [{ message: { content: `${which} answered` } }], usage: { total_tokens: 4 } });
  }
  if (u.hostname === 'generativelanguage.googleapis.com') {
    hits.gemini++;
    const reply = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } });
    if (/streamGenerateContent/.test(u.pathname)) return stream(sse([reply('gemini streamed')]));
    return json(reply('gemini answered'));
  }
  if (u.hostname === 'api.anthropic.com') {
    hits.claude++;
    if (body.stream) {
      return stream(sse([
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'claude streamed' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]));
    }
    return json({ content: [{ type: 'text', text: 'claude answered' }], usage: { input_tokens: 3, output_tokens: 2 } });
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

let ai;
let pacing;
let endpoints;
const logLines = [];
const settings = { models: { chat: { provider: 'local', model: 'x' } }, prefs: {} };

const BASES = { groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', claude: 'https://api.anthropic.com/v1' };
const MODELS = { groq: 'openai/gpt-oss-120b', openrouter: 'openrouter/free', gemini: 'gemini-flash-latest', claude: 'claude-sonnet-5' };
const VISION = { groq: 'meta-llama/llama-4-scout-17b-16e-instruct', openrouter: 'openrouter/free', gemini: 'gemini-flash-latest', claude: 'claude-sonnet-5' };
const row = (provider, rpm_limit) => ({
  id: provider, provider, label: provider, base_url: BASES[provider],
  auth_ref: `${provider}-k1`, auth_refs: [`${provider}-k1`], reachable_from: ['local'], models: [MODELS[provider]], rpm_limit,
});
const setLimits = (limits) => fs.writeFileSync(REG_FILE, JSON.stringify({
  endpoints: Object.entries(limits).map(([p, n]) => row(p, n)), roles: {},
}, null, 2));

beforeAll(async () => {
  endpoints = require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  pacing = require(PACING_PATH);
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => settings,
    aeonTerminalStream: { emit: (_t, e) => logLines.push(e?.message || '') },
  });
  await ai.envHydrated;
});

beforeEach(() => {
  require(POOL_PATH)._reset();
  pacing._reset();
  ai._resetProviderHealth?.();
  for (const k of Object.keys(hits)) hits[k] = 0;
  logLines.length = 0;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => { vi.useRealTimers(); });

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const nap = (ms = 5) => new Promise((r) => realSetTimeout(r, ms));
const settle = async (promise, stepMs = 1000) => {
  let done = false;
  let out;
  let failure;
  promise.then((v) => { out = v; done = true; }, (e) => { failure = e; done = true; });
  const deadline = performance.now() + 15_000;
  while (!done && performance.now() < deadline) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await nap();
  }
  if (!done) throw new Error('the call never finished');
  if (failure) throw failure;
  return out;
};
const idle = async (ms) => { await vi.advanceTimersByTimeAsync(ms); await nap(); };
const WAIT = (p) => new RegExp(`pacing: waiting \\d+s for ${p} \\(your limit: 1/min`);
const PROVIDERS = ['groq', 'gemini', 'openrouter', 'claude'];
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

// One call goes straight through; the second, inside the minute, is held and
// says so; after the window it runs. `call(notices)` makes one call.
const provePaced = async (provider, call, expectedText) => {
  const first = [];
  await settle(call(first), 0);
  expect(hits[provider], `${provider}: the first call should go straight out`).toBe(1);
  expect(first).toEqual([]);

  const notices = [];
  let finished = false;
  const p = call(notices).then((r) => { finished = true; return r; });
  await idle(20_000);
  expect(finished, `${provider}: a second call inside the minute was not delayed`).toBe(false);
  expect(hits[provider], `${provider}: a second request reached the provider inside the window`).toBe(1);
  expect(notices.join('\n')).toMatch(WAIT(provider));
  expect(logLines.join('\n')).toMatch(WAIT(provider));
  const r = await settle(p);
  expect(hits[provider]).toBe(2);
  if (expectedText) expect(String(r?.text ?? r)).toBe(expectedText);
};

describe('a caller that names the provider is held to the limit (the Council seat shape)', () => {
  for (const provider of PROVIDERS) {
    it(`${provider}, blocking`, async () => {
      setLimits({ [provider]: 1 });
      await provePaced(
        provider,
        (notices) => ai.kernelLLM('hi', { provider, model: MODELS[provider], onNotice: (m) => notices.push(m) }),
        `${provider} answered`,
      );
    });

    it(`${provider}, streamed (an agent's first round on its own provider)`, async () => {
      setLimits({ [provider]: 1 });
      await provePaced(
        provider,
        (notices) => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], {
          role: 'chat', provider, model: MODELS[provider], onToken: () => {}, onNotice: (m) => notices.push(m),
        }),
        `${provider} streamed`,
      );
    });
  }

  it('a burst of concurrent named calls is spread over the limit, not sent at once', async () => {
    setLimits({ groq: 3 });
    const calls = Array.from({ length: 5 }, (_, i) => ai.kernelLLM(`q${i}`, { provider: 'groq', model: MODELS.groq }));
    await idle(20_000);
    expect(hits.groq, 'five Council seats reached groq inside one minute at a limit of 3').toBe(3);
    await settle(Promise.all(calls));
    expect(hits.groq).toBe(5);
  });
});

describe('one key, one budget', () => {
  it('a role-routed call and a caller-named call on the same single credential spend one limit, not two', async () => {
    require(VAULT_PATH);
    await require(VAULT_PATH).setSecret('groq-k1', 'test-only-groq-k1');
    fs.writeFileSync(REG_FILE, JSON.stringify({
      endpoints: [row('groq', 1)], roles: { chat: { endpoint_id: 'groq', model: MODELS.groq } },
    }, null, 2));
    settings.models.chat = { provider: 'groq', model: MODELS.groq };
    try {
      await settle(ai.kernelLLM('by role', { role: 'chat' }), 0);
      expect(hits.groq).toBe(1);
      let finished = false;
      const notices = [];
      const p = ai.kernelLLM('by name', { provider: 'groq', model: MODELS.groq, onNotice: (m) => notices.push(m) }).then((t) => { finished = true; return t; });
      await idle(20_000);
      expect(finished, 'the named call had a budget of its own').toBe(false);
      expect(hits.groq).toBe(1);
      expect(notices.join('\n')).toMatch(WAIT('groq'));
      await settle(p);
      expect(hits.groq).toBe(2);
    } finally { settings.models.chat = { provider: 'local', model: 'x' }; }
  });
});

describe('image reads are held to the limit too', () => {
  for (const provider of PROVIDERS) {
    it(`${provider} vision`, async () => {
      setLimits({ [provider]: 1 });
      await provePaced(
        provider,
        (notices) => ai.kernelVision(IMAGE, 'what is this', { provider, model: VISION[provider], onNotice: (m) => notices.push(m) }),
        provider === 'claude' ? 'claude answered' : (provider === 'gemini' ? 'gemini answered' : `${provider} answered`),
      );
    });
  }

  it('a vision role declared in Settings (no caller override) is held as well', async () => {
    setLimits({ gemini: 1 });
    settings.models.vision = { provider: 'gemini', model: VISION.gemini };
    try {
      await provePaced('gemini', (notices) => ai.kernelVision(IMAGE, 'what is this', { onNotice: (m) => notices.push(m) }), 'gemini answered');
    } finally { delete settings.models.vision; }
  });
});

describe('nothing waits where the operator set no limit', () => {
  it('limit 0, no limit, and no connection at all never delay a named call', async () => {
    for (const limits of [{ groq: 0 }, { groq: null }, {}]) {
      setLimits(limits);
      pacing._reset();
      const before = hits.groq;
      for (let i = 0; i < 4; i++) {
        const notices = [];
        await settle(ai.kernelLLM('hi', { provider: 'groq', model: MODELS.groq, onNotice: (m) => notices.push(m) }), 0);
        expect(notices).toEqual([]);
      }
      expect(hits.groq - before, JSON.stringify(limits)).toBe(4);
    }
  });

  it('a limit raised in Settings frees the next named call with no restart', async () => {
    setLimits({ groq: 1 });
    await settle(ai.kernelLLM('one', { provider: 'groq', model: MODELS.groq }), 0);
    await endpoints.setRpmLimit('groq', 5);
    const notices = [];
    await settle(ai.kernelLLM('two', { provider: 'groq', model: MODELS.groq, onNotice: (m) => notices.push(m) }), 0);
    expect(notices).toEqual([]);
    expect(hits.groq).toBe(2);
  });
});
