/**
 * vault-push honors the local-only gate every other cloud consumer honors.
 *
 * Found live, 2026-09-20 (CEO: "check supabase to matrix sync... triple
 * checked"). cloudvault.cjs's sbUpsert() built its own Supabase client from
 * raw process.env.SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, bypassing
 * services/cloud.js — the one client every other cloud consumer (sync.cjs,
 * ai.js, security.js, the terminal's isCloudLinked gate) shares via
 * deps.supabase, which is null under AEON_LOCAL_ONLY=1 or
 * AEON_PORTABLE=true specifically so a portable/local-only install cannot
 * reach a cloud mirror. A host with leftover SUPABASE_URL/KEY env vars would
 * still have pushed full Vault document content off that guarantee, because
 * the route asked process.env instead of the one client the kernel actually
 * gates. This test proves the raw env vars are never read at all, whether
 * or not they are set — the ONLY thing that may decide is deps.supabase.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

// Isolation BEFORE the require — see operator-gate-scope.test.js and
// tests/suite-touches-nothing.test.js. Not because cloudvault.cjs itself
// touches vault.cjs (it doesn't — this file's own name trips that gate's
// substring check, "cloudvault.cjs" ending in "vault.cjs"), but the
// project's own rule for any file whose require path might match is to set
// this first, defensively, rather than argue with the regex.
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cloudvault-secrets-'));

const require = createRequire(import.meta.url);
const cloudvaultFactory = require('../src/blocks/aeon_matrix/api/cloudvault.cjs');

let root, dataRoot, vault, servers, savedEnv;
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cloudvault-'));
  dataRoot = path.join(root, 'data');
  vault = path.join(root, 'Vault');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'vault_index.json'), JSON.stringify({
    documents: { 'a.md': { path: 'a.md', title: 'A', summary: 'sum', updatedAt: 1, sizeBytes: 10 } },
  }));
  servers = [];
  // Simulate the exact leaked-env condition the finding describes — a
  // previous non-portable install's credentials still sitting in the shell.
  savedEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://leaked-from-a-prior-install.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'leaked-service-role-key';
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

async function mount(deps) {
  const app = express(); app.use(express.json());
  app.use('/api', cloudvaultFactory({ DATA_ROOT: dataRoot, VAULT_ROOT: vault, ...deps }));
  const { server, port } = await listen(app);
  servers.push(server);
  return async () => (await fetch(`http://127.0.0.1:${port}/api/crn/second-brain/vault-push`, { method: 'POST' })).json();
}

describe('vault-push on a local-only install (deps.supabase is null)', () => {
  it('refuses honestly with 409, and never touches the leaked env credentials', async () => {
    let networkAttempted = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const url = String(args[0] || '');
      if (url.includes('leaked-from-a-prior-install')) networkAttempted = true;
      return origFetch(...args);
    };
    try {
      const push = await mount({ supabase: null });
      const body = await push();
      expect(networkAttempted).toBe(false);           // the raw env-var client must never be built
      expect(body.ok).toBe(false);
      expect(body.error).toBe('no_cloud_mirror');
      expect(body.message).toMatch(/local-only|not configured/i);
    } finally { globalThis.fetch = origFetch; }
  });
});

describe('vault-push with a real cloud mirror linked (deps.supabase set)', () => {
  it('upserts through the shared client, not a second one', async () => {
    const calls = [];
    const stubSupabase = {
      from: (table) => ({
        upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return { error: null }; },
      }),
    };
    const push = await mount({ supabase: stubSupabase });
    const body = await push();
    expect(body.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].table).toBe('vault_docs');
    expect(calls[0].opts).toEqual({ onConflict: 'path' });
    expect(calls[0].rows[0].path).toBe('a.md');
  });
});

// Review of audit #2 (2026-10-03): this read vault_index.json raw. Between a
// memory being switched off (or an agent set to Local only) and the next
// scan, a push uploaded that file's full text, and rows pushed before the
// switch stayed in vault_docs for good.
describe('vault-push never uploads what Memory Core withholds', () => {
  const put = (rel, body) => {
    const full = path.join(vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
  };

  it('skips withheld entries still in the index, and deletes the rows it pushed before the switch', async () => {
    put('Notes/plan.md', 'The launch plan.');
    put('Agents/Aeon/memory/memories.json', [{ id: 'off1', text: 'blue heron seven', timestamp: 1, active: false }]);
    put('Agents/Aeon/memory/off1.md', '---\nid: off1\nactive: false\n---\n\nblue heron seven\n');
    put('Agents/Scout/agent.json', { id: 'scout', name: 'Scout', privacy: 'local-only' });
    put('Agents/Scout/memory/s1.md', 'The Charizard ceiling is four hundred dollars.');
    const doc = (p) => ({ path: p, title: p, summary: 's', updatedAt: 2, sizeBytes: 10 });
    fs.writeFileSync(path.join(dataRoot, 'vault_index.json'), JSON.stringify({ documents: {
      'Notes/plan.md': doc('Notes/plan.md'),
      'Agents/Aeon/memory/off1.md': doc('Agents/Aeon/memory/off1.md'),
      'Agents/Scout/memory/s1.md': doc('Agents/Scout/memory/s1.md'),
    } }));
    fs.writeFileSync(path.join(dataRoot, 'cloudvault_state.json'), JSON.stringify({ pushed: {
      'Agents/Aeon/memory/off1.md': '1:10', 'Agents/Scout/memory/s1.md': '1:10',
    } }));
    const upserted = [];
    const deleted = [];
    const supabase = {
      from: () => ({
        upsert: async (rows) => { upserted.push(...rows); return { error: null }; },
        delete: () => ({ in: async (_col, paths) => { deleted.push(...paths); return { error: null }; } }),
      }),
    };
    const push = await mount({ supabase });
    const out = await push();
    expect(out).toMatchObject({ ok: true, pushed: 1, withheld: 2, removed: 2 });
    expect(upserted.map((r) => r.path)).toEqual(['Notes/plan.md']);
    expect(deleted.sort()).toEqual(['Agents/Aeon/memory/off1.md', 'Agents/Scout/memory/s1.md']);
    expect(JSON.stringify(upserted)).not.toMatch(/blue heron|Charizard/);
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, 'cloudvault_state.json'), 'utf8'));
    expect(Object.keys(state.pushed)).toEqual(['Notes/plan.md']);
  });

  it('a delete that fails is reported, not passed off as ok', async () => {
    put('Agents/Scout/agent.json', { id: 'scout', name: 'Scout', privacy: 'local-only' });
    fs.writeFileSync(path.join(dataRoot, 'cloudvault_state.json'), JSON.stringify({ pushed: { 'Agents/Scout/memory/s1.md': '1:10' } }));
    const supabase = {
      from: () => ({
        upsert: async () => ({ error: null }),
        delete: () => ({ in: async () => ({ error: { message: 'permission denied' } }) }),
      }),
    };
    const push = await mount({ supabase });
    const out = await push();
    expect(out.ok).toBe(false);
    expect(out.removeError).toMatch(/permission denied/);
    expect(out.hint).toMatch(/still in vault_docs/);
  });
});
