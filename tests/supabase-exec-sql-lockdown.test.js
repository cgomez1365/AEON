/**
 * A Supabase project that already has the old, open exec_sql is locked down
 * on its next setup or migrate run (audit #1 follow-up, 2026-10-03).
 *
 * The fixed bootstrap text only reached an operator whose project had NO
 * exec_sql: Settings → Cloud and tools/migrate.cjs printed it on that error
 * path alone. A project bootstrapped with the old text has exec_sql, so setup
 * answered "Cloud ready" and the function stayed callable by anyone holding
 * the anon key. Both now run the REVOKE/GRANT through exec_sql (as its owner)
 * before anything else, and stop if that fails.
 *
 * Drives the real setup route with a stub Supabase client that records every
 * SQL text it is given.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-exec-sql-lockdown-'));
process.env.VAULT_PATH = tempVault;
process.env.AEON_SECRETS_DIR = path.join(tempVault, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-this-file-only';
delete process.env.VERCEL;

const require = createRequire(import.meta.url);
const express = require('express');
const mountConnectivity = require('../src/blocks/settings/api/connectivity.js');
const execSql = require('../src/kernel/supabaseExecSql.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The route requires @supabase/supabase-js when it runs; the same resolved
// module is replaced in the require cache with a stub client.
const requireFromRoute = createRequire(require.resolve('../src/blocks/settings/api/connectivity.js'));
const SUPABASE_ID = requireFromRoute.resolve('@supabase/supabase-js');
let realSupabase;
let sent;
let answer;
function stubSupabase() {
  realSupabase = require.cache[SUPABASE_ID];
  require.cache[SUPABASE_ID] = {
    id: SUPABASE_ID, filename: SUPABASE_ID, loaded: true,
    exports: {
      createClient: () => ({
        rpc: async (fn, args) => { sent.push({ fn, sql: args.sql }); return { error: answer(args.sql) }; },
      }),
    },
  };
}

describe('lockDown()', () => {
  it('runs the REVOKE, GRANT and search_path through exec_sql', async () => {
    const calls = [];
    const r = await execSql.lockDown({ rpc: async (fn, args) => { calls.push({ fn, ...args }); return { error: null }; } });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('exec_sql');
    expect(calls[0].sql).toMatch(/REVOKE ALL ON FUNCTION public\.exec_sql\(text\) FROM PUBLIC, anon, authenticated;/);
    expect(calls[0].sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.exec_sql\(text\) TO service_role;/);
    expect(calls[0].sql).toMatch(/ALTER FUNCTION public\.exec_sql\(text\) SET search_path = public, extensions;/);
  });

  it('tells a missing exec_sql from one that refused, and never throws', async () => {
    const missing = await execSql.lockDown({ rpc: async () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.exec_sql(sql) in the schema cache' } }) });
    expect(missing).toMatchObject({ ok: false, missing: true });
    const refused = await execSql.lockDown({ rpc: async () => ({ error: { code: '42501', message: 'must be owner of function exec_sql' } }) });
    expect(refused).toMatchObject({ ok: false, missing: false, error: 'must be owner of function exec_sql' });
    const threw = await execSql.lockDown({ rpc: async () => { throw new Error('fetch failed'); } });
    expect(threw).toMatchObject({ ok: false, missing: false, error: 'fetch failed' });
  });

  it('the bootstrap pins a search_path that still finds pgvector in `extensions`', () => {
    expect(execSql.BOOTSTRAP_SQL).toMatch(/SECURITY DEFINER SET search_path = public, extensions AS \$\$/);
  });
});

describe('POST /supabase/setup on a project that already has exec_sql', () => {
  let server;
  let originalFetch;

  beforeEach(async () => {
    sent = [];
    answer = () => null;
    originalFetch = global.fetch;
    // Saving the credentials pings the project first.
    global.fetch = vi.fn(async (url, opts) => {
      if (!String(url).includes('fake-project.supabase.co')) return originalFetch(url, opts);
      return { ok: true, status: 200, json: async () => ({}) };
    });
    stubSupabase();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (realSupabase) require.cache[SUPABASE_ID] = realSupabase; else delete require.cache[SUPABASE_ID];
    if (server) server.close();
  });
  afterAll(() => {
    delete process.env.VAULT_PATH;
    delete process.env.AEON_VAULT_MASTER_KEY;
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  async function setup() {
    const app = express();
    app.use(express.json());
    mountConnectivity(app, { lifecycle: { onCleanup: () => {} } });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/settings/connectivity/supabase`;
    const call = async (route, body) => {
      const r = await originalFetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return { status: r.status, body: await r.json() };
    };
    const saved = await call('save', { url: 'https://fake-project.supabase.co', anonKey: 'test-anon-key-not-a-real-one', serviceRoleKey: 'test-service-role-key-not-a-real-one' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return call('setup');
  }

  it('locks exec_sql down first, then applies the schemas, and says so', async () => {
    const r = await setup();
    expect(r.status).toBe(200);
    expect(r.body.execSqlLocked).toBe(true);
    expect(r.body.message).toContain(execSql.LOCKED_NOTE);
    expect(sent[0].sql).toBe(execSql.LOCKDOWN_SQL);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('a lockdown that fails stops setup: nothing else runs through exec_sql', async () => {
    answer = (sql) => (sql === execSql.LOCKDOWN_SQL ? { code: '42501', message: 'must be owner of function exec_sql' } : null);
    const r = await setup();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/could not be locked to the service role/);
    expect(r.body.error).toContain(execSql.LOCKDOWN_SQL);
    expect(sent).toHaveLength(1);
  });

  it('no exec_sql: the bootstrap, with PUBLIC revoked, and nothing applied', async () => {
    answer = () => ({ code: 'PGRST202', message: 'Could not find the function public.exec_sql(sql) in the schema cache' });
    const r = await setup();
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(execSql.BOOTSTRAP_SQL);
    expect(sent).toHaveLength(1);
  });
});

describe('tools/migrate.cjs', () => {
  it('locks exec_sql down before its first statement through it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'migrate.cjs'), 'utf8');
    const lock = src.indexOf('execSql.lockDown(db)');
    expect(lock).toBeGreaterThan(-1);
    expect(src.indexOf('await run(', lock)).toBeGreaterThan(lock);
    expect(src.slice(0, lock)).not.toMatch(/await run\(/);
  });
});
