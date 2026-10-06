/**
 * The operator sets each connection's requests-per-minute limit.
 *
 * CEO, 2026-10-05: AEON paced only the generic "custom" provider. A Gemini
 * connection had no pacing at all, so a provider that allows a handful of
 * calls a minute could only ever be hit with the 429 instead of respected, and
 * the limit was visible nowhere. Principle 05: providers and models are policy,
 * so the NUMBER belongs to the operator and no provider's number is in code.
 *
 * Second defect, found while designing it: POST /api/connections goes through
 * addEndpoint, which REPLACED the whole row. An update that omitted rpm_limit
 * reset a saved limit to the provider default, and one that omitted models
 * emptied the model list.
 *
 * These drive the real registry and the real settings routes. The numbers below
 * are arbitrary; none is a real provider's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Before the requires: both modules resolve their paths at module scope.
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-conn-rpm-'));
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-conn-rpm';

const express = require('express');
const endpoints = require('../src/kernel/endpoints.cjs');
const vault = require('../src/kernel/vault.cjs');
const mountConnections = require('../src/blocks/settings/api/connections.js');

const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');
const onDisk = () => JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
const rowOnDisk = (id) => onDisk().endpoints.find((e) => e.id === id);

let server;
let base;
const audits = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountConnections(app, { writeOSAudit: (action, details, status, tokens) => audits.push({ action, details, status, tokens }) });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.AEON_VAULT_MASTER_KEY;
  fs.rmSync(tempSecrets, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const post = (p, body) => call('POST', p, body);
const setRpm = (id, rpm_limit) => post(`/api/connections/${id}/rpm`, { rpm_limit });

// A Gemini connection that carries everything an update could lose.
async function seedGemini() {
  fs.rmSync(REG_FILE, { force: true });
  audits.length = 0;
  await endpoints.addEndpoint({
    id: 'g1', provider: 'gemini', label: 'My Gemini', models: ['m-one', 'm-two'], preferred_model: 'm-two', auth_ref: 'g1-key',
  });
  await endpoints.assignRole('chat', 'g1', 'm-two');
}

describe('POST /api/connections/:id/rpm', () => {
  beforeEach(seedGemini);

  it('starts unpaced: no provider ships a number', () => {
    expect(rowOnDisk('g1').rpm_limit).toBeNull();
  });

  it('sets the limit, persists it, and the very next resolve sees it', async () => {
    const r = await setRpm('g1', 7);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.endpoint.rpm_limit).toBe(7);

    expect(rowOnDisk('g1').rpm_limit).toBe(7);
    const byRole = await endpoints.resolveForRole('chat');
    expect(byRole.rpm_limit).toBe(7);
    const byProvider = await endpoints.resolveForProvider('gemini');
    expect(byProvider.rpm_limit).toBe(7);

    // Changed again, no restart: nothing cached the old value.
    const again = await setRpm('g1', 11);
    expect(again.status).toBe(200);
    expect((await endpoints.resolveForRole('chat')).rpm_limit).toBe(11);
    expect(rowOnDisk('g1').rpm_limit).toBe(11);
  });

  it('GET /api/connections shows the limit and the provider default beside it', async () => {
    await setRpm('g1', 7);
    const got = await call('GET', '/api/connections');
    const row = got.body.endpoints.find((e) => e.id === 'g1');
    expect(row.rpm_limit).toBe(7);
    expect(row).toHaveProperty('rpm_default', null);
    // The default is a view field. It must never be written back to the registry.
    expect(rowOnDisk('g1')).not.toHaveProperty('rpm_default');
  });

  it('0 is an explicit "no limit", kept as 0', async () => {
    await setRpm('g1', 7);
    const r = await setRpm('g1', 0);
    expect(r.status).toBe(200);
    expect(rowOnDisk('g1').rpm_limit).toBe(0);
    expect((await endpoints.resolveForRole('chat')).rpm_limit).toBe(0);
  });

  it('accepts a whole number typed as a string', async () => {
    const r = await setRpm('g1', ' 9 ');
    expect(r.status).toBe(200);
    expect(rowOnDisk('g1').rpm_limit).toBe(9);
  });

  it('empty or null falls back to the provider default: none for Gemini, 30 for a generic endpoint', async () => {
    await setRpm('g1', 7);
    expect((await setRpm('g1', null)).status).toBe(200);
    expect(rowOnDisk('g1').rpm_limit).toBeNull();

    await setRpm('g1', 7);
    expect((await setRpm('g1', '')).status).toBe(200);
    expect(rowOnDisk('g1').rpm_limit).toBeNull();

    await endpoints.addEndpoint({ id: 'c1', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', models: ['m'] });
    expect(rowOnDisk('c1').rpm_limit).toBe(30);
    await setRpm('c1', 4);
    expect(rowOnDisk('c1').rpm_limit).toBe(4);
    const back = await setRpm('c1', null);
    expect(back.status).toBe(200);
    expect(rowOnDisk('c1').rpm_limit).toBe(30);
    const got = await call('GET', '/api/connections');
    expect(got.body.endpoints.find((e) => e.id === 'c1').rpm_default).toBe(30);
  });

  it('changes ONLY the limit', async () => {
    const before = rowOnDisk('g1');
    await setRpm('g1', 7);
    const after = rowOnDisk('g1');
    expect({ ...after, rpm_limit: before.rpm_limit }).toEqual(before);
    expect(onDisk().roles.chat).toEqual({ endpoint_id: 'g1', model: 'm-two', cloud_fallback: null });
  });

  it.each([
    ['below zero', -1],
    ['above 600', 601],
    ['a fraction', 5.5],
    ['text', 'abc'],
    ['a fraction as text', '5.5'],
    ['a boolean', true],
    ['an array', []],
    ['an object', {}],
  ])('refuses %s with a sentence that names the remedy, and changes nothing', async (_name, bad) => {
    await setRpm('g1', 7);
    const bytes = fs.readFileSync(REG_FILE, 'utf8');
    audits.length = 0;
    const r = await setRpm('g1', bad);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/whole number from 0 to 600/);
    expect(r.body.error).toMatch(/provider's own rate-limits page/);
    expect(r.body.error).toMatch(/0 to turn pacing off/);
    expect(fs.readFileSync(REG_FILE, 'utf8')).toBe(bytes);
    expect(audits).toEqual([]);
  });

  it('refuses a body that does not mention rpm_limit at all', async () => {
    const r = await post('/api/connections/g1/rpm', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rpm_limit/);
  });

  it('answers 404 for a connection that is not there, naming where to look', async () => {
    const r = await setRpm('nope', 5);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/nope/);
    expect(r.body.error).toMatch(/Settings/);
  });

  it('audits the change with the old and the new value', async () => {
    await setRpm('g1', 7);
    await setRpm('g1', 12);
    const lines = audits.filter((a) => a.action === 'CONN_RPM');
    expect(lines).toHaveLength(2);
    expect(lines[0].details).toBe('Endpoint g1 (gemini) rpm_limit unset -> 7');
    expect(lines[1].details).toBe('Endpoint g1 (gemini) rpm_limit 7 -> 12');
    expect(lines[1].status).toBe(200);
  });

  it('writes no audit line when nothing changed', async () => {
    await setRpm('g1', 7);
    audits.length = 0;
    const r = await setRpm('g1', 7);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(false);
    expect(audits).toEqual([]);
  });
});

describe('an update never discards what the operator set', () => {
  beforeEach(async () => {
    await seedGemini();
    // Written straight to the file, not through the route or addEndpoint, so
    // these stay a test of the update semantics alone.
    const reg = onDisk();
    reg.endpoints.find((e) => e.id === 'g1').rpm_limit = 7;
    fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
  });

  const intact = () => {
    const row = rowOnDisk('g1');
    expect(row.rpm_limit).toBe(7);
    expect(row.models).toEqual(['m-one', 'm-two']);
    expect(row.preferred_model).toBe('m-two');
    expect(row.auth_refs).toEqual(['g1-key']);
    return row;
  };

  it('a label edit through POST /api/connections keeps the limit, the models and the preferred model', async () => {
    const r = await post('/api/connections', { id: 'g1', provider: 'gemini', label: 'Renamed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(intact().label).toBe('Renamed');
  });

  it('an empty models array from a form does not empty the saved list', async () => {
    const r = await post('/api/connections', { id: 'g1', provider: 'gemini', label: 'Again', models: [] });
    expect(r.status).toBe(200);
    intact();
  });

  it('adding a key keeps the limit', async () => {
    const r = await post('/api/connections/g1/keys', { apiKey: 'fixture-key-two', label: 'second' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = rowOnDisk('g1');
    expect(row.rpm_limit).toBe(7);
    expect(row.auth_refs).toHaveLength(2);
  });

  it('a bare addEndpoint({id, provider}) keeps every field it was not given', async () => {
    const ep = await endpoints.addEndpoint({ id: 'g1', provider: 'gemini' });
    expect(ep.label).toBe('My Gemini');
    expect(ep.rpm_limit).toBe(7);
    expect(ep.models).toEqual(['m-one', 'm-two']);
    expect(ep.preferred_model).toBe('m-two');
    expect(ep.base_url).toBe(rowOnDisk('g1').base_url);
    intact();
  });

  it('what the caller DOES send still wins, including 0 and a new model list', async () => {
    const ep = await endpoints.addEndpoint({ id: 'g1', provider: 'gemini', rpm_limit: 0, models: ['only'], preferred_model: 'only', label: 'New' });
    expect(ep.rpm_limit).toBe(0);
    expect(ep.models).toEqual(['only']);
    expect(ep.preferred_model).toBe('only');
    expect(ep.label).toBe('New');
  });

  it('a new connection is unaffected: the generic endpoint still starts at its default, an explicit value wins', async () => {
    const a = await endpoints.addEndpoint({ id: 'c2', provider: 'custom', base_url: 'http://127.0.0.1:9/v1' });
    expect(a.rpm_limit).toBe(30);
    const b = await endpoints.addEndpoint({ id: 'c3', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', rpm_limit: 8 });
    expect(b.rpm_limit).toBe(8);
    const g = await endpoints.addEndpoint({ id: 'g9', provider: 'gemini' });
    expect(g.rpm_limit).toBeNull();
  });

  it('an id reused for a different provider is a new connection, not an update', async () => {
    const ep = await endpoints.addEndpoint({ id: 'g1', provider: 'groq' });
    expect(ep.provider).toBe('groq');
    expect(ep.rpm_limit).toBeNull();
    expect(ep.models).toEqual([]);
  });

  it('the Add form can create a connection already paced, for any provider', async () => {
    const r = await post('/api/connections', { id: 'g2', provider: 'gemini', rpm_limit: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rowOnDisk('g2').rpm_limit).toBe(3);
  });

  it('the Add form refuses a bad limit with the same sentence, before saving anything', async () => {
    const r = await post('/api/connections', { id: 'g3', provider: 'gemini', rpm_limit: 9999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/whole number from 0 to 600/);
    expect(rowOnDisk('g3')).toBeUndefined();
  });
});

describe('the model that runs on this computer is not paced, and says so', () => {
  // The native local runtime has no provider quota to stay under, and no call
  // to it passes through the pacing seam. A limit saved on it would read
  // "Paced to N requests/min" on the card while nothing was ever delayed.
  it('POST /:id/rpm refuses a local connection and leaves the row as it was', async () => {
    fs.rmSync(REG_FILE, { force: true });
    await endpoints.addEndpoint({ id: 'loc', provider: 'local', models: ['m'] });
    const r = await setRpm('loc', 5);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/runs on this computer/);
    expect(r.body.error).toMatch(/does not pace it/);
    expect(rowOnDisk('loc').rpm_limit ?? null).toBeNull();
    expect(audits.filter((a) => a.action === 'CONN_RPM')).toHaveLength(0);
  });

  it('the Add form refuses a limit on a local connection before saving anything', async () => {
    const r = await post('/api/connections', { id: 'loc2', provider: 'local', rpm_limit: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/runs on this computer/);
    expect(rowOnDisk('loc2')).toBeUndefined();
  });

  it('a local connection with no limit is added as before, and a cloud one is still paced', async () => {
    const ok = await post('/api/connections', { id: 'loc3', provider: 'local' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(rowOnDisk('loc3').rpm_limit ?? null).toBeNull();
    const cloud = await post('/api/connections', { id: 'g7', provider: 'gemini', rpm_limit: 4 });
    expect(cloud.status).toBe(200);
    expect(rowOnDisk('g7').rpm_limit).toBe(4);
  });
});

describe('the registry helpers', () => {
  it('normalizeRpmLimit separates "unset" from a number from a refusal', () => {
    expect(endpoints.normalizeRpmLimit(7)).toEqual({ ok: true, value: 7 });
    expect(endpoints.normalizeRpmLimit('0')).toEqual({ ok: true, value: 0 });
    expect(endpoints.normalizeRpmLimit(600)).toEqual({ ok: true, value: 600 });
    expect(endpoints.normalizeRpmLimit(null)).toEqual({ ok: true, unset: true });
    expect(endpoints.normalizeRpmLimit('  ')).toEqual({ ok: true, unset: true });
    expect(endpoints.normalizeRpmLimit(601).ok).toBe(false);
    expect(endpoints.normalizeRpmLimit(NaN).ok).toBe(false);
    expect(endpoints.normalizeRpmLimit(Infinity).ok).toBe(false);
  });

  it('rpmDefault names only the one default that exists', () => {
    expect(endpoints.rpmDefault('custom')).toBe(30);
    for (const p of ['gemini', 'groq', 'openrouter', 'claude', 'openai', 'grok', 'lmstudio', 'local']) {
      expect(endpoints.rpmDefault(p), `${p} must not ship a number`).toBeNull();
    }
  });
});

describe('the route is generated and gated like its siblings', () => {
  it('is in the settings manifest behind a session', () => {
    const m = require('../src/blocks/settings/block.manifest.json');
    const hit = m.routes.find((r) => r.method === 'POST' && r.path === '/api/connections/:id/rpm');
    expect(hit, 'run node scripts/gen-block-routes.cjs').toBeTruthy();
    expect(hit.auth).toBe(true);
  });
});
