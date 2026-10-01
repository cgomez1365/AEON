/**
 * Settings → Models → Local only (audit A072).
 *
 * README calls local models "fully private", but a role kept on Local handed
 * its prompt to every configured cloud provider when Local failed, roulette
 * shuffled them in, and there was no switch to stop it. settings.local_only is
 * that switch: with it on, nothing services/ai.js sends goes to a cloud model —
 * the fallback list holds only local candidates and a role set to a cloud
 * provider is refused with the reason. Off by default; the failover the
 * operator relies on (tests/roulette-settings-authority.test.js) is unchanged.
 *
 * Drives the REAL services/ai.js. "Local" here is a custom connection on
 * 127.0.0.1; "cloud" is an `openai` connection (a named vendor is cloud
 * whatever address it carries) and an env-keyed Groq. No request leaves this
 * machine: fetch to any non-loopback host is answered by a stub and recorded.
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

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-local-only-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-local-only-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'local-only-suite-key';
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

// Any request to a host that is not this machine is stubbed and recorded.
const realFetch = globalThis.fetch;
const offMachine = [];
globalThis.fetch = (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
  offMachine.push(u.hostname);
  return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
};

const modes = { local: 'ok', cloud: 'ok' };
const hits = { local: 0, cloud: 0 };
const makeFake = (name) => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    hits[name]++;
    if (modes[name] === '402') return res.status(402).json({ error: { code: 402, message: 'Insufficient credits' } });
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
let settings;

beforeAll(async () => {
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
  const lPort = await listen(makeFake('local'));
  const cPort = await listen(makeFake('cloud'));
  const vault = require(VAULT_PATH);
  await vault.setSecret('local-key', 'sk-local-stub');
  await vault.setSecret('cloud-key', 'sk-cloud-stub');
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'lan', provider: 'custom', base_url: `http://127.0.0.1:${lPort}/v1`, auth_ref: 'local-key',
        reachable_from: ['local'], models: ['local-model'], rpm_limit: 0 },
      { id: 'vendor', provider: 'openai', base_url: `http://127.0.0.1:${cPort}/v1`, auth_ref: 'cloud-key',
        reachable_from: ['local'], models: ['cloud-model'], rpm_limit: 0 },
      // A custom connection at a public address is a cloud model too. Never
      // reached: the fetch stub answers anything off this machine.
      { id: 'remote', provider: 'custom', base_url: 'https://models.example.net/v1', auth_ref: 'cloud-key',
        reachable_from: ['local', 'cloud'], models: ['remote-model'], rpm_limit: 0 },
    ],
    // The registry's own map points chat at the cloud vendor: the auto-pick.
    roles: { chat: { endpoint_id: 'vendor', model: 'cloud-model' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => settings,
    aeonTerminalStream: { emit: () => {} },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  // Includes what ai.js hydrated from this file's temp vault (OPENAI_API_KEY).
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => {
  keyPool._reset(); ai._resetProviderHealth?.();
  modes.local = 'ok'; modes.cloud = 'ok'; hits.local = 0; hits.cloud = 0;
  offMachine.length = 0;
  delete process.env.GROQ_API_KEY;
  settings = { models: { chat: { provider: 'custom', model: 'local-model' } }, roulette: false, local_only: true, prefs: {} };
});

const stream = (extra = {}) => ai.kernelLLMStream([{ role: 'user', content: 'private passage' }], { role: 'chat', onToken() {}, ...extra });
const ask = (extra = {}) => ai.kernelLLM('private passage', { role: 'chat', returnMeta: true, ...extra });

describe('off (the default): failover is what it was', () => {
  it('a local connection out of credits hands the prompt to the cloud vendor', async () => {
    settings.local_only = false;
    modes.local = '402';
    const r = await stream();
    expect(r).toMatchObject({ provider: 'openai', text: 'from-cloud' });
  });

  it('an absent key is not "off": local_only must be exactly true to restrict', async () => {
    delete settings.local_only;
    modes.local = '402';
    const r = await ask();
    expect(r).toMatchObject({ provider: 'openai', text: 'from-cloud' });
  });
});

describe('on: a role on a local model never fails over to the cloud', () => {
  it('stream: the local connection answers', async () => {
    const r = await stream();
    expect(r).toMatchObject({ provider: 'custom', text: 'from-local' });
    expect(hits.cloud).toBe(0);
  });

  it('stream: local out of credits is an error, not a cloud answer', async () => {
    modes.local = '402';
    const err = await stream().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Local only is on/);
    expect(err.message).not.toMatch(/Add a key/);
    expect(hits.cloud).toBe(0);
  });

  it('non-stream: the same', async () => {
    modes.local = '402';
    const err = await ask().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(hits.cloud).toBe(0);
  });

  it('roulette shuffles only local candidates', async () => {
    settings.roulette = true;
    modes.local = '402';
    for (let i = 0; i < 6; i++) {
      keyPool._reset(); ai._resetProviderHealth?.();
      await stream().catch(() => {});
    }
    expect(hits.cloud).toBe(0);
  });

  it('an env-keyed cloud provider (Groq) is never tried, and nothing leaves the machine', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_never_sent_0000';
    modes.local = '402';
    modes.cloud = '402';                     // so the chain would reach Groq
    await stream().catch(() => {});
    await ask().catch(() => {});
    expect(offMachine).toEqual([]);
  });
});

describe('on: a role or caller naming a cloud provider is refused, in words', () => {
  it('stream: chat set to a cloud vendor', async () => {
    settings.models.chat = { provider: 'openai', model: 'cloud-model' };
    const err = await stream().catch((e) => e);
    expect(err.message).toMatch(/Local only is on .*The chat role is set to openai/);
    expect(err.localOnly).toBe(true);
    expect(err.noProviderAvailable).toBe(true);
    expect(hits).toEqual({ local: 0, cloud: 0 });
  });

  it('non-stream: the same', async () => {
    settings.models.chat = { provider: 'openai', model: 'cloud-model' };
    const err = await ask().catch((e) => e);
    expect(err.message).toMatch(/Local only is on .*The chat role is set to openai/);
    expect(hits.cloud).toBe(0);
  });

  it('a custom connection at a public address is judged by its address, and refused', async () => {
    settings.models.chat = { provider: 'custom', model: 'remote-model' };
    for (const call of [stream, ask]) {
      const err = await call().catch((e) => e);
      expect(err.message).toMatch(/Local only is on .*The chat role is set to custom/);
    }
    expect(offMachine).toEqual([]);
    expect(hits.cloud).toBe(0);
  });

  it('a caller that names a cloud provider (a Council seat) is refused too', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_never_sent_0000';
    const err = await ask({ provider: 'groq', model: 'openai/gpt-oss-120b' }).catch((e) => e);
    expect(err.message).toMatch(/This request asked for groq/);
    expect(offMachine).toEqual([]);
  });

  it('nothing declared: the registry auto-pick (a cloud vendor) is dropped; a local connection answers', async () => {
    settings.models = {};
    const r = await stream();
    expect(r).toMatchObject({ provider: 'custom', text: 'from-local' });
    expect(hits.cloud).toBe(0);
  });

  it('Local declared, nothing local can answer: says so, and names no cloud provider as the remedy', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_never_sent_0000';
    settings.models.chat = { provider: 'local', model: 'some-gguf' };
    modes.local = '402';
    await ask().catch(() => {});            // the local connection is now resting
    for (const call of [ask, stream]) {
      const err = await call().catch((e) => e);
      expect(err.message).toMatch(/Local only is on, and no local model is installed/);
      expect(err.message).not.toMatch(/groq/);
    }
    expect(offMachine).toEqual([]);
    expect(hits.cloud).toBe(0);
  });

  it('vision sends no image to a cloud model', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_never_sent_0000';
    settings.models.vision = { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' };
    const err = await ai.kernelVision('data:image/png;base64,AAAA', 'what is this').catch((e) => e);
    expect(err.message).toMatch(/Local only is on/);
    expect(offMachine).toEqual([]);
  });
});
