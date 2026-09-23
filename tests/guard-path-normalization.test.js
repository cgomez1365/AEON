/**
 * The session guards must see a request the way Express routes it.
 *
 * Measured 2026-09-23 on a live server with an operator account and the guard
 * ON, no session:
 *
 *   GET  /api/connections                 401
 *   GET  /API/connections                 200   <- the endpoint list
 *   POST /API/build/blocks/writer/stop    200   <- stopped a block
 *   GET  /BLOCKS/registry, /CORE/state    200
 *
 * Express routes case-insensitively; isGuardedPath() and the manifest route
 * matcher compared case-sensitively, so any capitalisation walked past both.
 *
 * Same run, guard OFF (account present — the manifest guard is the only
 * protection then): a route declared `ALL` reached its handler with no session
 * while a GET-declared route was refused — the matcher compared
 * `r.method === method` and nothing sends the method "ALL".
 *
 * And GET /api/health, pre-auth by the gate's own list, answered 401
 * `declaredBy: host_os manifest: GET /api/health`: the manifest guard asked
 * isPreAuthRequest() about the MOUNT-RELATIVE path (`/health`, the block router
 * is mounted at /api), which is on no list.
 *
 * This drives the REAL auth gate, the REAL block host and the REAL manifest
 * guard over a fixture block in a temp tree; only the account is a fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-guard-case-'));
// Same isolation pattern as security-block-missing.test.js: before any require
// resolves the Vault / secrets / run-state roots.
process.env.VAULT_PATH = path.join(TMP, 'Vault');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
process.env.AEON_DB_DIR = path.join(TMP, 'db');
delete process.env.VERCEL;

const express = require('express');
const authGate = require('../src/kernel/authGate.cjs');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const { createBlockHost } = require('../src/kernel/blockHost.cjs');
const { manifestAuthGuard, compilePath } = require('../src/kernel/manifestRouteAuth.cjs');
const EXPRESS_PATH = require.resolve('express');

const BLOCKS = path.join(TMP, 'blocks');
const ID = 'probe';

function writeFixtureBlock() {
  const dir = path.join(BLOCKS, ID);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify({
    manifestVersion: '1.1.0', id: ID, label: ID, icon: 'x', route: `/${ID}`,
    description: 'fixture', category: 'tools', tier: 'experimental', version: '0.0.1',
    api_routes: true, provides: { routes: true, api: true, models: [] },
    contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false },
      storage: { type: 'none', scope: 'block', access: 'scoped' } },
    // Exactly the shapes the generator emits today, host_os's /api/health included.
    routes: [
      { method: 'GET', path: '/api/health', auth: true },
      { method: 'GET', path: '/api/probe/secret', auth: true },
      { method: 'POST', path: '/api/probe/stop', auth: true },
      { method: 'ALL', path: '/api/probe/any', auth: true },
    ],
  }, null, 2));
  // Router shape (arity 1) — mounted at /api, like host_os/system.cjs.
  fs.writeFileSync(path.join(dir, 'api', 'router.cjs'), `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (_deps) => {
  const router = express.Router();
  router.get('/health', (_q, s) => s.json({ reached: 'health' }));
  router.get('/probe/secret', (_q, s) => s.json({ reached: 'secret' }));
  router.post('/probe/stop', (_q, s) => s.json({ reached: 'stop' }));
  return router;
};`);
  // Plugin shape (arity 2) with a computed verb list — the generator emits ALL.
  fs.writeFileSync(path.join(dir, 'api', 'plugin.cjs'), `
module.exports = (app, _deps) => {
  ['get', 'post'].forEach((m) => app[m]('/api/probe/any', (_q, s) => s.json({ reached: 'any' })));
};`);
}

function seedAccount() {
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  sessions.saveUser({
    username: 'operator', displayName: 'Operator', role: 'operator',
    salt, passHash: crypto.scryptSync('Fixture-Pass-1', salt, 64).toString('hex'),
    failedAttempts: 0, lockedUntil: 0, createdAt: new Date().toISOString(),
    sessions: { 'fixture-token': { created: now, lastSeen: now, expires: now + 3_600_000 } },
  });
}

let server;
let port;

beforeAll(async () => {
  writeFixtureBlock();
  const host = createBlockHost({
    blocksDir: BLOCKS,
    baseDeps: { getDataFile: () => TMP, getBlockDataFile: (b) => path.join(TMP, b) },
    createScopedDeps: (b) => ({ ...b }),
    registry: [], readiness: {},
    getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
    log: { log() {}, warn() {}, error() {} },
  });
  const r = host.rescan('test');
  if (r.skipped.length) throw new Error(`fixture did not mount: ${JSON.stringify(r.skipped)}`);
  const app = express();
  app.use(authGate.guard);          // server.js order: gate, then the block host
  app.use(host.router);
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(sessions.AUTH_FILE, { force: true }); } catch {}
  try { fs.rmSync(sessions.POLICY_FILE, { force: true }); } catch {}
  delete process.env.VAULT_PATH;
  delete process.env.AEON_DB_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = (p, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

describe('isGuardedPath follows Express, which is case-insensitive', () => {
  it.each(['/API/settings', '/Api/connections', '/BLOCKS/registry', '/Blocks', '/CORE/state', '/EVENTS', '/WS', '/BLOCK/x/y'])(
    'guards %s', (p) => { expect(sessions.isGuardedPath(p)).toBe(true); });

  it.each(['/', '/assets/index.js', '/APIARY', '/WSX'])('still does not guard %s', (p) => {
    expect(sessions.isGuardedPath(p)).toBe(false);
  });
});

describe('manifest path compilation', () => {
  it('matches a declared path in any case, as Express would route it', () => {
    expect(compilePath('/api/probe/secret').test('/API/Probe/SECRET')).toBe(true);
  });
});

describe('guard ON, account present, no session', () => {
  beforeEach(() => {
    seedAccount();
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: true, lockEveryLaunch: false });
  });

  it.each([
    ['GET', '/api/probe/secret'],
    ['GET', '/API/probe/secret'],
    ['GET', '/Api/PROBE/secret'],
    ['POST', '/API/probe/stop'],
  ])('%s %s is refused', async (method, p) => {
    const r = await call(p, method);
    expect(r.status, `${method} ${p} answered ${r.status}: ${r.body}`).toBe(401);
    expect(r.body).not.toMatch(/reached/);
  });

  it('the same routes answer with a valid session (the fix did not just close everything)', async () => {
    const h = { authorization: 'Bearer fixture-token' };
    expect((await call('/API/probe/secret', 'GET', h)).status).toBe(200);
    expect((await call('/api/probe/any', 'POST', h)).status).toBe(200);
  });
});

describe('guard OFF, account present — the manifest guard is the only protection', () => {
  beforeEach(() => {
    seedAccount();
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: false, lockEveryLaunch: false });
  });

  it('control: a GET-declared route is refused without a session', async () => {
    expect((await call('/api/probe/secret')).status).toBe(401);
  });

  it('an upper-case spelling of the same route is refused too', async () => {
    const r = await call('/API/PROBE/SECRET');
    expect(r.status, r.body).toBe(401);
  });

  it('HEAD runs the GET handler in Express, so it is refused like GET', async () => {
    expect((await call('/api/probe/secret', 'HEAD')).status).toBe(401);
  });

  it.each(['GET', 'POST'])('a route declared ALL is refused for %s without a session', async (method) => {
    const r = await call('/api/probe/any', method);
    expect(r.status, `ALL-declared route answered ${r.status}: ${r.body}`).toBe(401);
    expect(r.body).toMatch(/probe manifest: ALL \/api\/probe\/any/);
  });
});

describe('a block router\'s /block/<id> copy is judged as the /api route it serves (agent C4)', () => {
  // blockHost mounts every router-shaped block API twice: at /api and at
  // /block/<id>. Manifests declare only the /api form, and the guard matched
  // req.originalUrl — so /block/host_os/fs/list answered the Vault listing with
  // no session while /api/fs/list was refused (measured 2026-09-23, guard off).
  beforeEach(() => {
    seedAccount();
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: false, lockEveryLaunch: false });
  });

  it.each([
    ['GET', '/block/probe/probe/secret'],
    ['GET', '/BLOCK/probe/PROBE/secret'],
    ['POST', '/block/probe/probe/stop'],
  ])('%s %s is refused without a session', async (method, p) => {
    const r = await call(p, method);
    expect(r.status, `${method} ${p} answered ${r.status}: ${r.body}`).toBe(401);
    expect(r.body).not.toMatch(/reached/);
  });

  it('and answers with one', async () => {
    const r = await call('/block/probe/probe/secret', 'GET', { authorization: 'Bearer fixture-token' });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/reached/);
  });
});

describe('pre-auth routes stay open through a mounted block router', () => {
  beforeEach(() => {
    seedAccount();
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: true, lockEveryLaunch: false });
  });

  it('GET /api/health answers without a session, as the gate declares', async () => {
    const r = await call('/api/health');
    expect(r.status, `/api/health answered ${r.status}: ${r.body}`).toBe(200);
    expect(r.body).toMatch(/reached/);
  });

  it('isPreAuthRequest judges the full request path, not the mount-relative one', () => {
    // What a router mounted at /api sees: req.path is '/health', originalUrl is the truth.
    expect(sessions.isPreAuthRequest({ method: 'GET', path: '/health', originalUrl: '/api/health', headers: {} })).toBe(true);
    // ...and the reverse: a mount-relative path that LOOKS pre-auth is not.
    expect(sessions.isPreAuthRequest({ method: 'POST', path: '/api/auth/login', originalUrl: '/api/x/api/auth/login', headers: {} })).toBe(false);
  });

  it('a route that is not pre-auth is still refused through the same mount', async () => {
    expect((await call('/api/probe/secret')).status).toBe(401);
  });
});

describe('the generator and the gate share one pre-auth authority', () => {
  it('isPreAuthRoute answers for /api/health and GET /api/security/policy', () => {
    expect(typeof sessions.isPreAuthRoute).toBe('function');
    expect(sessions.isPreAuthRoute('GET', '/api/health')).toBe(true);
    expect(sessions.isPreAuthRoute('GET', '/api/security/policy')).toBe(true);
    expect(sessions.isPreAuthRoute('POST', '/api/security/policy')).toBe(false);
    expect(sessions.isPreAuthRoute('POST', '/api/auth/login')).toBe(true);
    expect(sessions.isPreAuthRoute('GET', '/api/connections')).toBe(false);
  });

  it('scripts/gen-block-routes.cjs decides auth through isPreAuthRoute', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gen-block-routes.cjs'), 'utf8');
    expect(src).toMatch(/isPreAuthRoute\(\s*r\.method\s*,\s*r\.path\s*\)/);
  });
});
