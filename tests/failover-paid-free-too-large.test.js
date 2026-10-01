/**
 * Failover that reads the failure (live, the CEO's drive, 2026-09-30 20:55).
 *
 * Chat on openrouter / anthropic/claude-opus-4.6. The terminal showed the
 * error, THEN its causes: "openrouter out of credits → groq", "groq request
 * too large for it → local", and "local unavailable". The ledger said:
 *
 *   - OpenRouter answered 402 "can only afford 4" tokens — for the PAID model.
 *     The account still served ':free' models (the turn before had). The 402
 *     benched all of OpenRouter for 30 minutes.
 *   - Groq answered 413 on every turn: the turn carried ~11,000 tokens, sized
 *     for the declared model's window, over Groq's free per-minute cap.
 *   - Local failed before dispatch (no ledger row) with words that matched no
 *     reason, so it read "unavailable".
 *
 * Drives the REAL services/ai.js against a fake OpenRouter (402 on paid, 200
 * on ':free' and openrouter/free), a fake Groq (413 over its "Limit", 200
 * under it) and a stubbed local runtime, registered the way Settings
 * registers them. Every address is 127.0.0.1; provider env keys are cleared.
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
const { estimateMessageTokens } = require(path.join(ROOT, 'src', 'kernel', 'tokens.cjs'));

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-failover-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-failover-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
const savedPortable = process.env.AEON_PORTABLE;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'failover-suite-key';
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

const OPUS = 'anthropic/claude-opus-4.6';
const NEMOTRON = 'nvidia/nemotron-3-ultra-550b-a55b';
const OR_MODELS = [OPUS, NEMOTRON, `${NEMOTRON}:free`, 'openrouter/free'];
const isFree = (m) => m === 'openrouter/free' || String(m).endsWith(':free');

const answer = (req, res, text) => {
  if (req.body.stream) {
    res.status(200).set('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  return res.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: 5 } });
};

// OpenRouter: 'paid402' — the account the CEO had (paid 402s, free answers);
// 'free503' — paid 402s and the free router is down; 'all402' — nothing at
// all can be afforded, free models included.
let orMode = 'paid402';
const orSeen = [];
const fakeOpenRouter = express();
fakeOpenRouter.use(express.json({ limit: '5mb' }));
fakeOpenRouter.post('/v1/chat/completions', (req, res) => {
  const m = req.body.model;
  orSeen.push(m);
  if (orMode === 'all402' || !isFree(m)) {
    return res.status(402).json({ error: { code: 402, message: `This request requires more credits, or fewer max_tokens. You requested up to ${req.body.max_tokens} tokens, but can only afford 4. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account` } });
  }
  if (orMode === 'free503') return res.status(503).json({ error: { code: 503, message: 'No endpoints available for this free model right now' } });
  return answer(req, res, `from-openrouter:${m}`);
});

// Groq's free tier counts the prompt AND the answer it reserves against a
// per-minute cap, and answers 413 for a single request above it.
let groqLimit = 8000;
const groqSeen = [];
const fakeGroq = express();
fakeGroq.use(express.json({ limit: '5mb' }));
fakeGroq.post('/v1/chat/completions', (req, res) => {
  const requested = Math.ceil(JSON.stringify(req.body.messages).length / 4) + (req.body.max_tokens || 0);
  groqSeen.push({ requested, messages: req.body.messages, max_tokens: req.body.max_tokens });
  if (requested > groqLimit) {
    return res.status(413).json({ error: {
      message: `Request too large for model \`openai/gpt-oss-120b\` in organization \`org_test\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${groqLimit}, Requested ${requested}, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`,
      type: 'tokens', code: 'rate_limit_exceeded',
    } });
  }
  return answer(req, res, 'from-groq');
});

// The local runtime: a window the prompt must fit (the budget engine's own
// refusal), or a llama-server that never came up.
const local = { on: true, window: 8192, fail: null };
const localSeen = [];
const lrStub = {
  isAvailable: () => local.on,
  defaultModel: () => (local.on ? 'phi4-mini-q4' : null),
  listReadyModels: () => (local.on ? [{ id: 'phi4-mini-q4', capabilities: ['chat'] }] : []),
  status: () => ({ available: local.on, readyModels: local.on ? [{ id: 'phi4-mini-q4', capabilities: ['chat'] }] : [] }),
  plannedContext: async () => ({ contextTokens: local.window }),
  cancelAll: () => 0,
  infer: async () => ({ text: 'from-local', model: 'phi4-mini-q4', tokens: 3 }),
  inferStream: async (_p, o, onToken) => {
    localSeen.push(o.messages);
    if (local.fail === 'exited') throw new Error('llama-server exited during startup (code 1). error: failed to load model');
    if (local.fail === 'llama400') {
      throw new Error('llama-server returned 400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}');
    }
    const prompt = estimateMessageTokens(o.messages);
    if (prompt + 512 > local.window) {
      const e = new Error(`The prompt uses ${prompt.toLocaleString()} of a ${local.window.toLocaleString()}-token window, leaving 0 for the answer. Shorten the input, or serve this model with a larger context.`);
      e.code = 'CONTEXT_EXHAUSTED';
      throw e;
    }
    onToken?.('from-local');
    return { text: 'from-local', tokens: 3, model: 'phi4-mini-q4', complete: true };
  },
};

// A chat turn the size of the live one: identity, then 68 memories under a
// heading, twenty older turns, and a short question.
const IDENTITY = 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise.';
const MEMORY_LINE = (i) => `- [fact] The operator noted item ${i}: ${'the store packs ship as pilots, the drive carries the only vault copy, and every answer stays terse and direct. '.repeat(5)}`;
const BIG_SYSTEM = `${IDENTITY}\n\n## MEMORY\nStored memories, most relevant first:\n${Array.from({ length: 68 }, (_, i) => MEMORY_LINE(i)).join('\n')}\n\n## MEMORY RULES\n68 of 68 stored memories are loaded above.`;
const OLD_TURNS = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `Turn ${i}: ${'we talked about the release plan and what ships next for the store. '.repeat(25)}`,
}));
const QUESTION = { role: 'user', content: 'What should I ship first tomorrow?' };
const bigTurn = () => [{ role: 'system', content: BIG_SYSTEM }, ...OLD_TURNS, QUESTION];

const servers = [];
let ai;
let keyPool;
let settingsNow;
const notices = [];

beforeAll(async () => {
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
  const orPort = await listen(fakeOpenRouter);
  const groqPort = await listen(fakeGroq);
  const vault = require(VAULT_PATH);
  await vault.setSecret('or-key', 'sk-or-v1-failoverstub0000');
  await vault.setSecret('groq-key', 'gsk_failover_stub_0000');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'or-fake', provider: 'openrouter', base_url: `http://127.0.0.1:${orPort}/v1`, auth_ref: 'or-key',
        reachable_from: ['local'], models: OR_MODELS, rpm_limit: 0 },
      { id: 'groq-fake', provider: 'groq', base_url: `http://127.0.0.1:${groqPort}/v1`, auth_ref: 'groq-key',
        reachable_from: ['local'], models: ['openai/gpt-oss-120b'], rpm_limit: 0 },
    ],
    roles: {},
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
  orMode = 'paid402'; groqLimit = 8000;
  Object.assign(local, { on: true, window: 8192, fail: null });
  orSeen.length = 0; groqSeen.length = 0; localSeen.length = 0; notices.length = 0;
  settingsNow = { models: { chat: { provider: 'openrouter', model: OPUS } }, roulette: false, prefs: {} };
});

const stream = (messages, switches = []) => ai.kernelLLMStream(messages, {
  role: 'chat', onToken() {}, onFallback: (f) => switches.push(f),
});
const noticeOf = (f) => f.notice || `${f.from} ${f.reason} → ${f.to}`;
const ledgerRows = () => {
  const f = path.join(ledgerDir, 'llm_calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('a paid OpenRouter model out of credits → the same connection on a free model', () => {
  it('stream: 402 on the paid model is answered by openrouter/free, before any other provider', async () => {
    const switches = [];
    const r = await stream([{ role: 'user', content: 'hello' }], switches);
    expect(r).toMatchObject({ provider: 'openrouter', model: 'openrouter/free', text: 'from-openrouter:openrouter/free' });
    expect(orSeen).toEqual([OPUS, 'openrouter/free']);
    expect(groqSeen).toHaveLength(0);
    expect(switches.map(noticeOf)).toEqual([`openrouter (${OPUS}) out of credits → openrouter free model`]);
  });

  it('stream: a paid model whose own ":free" twin the connection lists gets the twin', async () => {
    settingsNow.models.chat = { provider: 'openrouter', model: NEMOTRON };
    const r = await stream([{ role: 'user', content: 'hello' }]);
    expect(r).toMatchObject({ provider: 'openrouter', model: `${NEMOTRON}:free` });
    expect(orSeen).toEqual([NEMOTRON, `${NEMOTRON}:free`]);
  });

  it('only the paid models rest: OpenRouter stays healthy, and the next turn starts on the free model with one notice', async () => {
    await stream([{ role: 'user', content: 'first' }]);
    const h = ai.getProviderHealth().openrouter;
    expect(h.healthy).toBe(true);
    expect(h.paidResting).toBe(true);

    orSeen.length = 0;
    const switches = [];
    const r = await stream([{ role: 'user', content: 'second' }], switches);
    expect(r).toMatchObject({ provider: 'openrouter', model: 'openrouter/free' });
    expect(orSeen).toEqual(['openrouter/free']);
    expect(switches.map(noticeOf)).toEqual([`openrouter (${OPUS}) out of credits → openrouter free model`]);
  });

  it('non-stream: the same hand-off, and the notice is in words', async () => {
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ provider: 'openrouter', model: 'openrouter/free', text: 'from-openrouter:openrouter/free' });
    expect(orSeen).toEqual([OPUS, 'openrouter/free']);
    expect(groqSeen).toHaveLength(0);
    expect(notices.join('\n')).toContain(`openrouter (${OPUS}) out of credits → openrouter free model`);
    expect(notices.join('\n')).not.toMatch(/can only afford/);
  });

  it('a 402 on the free model as well keeps today\'s rule: OpenRouter rests and the next provider answers', async () => {
    orMode = 'all402';
    const r = await stream([{ role: 'user', content: 'hello' }]);
    expect(orSeen).toEqual([OPUS, 'openrouter/free']);
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
    expect(ai.getProviderHealth().openrouter.healthy).toBe(false);
  });
});

describe('a request too large for the model is retried once with less context', () => {
  it('stream: Groq 413 → the same Groq connection, trimmed under its cap, answers', async () => {
    settingsNow.models.chat = { provider: 'groq', model: 'openai/gpt-oss-120b' };
    const switches = [];
    const r = await stream(bigTurn(), switches);
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
    expect(groqSeen).toHaveLength(2);
    expect(groqSeen[0].requested).toBeGreaterThan(8000);
    expect(groqSeen[1].requested).toBeLessThanOrEqual(8000);
    expect(switches.map(noticeOf)).toEqual(['groq request too large for it → retried with less context']);

    const sent = groqSeen[1].messages;
    // The operator's message is intact and last; the system prompt keeps its
    // head, loses the injected memory, and says it was cut.
    expect(sent[sent.length - 1]).toEqual(QUESTION);
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain(IDENTITY);
    expect(sent[0].content).not.toContain('## MEMORY');
    expect(sent[0].content).toMatch(/Context trimmed/);
    // Older turns kept are the newest ones.
    const kept = sent.slice(1, -1);
    expect(kept.length).toBeLessThan(OLD_TURNS.length);
    if (kept.length) expect(kept[kept.length - 1]).toEqual(OLD_TURNS[OLD_TURNS.length - 1]);
    expect(ai.getProviderHealth().groq.healthy).toBe(true);
  });

  it('non-stream: the same retry, trimming the system prompt', async () => {
    settingsNow.models.chat = { provider: 'groq', model: 'openai/gpt-oss-120b' };
    local.on = false;
    const r = await ai.kernelLLM('What should I ship first tomorrow?', { role: 'chat', system: BIG_SYSTEM, returnMeta: true });
    expect(r).toMatchObject({ provider: 'groq', text: 'from-groq' });
    expect(groqSeen).toHaveLength(2);
    expect(groqSeen[1].messages[0].content).not.toContain('## MEMORY');
    expect(groqSeen[1].messages.at(-1)).toEqual({ role: 'user', content: 'What should I ship first tomorrow?' });
    expect(notices.join('\n')).toContain('groq request too large for it → retried with less context');
  });

  it('too large is the request, not the provider: three failed turns never rest Groq', async () => {
    settingsNow.models.chat = { provider: 'groq', model: 'openai/gpt-oss-120b' };
    groqLimit = 500;     // even the trimmed retry is over this cap
    local.on = false;
    for (let i = 0; i < 3; i++) await stream(bigTurn()).catch(() => {});
    expect(groqSeen).toHaveLength(6);   // each turn: the full request, then one trimmed retry
    expect(ai.getProviderHealth().groq.healthy).toBe(true);
  });

  it('local: the runtime\'s "prompt uses N of a M-token window" is retried trimmed, and Local answers', async () => {
    orMode = 'all402';
    groqLimit = 500;
    const switches = [];
    const r = await stream(bigTurn(), switches);
    expect(r).toMatchObject({ provider: 'local', text: 'from-local' });
    expect(localSeen).toHaveLength(2);
    expect(estimateMessageTokens(localSeen[1])).toBeLessThan(local.window);
    expect(switches.map(noticeOf)).toContain('local request too large for it → retried with less context');
  });
});

describe('when nothing can answer, the reasons are true and the next step is useful', () => {
  it('the live case end to end: notices in order, every rung named, no "unavailable", no raw body', async () => {
    orMode = 'free503';
    groqLimit = 500;
    local.fail = 'exited';
    const switches = [];
    const err = await stream(bigTurn(), switches).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(switches.map(noticeOf)).toEqual([
      `openrouter (${OPUS}) out of credits → openrouter free model`,
      'openrouter provider error → groq',
      'groq request too large for it → retried with less context',
      'groq request too large for it → local',
    ]);
    expect(err.message).toContain(`openrouter (${OPUS}) out of credits, openrouter (openrouter/free) provider error, groq request too large for it, local no chat model running`);
    expect(err.message).not.toMatch(/unavailable/);
    expect(err.message).toMatch(/':free' OpenRouter model .*Settings → Models.*OpenRouter credits/);
    expect(err.message).not.toMatch(/can only afford|\{"error"|org_test|No endpoints available/);
  });

  it('when even the free models are refused, the step is credits, not "pick a free model"', async () => {
    orMode = 'all402';
    groqLimit = 500;
    local.fail = 'exited';
    const err = await stream(bigTurn()).catch((e) => e);
    expect(err.message).toMatch(/openrouter \(openrouter\/free\) out of credits/);
    expect(err.message).toMatch(/Add OpenRouter credits/);
    expect(err.message).not.toMatch(/Pick a ':free'/);
  });

  it('a local failure before dispatch reaches the call log with its real words', async () => {
    orMode = 'all402';
    groqLimit = 500;
    local.fail = 'exited';
    await stream([{ role: 'user', content: 'hello' }]).catch(() => {});
    const row = ledgerRows().reverse().find((x) => x.provider === 'local');
    expect(row).toBeTruthy();
    expect(row.success).toBe(false);
    expect(String(row.error)).toMatch(/llama-server exited during startup/);
  });

  it('llama.cpp\'s "exceeds the available context size" reads as too large, not unavailable', async () => {
    orMode = 'all402';
    groqLimit = 500;
    local.fail = 'llama400';
    const err = await stream(bigTurn()).catch((e) => e);
    expect(err.message).toMatch(/local request too large for it/);
    expect(err.message).not.toMatch(/local unavailable/);
    expect(localSeen).toHaveLength(2);   // tried, then tried trimmed
  });
});
