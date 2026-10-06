/**
 * The kernel's rule for "this connection cannot be given that model".
 *
 * assignRole was a bare write, so a model its connection never listed went
 * straight into the registry (and, through the routes, into settings.models,
 * which is what the router sends to the provider). The readiness badge already
 * called that pair broken after the fact; this is the same rule at write time.
 *
 * Only a hosted vendor's stored list is authoritative. A local runtime and LM
 * Studio load models without telling the registry, a custom server's list can
 * be one hand-typed entry, and an empty list means discovery never ran.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-model-refusal-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-model-refusal';
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const endpoints = require('../src/kernel/endpoints.cjs');
const REG_FILE = path.join(process.env.AEON_SECRETS_DIR, 'aeon-endpoints.json');

const ENDPOINTS = [
  { id: 'or1', provider: 'openrouter', models: ['openrouter/free'], reachable_from: ['local', 'cloud'] },
  { id: 'gm1', provider: 'gemini', models: ['gemini-2.5-flash', 'gemini-flash-latest'], reachable_from: ['local', 'cloud'] },
  { id: 'gq1', provider: 'groq', models: [], reachable_from: ['local', 'cloud'] },
  { id: 'gq2', provider: 'groq', reachable_from: ['local', 'cloud'] },
  { id: 'lm1', provider: 'lmstudio', models: ['qwen-in-lm-studio'], reachable_from: ['local'] },
  { id: 'cu1', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', models: ['only-one'], reachable_from: ['local'] },
  { id: 'lo1', provider: 'local', models: ['listed-local'], reachable_from: ['local'] },
];

beforeEach(() => {
  fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: ENDPOINTS, roles: {} }));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ep = (id) => ENDPOINTS.find((e) => e.id === id);
const roles = () => JSON.parse(fs.readFileSync(REG_FILE, 'utf8')).roles;

describe('modelRefusal', () => {
  it('refuses a model a hosted provider does not list, in the words readiness uses', () => {
    const why = endpoints.modelRefusal(ep('or1'), 'gemini-flash-latest');
    expect(why).toBe('openrouter does not serve "gemini-flash-latest". Pick a model this provider offers in Settings → Model Assignment, or re-scan the provider\'s model list.');
  });

  it('allows a model the hosted provider lists', () => {
    expect(endpoints.modelRefusal(ep('gm1'), 'gemini-flash-latest')).toBeNull();
  });

  it.each([
    ['an empty list (discovery never ran)', 'gq1'],
    ['no list at all', 'gq2'],
    ['LM Studio', 'lm1'],
    ['a custom server', 'cu1'],
    ['the local runtime', 'lo1'],
  ])('does not refuse on %s', (_label, id) => {
    expect(endpoints.modelRefusal(ep(id), 'something-not-listed')).toBeNull();
  });

  it('does not refuse for a connection it cannot see', () => {
    expect(endpoints.modelRefusal(undefined, 'x')).toBeNull();
  });
});

describe('assignRole', () => {
  it('rejects with a 400 and writes nothing for a model a hosted provider does not list', async () => {
    await expect(endpoints.assignRole('chat', 'or1', 'gemini-flash-latest', null, null))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/openrouter does not serve "gemini-flash-latest"/) });
    expect(roles()).toEqual({});
  });

  it('assigns a model the hosted provider lists', async () => {
    const mapping = await endpoints.assignRole('chat', 'gm1', 'gemini-flash-latest', null, null);
    expect(mapping).toMatchObject({ endpoint_id: 'gm1', model: 'gemini-flash-latest' });
    expect(roles().chat).toMatchObject({ endpoint_id: 'gm1', model: 'gemini-flash-latest' });
  });

  it.each([
    ['an empty list', 'gq1'],
    ['LM Studio', 'lm1'],
    ['a custom server', 'cu1'],
    ['the local runtime', 'lo1'],
    ['an unknown connection', 'nope'],
  ])('still assigns where the list proves nothing: %s', async (_label, id) => {
    await expect(endpoints.assignRole('research', id, 'something-not-listed', null, null)).resolves.toMatchObject({ endpoint_id: id });
  });
});
