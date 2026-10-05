/**
 * Groq gpt-oss answers a chat turn with a NATIVE tool call (live, the CEO's
 * drive, 2026-10-05 22:28 and 22:47).
 *
 * The ledger: two rows, provider groq, model openai/gpt-oss-120b, error
 * "Endpoint error in the response body: Tool choice is none, but model called
 * a tool". The terminal said "groq unavailable → local", and the 2,048-token
 * local model could not hold the turn ("uses 4,407 of a 2,048-token window").
 *
 * AEON sends Groq no `tools` and no `tool_choice` (agents use the text
 * aeon-tool protocol), so Groq defaults tool_choice to "none". gpt-oss was
 * trained on harmony tool calls and wrote one anyway after reading the
 * ## TOOLS section; Groq refuses that, mid-stream, under a 200. A refusal of
 * the model's FORMAT is not the provider being down: the same model is asked
 * once more with a note not to call functions, and only then does the chain
 * move on.
 *
 * REAL services/ai.js; fetch is mocked, so nothing leaves the machine.
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
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-groq-tool-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-groq-tool-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'groq-tool-suite-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');
const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }

const GROQ_BASE = 'https://groq.fake.test/openai/v1';
const REFUSAL = {
  message: 'Tool choice is none, but model called a tool',
  type: 'invalid_request_error',
  code: 'tool_use_failed',
  failed_generation: '{"name":"vault_search","arguments":{"query":"plan"}}',
};

const sseResponse = (...events) => new Response(
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const textChunk = (content) => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

// What Groq does on each successive request: 'refuse' (the error chunk under a
// 200, as the ledger's wording shows), 'refuse400' (the same refusal as an
// HTTP 400), 'answer', 'down500', or 'tooLarge' (a 413).
let plan = [];
const groqSeen = [];
const localSeen = [];
const realFetch = globalThis.fetch;
const fakeFetch = async (url, init = {}) => {
  if (!String(url).startsWith(GROQ_BASE)) throw new Error(`unexpected network call to ${url}`);
  const body = JSON.parse(init.body);
  groqSeen.push(body);
  const step = plan[Math.min(groqSeen.length - 1, plan.length - 1)];
  if (step === 'refuse') return sseResponse({ error: REFUSAL });
  if (step === 'refuse400') return new Response(JSON.stringify({ error: REFUSAL }), { status: 400, headers: { 'content-type': 'application/json' } });
  if (step === 'tooLarge') return new Response(JSON.stringify({ error: { message: 'Request too large for model' } }), { status: 413, headers: { 'content-type': 'application/json' } });
  if (step === 'down500') return new Response(JSON.stringify({ error: { message: 'internal error' } }), { status: 500 });
  return sseResponse(textChunk('from-groq'), '[DONE]');
};

const lrStub = {
  isAvailable: () => true,
  defaultModel: () => 'llama3-8b-q4',
  listReadyModels: () => [{ id: 'llama3-8b-q4', capabilities: ['chat'] }],
  status: () => ({ available: true, readyModels: [{ id: 'llama3-8b-q4', capabilities: ['chat'] }] }),
  plannedContext: async () => ({ contextTokens: 8192 }),
  cancelAll: () => 0,
  infer: async () => ({ text: 'from-local', model: 'llama3-8b-q4', tokens: 3 }),
  inferStream: async (_p, o, onToken) => {
    localSeen.push(o.messages);
    onToken?.('from-local');
    return { text: 'from-local', tokens: 3, model: 'llama3-8b-q4', complete: true };
  },
};

let ai;
let keyPool;
const settingsNow = { models: { chat: { provider: 'groq', model: 'openai/gpt-oss-120b' } }, roulette: false, prefs: {} };

beforeAll(async () => {
  const vault = require(VAULT_PATH);
  await vault.setSecret('groq-key', 'gsk_groq_tool_stub_0000');
  fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: [
    { id: 'groq-fake', provider: 'groq', base_url: GROQ_BASE, auth_ref: 'groq-key', reachable_from: ['local'], models: ['openai/gpt-oss-120b'], rpm_limit: 0 },
  ], roles: {} }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  globalThis.fetch = fakeFetch;
  ai = require(AI_PATH)({ supabase: null, writeOSAudit: () => {}, TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'), loadSettings: () => settingsNow, aeonTerminalStream: { emit: () => {} } });
  await ai.envHydrated;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [p, mod] of Object.entries(savedCache)) { if (mod) require.cache[p] = mod; else delete require.cache[p]; }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => { keyPool._reset(); ai._resetProviderHealth(); groqSeen.length = 0; localSeen.length = 0; plan = []; });

const TURN = () => [
  { role: 'system', content: 'You are AEON.\n\n## TOOLS\nTools:\n- vault_search {"query"} — search the Vault.' },
  { role: 'user', content: 'what is in my plan?' },
];
const run = async (messages = TURN()) => {
  const fallbacks = [];
  const tokens = [];
  const r = await ai.kernelLLMStream(messages, {
    role: 'chat', onToken: (t) => tokens.push(t), onFallback: (f) => fallbacks.push(f),
  });
  return { r, fallbacks, tokens };
};

describe('a native tool call that Groq refuses (tool_choice is none)', () => {
  it('sends Groq no tools and no tool_choice: the refusal is the model\'s choice, not a request AEON built', async () => {
    plan = ['answer'];
    await run();
    expect(groqSeen[0].tools).toBeUndefined();
    expect(groqSeen[0].tool_choice).toBeUndefined();
  });

  for (const shape of ['refuse', 'refuse400']) {
    it(`${shape}: asks the SAME model once more, with a note not to call functions, and keeps the turn off Local`, async () => {
      plan = [shape, 'answer'];
      const { r, fallbacks } = await run();
      expect(groqSeen.length).toBe(2);
      expect(groqSeen[1].model).toBe('openai/gpt-oss-120b');
      expect(groqSeen[1].messages[0].content).toMatch(/never emit a tool or function call/i);
      expect(groqSeen[0].messages[0].content).not.toMatch(/never emit a tool or function call/i);
      expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
      expect(localSeen.length).toBe(0);
      // Said in words, on the same connection, never "groq unavailable".
      expect(fallbacks.map((f) => `${f.from}>${f.to}`)).toEqual(['groq>groq']);
      expect(fallbacks[0].notice).toMatch(/tool call/i);
      expect(fallbacks[0].notice).not.toMatch(/unavailable/i);
    });
  }

  it('a refusal is the model\'s format, not Groq down: no rest, no failure streak', async () => {
    for (let i = 0; i < 4; i++) {
      plan = ['refuse', 'answer'];
      groqSeen.length = 0;
      await run();
    }
    const h = ai.getProviderHealth().groq;
    expect(h.healthy).toBe(true);
    expect(h.blockedUntil || 0).toBeLessThanOrEqual(Date.now());
  });

  it('two refusals in a row: one retry only, then the chain moves on, with the cause in words', async () => {
    plan = ['refuse', 'refuse'];
    const { r, fallbacks } = await run();
    expect(groqSeen.length).toBe(2);
    expect(r).toMatchObject({ provider: 'local', text: 'from-local' });
    const toLocal = fallbacks.find((f) => f.to === 'local');
    expect(toLocal.reason).toMatch(/tool call/i);
    expect(toLocal.reason).not.toBe('unavailable');
  });

  it('any other Groq failure is not retried on the same model', async () => {
    plan = ['down500'];
    const { r } = await run();
    expect(groqSeen.length).toBe(1);
    expect(r.provider).toBe('local');
  });

  it('the note is carried once through a trimmed retry that follows the refusal', async () => {
    // No heading in the system prompt, so the trim keeps it whole (note included).
    const long = [
      { role: 'system', content: 'You are AEON. Tools: vault_search.' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} `.repeat(400) })),
      { role: 'user', content: 'what is in my plan?' },
    ];
    plan = ['refuse', 'tooLarge', 'answer'];
    const { r } = await run(long);
    expect(groqSeen.length).toBe(3);
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq', trimmed: true });
    const note = /never emit a tool or function call/ig;
    expect(groqSeen[2].messages[0].content.match(note)?.length).toBe(1);
  });
});
