/**
 * Settings is the nervous system: every block reads its role, model and keys
 * from here. These cover four ways it failed silently (audit, 2026-09-28):
 *
 *   1. a settings file that did not parse was replaced by defaults on the
 *      next save — every role assignment gone, nothing reported.
 *   2. a patch carrying "__proto__" wrote to Object.prototype process-wide.
 *   3. two registry mutations at once read one snapshot; the second save
 *      dropped the first's change (a role, or a key ref).
 *   4. the role picker counted connections, not keys, as "keys pooled".
 *
 * Each test names the fix it fails on if undone.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Set BEFORE the requires — paths resolve at module scope, and the suite must
// never touch the operator's own install.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-nervous-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-nervous-system';
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const settings = require('../services/settings.js');
const storage = require('../services/storage.js');
const endpoints = require('../src/kernel/endpoints.cjs');
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
  for (const f of fs.readdirSync(path.dirname(SETTINGS_FILE))) {
    if (f.startsWith(path.basename(SETTINGS_FILE))) fs.rmSync(path.join(path.dirname(SETTINGS_FILE), f), { force: true });
  }
  fs.rmSync(REG_FILE, { force: true });
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('settings file that does not parse', () => {
  it('is moved aside, not overwritten by defaults (fix 1)', () => {
    const broken = '{"models":{"chat":{"provider":"groq","model":"x"}'; // truncated
    fs.writeFileSync(SETTINGS_FILE, broken);
    const loaded = settings.loadSettings();
    expect(loaded.models.chat.provider).toBe('local');
    const dir = path.dirname(SETTINGS_FILE);
    const aside = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(SETTINGS_FILE) + '.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe(broken);
  });

  it('a missing file still returns defaults and moves nothing', () => {
    expect(settings.loadSettings().models.chat.provider).toBe('local');
    expect(fs.readdirSync(path.dirname(SETTINGS_FILE)).some(f => f.includes('.corrupt-'))).toBe(false);
  });
});

describe('POST /api/settings patch', () => {
  it('ignores __proto__ and cannot pollute Object.prototype (fix 2)', async () => {
    const { server, base } = await mount();
    try {
      const res = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"patch":{"__proto__":{"aeonPolluted":1},"prefs":{"theme":"dark"}}}',
      });
      expect(res.status).toBeLessThan(500);
      expect(({}).aeonPolluted).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).prefs.theme).toBe('dark');
    } finally { delete Object.prototype.aeonPolluted; server.close(); }
  });
});

describe('endpoint registry mutations', () => {
  it('run in turn, so concurrent changes all land (fix 3)', async () => {
    fs.writeFileSync(REG_FILE, JSON.stringify({
      endpoints: [{ id: 'ep1', provider: 'openrouter', auth_ref: 'k1', models: ['m'] }], roles: {},
    }));
    await Promise.all([
      endpoints.assignRole('chat', 'ep1', 'm', null, null),
      endpoints.addCredential('ep1', 'k2', null),
      endpoints.assignRole('research', 'ep1', 'm', null, null),
      endpoints.addCredential('ep1', 'k3', null),
    ]);
    const reg = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    expect(Object.keys(reg.roles).sort()).toEqual(['chat', 'research']);
    expect(reg.endpoints[0].auth_refs).toEqual(['k1', 'k2', 'k3']);
  });

  it('a failed mutation does not stall the ones after it', async () => {
    fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: [{ id: 'ep1', provider: 'groq', auth_ref: 'k1' }], roles: {} }));
    const bad = endpoints.addCredential('nope', 'k9', null);
    const good = endpoints.assignRole('chat', 'ep1', 'm', null, null);
    await expect(bad).rejects.toThrow(/not found/);
    await expect(good).resolves.toMatchObject({ endpoint_id: 'ep1' });
  });
});

describe('nervous system accounts', () => {
  it('counts every pooled key, not every connection (fix 4)', async () => {
    fs.writeFileSync(REG_FILE, JSON.stringify({
      endpoints: [{ id: 'ep1', provider: 'openrouter', label: 'OR', auth_ref: 'a', auth_refs: ['a', 'b', 'c'], models: [] }],
      roles: {},
    }));
    const { server, base } = await mount();
    try {
      const ns = await (await fetch(`${base}/api/settings/nervous-system`)).json();
      const or = ns.providers.openrouter;
      expect(or.accounts.map(a => a.authRef)).toEqual(['a', 'b', 'c']);
    } finally { server.close(); }
  });
});
