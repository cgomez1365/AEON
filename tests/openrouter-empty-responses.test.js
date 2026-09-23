/**
 * "The model returned an empty response" — what it was hiding.
 *
 * Found in the CEO's blind test on a 2017 MacBook Air (2026-09-23): 3 of 4
 * terminal turns read "openrouter unavailable — falling back to groq
 * (openrouter: The model returned an empty response. If this is a custom
 * endpoint, check the model name ...)", and the fourth was cut off at
 * max_tokens. OpenRouter's own docs (read 2026-09-23) name the two causes:
 *
 *   1. Provider failures arrive INSIDE an HTTP 200 body — `{"error":{"code":429,
 *      ...}}` with no choices, or an SSE chunk with finish_reason "error" and a
 *      top-level `error`. services/ai.js never read `error`, found no text, and
 *      reported "empty" with a wrong remedy; a 429 hidden this way also never
 *      reached the cooldown or the key rotation.
 *   2. Reasoning counts against max_tokens. Free models are capped at 1024; a
 *      reasoning model can spend all of it thinking and return empty content
 *      with finish_reason "length". OpenRouter sends the thinking as `reasoning`
 *      (and `reasoning_details` when streaming); AEON read only
 *      `reasoning_content`.
 *
 * Drives the REAL services/ai.js against a fake OpenAI-compatible endpoint
 * that answers in whichever of those shapes the test asks for.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-empty-resp-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-empty-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'empty-response-suite-key';
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

// ── The fake endpoint: answers in the shape `mode` names ──
let mode = 'ok';
let hits = 0;
const sse = (res, events) => {
  res.status(200).set('content-type', 'text/event-stream');
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end();
};
const fake = express();
fake.use(express.json());
fake.post('/v1/chat/completions', (req, res) => {
  hits++;
  const stream = !!req.body.stream;
  if (mode === 'ok') {
    return stream
      ? sse(res, [{ choices: [{ delta: { content: 'answ' } }] }, { choices: [{ delta: { content: 'ered' }, finish_reason: 'stop' }] }, '[DONE]'])
      : res.json({ choices: [{ message: { content: 'answered' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } });
  }
  if (mode === 'body429') {
    const error = { code: 429, message: 'Rate limit exceeded: free-models-per-min.', metadata: {} };
    return stream
      ? sse(res, [{ error, choices: [{ delta: { content: '' }, finish_reason: 'error' }] }, '[DONE]'])
      : res.status(200).json({ error });
  }
  if (mode === 'reasonOnlyStop') {
    return stream
      ? sse(res, [{ choices: [{ delta: { reasoning: 'the reasoned ' } }] }, { choices: [{ delta: { reasoning: 'answer' }, finish_reason: 'stop' }] }, '[DONE]'])
      : res.json({ choices: [{ message: { content: null, reasoning: 'the reasoned answer' }, finish_reason: 'stop' }] });
  }
  if (mode === 'reasonDetails') {
    return sse(res, [{ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'detailed answer' }] }, finish_reason: 'stop' }] }, '[DONE]']);
  }
  if (mode === 'reasonExhausted') {
    return stream
      ? sse(res, [{ choices: [{ delta: { reasoning: 'Let me think about this carefully. First' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]'])
      : res.json({ choices: [{ message: { content: '', reasoning: 'Let me think about this carefully. First' }, finish_reason: 'length' }] });
  }
  if (mode === 'trulyEmpty') {
    return stream
      ? sse(res, [{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
      : res.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  }
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
  const port = await new Promise((resolve) => { server = fake.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  const vault = require(VAULT_PATH);
  await vault.setSecret('fake-key', 'sk-local-stub');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [{
      id: 'fake', provider: 'custom', base_url: `http://127.0.0.1:${port}/v1`,
      auth_ref: 'fake-key', reachable_from: ['local'], models: ['fake-model'], rpm_limit: 0,
    }],
    roles: { chat: { endpoint_id: 'fake', model: 'fake-model' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: (...a) => audits.push(a),
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => ({ models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} }),
    aeonTerminalStream: null,
  });
});

afterAll(() => {
  try { server.close(); } catch {}
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => { keyPool._reset(); hits = 0; mode = 'ok'; ai._resetProviderHealth?.(); });

const stream = (onToken = () => {}) => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken });
const ledgerRows = () => {
  const f = path.join(ledgerDir, 'llm_calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('a provider error inside an HTTP 200 body is reported as that error', () => {
  it('non-streaming: names the 429 instead of "empty response"', async () => {
    mode = 'body429';
    const err = await ai.kernelLLM('hello', { role: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/429|rate/i);
    expect(err.message).not.toMatch(/empty response/i);
  });

  it('streaming: an error chunk ends the stream as that error', async () => {
    mode = 'body429';
    const err = await stream().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const detail = `${err.message} ${JSON.stringify(err.attempts || [])}`;
    expect(detail).toMatch(/429|rate limit/i);
    expect(detail).not.toMatch(/empty response/i);
  });

  it('the hidden 429 now reaches the cooldown, like a real 429 status does', async () => {
    mode = 'body429';
    await stream().catch(() => {});
    const h = ai.getProviderHealth();
    const custom = (h.providers || h).custom || Object.values(h.providers || h).find((x) => x && x.provider === 'custom');
    expect(custom && (custom.blockedUntil > Date.now() || custom.cooldown || custom.healthy === false)).toBeTruthy();
  });

  it('the call log records why it failed, not just that it failed', async () => {
    mode = 'body429';
    await stream().catch(() => {});
    const row = ledgerRows().reverse().find((r) => r.success === false);
    expect(row).toBeTruthy();
    expect(row.status).toBe(429);
    expect(String(row.error)).toMatch(/rate limit/i);
    expect(String(row.error)).not.toMatch(/sk-local-stub/);
  });
});

describe('reasoning models', () => {
  it('non-streaming: OpenRouter\'s `reasoning` field is read when content is null and the model finished', async () => {
    mode = 'reasonOnlyStop';
    expect(await ai.kernelLLM('hello', { role: 'chat' })).toBe('the reasoned answer');
  });

  it('streaming: `delta.reasoning` is read', async () => {
    mode = 'reasonOnlyStop';
    const r = await stream();
    expect(r.text).toBe('the reasoned answer');
  });

  it('streaming: `delta.reasoning_details` is read', async () => {
    mode = 'reasonDetails';
    const r = await stream();
    expect(r.text).toBe('detailed answer');
  });

  it('a budget spent entirely on thinking fails with that reason — its half-finished thinking is never shown as the answer', async () => {
    mode = 'reasonExhausted';
    const seen = [];
    const err = await stream((t) => seen.push(t)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const detail = `${err.message} ${JSON.stringify(err.attempts || [])}`;
    expect(detail).toMatch(/budget|max_tokens|length/i);
    expect(detail).not.toMatch(/empty response/i);
    expect(seen.join('')).not.toMatch(/Let me think/);

    const err2 = await ai.kernelLLM('hello', { role: 'chat' }).catch((e) => e);
    expect(`${err2.message} ${JSON.stringify(err2.attempts || [])}`).toMatch(/budget|max_tokens|length/i);
  });

  it('a genuinely empty answer is still reported as empty', async () => {
    mode = 'trulyEmpty';
    const err = await stream().catch((e) => e);
    expect(`${err.message} ${JSON.stringify(err.attempts || [])}`).toMatch(/empty/i);
  });
});

describe('a provider that keeps failing is rested', () => {
  it('three failures in a row put it in cooldown, even without a 429', async () => {
    mode = 'trulyEmpty';
    for (let i = 0; i < 3; i++) await stream().catch(() => {});
    const h = ai.getProviderHealth();
    const custom = (h.providers || h).custom;
    expect(custom && (custom.blockedUntil > Date.now() || custom.healthy === false)).toBeTruthy();
  });

  it('a success resets the count', async () => {
    mode = 'trulyEmpty';
    await stream().catch(() => {});
    await stream().catch(() => {});
    mode = 'ok';
    expect((await stream()).text).toBe('answered');
    mode = 'trulyEmpty';
    await stream().catch(() => {});
    const h = ai.getProviderHealth();
    const custom = (h.providers || h).custom;
    expect(!custom || !(custom.blockedUntil > Date.now())).toBeTruthy();
  });
});

describe('the non-streaming path keeps the registry provider\'s failure', () => {
  it('when nothing else can serve, the error names the registry provider\'s real cause', async () => {
    // Before: "No local model is installed and no cloud provider is configured.
    // Install a local model in Cookbook, or add a provider key." — false: a
    // provider IS configured, it is rate-limited for a minute.
    mode = 'body429';
    const err = await ai.kernelLLM('hello', { role: 'chat' }).catch((e) => e);
    expect(err.message).toMatch(/429|rate/i);
    expect(err.message).not.toMatch(/no cloud provider is configured|check API keys in Settings/i);
    expect(err.message).toMatch(/could not serve either: \S/);
  });

  it('a throttled sole provider says "none configured", not a dangling "either: "', () => {
    // The || bound to the whole (never-empty) string, so with nothing else in
    // the chain the message ended on "either: " (agent C2, 2026-09-23).
    const err = ai._chainExhaustedError([{ provider: 'custom', status: 429, configured: true }], null);
    expect(err.rateLimited).toBe(true);
    expect(err.message).toMatch(/could not serve either: none configured$/);
  });
});

describe('what the operator sees about providers is true (reported by agent C3)', () => {
  it('a provider configured in the registry is listed before its first failure', () => {
    const h = ai.getProviderHealth();
    expect(h.custom).toBeTruthy();
    expect(h.custom.configured).toBe(true);
  });

  it('a registry call is recorded under its provider, the same name the streaming path uses', async () => {
    mode = 'ok';
    await ai.kernelLLM('hello', { role: 'chat' });
    const row = ledgerRows().reverse().find((r) => r.success === true);
    expect(row.provider).toBe('custom');
  });

  it('the audit line of a failed call carries its real status, not a blanket 500', async () => {
    mode = 'body429';
    audits.length = 0;
    await stream().catch(() => {});
    const failed = audits.find((a) => /FAILED/.test(String(a[1])));
    expect(failed).toBeTruthy();
    expect(failed[2]).toBe(429);
  });
});
