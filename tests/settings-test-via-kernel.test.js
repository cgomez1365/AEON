/**
 * Settings "Test" calls providers through the kernel, and no key rides in a URL (a14).
 *
 *   1. POST /api/settings/test-provider/:id kept its own copy of every vendor
 *      call (six hand-written fetches to six vendor hosts), parallel to the
 *      kernel's discoverModelCatalogue that /api/connections/discover uses.
 *      Two copies of "how to call a provider" drift; the kernel is the one.
 *   2. Both copies sent the Gemini key as `?key=` in the URL, where it lands in
 *      proxy and access logs and in any fetch error that quotes the URL. Google
 *      accepts it as the `x-goog-api-key` header instead.
 *
 * Drives the real route over a real socket. Outbound calls are stubbed;
 * nothing leaves this machine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// SECRETS_DIR resolves at module scope: redirect it before the require.
const SECRETS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-a14-secrets-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
process.env.AEON_SECRETS_DIR = SECRETS_TMP;

const express = require('express');
const endpoints = require('../src/kernel/endpoints.cjs');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

const KEY = 'test-only-not-a-real-key-a14';
const ENV_KEYS = {
  groq: 'GROQ_API_KEY', gemini: 'GEMINI_FREE_KEY_1', openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY', grok: 'GROK_API_KEY', openrouter: 'OPENROUTER_API_KEY',
};
const ALL_ENV = [...Object.values(ENV_KEYS), 'GEMINI_PAID_KEY'];
const savedEnv = Object.fromEntries(ALL_ENV.map((k) => [k, process.env[k]]));
const VENDOR_HOST = /generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|api\.groq\.com|openrouter\.ai|api\.x\.ai/;

let server;
let base;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  for (const k of ALL_ENV) delete process.env[k];
  for (const k of Object.values(ENV_KEYS)) process.env[k] = KEY;
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, { supabase: null });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

afterAll(() => {
  if (server) server.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  try { fs.rmSync(SECRETS_TMP, { recursive: true, force: true }); } catch {}
});

const probe = async (id) => {
  const r = await realFetch(`${base}/api/settings/test-provider/${id}`, { method: 'POST' });
  return r.json();
};

/** Any outbound call is recorded; vendor calls fail the test unless `answer` handles them. */
function stubOutbound(answer) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, init);
    calls.push({ href, headers: { ...((init && init.headers) || {}) } });
    if (answer) return answer(href, init);
    throw new Error(`unexpected outbound fetch in test: ${href}`);
  };
  return calls;
}

describe('settings.js holds no vendor call of its own', () => {
  it('names vendor hosts only inside its provider table', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/settings/api/settings.js'), 'utf8');
    const start = src.indexOf('const ENV_PROVIDER_MAP = {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n    };', start);
    expect(end).toBeGreaterThan(start);
    const outside = (src.slice(0, start) + src.slice(end)).split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => VENDOR_HOST.test(line) && !/^\s*(\/\/|\*)/.test(line));
    expect(outside.map(({ line }) => line.trim())).toEqual([]);
  });

  it('never builds a URL with a key in its query string', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/settings/api/settings.js'), 'utf8');
    expect(src).not.toMatch(/[?&]key=\$\{/);
  });
});

describe('the Test button goes through the kernel', () => {
  // What each provider sends back to the UI, given the same kernel answer.
  // Same shapes as before: alphabetical for groq/openai/grok/gemini, the
  // provider's own order for claude, `free` only where prices exist.
  const kernelAnswer = { models: ['zeta', 'alpha'], free: ['zeta'] };
  const expected = {
    groq: { ok: true, models: ['alpha', 'zeta'], latency_ms: 0 },
    gemini: { ok: true, models: ['alpha', 'zeta'] },
    openai: { ok: true, models: ['alpha', 'zeta'] },
    claude: { ok: true, models: ['zeta', 'alpha'] },
    grok: { ok: true, models: ['alpha', 'zeta'] },
    openrouter: { ok: true, models: ['zeta', 'alpha'], free: ['zeta'] },
  };

  for (const id of Object.keys(expected)) {
    it(`${id}: calls discoverModelCatalogue with the resolved key and keeps the UI shape`, async () => {
      const calls = stubOutbound(null); // any direct vendor fetch throws
      const spy = vi.spyOn(endpoints, 'discoverModelCatalogue').mockResolvedValue(kernelAnswer);
      const body = await probe(id);
      expect(spy).toHaveBeenCalledTimes(1);
      const [provider, baseUrl, apiKey] = spy.mock.calls[0];
      expect(provider).toBe(id);
      expect(baseUrl == null).toBe(true); // the kernel's own built-in host
      expect(apiKey).toBe(KEY);
      expect(calls).toEqual([]);
      expect(body).toEqual(expected[id]);
    });
  }

  it('a kernel refusal reaches the UI as ok:false with the reason', async () => {
    stubOutbound(null);
    vi.spyOn(endpoints, 'discoverModelCatalogue').mockResolvedValue({ error: 'That service rejected the API key.' });
    expect(await probe('openai')).toEqual({ ok: false, models: [], error: 'That service rejected the API key.' });
  });
});

describe('the Gemini test never puts the key in a URL', () => {
  const geminiOk = () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-flash-latest' }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

  it('kernel discovery sends it as the x-goog-api-key header', async () => {
    const calls = stubOutbound(geminiOk);
    const out = await endpoints.discoverModelCatalogue('gemini', null, KEY);
    expect(out.models).toEqual(['gemini-flash-latest']);
    expect(calls).toHaveLength(1);
    expect(calls[0].href).not.toContain(KEY);
    expect(calls[0].href).not.toMatch(/[?&]key=/);
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
  });

  it('the Settings Test button, end to end, sends it as a header too', async () => {
    const calls = stubOutbound(geminiOk);
    const body = await probe('gemini');
    expect(body).toEqual({ ok: true, models: ['gemini-flash-latest'] });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.href).not.toContain(KEY);
      expect(c.href).not.toMatch(/[?&]key=/);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
    }
  });
});
