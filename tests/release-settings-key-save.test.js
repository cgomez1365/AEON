/**
 * Settings → Keys: a saved key is used at once, a rejected Gemini key says
 * why, and the retired Google Apps Script service is gone (3.1.0 follow-ups).
 *
 *   1. POST /api/settings/secrets set the env names but never rebuilt the
 *      kernel's key pools, so a Gemini key saved there was not used until a
 *      restart while the reply said `restartRequired: false` (A041). It now
 *      calls deps.hydrateEnvFromVault, as connections.js does after a key add.
 *   2. The Gemini "Test" button showed only "Gemini: Failed" for a bad key:
 *      the route dropped Google's reason. It now returns it as `error`.
 *   3. 'gas' (Google Apps Script, VITE_GAS_URL) had no consumer since
 *      NeuralTerminal.jsx was deleted; Settings still listed it.
 *
 * Drives the real route over a real socket. Outbound provider calls are
 * stubbed; nothing leaves this machine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// SECRETS_DIR resolves at module scope: redirect it before the require.
const SECRETS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-release-keysave-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = SECRETS_TMP;

const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

const KEY_NAMES = ['GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_1', 'VITE_GAS_URL'];
const savedEnv = Object.fromEntries(KEY_NAMES.map((k) => [k, process.env[k]]));

let server;
let base;
let hydrateCalls = 0;
let hydrateFails = false;
const saved = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  for (const k of KEY_NAMES) delete process.env[k];
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, {
    supabase: null,
    // A stand-in key store: records what was saved, hydrates nothing itself.
    providerCredentials: {
      save: (vars) => { saved.push(vars); return Object.keys(vars || {}); },
      hydrate: () => {},
      metadata: () => ({}),
    },
    hydrateEnvFromVault: async () => {
      hydrateCalls++;
      if (hydrateFails) throw new Error('vault busy');
    },
  });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { globalThis.fetch = realFetch; });

afterAll(() => {
  if (server) server.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  try { fs.rmSync(SECRETS_TMP, { recursive: true, force: true }); } catch {}
});

const post = async (p, body) => {
  const r = await realFetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};

describe('POST /api/settings/secrets', () => {
  it('rebuilds the running key pools after saving, so the key is used without a restart', async () => {
    hydrateCalls = 0;
    const r = await post('/api/settings/secrets', { vars: { GEMINI_FREE_KEY_1: 'test-only-not-a-real-key' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, restartRequired: false });
    expect(saved.at(-1)).toEqual({ GEMINI_FREE_KEY_1: 'test-only-not-a-real-key' });
    expect(hydrateCalls).toBe(1);
  });

  it('a failed reload still reports the key as saved (it is in the vault)', async () => {
    hydrateCalls = 0;
    hydrateFails = true;
    try {
      const r = await post('/api/settings/secrets', { vars: { GEMINI_FREE_KEY_1: 'test-only-not-a-real-key' } });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(hydrateCalls).toBe(1);
    } finally { hydrateFails = false; }
  });
});

describe('POST /api/settings/test-provider/gemini', () => {
  it('passes on the reason Google gives for a rejected key', async () => {
    process.env.GEMINI_FREE_KEY_1 = 'test-only-not-a-real-key';
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.startsWith(base)) return realFetch(url, init);
      if (href.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          error: {
            code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected outbound fetch in test: ${href}`);
    };
    try {
      const r = await post('/api/settings/test-provider/gemini');
      expect(r.body.ok).toBe(false);
      expect(r.body.models).toEqual([]);
      expect(r.body.error).toBe('API key not valid. Please pass a valid API key.');
    } finally { delete process.env.GEMINI_FREE_KEY_1; }
  });

  it('a working key carries no error', async () => {
    process.env.GEMINI_FREE_KEY_1 = 'test-only-not-a-real-key';
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.startsWith(base)) return realFetch(url, init);
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-flash-latest' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const r = await post('/api/settings/test-provider/gemini');
      expect(r.body).toEqual({ ok: true, models: ['gemini-flash-latest'] });
    } finally { delete process.env.GEMINI_FREE_KEY_1; }
  });
});

describe('the retired Google Apps Script service is gone', () => {
  it('Settings no longer lists or tests a "gas" provider, even with VITE_GAS_URL set', async () => {
    process.env.VITE_GAS_URL = 'https://script.google.com/macros/s/test-only/exec';
    try {
      const providers = await (await realFetch(`${base}/api/settings/providers`)).json();
      expect(Object.keys(providers)).not.toContain('gas');
      const ns = await (await realFetch(`${base}/api/settings/nervous-system`)).json();
      expect(Object.keys(ns.providers || {})).not.toContain('gas');
      const details = await (await realFetch(`${base}/api/settings/provider-details`)).json();
      expect(Object.keys(details)).not.toContain('gas');
      const t = await post('/api/settings/test-provider/gas');
      expect(t.body).toEqual({ ok: false, error: 'Unknown provider: gas' });
    } finally { delete process.env.VITE_GAS_URL; }
  });

  it('no source file, route or template names it', () => {
    const files = [
      'src/blocks/settings/api/settings.js', 'src/blocks/settings/index.jsx',
      'src/kernel/blockStandard.cjs', 'src/kernel/routers/core.cjs',
      'src/blocks/host_os/api/system.cjs', 'src/blocks/host_os/block.manifest.json',
      'src/utils/interceptorPolicy.js', '.env.example',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/VITE_GAS_URL|\/gas\/status|\bgas\s*:|id === 'gas'|providers\.gas|scriptUrl/);
    }
  });
});
