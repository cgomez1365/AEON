/**
 * Assigning a role refuses a model its endpoint does not list.
 *
 * Measured live 2026-10-05 (drive audit log): switching Chat's provider in
 * Settings → Models saved the OLD provider's model against the NEW provider's
 * connection — "chat → openrouter-…/gemini-flash-latest", then "grading →
 * gemini-…/openrouter/free", "chat → gemini-…/nvidia/nemotron-…:free", "vision →
 * gemini-…/openrouter/free" — each corrected by hand seconds later. The route
 * answered 200 for all of them and wrote settings.models, which is what the
 * kernel routes by, so the role pointed at a model the provider does not have.
 *
 * Only a hosted vendor's catalogue is authoritative. A local runtime, LM Studio
 * and a custom server load models without telling the registry, and a hand-typed
 * model is a one-entry list, so they are never refused on their list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-assign-guard-'));
process.env.AEON_HOME = path.join(tempSecrets, 'home');
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-assign-guard';

const express = require('express');
const mountConnections = require('../src/blocks/settings/api/connections.js');

let server;
let base;
let settings;
const audits = [];

beforeAll(async () => {
  settings = { models: {} };
  const app = express();
  app.use(express.json());
  mountConnections(app, {
    loadSettings: () => JSON.parse(JSON.stringify(settings)),
    saveSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
    writeOSAudit: (...a) => audits.push(a),
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const add = (b) => post('/api/connections', b);
  await add({ provider: 'openrouter', id: 'or1', models: ['openrouter/free', 'google/gemini-2.5-flash'] });
  await add({ provider: 'gemini', id: 'gm1', models: ['gemini-2.5-flash', 'gemini-flash-latest'] });
  await add({ provider: 'groq', id: 'gq1', models: [] });
  await add({ provider: 'custom', id: 'cu1', base_url: 'http://127.0.0.1:9/v1', models: ['only-one'] });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.AEON_VAULT_MASTER_KEY;
  fs.rmSync(tempSecrets, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const registry = () => fetch(`${base}/api/connections`).then((r) => r.json());

describe('POST /api/connections/assign-role', () => {
  it('refuses a model the endpoint does not list, with a plain 400, and writes nothing', async () => {
    const before = await registry();
    const r = await post('/api/connections/assign-role', { role: 'chat', endpoint_id: 'or1', model: 'gemini-flash-latest' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gemini-flash-latest/);
    expect(r.body.error).toMatch(/openrouter/i);
    expect((await registry()).roles).toEqual(before.roles);
    expect(settings.models.chat).toBeUndefined();
  });

  it('accepts a model the endpoint lists, and mirrors it to settings.models', async () => {
    const r = await post('/api/connections/assign-role', { role: 'chat', endpoint_id: 'gm1', model: 'gemini-flash-latest' });
    expect(r.status).toBe(200);
    expect(settings.models.chat).toMatchObject({ provider: 'gemini', model: 'gemini-flash-latest' });
  });

  it('does not refuse where the list proves nothing: empty list, custom server', async () => {
    const unknown = await post('/api/connections/assign-role', { role: 'research', endpoint_id: 'gq1', model: 'openai/gpt-oss-120b' });
    expect(unknown.status).toBe(200);
    const custom = await post('/api/connections/assign-role', { role: 'grading', endpoint_id: 'cu1', model: 'a-model-the-server-has' });
    expect(custom.status).toBe(200);
  });
});
