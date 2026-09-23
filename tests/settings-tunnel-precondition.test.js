/**
 * Settings → Remote Access must not publish an unprotected AEON.
 *
 * cloudflared connects to http://localhost:<PORT>, so every request that comes
 * through the tunnel reaches the server from 127.0.0.1. security.js's tunnel
 * Bearer gate and rate limiter both skip loopback callers, so neither ever
 * applies to tunnel traffic (read 2026-09-23: security/security.js:61-65 and
 * :81-84). The only protection a tunnel visitor meets is the operator session
 * guard — which is OFF until an account exists and can be switched off after.
 *
 * Yet /tunnel/start started with no precondition, and its reply told the
 * operator "API calls from outside require your AEON_MOBILE_SECRET as a Bearer
 * token" — false for the reason above. With no account, one click published
 * every route of this AEON (keys, files, shell-gated or not) to anyone with the
 * URL.
 *
 * Now: start refuses (409) unless an operator account exists AND the guard is
 * on, before anything is downloaded or spawned; the status says what actually
 * protects the tunnel. The tunnel itself was never started for this test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tunnel-precondition-'));
process.env.VAULT_PATH = tempVault;
process.env.AEON_SECRETS_DIR = path.join(tempVault, 'secrets');
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-this-file-only';
delete process.env.VERCEL;

const require = createRequire(import.meta.url);
const express = require('express');
const mountConnectivity = require('../src/blocks/settings/api/connectivity.js');

let server;
let originalFetch;
let downloads;

function start(sessionValidator) {
  const app = express();
  app.use(express.json());
  mountConnectivity(app, { lifecycle: { onCleanup: () => {} }, sessionValidator });
  return new Promise((r) => { server = app.listen(0, '127.0.0.1', () => r(server.address().port)); });
}

const call = (port, p, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json' } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { let json = {}; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, body: json }); });
  });
  req.on('error', reject);
  req.end(method === 'POST' ? '{}' : undefined);
});

beforeEach(() => {
  downloads = 0;
  // No test here may download cloudflared or start a tunnel. A download
  // attempt is counted and refused. (Spawn is not stubbable here — the module
  // destructures it at load — so the refusal must come before the download,
  // which is what these tests assert. No cloudflared binary exists in a fresh
  // checkout: tools/bin/ is gitignored.)
  originalFetch = global.fetch;
  global.fetch = async () => { downloads++; throw new Error('network disabled in this test'); };
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

afterAll(() => {
  delete process.env.VAULT_PATH;
  delete process.env.AEON_VAULT_MASTER_KEY;
  fs.rmSync(tempVault, { recursive: true, force: true });
});

const validator = ({ account, guard }) => ({
  hasAccount: () => account,
  guardActive: () => account && guard,
});

describe('tunnel/start refuses when nothing would protect the tunnel', () => {
  it('no operator account: 409, nothing downloaded or spawned', async () => {
    const port = await start(validator({ account: false, guard: false }));
    const r = await call(port, '/api/settings/connectivity/tunnel/start', 'POST');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toMatch(/account/i);
    expect(downloads).toBe(0);
  });

  it('account but the login guard switched off: 409, nothing downloaded or spawned', async () => {
    const port = await start(validator({ account: true, guard: false }));
    const r = await call(port, '/api/settings/connectivity/tunnel/start', 'POST');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/login/i);
    expect(downloads).toBe(0);
  });
});

describe('status says what actually protects tunnel traffic', () => {
  it('reports the login guard, not the Bearer secret', async () => {
    const port = await start(validator({ account: true, guard: false }));
    const r = await call(port, '/api/settings/connectivity');
    expect(r.status).toBe(200);
    expect(r.body.tunnel.accountExists).toBe(true);
    expect(r.body.tunnel.loginRequired).toBe(false);
    expect(r.body.tunnel.secured).toBe(false);
  });

  it('secured only when an account exists and login is required', async () => {
    const port = await start(validator({ account: true, guard: true }));
    const r = await call(port, '/api/settings/connectivity');
    expect(r.body.tunnel.secured).toBe(true);
  });
});

describe('no false claim is left in the reply', () => {
  it('the start reply no longer says the Bearer secret guards tunnel traffic', () => {
    const src = fs.readFileSync(require.resolve('../src/blocks/settings/api/connectivity.js'), 'utf8');
    expect(src).not.toMatch(/API calls from outside require your AEON_MOBILE_SECRET/);
  });
});
