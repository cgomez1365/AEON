/**
 * Gemini 3.x answers, read the way Google sends them.
 *
 * The CEO's key answered gemini-2.5-flash in ~2 s and failed gemini-3.8-flash
 * (and the gemini-flash-latest alias) with "gemini provider error -> groq",
 * 0 tokens and no reason in the call log. A 3.x model thinks before it
 * answers; the thinking counts against maxOutputTokens, and a thought is a
 * `thought: true` part beside the text parts. The Gemini transports read only
 * parts[0] (non-streaming) or every part's text (streaming), and turned every
 * answer without text into "The model returned an empty response ... check the
 * model name" — the same hole the OpenRouter transport closed (see
 * openrouter-empty-responses.test.js).
 *
 * Drives the REAL services/ai.js against a fake Gemini endpoint on 127.0.0.1
 * that answers in whichever of those shapes the test asks for. Nothing leaves
 * this machine: any other fetch is answered by a stub.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini3-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gemini3-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'gemini3-suite-key';
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

// ── The fake endpoint: answers in the shape `mode` names ──
let mode = 'ok';
let hits = 0;
const sse = (res, events) => {
  res.status(200).set('content-type', 'text/event-stream');
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const cand = (parts, finishReason, extra = {}) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), index: 0 }],
  ...extra,
});
const USAGE_SPENT = { promptTokenCount: 120, thoughtsTokenCount: 4090, totalTokenCount: 4210 };
const GOOGLE_503 = { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } };

const fake = express();
fake.use(express.json());
fake.post(/[gG]enerateContent$/, (req, res) => {
  hits++;
  const streaming = /streamGenerateContent$/.test(req.path);
  const reply = (events) => (streaming ? sse(res, events) : res.json(events[events.length - 1]));
  if (mode === 'ok') return reply([cand([{ text: 'answered' }], 'STOP', { usageMetadata: { totalTokenCount: 9 } })]);
  // Thinking summaries ride beside the answer as `thought: true` parts.
  if (mode === 'thoughtThenText') {
    return reply([
      cand([{ text: 'Let me think about this carefully.', thought: true }]),
      cand([{ text: 'answered' }], 'STOP', { usageMetadata: { totalTokenCount: 9 } }),
    ]);
  }
  // One reply, thought first, answer second (what a non-streaming call returns).
  if (mode === 'thoughtPartFirst') {
    return reply([cand([{ text: 'Let me think about this carefully.', thought: true }, { text: 'answered' }], 'STOP')]);
  }
  // The answer split over several parts.
  if (mode === 'splitParts') {
    return reply([cand([{ text: 'answer' }, { text: 'ed' }], 'STOP')]);
  }
  // The whole output budget spent thinking: finishReason MAX_TOKENS, no text.
  if (mode === 'thinkingSpent') {
    return reply([{ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }], usageMetadata: USAGE_SPENT }]);
  }
  // The prompt refused before any candidate exists.
  if (mode === 'blocked') {
    return reply([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 120, totalTokenCount: 120 } }]);
  }
  // A candidate stopped by a filter with no text.
  if (mode === 'safety') {
    return reply([{ candidates: [{ content: { role: 'model' }, finishReason: 'SAFETY', index: 0 }] }]);
  }
  // A failure that arrives as an SSE event under HTTP 200.
  if (mode === 'errorInStream') {
    return streaming ? sse(res, [GOOGLE_503]) : res.status(503).json(GOOGLE_503);
  }
  if (mode === 'http503') return res.status(503).json(GOOGLE_503);
  if (mode === 'trulyEmpty') return reply([cand([{ text: '' }], 'STOP')]);
  res.status(500).end();
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
let keyPool;
const audits = [];

beforeAll(async () => {
  const port = await new Promise((r) => { server = fake.listen(0, '127.0.0.1', () => r(server.address().port)); });
  const vault = require(VAULT_PATH);
  await vault.setSecret('gemini-key', 'test-only-not-a-real-key');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'gem', provider: 'gemini', base_url: `http://127.0.0.1:${port}/v1beta`, auth_ref: 'gemini-key',
        reachable_from: ['local'], models: ['gemini-3.8-flash'], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'gem', model: 'gemini-3.8-flash' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: (...a) => audits.push(a),
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => ({ models: { chat: { provider: 'gemini', model: 'gemini-3.8-flash' } }, prefs: {} }),
    aeonTerminalStream: null,
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

beforeEach(() => { keyPool._reset(); hits = 0; mode = 'ok'; audits.length = 0; ai._resetProviderHealth?.(); });

const stream = (onToken = () => {}) => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken });
const block = (err) => `${err?.message || ''} ${JSON.stringify(err?.attempts || [])}`;
const ledgerRows = () => {
  const f = path.join(ledgerDir, 'llm_calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('baseline: a plain Gemini answer', () => {
  it('streams and returns text', async () => {
    const r = await stream();
    expect(r.text).toBe('answered');
  });
  it('non-streaming returns text', async () => {
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('answered');
  });
});

describe('a thinking model\'s thought is not the answer', () => {
  it('streaming: a `thought: true` part is held back', async () => {
    mode = 'thoughtThenText';
    const seen = [];
    const r = await stream((t) => seen.push(t));
    expect(r.text).toBe('answered');
    expect(seen.join('')).not.toMatch(/Let me think/);
  });

  it('non-streaming: the answer is the text part after the thought, not parts[0]', async () => {
    mode = 'thoughtPartFirst';
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('answered');
  });

  it('non-streaming: an answer split over several parts is returned whole', async () => {
    mode = 'splitParts';
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('answered');
  });
});

describe('an answer that never came says why', () => {
  it('streaming: a budget spent thinking (MAX_TOKENS, no text) names the budget', async () => {
    mode = 'thinkingSpent';
    const err = await stream().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(block(err)).toMatch(/budget|max_tokens/i);
    expect(block(err)).not.toMatch(/empty response/i);
  });

  it('non-streaming: the same turn is an error, never an empty string returned as success', async () => {
    mode = 'thinkingSpent';
    const out = await ai.kernelLLM('hello', { role: 'chat' }).then((t) => ({ t }), (e) => ({ e }));
    expect(out.e).toBeInstanceOf(Error);
    expect(block(out.e)).toMatch(/budget|max_tokens/i);
  });

  it('a prompt Google refused names the block reason', async () => {
    mode = 'blocked';
    const err = await stream().catch((e) => e);
    expect(block(err)).toMatch(/PROHIBITED_CONTENT|blocked/i);
    expect(block(err)).not.toMatch(/empty response/i);
  });

  it('a candidate stopped by a filter names the finish reason', async () => {
    mode = 'safety';
    const err = await stream().catch((e) => e);
    expect(block(err)).toMatch(/SAFETY/);
    expect(block(err)).not.toMatch(/empty response/i);
  });

  it('a genuinely empty answer is still reported as empty', async () => {
    mode = 'trulyEmpty';
    const err = await stream().catch((e) => e);
    expect(block(err)).toMatch(/empty/i);
  });
});

describe('a provider failure is reported as that failure', () => {
  it('streaming: an error event under HTTP 200 is the 503, not "empty response"', async () => {
    mode = 'errorInStream';
    const err = await stream().catch((e) => e);
    expect(block(err)).toMatch(/503|overloaded/i);
    expect(block(err)).not.toMatch(/empty response/i);
  });

  it('the call log records the status and the reason of an HTTP 503 (streaming)', async () => {
    mode = 'http503';
    await stream().catch(() => {});
    const row = ledgerRows().reverse().find((r) => r.success === false);
    expect(row).toBeTruthy();
    expect(row.status).toBe(503);
    expect(String(row.error)).toMatch(/overloaded/i);
    expect(String(row.error)).not.toMatch(/test-only-not-a-real-key/);
  });

  it('the call log records the status and the reason of an HTTP 503 (non-streaming)', async () => {
    mode = 'http503';
    await ai.kernelLLM('hello', { role: 'chat' }).catch(() => {});
    const row = ledgerRows().reverse().find((r) => r.success === false);
    expect(row).toBeTruthy();
    expect(row.status).toBe(503);
    expect(String(row.error)).toMatch(/overloaded/i);
  });

  it('the audit line of the failed call carries the real status, not a blanket 500', async () => {
    mode = 'http503';
    await stream().catch(() => {});
    const failed = audits.find((a) => /FAILED/.test(String(a[1])));
    expect(failed).toBeTruthy();
    expect(failed[2]).toBe(503);
  });
});
