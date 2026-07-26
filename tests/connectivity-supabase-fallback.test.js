// Found via the setup-wizard end-to-end test (2026-07-26, with a real
// Supabase project): pingSupabase() only ever tested the anon key. Some
// projects legitimately restrict anon-tier REST access entirely -- Supabase
// itself answers "Only the service_role API key can be used for this
// endpoint" -- which is a valid, hardened configuration, not proof the
// project/anon key pairing is wrong. Confirmed live: a real project's anon
// key was correctly rejected by Supabase (401), while its service role key
// worked fine (200) on the identical endpoint. The wizard's /test and /save
// routes used to treat that as "key rejected" and refuse to proceed, with no
// way forward for an operator whose project is simply configured this way.
//
// Fix: pingSupabase(url, key, fallbackKey) retries with the service role key
// when the primary key gets a 401/403, before rejecting outright.
// connectivity.js's cloudCredentials store resolves its file path off
// storage.js's VAULT_ROOT at require time -- isolate it the same way
// tests/vault-keyslots.test.js does, or this test touches the REAL project's
// default vault instead of a throwaway one.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-connectivity-fallback-'));
process.env.VAULT_PATH = tempVault;
// Keyslots live under AEON_SECRETS_DIR, a SEPARATE root from VAULT_PATH --
// without isolating this too, masterKey() falls back to the real project's
// secrets/aeon-keyslots.json, which won't match this test's master key.
process.env.AEON_SECRETS_DIR = path.join(tempVault, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-this-file-only';
delete process.env.VERCEL;

const require = createRequire(import.meta.url);
const express = require('express');
const mountConnectivity = require('../src/blocks/settings/api/connectivity.js');

describe('Supabase connectivity test/save falls back to the service role key', () => {
  let server;
  let originalFetch;

  afterAll(() => {
    delete process.env.VAULT_PATH;
    delete process.env.AEON_VAULT_MASTER_KEY;
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (server) server.close();
  });

  function mountApp() {
    const app = express();
    app.use(express.json());
    mountConnectivity(app, { lifecycle: { onCleanup: () => {} } });
    return app;
  }

  // Simulates Supabase's real behavior: the anon key gets 401'd on a project
  // that restricts anon-tier REST access; the service role key succeeds on
  // the identical endpoint. Only intercepts calls to the fake Supabase host —
  // everything else (including this test's own calls to its local Express
  // server) passes through to the real fetch, or mocking one breaks the other.
  function mockRestrictedProjectFetch() {
    global.fetch = vi.fn(async (url, opts) => {
      if (!String(url).includes('fake-project.supabase.co')) return originalFetch(url, opts);
      const key = opts.headers.apikey;
      if (key === 'good-service-role-key') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) };
    });
  }

  function mockGenuinelyBadCredentials() {
    global.fetch = vi.fn(async (url, opts) => {
      if (!String(url).includes('fake-project.supabase.co')) return originalFetch(url, opts);
      return { ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) };
    });
  }

  async function post(app, url, body) {
    const s = await new Promise(resolve => { const inst = app.listen(0, '127.0.0.1', () => resolve(inst)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    s.close();
    return { status: r.status, body: data };
  }

  it('an anon-key-restricted project (401 on anon, 200 on service role) is accepted when a service role key is provided', async () => {
    mockRestrictedProjectFetch();
    const app = mountApp();
    const r = await post(app, '/api/settings/connectivity/supabase/test', {
      url: 'https://fake-project.supabase.co',
      anonKey: 'anon-key-locked-down',
      serviceRoleKey: 'good-service-role-key',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('the same anon-key-restricted project is REJECTED with no service role key provided (no way to distinguish it from a genuinely bad key)', async () => {
    mockRestrictedProjectFetch();
    const app = mountApp();
    const r = await post(app, '/api/settings/connectivity/supabase/test', {
      url: 'https://fake-project.supabase.co',
      anonKey: 'anon-key-locked-down',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rejected/i);
  });

  it('genuinely bad credentials are still rejected even with a service role key provided (the fallback also fails)', async () => {
    mockGenuinelyBadCredentials();
    const app = mountApp();
    const r = await post(app, '/api/settings/connectivity/supabase/test', {
      url: 'https://fake-project.supabase.co',
      anonKey: 'totally-wrong',
      serviceRoleKey: 'also-wrong',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rejected/i);
  });

  it('save persists to the vault when the fallback validates a restricted project', async () => {
    mockRestrictedProjectFetch();
    const app = mountApp();
    const r = await post(app, '/api/settings/connectivity/supabase/save', {
      url: 'https://fake-project.supabase.co',
      anonKey: 'anon-key-locked-down',
      serviceRoleKey: 'good-service-role-key',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.cloudProviders?.supabase?.configured).toBe(true);
  });
});
