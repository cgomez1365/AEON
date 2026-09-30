/**
 * C28 — deleting a connection stops its keys serving now, not at restart.
 *
 * DELETE /api/connections/:id removed the keys from the vault and answered
 * removedKeys:[ref], but only dehydrated the provider when it was its LAST
 * connection (and only for groq/openrouter/claude/gemini). Deleting one of two
 * OpenRouter connections left its key in OPENROUTER_API_KEY_n and the pool,
 * rotated into requests until restart. The per-key DELETE already read the
 * secret and called forgetKey; the connection route never did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-conn-del-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_VAULT_MASTER_KEY = 'sweep-keys-conn-delete-master';

const express = require('express');
const mountConnections = require('../src/blocks/settings/api/connections.js');

const forgotten = [];
const dehydrated = [];
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountConnections(app, {
    forgetKey: (v) => { forgotten.push(v); return 1; },
    dehydrateProvider: (p) => { dehydrated.push(p); return { ok: true }; },
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE' }).then((r) => r.json());
const conn = (id, apiKey, extra = {}) => post('/api/connections', { provider: 'custom', id, base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey, ...extra });

describe('DELETE /api/connections/:id', () => {
  it('forgets every key it removed, while the provider still has another connection', async () => {
    expect((await conn('ora', 'sk-or-account-a')).ok).toBe(true);
    expect((await post('/api/connections/ora/keys', { apiKey: 'sk-or-account-a2', label: 'second' })).ok).toBe(true);
    expect((await conn('orb', 'sk-or-account-b')).ok).toBe(true);

    const gone = await del('/api/connections/ora');

    expect(gone.ok).toBe(true);
    expect(gone.removedKeys.sort()).toEqual(['custom-ora', 'ora-second']);
    expect(forgotten.sort()).toEqual(['sk-or-account-a', 'sk-or-account-a2']);
    expect(dehydrated).toEqual([]); // orb is still a custom connection
  });

  it('a key another connection still uses is kept, and keeps serving', async () => {
    forgotten.length = 0;
    expect((await conn('sha', 'sk-shared-key', { auth_ref: 'shared-ref' })).ok).toBe(true);
    expect((await post('/api/connections', { provider: 'custom', id: 'shb', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], auth_ref: 'shared-ref' })).ok).toBe(true);
    const r = await del('/api/connections/sha');
    expect(r.keptKeys).toEqual(['shared-ref']);
    expect(forgotten).toEqual([]);
  });
});
