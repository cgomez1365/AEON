/**
 * Roulette and fallback follow what Settings declares (CEO, 2026-09-28):
 * "If settings declares it, that is what is going to be used", and a
 * provider out of credits must "seamlessly go to the next one" with a
 * notice, not an error in the chat.
 *
 * Before: roulette knew three hardcoded providers (groq/gemini/openrouter),
 * the streaming path discarded the assigned model when roulette was on, a
 * connection on any other provider never served as a fallback, and a switch
 * printed the provider's raw 402 body. Drives the REAL services/ai.js against
 * two fake endpoints registered the way Settings registers them.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-roulette-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-roulette-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'roulette-suite-key';
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

// Two endpoints; each answers in the mode the test sets for it.
const modes = { primary: 'ok', backup: 'ok' };
const hits = { primary: 0, backup: 0 };
const makeFake = (name) => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    hits[name]++;
    const m = modes[name];
    if (m === '402') return res.status(402).json({ error: { code: 402, message: 'Insufficient credits. Add more using https://example/credits' } });
    if (m === '429') return res.status(429).json({ error: { code: 429, message: 'Rate limit exceeded' } });
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

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

const servers = [];
let ai;
let keyPool;
let roulette = true;
let declaredChat = { provider: 'custom', model: 'primary-model' };
const notices = [];

beforeAll(async () => {
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
  const pPort = await listen(makeFake('primary'));
  const bPort = await listen(makeFake('backup'));
  const vault = require(VAULT_PATH);
  await vault.setSecret('primary-key', 'sk-primary-stub');
  await vault.setSecret('backup-key', 'sk-backup-stub');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'primary', provider: 'custom', base_url: `http://127.0.0.1:${pPort}/v1`, auth_ref: 'primary-key',
        reachable_from: ['local'], models: ['primary-model'], rpm_limit: 0 },
      // Not groq/gemini/openrouter: the old roulette could never reach it.
      { id: 'backup', provider: 'openai', base_url: `http://127.0.0.1:${bPort}/v1`, auth_ref: 'backup-key',
        reachable_from: ['local'], models: ['backup-model'], rpm_limit: 0 },
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
    loadSettings: () => ({ models: { chat: declaredChat }, roulette, prefs: {} }),
    aeonTerminalStream: { emit: (_e, ev) => notices.push(ev.message) },
  });
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => {
  keyPool._reset(); ai._resetProviderHealth?.();
  modes.primary = 'ok'; modes.backup = 'ok'; hits.primary = 0; hits.backup = 0;
  notices.length = 0; roulette = true;
  declaredChat = { provider: 'custom', model: 'primary-model' };
});

const stream = (extra = {}) => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken() {}, ...extra });

describe('roulette keeps the assignment Settings made', () => {
  it('streaming with roulette on: the assigned connection answers first, every time', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await stream();
      expect(r.provider).toBe('custom');
    }
    expect(hits).toEqual({ primary: 6, backup: 0 });
  });
});

describe('a provider out of credits hands off with a notice, not an error', () => {
  it('stream: 402 on the assigned connection → the other declared connection answers', async () => {
    modes.primary = '402';
    const switches = [];
    const r = await stream({ onFallback: (f) => switches.push(f) });
    expect(r.text).toBe('from-backup');
    expect(r.provider).toBe('openai');
    expect(switches).toEqual([expect.objectContaining({ from: 'custom', to: 'openai', reason: 'out of credits' })]);
  });

  it('non-stream: same hand-off, and the notice is in words', async () => {
    modes.primary = '402';
    roulette = false;
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ text: 'from-backup', provider: 'openai' });
    expect(notices.join('\n')).toMatch(/custom out of credits/);
    expect(notices.join('\n')).not.toMatch(/example\/credits/); // no raw body
  });

  it('the next turn goes straight to the provider that can answer', async () => {
    modes.primary = '402';
    await stream();
    hits.primary = 0; hits.backup = 0;
    const r = await stream();
    expect(r.provider).toBe('openai');
    expect(hits.primary).toBe(0);
  });

  it('only when every declared provider fails is there an error — one sentence, in words', async () => {
    modes.primary = '402';
    modes.backup = '429';
    const err = await stream().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/custom out of credits/);
    expect(err.message).toMatch(/openai is rate-limited/);
    expect(err.message).not.toMatch(/example\/credits|\{"error"/);
  });
});

describe('Settings, not the registry, decides which provider a role uses', () => {
  // The registry's own role map still says chat → the custom endpoint.
  it('stream: chat declared as openai in Settings is served by openai', async () => {
    declaredChat = { provider: 'openai', model: 'backup-model' };
    const r = await stream();
    expect(r).toMatchObject({ provider: 'openai', model: 'backup-model', text: 'from-backup' });
    expect(hits.primary).toBe(0);
  });

  it('non-stream: the same', async () => {
    declaredChat = { provider: 'openai', model: 'backup-model' };
    roulette = false;
    const r = await ai.kernelLLM('hello', { role: 'chat', returnMeta: true });
    expect(r).toMatchObject({ provider: 'openai', text: 'from-backup' });
    expect(hits.primary).toBe(0);
  });
});
