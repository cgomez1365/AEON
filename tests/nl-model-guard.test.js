/**
 * /api/settings/nl (the terminal's /set and /god/model-swap) refuses a model
 * the provider's connection does not list, and saves nothing when it does.
 * It wrote settings.models first and swallowed the registry's answer, so a
 * mismatched pair was saved and reported ok:true.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-nl-guard-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-nl-guard';
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const settings = require('../services/settings.js');
const storage = require('../services/storage.js');
const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

const REG_FILE = path.join(process.env.AEON_SECRETS_DIR, 'aeon-endpoints.json');
const SETTINGS_FILE = storage.SETTINGS_FILE;

async function mount() {
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, { cloudCredentials: { metadata: () => ({ supabase: {}, firebase: {} }) }, providerCredentials: null, supabase: null });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ models: { chat: { provider: 'gemini', model: 'gemini-2.5-flash' } } }));
  fs.writeFileSync(REG_FILE, JSON.stringify({
    endpoints: [
      { id: 'or1', provider: 'openrouter', models: ['openrouter/free'], reachable_from: ['local', 'cloud'] },
      { id: 'gm1', provider: 'gemini', models: ['gemini-2.5-flash', 'gemini-flash-latest'], reachable_from: ['local', 'cloud'] },
      { id: 'gm2', provider: 'gemini', models: ['gemini-3.8-flash'], reachable_from: ['local', 'cloud'] },
      { id: 'gq1', provider: 'groq', models: [], reachable_from: ['local', 'cloud'] },
    ], roles: {},
  }));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const nl = (base, phrase) => fetch(`${base}/api/settings/nl`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phrase }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('POST /api/settings/nl', () => {
  it('refuses a model the provider does not list and leaves settings.models alone', async () => {
    const { server, base } = await mount();
    try {
      const r = await nl(base, 'chat to openrouter gemini-flash-latest');
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/gemini-flash-latest/);
      expect(settings.loadSettings().models.chat).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
      expect(JSON.parse(fs.readFileSync(REG_FILE, 'utf8')).roles).toEqual({});
    } finally { server.close(); }
  });

  it('saves a model the provider lists, in both stores', async () => {
    const { server, base } = await mount();
    try {
      const r = await nl(base, 'chat to gemini gemini-flash-latest');
      expect(r.status).toBe(200);
      expect(settings.loadSettings().models.chat).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
      expect(JSON.parse(fs.readFileSync(REG_FILE, 'utf8')).roles.chat).toMatchObject({ endpoint_id: 'gm1', model: 'gemini-flash-latest' });
    } finally { server.close(); }
  });

  it('uses the second connection of a provider when only it lists the model', async () => {
    const { server, base } = await mount();
    try {
      const r = await nl(base, 'chat to gemini gemini-3.8-flash');
      expect(r.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(REG_FILE, 'utf8')).roles.chat).toMatchObject({ endpoint_id: 'gm2', model: 'gemini-3.8-flash' });
    } finally { server.close(); }
  });

  it('does not refuse where the list proves nothing: a connection with no model list', async () => {
    const { server, base } = await mount();
    try {
      const r = await nl(base, 'chat to groq openai/gpt-oss-120b');
      expect(r.status).toBe(200);
      expect(settings.loadSettings().models.chat).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b' });
    } finally { server.close(); }
  });
});
