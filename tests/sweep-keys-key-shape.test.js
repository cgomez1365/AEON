/**
 * C05 — a key that cannot go in a header is refused where it is saved.
 *
 * Settings (providerCredentials.save) only trimmed, and POST /api/connections
 * stored apiKey exactly as pasted. trim() keeps U+200B, so a key copied with a
 * zero-width space — or pasted with "# main — acct" after it — saved "ok",
 * showed connected, and then every call threw Node's ByteString TypeError
 * before any HTTP status existed: never rotated, never cooled. No network here:
 * the connections use an unroutable base_url and name their models.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-keyshape-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_VAULT_MASTER_KEY = 'sweep-keys-key-shape-master';

const express = require('express');
const settings = require('../services/settings.js');
const vault = require('../src/kernel/vault.cjs');
const mountSettings = require('../src/blocks/settings/api/settings.js');
const mountConnections = require('../src/blocks/settings/api/connections.js');

const BAD = [
  ['a zero-width space', 'gsk_abc​'],
  ['an em-dash note', 'gsk_abc # main — acct'],
  ['a line break inside', 'gsk_abc\ndef'],
  ['an inner space', 'gsk_abc def'],
];

let server;
let base;
const store = settings.createProviderCredentialStore({ file: path.join(tmp, 'provider.json') });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountSettings(app, {
    cloudCredentials: settings.createCloudCredentialStore({ file: path.join(tmp, 'cloud.json') }),
    providerCredentials: store,
    supabase: null,
  });
  mountConnections(app, {});
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  delete process.env.AEON_ENV_FILE;
  delete process.env.GROQ_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('the Settings key store', () => {
  it.each(BAD)('refuses a key with %s, naming the field and never echoing the value', (_what, value) => {
    let err;
    try { store.save({ GROQ_API_KEY: value }); } catch (e) { err = e; }
    expect(err, 'saved a key that cannot be sent').toBeTruthy();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/GROQ_API_KEY is not a usable key/);
    expect(err.message).not.toContain('gsk_abc');
    const held = {};
    store.hydrate(held);
    expect(held.GROQ_API_KEY).toBeUndefined();
  });

  it('keeps a normal key, trimmed', () => {
    expect(store.save({ GROQ_API_KEY: '  gsk_good-Key.123  ' })).toEqual(['GROQ_API_KEY']);
    const held = {};
    store.hydrate(held);
    expect(held.GROQ_API_KEY).toBe('gsk_good-Key.123');
  });

  it('still takes a Coinbase CDP secret — a PEM block that signs locally, never a header', () => {
    const pem = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIFixtureOnlyNotAKey\n-----END EC PRIVATE KEY-----';
    expect(store.save({ COINBASE_API_SECRET: `${pem}\n` })).toEqual(['COINBASE_API_SECRET']);
    const held = {};
    store.hydrate(held);
    expect(held.COINBASE_API_SECRET).toBe(pem);
  });

  it('POST /api/settings/secrets answers 400 with the reason', async () => {
    const r = await post('/api/settings/secrets', { vars: { OPENROUTER_API_KEY: 'sk-or-1​' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/OPENROUTER_API_KEY is not a usable key: it contains a non-ASCII character .* at position 8/);
  });
});

describe('the Connections routes', () => {
  it.each(BAD)('POST /api/connections refuses a key with %s and writes nothing to the vault', async (_what, value) => {
    const before = await vault.listRefs(null);
    const r = await post('/api/connections', { provider: 'custom', id: 'shape', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey: value });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/API key is not a usable key/);
    expect(await vault.listRefs(null)).toEqual(before);
  });

  it('refuses in the same words as the Settings key store (the block restates the rule)', async () => {
    for (const [, value] of BAD) {
      const r = await post('/api/connections', { provider: 'custom', id: 'shape', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey: value });
      expect(r.body.error).toContain(`it ${settings.keyShapeProblem(value.trim())}.`);
    }
  });

  it('POST /api/connections stores a pasted key trimmed', async () => {
    const r = await post('/api/connections', { provider: 'custom', id: 'shape', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey: '  sk-fixture-ok \n' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await vault.getSecret(r.body.endpoint.auth_ref, null)).toBe('sk-fixture-ok');
  });

  it('POST /api/connections/:id/keys refuses a key that cannot be sent', async () => {
    const r = await post('/api/connections/shape/keys', { apiKey: 'sk-two​', label: 'two' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a usable key/);
    expect(await vault.listRefs(null)).not.toContain('shape-two');
  });

  it('discovery says why instead of "could not reach that address"', async () => {
    const r = await post('/api/connections/discover', { provider: 'custom', base_url: 'http://127.0.0.1:9/v1', apiKey: 'sk-x # note' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.error).toMatch(/contains a space or line break at position 5/);
  });
});
