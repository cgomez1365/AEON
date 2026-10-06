/**
 * The Settings Save button cannot write a model its provider does not list.
 *
 * updateRole refuses a stale pair at assign-role (400) but used to keep it in
 * the page's unsaved patch, and POST /api/settings then wrote settings.models
 * unchecked — the one write path the assign-role / nl guard did not cover.
 * That route now applies endpoints.modelRefusal to every role whose
 * provider+model the save would CHANGE, and writes nothing when one is refused.
 *
 * Only a hosted vendor's stored list is authoritative (modelRefusal's own
 * rule), so every legitimate shape must still save: an empty list, a custom
 * server, a provider with no connection yet, the embed role, an empty model, a
 * save that leaves models alone, a pair already on disk, an older file.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-save-guard-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-save-guard';
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const settings = require('../services/settings.js');
const storage = require('../services/storage.js');
const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

const REG_FILE = path.join(process.env.AEON_SECRETS_DIR, 'aeon-endpoints.json');
const SETTINGS_FILE = storage.SETTINGS_FILE;
const STALE = { provider: 'openrouter', model: 'gemini-flash-latest' };
const ON_DISK = { models: { chat: { provider: 'gemini', model: 'gemini-2.5-flash' }, grading: { provider: 'gemini', model: 'gemini-2.5-flash' } }, prefs: { a: 1 } };

async function mount() {
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, { cloudCredentials: { metadata: () => ({ supabase: {}, firebase: {} }) }, providerCredentials: null, supabase: null });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const seed = (obj = ON_DISK) => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj));
};
const onDisk = () => fs.readFileSync(SETTINGS_FILE, 'utf8');

beforeEach(() => {
  seed();
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'or1', provider: 'openrouter', models: ['openrouter/free', 'google/gemini-2.5-flash'], reachable_from: ['local', 'cloud'] },
      { id: 'gm1', provider: 'gemini', models: ['gemini-2.5-flash', 'gemini-flash-latest'], reachable_from: ['local', 'cloud'] },
      { id: 'gq1', provider: 'groq', models: [], reachable_from: ['local', 'cloud'] },
      { id: 'cu1', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', models: ['only-one'], reachable_from: ['local'] },
    ], roles: {},
  }));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const save = (base, body) => fetch(`${base}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

// Run `fn` against a mounted server and always close it.
const withServer = async (fn) => { const { server, base } = await mount(); try { await fn(base); } finally { server.close(); } };

describe('POST /api/settings with a model the provider does not list', () => {
  it('refuses a patch carrying a stale pair, names the remedy, and writes nothing', () => withServer(async (base) => {
    const before = onDisk();
    const r = await save(base, { patch: { models: { chat: STALE } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gemini-flash-latest/);
    expect(r.body.error).toMatch(/openrouter/);
    expect(r.body.error).toMatch(/Settings → Model Assignment/);
    expect(r.body.error).toMatch(/Nothing was saved/);
    expect(onDisk()).toBe(before);
  }));

  it('refuses a model-only patch that leaves the saved provider with a model it lacks', () => withServer(async (base) => {
    const before = onDisk();
    const r = await save(base, { patch: { models: { chat: { model: 'not-a-gemini-model' } } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gemini does not serve "not-a-gemini-model"/);
    expect(onDisk()).toBe(before);
  }));

  it('refuses the whole save when one role is good and another is stale, saving neither', () => withServer(async (base) => {
    const before = onDisk();
    const r = await save(base, { patch: { prefs: { b: 2 }, models: { grading: { provider: 'gemini', model: 'gemini-flash-latest' }, chat: STALE } } });
    expect(r.status).toBe(400);
    expect(onDisk()).toBe(before);
  }));

  it('refuses a full-replace body with a stale pair too', () => withServer(async (base) => {
    const before = onDisk();
    const r = await save(base, { settings: { models: { chat: STALE }, prefs: {} } });
    expect(r.status).toBe(400);
    expect(onDisk()).toBe(before);
  }));
});

describe('POST /api/settings still saves every legitimate shape', () => {
  it('saves a pair the provider lists', () => withServer(async (base) => {
    const r = await save(base, { patch: { models: { chat: { provider: 'gemini', model: 'gemini-flash-latest' } } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().models.chat).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
    expect(settings.loadSettings().models.grading).toEqual(ON_DISK.models.grading);
  }));

  it('saves a switch of provider that brings a model the new provider lists', () => withServer(async (base) => {
    const r = await save(base, { patch: { models: { chat: { provider: 'openrouter', model: 'openrouter/free' } } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().models.chat).toEqual({ provider: 'openrouter', model: 'openrouter/free' });
  }));

  it('does not refuse where the list proves nothing: empty list, custom server, provider with no connection', () => withServer(async (base) => {
    for (const pair of [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'custom', model: 'a-model-the-server-has' },
      { provider: 'openai', model: 'gpt-anything' },
      { provider: 'local', model: 'some-local.gguf' },
    ]) {
      const r = await save(base, { patch: { models: { chat: pair } } });
      expect(r.status, JSON.stringify(pair)).toBe(200);
      expect(settings.loadSettings().models.chat).toEqual(pair);
    }
  }));

  it('does not guard the embed role, which is not one of the chat model lists', () => withServer(async (base) => {
    const r = await save(base, { patch: { models: { embed: { provider: 'openrouter', model: 'text-embedding-3-small' } } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().models.embed.model).toBe('text-embedding-3-small');
  }));

  it('does not refuse an empty model', () => withServer(async (base) => {
    const r = await save(base, { patch: { models: { chat: { provider: 'openrouter', model: '' } } } });
    expect(r.status).toBe(200);
  }));

  it('saves a patch that does not touch models, even when the file already holds a stale pair', () => withServer(async (base) => {
    seed({ models: { chat: STALE }, prefs: {} });
    const r = await save(base, { patch: { prefs: { theme: 'dark' } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().prefs.theme).toBe('dark');
    expect(settings.loadSettings().models.chat).toEqual(STALE);
  }));

  it('does not refuse a pair that is already saved, re-sent unchanged', () => withServer(async (base) => {
    seed({ models: { chat: STALE }, prefs: {} });
    const r = await save(base, { patch: { models: { chat: STALE }, prefs: { x: 1 } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().prefs.x).toBe(1);
  }));

  it('saves into an older settings file with no models section or provider-less roles', () => withServer(async (base) => {
    seed({ prefs: {} });
    expect((await save(base, { patch: { models: { chat: { model: 'x' } } } })).status).toBe(200);
    seed({ models: { chat: { model: 'legacy' } } });
    expect((await save(base, { patch: { models: { grading: { model: 'y' } } } })).status).toBe(200);
  }));

  it('saves a full-replace body whose models are unchanged', () => withServer(async (base) => {
    const r = await save(base, { settings: { ...ON_DISK, prefs: { b: 2 } } });
    expect(r.status).toBe(200);
    expect(settings.loadSettings().prefs).toEqual({ b: 2 });
  }));

  it('still saves with no connections registered at all (setup wizard)', () => withServer(async (base) => {
    fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: [], roles: {} }));
    const r = await save(base, { patch: { models: { chat: STALE } } });
    expect(r.status).toBe(200);
  }));
});
