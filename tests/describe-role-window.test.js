/**
 * describeRole reports the model's REAL window for cloud models.
 *
 * Every memory, skill and recall budget of a chat turn is a fraction of the
 * window describeRole reports. It used to say 8,192 for every cloud model, so
 * a 1,000,000-token model got ~980 tokens of memory. It now asks the provider
 * (modelContext.lookup) with the candidate's own address and key, and keeps
 * the 8,192 floor whenever the provider will not say.
 *
 * Driven against the REAL services/ai.js with a fake OpenAI-compatible
 * endpoint in the registry and the local runtime stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const MC_PATH = path.join(ROOT, 'src', 'kernel', 'modelContext.cjs');

const temps = [];
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), tag)); temps.push(d); return d; };

// endpoints.cjs resolves its registry path at module scope: a fresh copy is
// loaded against this file's own secrets dir, and every module this file
// replaces is put back afterwards for the rest of the worker.
const savedSecrets = process.env.AEON_SECRETS_DIR;
const savedDataPath = process.env.DATA_PATH;
const tempSecrets = tmp('aeon-describe-role-');
process.env.AEON_SECRETS_DIR = tempSecrets;
const savedCache = {};
for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH, MC_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

// ── The fake endpoint: serves /v1/models only when told to ───────────────
let serveModels = false;
const modelHits = [];
const fake = express();
fake.get('/v1/models', (req, res) => {
  modelHits.push(req.headers);
  if (!serveModels) return res.status(404).json({ error: 'no catalogue here' });
  res.json({ data: [{ id: 'fake-model', context_length: 1000000 }, { id: 'other-model', context_length: 65536 }] });
});
let server;
let base;

const lrStub = {
  isAvailable: () => true,
  defaultModel: () => 'stub-model',
  listReadyModels: () => [{ id: 'stub-model' }],
  status: () => ({ available: true, readyModels: [{ id: 'stub-model', capabilities: ['chat'] }] }),
  plannedContext: async () => ({ contextTokens: 32768 }),
  cancelAll: () => 0,
};

const CLOUD = { models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} };
const LOCAL = { models: { chat: { provider: 'local', model: 'stub-model' } }, prefs: {} };

/**
 * A fresh ai.js. With `mc` the modelContext module is replaced by that stub;
 * without it a real one is loaded against a fresh, empty DATA_PATH.
 */
function makeAi(loadSettings, mc = null) {
  delete require.cache[AI_PATH];
  delete require.cache[MC_PATH];
  if (mc) {
    require.cache[MC_PATH] = { id: MC_PATH, filename: MC_PATH, loaded: true, exports: mc };
  } else {
    process.env.DATA_PATH = tmp('aeon-describe-role-data-');
    require(MC_PATH);
    process.env.DATA_PATH = savedDataPath;
  }
  return require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(tmp('aeon-describe-role-ledger-'), 'token_ledger.json'),
    loadSettings,
    aeonTerminalStream: null,
  });
}

beforeAll(async () => {
  await new Promise((resolve) => { server = fake.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
    endpoints: [{
      id: 'fake', provider: 'custom', base_url: base,
      auth_ref: null, reachable_from: ['local'], models: ['fake-model'],
    }],
    roles: { chat: { endpoint_id: 'fake', model: 'fake-model' } },
  }, null, 2));
  require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
});

afterAll(() => {
  try { server?.close(); } catch {}
  for (const [p, m] of Object.entries(savedCache)) {
    if (m) require.cache[p] = m; else delete require.cache[p];
  }
  if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
  process.env.DATA_PATH = savedDataPath;
  Object.assign(process.env, savedEnv);
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

describe('describeRole asks the provider for the window', () => {
  it('a provider that publishes nothing keeps the 8,192 floor', async () => {
    serveModels = false;
    const ai = makeAi(() => CLOUD);
    expect(await ai.kernelLLM.describeRole('chat')).toEqual({ provider: 'custom', model: 'fake-model', contextTokens: 8192 });
  });

  it('a provider that publishes the window gets it reported', async () => {
    serveModels = true;
    const ai = makeAi(() => CLOUD);
    expect(await ai.kernelLLM.describeRole('chat')).toEqual({ provider: 'custom', model: 'fake-model', contextTokens: 1000000 });
    // Cached: the next turn asks nobody.
    const before = modelHits.length;
    expect((await ai.kernelLLM.describeRole('chat')).contextTokens).toBe(1000000);
    expect(modelHits.length).toBe(before);
  });

  it('asks with the candidate\'s own provider, model and address', async () => {
    const lookup = vi.fn(async () => 200000);
    const ai = makeAi(() => CLOUD, { lookup });
    expect((await ai.kernelLLM.describeRole('chat')).contextTokens).toBe(200000);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toMatchObject({ provider: 'custom', model: 'fake-model', base_url: base });
  });

  it('a local model reports its planned window and never consults a catalogue', async () => {
    const lookup = vi.fn(async () => 999999);
    const ai = makeAi(() => LOCAL, { lookup });
    expect(await ai.kernelLLM.describeRole('chat')).toEqual({ provider: 'local', model: 'stub-model', contextTokens: 32768 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', async () => { throw new Error('catalogue exploded'); }],
    ['resolves to null', async () => null],
    ['resolves to nonsense', async () => -5],
  ])('a lookup that %s leaves the floor, and describeRole does not throw', async (_, impl) => {
    const ai = makeAi(() => CLOUD, { lookup: vi.fn(impl) });
    await expect(ai.kernelLLM.describeRole('chat')).resolves.toEqual({ provider: 'custom', model: 'fake-model', contextTokens: 8192 });
  });

  it('no candidate at all: nulls and the floor, and no lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => 1000000);
    const ai = makeAi(() => { throw new Error('settings unreadable'); }, { lookup });
    expect(await ai.kernelLLM.describeRole('chat')).toEqual({ provider: null, model: null, contextTokens: 8192 });
    expect(lookup).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
