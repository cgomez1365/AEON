/**
 * A block's `type: "secret"` setting never reaches the browser, and a block's
 * own AI role is offered in Settings → Models.
 *
 * Measured 2026-10-02 (block-builder readiness audit, isolated AEON_HOME): a
 * block declared `{ key: "site_password", type: "secret" }`, the operator saved
 * one, and BOTH GET /api/settings and GET /api/settings/block/<id> answered it
 * in plain text. sanitizeSettings() strips keys named like secrets, but the
 * resolved block values were added back after it ran — and a secret named
 * "site_login" would never have matched the name test. The manifest's
 * declaration decides now; the block's server code still reads the real value.
 *
 * Same audit: a block calling kernelLLM with its own role (contract.ai.role
 * "card_watch") had no row in Settings → Models until something wrote
 * settings.models.card_watch through the API. GET /api/settings now carries
 * the roles installed blocks declare.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-block-secrets-'));
const BLOCKS = path.join(TMP, 'blocks');
const SECRET = 'FIXTURE-SECRET-VALUE-0123456789';
// Module-scope resolution: set before anything below is required.
process.env.AEON_BLOCKS_DIR = BLOCKS;
process.env.AEON_SETTINGS_FILE = path.join(TMP, 'aeon-settings.json');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');

fs.mkdirSync(path.join(BLOCKS, 'vault_probe'), { recursive: true });
fs.writeFileSync(path.join(BLOCKS, 'vault_probe', 'block.manifest.json'), JSON.stringify({
  manifestVersion: '1.1.0', id: 'vault_probe', label: 'Vault Probe', route: '/vault_probe', version: '0.0.1',
  contract: {
    permissions: { filesystem: 'none', network: 'external', secrets: true, shell: false, ai: true },
    ai: { canGenerate: false, canAnalyze: true, canAutomate: false, roles: ['vault_probe'], role: 'vault_probe', blurb: 'Reads listings' },
    settings: [
      { key: 'site_login', label: 'Site login', type: 'secret', default: '' },
      { key: 'api_token', label: 'API token', type: 'secret', default: '' },
      { key: 'poll_minutes', label: 'Every', type: 'number', default: 15 },
    ],
  },
}));
fs.writeFileSync(process.env.AEON_SETTINGS_FILE, JSON.stringify({
  models: { chat: { provider: 'local', model: '' } },
  blockSettings: { vault_probe: { site_login: SECRET, poll_minutes: 5 } },
}));

const express = require('express');
const blockSettings = require('../src/kernel/blockSettings.cjs');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, { supabase: null });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('a block secret stays on the server', () => {
  it('GET /api/settings/block/:id blanks it and says it is saved', async () => {
    const res = await fetch(`${base}/api/settings/block/vault_probe`);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.values.site_login).toBe('');
    expect(body.secretsSet).toEqual({ site_login: true, api_token: false });
    expect(body.values.poll_minutes).toBe(5);               // not a secret: unchanged
  });

  it('GET /api/settings never carries it either', async () => {
    const text = await (await fetch(`${base}/api/settings`)).text();
    expect(text).not.toContain(SECRET);
    const { settings } = JSON.parse(text);
    expect(settings.blockSettings.vault_probe.site_login).toBe('');
    expect(settings.blockSecretsSet.vault_probe).toEqual({ site_login: true, api_token: false });
  });

  it('the block itself still reads the real value (deps.blockSettings → get)', () => {
    const raw = JSON.parse(fs.readFileSync(process.env.AEON_SETTINGS_FILE, 'utf8'));
    expect(blockSettings.get('vault_probe', raw).site_login).toBe(SECRET);
  });
});

describe('a block\'s own AI role is offered in Settings → Models', () => {
  it('GET /api/settings lists the roles installed blocks declare', async () => {
    const { settings } = await (await fetch(`${base}/api/settings`)).json();
    expect(settings.blockRoles.vault_probe).toEqual([{ id: 'vault_probe', label: 'Vault Probe', blurb: 'Reads listings' }]);
  });
});
