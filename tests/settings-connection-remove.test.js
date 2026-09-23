/**
 * Removing a connection removes its keys.
 *
 * Measured 2026-09-23 on a live server (throwaway home, fake keys only):
 * add connection "stubai" with a key, add a second key to its pool, remove the
 * second key (vault ref gone — correct), then DELETE /api/connections/stubai.
 * The endpoint and its role mapping were gone, but GET /api/connections still
 * listed vault ref "custom-stubai": the connection's key stayed encrypted in
 * the vault with nothing referring to it. The operator removed the connection
 * and reasonably believes the key is gone; it is not, and no screen shows it.
 *
 * Only refs no remaining connection uses are removed — POST /api/connections
 * accepts an existing auth_ref, so two connections can share one key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-conn-remove-'));
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-conn-remove';

const express = require('express');
const vault = require('../src/kernel/vault.cjs');
const mountConnections = require('../src/blocks/settings/api/connections.js');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountConnections(app, {});
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.AEON_VAULT_MASTER_KEY;
  fs.rmSync(tempSecrets, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE' }).then((r) => r.json());
const refs = async () => vault.listRefs(null);

describe('DELETE /api/connections/:id', () => {
  it('removes every key the connection held from the vault', async () => {
    const add = await post('/api/connections', { provider: 'custom', id: 'fixa', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey: 'sk-fixture-one' });
    expect(add.ok, JSON.stringify(add)).toBe(true);
    const k2 = await post('/api/connections/fixa/keys', { apiKey: 'sk-fixture-two', label: 'second' });
    expect(k2.ok, JSON.stringify(k2)).toBe(true);
    expect(await refs()).toEqual(expect.arrayContaining(['custom-fixa', 'fixa-second']));

    const gone = await del('/api/connections/fixa');
    expect(gone.ok).toBe(true);
    const left = await refs();
    expect(left, 'the removed connection\'s keys are still in the vault').not.toContain('custom-fixa');
    expect(left).not.toContain('fixa-second');
    expect(gone.removedKeys).toEqual(expect.arrayContaining(['custom-fixa', 'fixa-second']));
  });

  it('keeps a key another connection still uses', async () => {
    const a = await post('/api/connections', { provider: 'custom', id: 'sharea', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], apiKey: 'sk-fixture-shared', auth_ref: 'shared-ref' });
    expect(a.ok, JSON.stringify(a)).toBe(true);
    const b = await post('/api/connections', { provider: 'custom', id: 'shareb', base_url: 'http://127.0.0.1:9/v1', models: ['m1'], auth_ref: 'shared-ref' });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    await del('/api/connections/sharea');
    expect(await refs()).toContain('shared-ref');
    await del('/api/connections/shareb');
    expect(await refs()).not.toContain('shared-ref');
  });
});
