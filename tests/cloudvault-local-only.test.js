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
