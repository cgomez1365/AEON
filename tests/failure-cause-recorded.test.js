/**
 * A failed provider call says why: in the call log, the audit line and the
 * fallback notice.
 *
 * Only the OpenAI-compatible transports passed their cause to _trackLLM. A
 * Gemini, Groq or Claude failure wrote `success:false` and nothing else: the
 * 2026-10-05 drive log held 26 failed Gemini rows with no status and no error,
 * every audit line read "FAILED" with code 500 whatever Google answered, and
 * the terminal said "gemini unavailable → groq" for a 400, a 404 and a 500
 * alike.
 *
 * Drives the REAL services/ai.js against a fake Gemini endpoint on 127.0.0.1
 * (the way Settings → Keys registers one) plus a fake custom endpoint as the
 * fallback. The hosted Groq and Claude URLs are answered by a stub: nothing
 * leaves this machine.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-failcause-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-failcause-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'failure-cause-suite-key';
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

// The hosted providers' real hostnames, answered from here. Anything else off
// this machine gets a 503.
const hosted = {};
const hostedCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
  hostedCalls.push(u.hostname);
  const h = hosted[u.hostname];
  if (h) {
    const body = typeof h.body === 'string' ? h.body : JSON.stringify(h.body);
    return Promise.resolve(new Response(body, { status: h.status, headers: h.headers || {} }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
};

// What the fake Gemini answers, and what the fake fallback does.
let gemini = { status: 400, body: {} };
let customStatus = 200;
const fake = express();
fake.use(express.json());
fake.post(/[gG]enerateContent$/, (_req, res) => {
  if (gemini.empty) {
    res.status(200).set('content-type', 'text/event-stream');
    return res.end(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`);
  }
  if (gemini.drops) {
    res.status(200).set('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Half an ans' }] } }] })}\n\n`);
    return setTimeout(() => res.destroy(), 30);
  }
  // Google pretty-prints its error bodies; the indentation is most of a 160-character cap.
  if (gemini.pretty) return res.status(gemini.status).type('json').send(JSON.stringify(gemini.body, null, 2));
  return res.status(gemini.status).json(gemini.body);
});
fake.post('/v1/chat/completions', (req, res) => {
  if (customStatus !== 200) return res.status(customStatus).json({ error: { message: 'custom upstream down' } });
  if (req.body.stream) {
    res.status(200).set('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    return res.end();
  }
  return res.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });
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
let aiWithEnvKey;
const audits = [];
const notices = [];
let settingsChat = { provider: 'gemini', model: 'gemini-3.8-flash' };
let settingsExtra = {};

const deps = () => ({
  supabase: null,
  writeOSAudit: (...a) => audits.push(a),
  TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
  loadSettings: () => ({ models: { chat: settingsChat, ...settingsExtra }, prefs: {} }),
  aeonTerminalStream: { emit: (_t, e) => notices.push(e?.message || '') },
});

beforeAll(async () => {
  const port = await new Promise((r) => { server = fake.listen(0, '127.0.0.1', () => r(server.address().port)); });
  const vault = require(VAULT_PATH);
  await vault.setSecret('gemini-key', 'test-only-not-a-real-key');
  await vault.setSecret('fake-key', 'local-stub-credential');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'gem', provider: 'gemini', base_url: `http://127.0.0.1:${port}/v1beta`, auth_ref: 'gemini-key',
        reachable_from: ['local'], models: ['gemini-3.8-flash'], rpm_limit: 0 },
      { id: 'cus', provider: 'custom', base_url: `http://127.0.0.1:${port}/v1`, auth_ref: 'fake-key',
        reachable_from: ['local'], models: ['fake-model'], rpm_limit: 0 },
    ],
    roles: { chat: { endpoint_id: 'gem', model: 'gemini-3.8-flash' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  const factory = require(AI_PATH);
  ai = factory(deps());
  await ai.envHydrated;
  // A second instance built while a Gemini key is in the environment: the
  // legacy transports (geminiRequest, Gemini vision) read the env key pool
  // when the module is built.
  process.env.GEMINI_API_KEY = 'test-env-gemini-key';
  aiWithEnvKey = factory(deps());
  delete process.env.GEMINI_API_KEY;
  await aiWithEnvKey.envHydrated;
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

beforeEach(() => {
  ai._resetProviderHealth?.();
  aiWithEnvKey._resetProviderHealth?.();
  audits.length = 0;
  notices.length = 0;
  hostedCalls.length = 0;
  for (const k of Object.keys(hosted)) delete hosted[k];
  customStatus = 200;
  settingsChat = { provider: 'gemini', model: 'gemini-3.8-flash' };
  settingsExtra = {};
  try { fs.rmSync(path.join(ledgerDir, 'llm_calls.jsonl'), { force: true }); } catch {}
});

const ledgerRows = () => {
  const f = path.join(ledgerDir, 'llm_calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const failedRow = (provider) => ledgerRows().find((r) => r.provider === provider && r.success === false);
const failedAudit = (provider) => audits.find((a) => a[0] === `LLM_${provider.toUpperCase()}` && /FAILED/.test(a[1]));

const ask = () => ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
const askStream = (fallbacks = []) => ai.kernelLLMStream(
  [{ role: 'user', content: 'hello' }],
  { role: 'chat', onToken: () => {}, onFallback: (f) => fallbacks.push(f) },
);

// Google's own words for each failure.
const CASES = [
  { code: 400, message: 'Invalid JSON payload received. Unknown name "thinkingConfig".', reason: 'unavailable' },
  { code: 404, message: 'models/gemini-3.8-flash is not found for API version v1beta.', reason: 'model not available' },
  { code: 500, message: 'Internal error encountered.', reason: 'provider error' },
];
const bodyOf = (c) => ({ error: { code: c.code, message: c.message, status: 'ERR' } });

describe('Gemini answering the blocking path with an error', () => {
  for (const c of CASES) {
    it(`HTTP ${c.code}: the ledger row and the audit line carry the status and Google's words`, async () => {
      gemini = { status: c.code, body: bodyOf(c) };
      const r = await ask();
      expect(r.provider).toBe('custom'); // it did fall back

      const row = failedRow('gemini');
      expect(row.status).toBe(c.code);
      expect(row.error).toContain(c.message.slice(0, 30));

      const audit = failedAudit('gemini');
      expect(audit[2]).toBe(c.code);
      expect(audit[1]).toContain(`FAILED: Gemini error ${c.code}`);
      expect(audit[1]).toContain(c.message.slice(0, 30));
    });
  }
});

describe('Gemini answering the streaming path with an error', () => {
  for (const c of CASES) {
    it(`HTTP ${c.code}: the ledger row, the audit line and the fallback notice carry the status`, async () => {
      gemini = { status: c.code, body: bodyOf(c) };
      const fallbacks = [];
      const r = await askStream(fallbacks);
      expect(r.provider).toBe('custom');

      const row = failedRow('gemini');
      expect(row.status).toBe(c.code);
      expect(row.error).toContain(c.message.slice(0, 30));
      expect(failedAudit('gemini')[2]).toBe(c.code);

      // The plain phrase stays the reason; the number rides beside it.
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]).toMatchObject({ from: 'gemini', to: 'custom', reason: c.reason, status: c.code });
    });
  }

  it('a rejected key records the 400 Google sent, not the 401 the credential pool is told', async () => {
    gemini = {
      status: 400,
      body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
        details: [{ reason: 'API_KEY_INVALID' }] } },
    };
    const fallbacks = [];
    await askStream(fallbacks);
    expect(failedRow('gemini').status).toBe(400);
    expect(failedAudit('gemini')[2]).toBe(400);
    expect(fallbacks[0]).toMatchObject({ reason: 'key rejected', status: 400 });
  });

  it('an empty answer records why it failed, and no status it never had', async () => {
    gemini = { empty: true };
    const r = await askStream();
    expect(r.provider).toBe('custom');
    const row = failedRow('gemini');
    expect(row.error).toMatch(/empty response/i);
    expect(row.status).toBeUndefined();
    expect(failedAudit('gemini')[2]).toBe(500); // the historic code when no status exists
  });
});

describe('a stream that dies after the first words', () => {
  it('records why it ended, though the operator already has a partial answer', async () => {
    gemini = { drops: true };
    const err = await askStream().catch((e) => e);
    expect(err.partialText).toBe('Half an ans');
    const row = failedRow('gemini');
    expect(row.error).toEqual(expect.any(String));
    expect(row.error.length).toBeGreaterThan(0);
  });
});

describe('a pretty-printed provider body', () => {
  it('is recorded on one line, so the cap holds words and not indentation', async () => {
    const message = 'Request contains an invalid argument: thinking_budget must be between 0 and 24576 for this model.';
    gemini = { status: 400, pretty: true, body: { error: { code: 400, message, status: 'INVALID_ARGUMENT' } } };
    await ask();
    const row = failedRow('gemini');
    expect(row.error).not.toMatch(/\s{2}|\n/);
    expect(row.error).toContain('thinking_budget must be between');
    expect(failedAudit('gemini')[1]).not.toMatch(/\s{2}|\n/);
  });
});

describe('what a failed call never records', () => {
  const LEAKY = 'Request to https://x.test/v1beta/models/m:generateContent?key=AIzaSyA1234567890abcdefghijklmnopqrstu was refused for token sk-abcdefghij1234567890.';
  const CANARY = 'PROMPT-CANARY-7f3a';

  for (const mode of ['blocking', 'streaming']) {
    it(`${mode}: no key, no prompt text, and no more than 160 characters of the provider's words`, async () => {
      gemini = { status: 400, body: { error: { code: 400, message: `${LEAKY} ${'x'.repeat(400)}`, status: 'INVALID_ARGUMENT' } } };
      if (mode === 'blocking') await ai.kernelLLM(CANARY, { role: 'chat' });
      else await ai.kernelLLMStream([{ role: 'user', content: CANARY }], { role: 'chat', onToken: () => {} });

      const row = failedRow('gemini');
      expect(row.error.length).toBeGreaterThan(20);
      expect(row.error.length).toBeLessThanOrEqual(160);
      const everything = JSON.stringify([row, failedAudit('gemini')]);
      expect(everything).not.toMatch(/AIzaSyA12|sk-abcdefghij/);
      expect(everything).not.toContain(CANARY);
    });
  }
});

describe('the terminal notice on the blocking chain', () => {
  it('names the status behind the plain phrase when the next provider fails too', async () => {
    gemini = { status: 500, body: bodyOf(CASES[2]) };
    customStatus = 503;
    await expect(ask()).rejects.toThrow();
    expect(notices.some((n) => /custom provider error \(HTTP 503\) — trying the next provider/.test(n))).toBe(true);
  });
});

describe('the terminal notice when Claude is the role\'s provider', () => {
  it('names the status behind the plain phrase, like every other provider', async () => {
    // A role with no registry connection reaches the Claude branch of the chain.
    settingsExtra = { research: { provider: 'claude', model: 'claude-test' } };
    hosted['api.anthropic.com'] = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    process.env.ANTHROPIC_API_KEY = 'test-only-key';
    try { await ai.kernelLLM('hello', { role: 'research' }).catch(() => {}); } finally { delete process.env.ANTHROPIC_API_KEY; }
    expect(notices.some((n) => /↪ claude key rejected \(HTTP 401\) — trying the next provider/.test(n))).toBe(true);
  });
});

describe('the hosted transports', () => {
  const KEYS = { groq: 'GROQ_API_KEY', claude: 'ANTHROPIC_API_KEY' };
  const withEnv = async (name, fn) => {
    process.env[name] = 'test-only-key';
    try { return await fn(); } finally { delete process.env[name]; }
  };

  it('Groq: groqRequest records the status and the provider words', async () => {
    hosted['api.groq.com'] = { status: 503, body: { error: { message: 'Groq is over capacity' } } };
    await withEnv(KEYS.groq, () => expect(ai.groqRequest('hello', 'openai/gpt-oss-120b')).rejects.toThrow(/Groq API error 503/));
    expect(failedRow('groq')).toMatchObject({ status: 503 });
    expect(failedRow('groq').error).toContain('Groq is over capacity');
    expect(failedAudit('groq')[2]).toBe(503);
    expect(failedAudit('groq')[1]).toContain('FAILED: Groq API error 503');
  });

  it('Groq: a key the provider echoes back is not kept', async () => {
    hosted['api.groq.com'] = { status: 401, body: { error: { message: 'Invalid API Key: gsk_abcdefghijklmnop1234567890 is not recognised' } } };
    await withEnv(KEYS.groq, () => expect(ai.groqRequest('hello', 'openai/gpt-oss-120b')).rejects.toThrow(/Groq API error 401/));
    const row = failedRow('groq');
    expect(row.status).toBe(401);
    expect(row.error).toContain('Invalid API Key');
    expect(JSON.stringify([row, failedAudit('groq')])).not.toContain('gsk_abcdefghij');
  });

  it('Claude: claudeRequest records the status and the provider words', async () => {
    hosted['api.anthropic.com'] = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
    await expect(ai.claudeRequest('hello', 'claude-test', 'test-only-key')).rejects.toThrow(/Claude API error 529/);
    expect(failedRow('claude')).toMatchObject({ status: 529 });
    expect(failedRow('claude').error).toContain('Overloaded');
    expect(failedAudit('claude')[2]).toBe(529);
  });

  it('Claude streaming: a refused request records the status and the words', async () => {
    hosted['api.anthropic.com'] = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    const r = await withEnv(KEYS.claude, () => ai.kernelLLMStream(
      [{ role: 'user', content: 'hello' }], { role: 'chat', provider: 'claude', model: 'claude-test', onToken: () => {} },
    ).catch((e) => e));
    expect(r).toBeDefined();
    expect(failedRow('claude')).toMatchObject({ status: 401 });
    expect(failedRow('claude').error).toContain('invalid x-api-key');
    expect(failedAudit('claude')[2]).toBe(401);
  });

  it('Claude streaming: an error event mid-stream records its words', async () => {
    const sse = `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded mid-stream' } })}\n\n`;
    hosted['api.anthropic.com'] = { status: 200, body: sse, headers: { 'content-type': 'text/event-stream' } };
    await withEnv(KEYS.claude, () => ai.kernelLLMStream(
      [{ role: 'user', content: 'hello' }], { role: 'chat', provider: 'claude', model: 'claude-test', onToken: () => {} },
    ).catch((e) => e));
    expect(failedRow('claude').error).toContain('Overloaded mid-stream');
  });

  it('Claude streaming: an empty answer records why', async () => {
    hosted['api.anthropic.com'] = {
      status: 200, body: `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`, headers: { 'content-type': 'text/event-stream' },
    };
    await withEnv(KEYS.claude, () => ai.kernelLLMStream(
      [{ role: 'user', content: 'hello' }], { role: 'chat', provider: 'claude', model: 'claude-test', onToken: () => {} },
    ).catch((e) => e));
    const row = failedRow('claude');
    expect(row.error).toMatch(/empty response/i);
    expect(row.status).toBeUndefined();
  });

  it('Gemini through the env key pool: geminiRequest records the status and the words', async () => {
    hosted['generativelanguage.googleapis.com'] = { status: 400, body: { error: { code: 400, message: 'Unknown name "foo" at generation_config' } } };
    await aiWithEnvKey.geminiRequest('hello', 'gemini-test').catch(() => {});
    const row = failedRow('gemini');
    expect(row.status).toBe(400);
    expect(row.error).toContain('Unknown name');
  });

  const IMAGE = 'data:image/png;base64,AAAA';
  it('vision on Groq records the status and the words', async () => {
    hosted['api.groq.com'] = { status: 400, body: { error: { message: 'image too small' } } };
    await withEnv(KEYS.groq, () => expect(ai.kernelVision(IMAGE, 'what is this', { provider: 'groq', model: 'vision-test' })).rejects.toThrow(/vision error 400/));
    expect(failedRow('groq')).toMatchObject({ status: 400 });
    expect(failedRow('groq').error).toContain('image too small');
  });

  it('vision on Gemini records the status and the words', async () => {
    hosted['generativelanguage.googleapis.com'] = { status: 403, body: { error: { message: 'vision not enabled for this project' } } };
    await expect(aiWithEnvKey.kernelVision(IMAGE, 'what is this', { provider: 'gemini', model: 'vision-test' })).rejects.toThrow(/vision error 403/);
    expect(failedRow('gemini')).toMatchObject({ status: 403 });
    expect(failedRow('gemini').error).toContain('vision not enabled');
  });

  it('vision on Claude records the status and the words', async () => {
    hosted['api.anthropic.com'] = { status: 413, body: { error: { message: 'image exceeds 5 MB' } } };
    await withEnv(KEYS.claude, () => expect(ai.kernelVision(IMAGE, 'what is this', { provider: 'claude', model: 'vision-test' })).rejects.toThrow(/vision error 413/));
    expect(failedRow('claude')).toMatchObject({ status: 413 });
    expect(failedRow('claude').error).toContain('image exceeds');
  });
});
