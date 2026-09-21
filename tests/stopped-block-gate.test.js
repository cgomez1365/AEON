/**
 * A STOPPED block must refuse its own routes and nothing else.
 *
 * 2026-09-20 (BO-FLEET stranger install): a rebuilt block did
 * `router.use(express.json())`. blockHost's routerMatches() counted that
 * middleware layer — whose pattern matches every URL — as "this block would
 * handle the request", so once the block was installed (manual-start, stopped)
 * it answered POST /api/auth/login and GET /api/auth/status with
 * `503 block "inventory" is stopped`. The operator could not log in, so could
 * not press Start. One block's middleware bricked the whole console.
 *
 * The gate's own comment states the intent: refusing before matching "would 503
 * every other block's traffic whenever one stopped block exists". A generic
 * middleware layer must not defeat that.
 *
 * This drives the REAL block host with the REAL runState.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stopped-gate-'));
process.env.AEON_DB_DIR = path.join(TMP, 'db');          // before runState resolves it
const runState = require('../src/kernel/runState.cjs');
const { createBlockHost } = require('../src/kernel/blockHost.cjs');
const express = require('express');
const EXPRESS_PATH = require.resolve('express');

const BLOCKS = path.join(TMP, 'blocks');

function writeBlock(id, apiSource) {
  const dir = path.join(BLOCKS, id);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify({
    manifestVersion: '1.1.0', id, label: id, icon: '🧩', route: `/${id}`,
    description: 'fixture', category: 'tools', tier: 'experimental', version: '0.0.1',
    api_routes: true, provides: { routes: true, api: true, models: [] },
    contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false },
      storage: { type: 'none', scope: 'block', access: 'scoped' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'api', `${id}.cjs`), apiSource);
}

const withMiddleware = (id) => `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (_deps) => {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));           // the shape that bricked login
  router.get('/${id}/status', (_q, s) => s.json({ ok: true }));
  return router;
};`;

const plain = (id) => `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (_deps) => {
  const router = express.Router();
  router.get('/${id}/status', (_q, s) => s.json({ ok: true }));
  return router;
};`;

const nested = (id) => `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (_deps) => {
  const router = express.Router();
  const sub = express.Router();
  sub.get('/deep', (_q, s) => s.json({ ok: true }));
  router.use('/${id}/sub', sub);                          // a real nested router
  return router;
};`;

const apps = [];
async function startApp(id, source) {
  // One block per host: a control must not share a router with the block
  // under test, or it cannot say which one captured the request.
  const root = path.join(TMP, `blocks_${id}`);
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), fs.readFileSync(path.join(BLOCKS, id, 'block.manifest.json')));
  fs.writeFileSync(path.join(dir, 'api', `${id}.cjs`), source);
  runState.registerManual(id, { by: 'test' });               // installed = stopped
  const host = createBlockHost({
    blocksDir: root,
    baseDeps: { getDataFile: () => TMP, getBlockDataFile: (b) => path.join(TMP, b) },
    createScopedDeps: (b) => ({ ...b }),
    registry: [], readiness: {},
    getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
    log: { log() {}, warn() {}, error() {} },
  });
  host.rescan('test');
  const app = express();
  app.use(host.router);
  // Stand-ins for every OTHER route on the server (auth, other blocks, ...).
  app.post('/api/auth/login', (_q, s) => s.json({ ok: 'login reached' }));
  app.get('/api/auth/status', (_q, s) => s.json({ ok: 'status reached' }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  apps.push(server);
  const port = server.address().port;
  const call = (p, method = 'GET') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.end();
  });
  return call;
}

beforeAll(() => {
  writeBlock('gate_mw', withMiddleware('gate_mw'));
  writeBlock('gate_plain', plain('gate_plain'));
});

afterAll(async () => {
  for (const s of apps) { try { await new Promise((r) => s.close(r)); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('a stopped block refuses its own routes and only its own', () => {
  it('a stopped block WITH router-level middleware refuses its own route and lets login through', async () => {
    const call = await startApp('gate_mw', withMiddleware('gate_mw'));
    expect((await call('/api/gate_mw/status')).status).toBe(503);        // the gate is not removed
    const login = await call('/api/auth/login', 'POST');
    expect(login.status).toBe(200);                                      // was 503: operator locked out
    expect(login.body).toMatch(/login reached/);
    expect((await call('/api/auth/status')).status).toBe(200);
  });

  it('control: a stopped block WITHOUT middleware behaves the same (passes before and after the fix)', async () => {
    const call = await startApp('gate_plain', plain('gate_plain'));
    expect((await call('/api/gate_plain/status')).status).toBe(503);
    expect((await call('/api/auth/login', 'POST')).status).toBe(200);
  });

  it('a RUNNING block with middleware still serves its own route', async () => {
    const call = await startApp('gate_mw', withMiddleware('gate_mw'));
    runState.setRunning('gate_mw', true, { operator: 'test' });
    expect((await call('/api/gate_mw/status')).status).toBe(200);
  });

  it('a stopped block still refuses a route that lives in a NESTED router', async () => {
    writeBlock('gate_nested', nested('gate_nested'));
    const call = await startApp('gate_nested', nested('gate_nested'));
    expect((await call('/api/gate_nested/sub/deep')).status).toBe(503);
    expect((await call('/api/auth/login', 'POST')).status).toBe(200);
  });
});
