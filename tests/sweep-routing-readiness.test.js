/**
 * Sweep S01 — readiness says what routing does.
 *
 * Since 3efff20 the router takes a role's provider from Settings
 * (settings.models, "Same as Chat" meaning Chat's), and the registry's own
 * role map only answers when Settings declares nothing usable. Readiness
 * (describeRoleLocal → checkReadiness().roles) still read the registry map
 * alone: a role set to Local showed "ready via openrouter", and a declared
 * model the provider no longer serves showed ready from a stale mapping.
 *
 * The settings file written here is the suite's isolated one (AEON_HOME is a
 * temp dir — tests/setup-isolation.js); the test refuses to write anywhere
 * else, and puts back whatever was there.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const STD_PATH = path.join(ROOT, 'src', 'kernel', 'blockStandard.cjs');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-readiness-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = tempSecrets;
// Put back in afterAll: vitest runs several files per worker.
const savedRuntimeEnv = { VERCEL: process.env.VERCEL, AEON_PORTABLE: process.env.AEON_PORTABLE };
delete process.env.VERCEL;
delete process.env.AEON_PORTABLE;
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

const savedCache = {};
for (const p of [ENDPOINTS_PATH, STD_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }

let localOn = false;
require.cache[LR_PATH] = {
  id: LR_PATH, filename: LR_PATH, loaded: true,
  exports: {
    isAvailable: () => localOn,
    defaultModel: () => (localOn ? 'qwen-local' : null),
    status: () => ({ readyModels: localOn ? [{ id: 'qwen-local', capabilities: ['chat'] }] : [] }),
  },
};

const endpoints = require(ENDPOINTS_PATH);
const std = require(STD_PATH);
const settingsService = require(path.join(ROOT, 'services', 'settings.js'));
const writerManifest = require('../src/blocks/writer/block.manifest.json');

const SETTINGS_FILE = settingsService.SETTINGS_FILE;
const SUITE_HOME = process.env.AEON_HOME;
if (!SUITE_HOME || !path.resolve(SETTINGS_FILE).startsWith(path.resolve(SUITE_HOME) + path.sep)) {
  throw new Error(`refusing to write settings outside the suite's temp home: ${SETTINGS_FILE}`);
}
const savedSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE) : null;
const writeSettings = (models) => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ models, roulette: false, prefs: {} }, null, 2));
};

// The registry still maps every role to OpenRouter — what it last held.
fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
  endpoints: [
    { id: 'or', label: 'OpenRouter', kind: 'cloud', provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1',
      auth_ref: 'or-ref', models: ['openai/gpt-4o-mini', 'nvidia/nemotron:free'], reachable_from: ['local', 'cloud'] },
    { id: 'gq', label: 'Groq', kind: 'cloud', provider: 'groq', base_url: 'https://api.groq.com/openai/v1',
      auth_ref: 'gq-ref', models: ['openai/gpt-oss-120b'], reachable_from: ['local', 'cloud'] },
  ],
  roles: {
    chat: { endpoint_id: 'or', model: 'openai/gpt-4o-mini' },
    creative: { endpoint_id: 'or', model: 'openai/gpt-4o-mini' },
  },
  updated_at: null,
}, null, 2));

beforeEach(() => { localOn = false; });
afterEach(() => { try { fs.unlinkSync(SETTINGS_FILE); } catch {} });
afterAll(() => {
  if (savedSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings);
  for (const [p, mod] of Object.entries(savedCache)) { if (mod) require.cache[p] = mod; else delete require.cache[p]; }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  for (const [k, v] of Object.entries(savedRuntimeEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
});

describe('S01 — a role reports the provider Settings routes it to', () => {
  it('a role set to Local reports Local, not the registry\'s OpenRouter mapping', () => {
    localOn = true;
    writeSettings({ chat: { provider: 'openrouter', model: 'openai/gpt-4o-mini' }, creative: { provider: 'local', model: 'qwen-local' } });
    expect(endpoints.describeRoleLocal('creative')).toEqual({ ok: true, provider: 'local', model: 'qwen-local' });
    // And the block badge that reads it.
    expect(std.checkReadiness(writerManifest, {}).roles.creative).toEqual({ ready: true, provider: 'local', model: 'qwen-local' });
  });

  it('"Same as Chat" reports Chat\'s provider', () => {
    writeSettings({ chat: { provider: 'groq', model: 'openai/gpt-oss-120b' }, creative: { provider: '', model: '' } });
    expect(endpoints.describeRoleLocal('creative')).toEqual({ ok: true, provider: 'groq', model: 'openai/gpt-oss-120b' });
  });

  it('a declared model the provider does not serve is not ready, whatever the registry maps', () => {
    writeSettings({ chat: { provider: 'openrouter', model: 'openai/gpt-4o-mini' }, creative: { provider: 'openrouter', model: 'retired/model' } });
    expect(endpoints.describeRoleLocal('creative')).toMatchObject({ ok: false, provider: 'openrouter', model: 'retired/model', reason: 'model_not_on_endpoint' });
  });

  it('a declared provider with no connection and no key is not ready', () => {
    writeSettings({ chat: { provider: 'gemini', model: 'gemini-flash-latest' } });
    expect(endpoints.describeRoleLocal('creative')).toMatchObject({ ok: false, provider: 'gemini', reason: 'provider_not_configured' });
    process.env.GEMINI_API_KEY = 'AIza-sweep-stub-0000';
    try {
      expect(endpoints.describeRoleLocal('creative')).toMatchObject({ ok: true, provider: 'gemini', model: 'gemini-flash-latest' });
    } finally { delete process.env.GEMINI_API_KEY; }
  });

  it('nothing usable declared (the install default: Local, no local model) still reads the registry', () => {
    writeSettings({ chat: { provider: 'local', model: null }, creative: { provider: 'local', model: null } });
    expect(endpoints.describeRoleLocal('creative')).toEqual({ ok: true, provider: 'openrouter', model: 'openai/gpt-4o-mini' });
  });

  it('embed never borrows Chat and is not read from the Chat declaration', () => {
    writeSettings({ chat: { provider: 'groq', model: 'openai/gpt-oss-120b' } });
    expect(endpoints.describeRoleLocal('embed')).toMatchObject({ ok: false, reason: 'no_embed_model' });
  });
});
