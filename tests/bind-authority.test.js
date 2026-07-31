// BO-0 — a fresh install must never serve the kernel to the network.
//
// Two independent locks are asserted here:
//   1. resolveBind() defaults to loopback in every mode (AEON_BIND opts out).
//   2. authGate.guard refuses guarded traffic when no account exists AND the
//      bind is exposed — because guardActive() is false in exactly that window.
//
// authGate reads the module-level sessionValidator singleton, so isolation
// follows the established VAULT_PATH-before-require pattern
// (see tests/security-block-missing.test.js).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bind-test-'));
process.env.VAULT_PATH = tempVault;
delete process.env.VERCEL;

const express = require('express');
const bind = require('../src/kernel/server-utils/bind.cjs');
const authGate = require('../src/kernel/authGate.cjs');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');

describe('bind authority', () => {
  it('defaults to loopback when AEON_BIND is unset', () => {
    expect(bind.resolveBind({})).toBe('127.0.0.1');
  });

  it('defaults to loopback even for a non-portable install', () => {
    // The pre-BO-0 default was 0.0.0.0 for anything not portable.
    expect(bind.resolveBind({ AEON_PORTABLE: 'false' })).toBe('127.0.0.1');
    expect(bind.resolveBind({ AEON_PORTABLE: undefined })).toBe('127.0.0.1');
  });

  it('honours an explicit AEON_BIND opt-out', () => {
    expect(bind.resolveBind({ AEON_BIND: '0.0.0.0' })).toBe('0.0.0.0');
    expect(bind.resolveBind({ AEON_BIND: '  192.168.1.9  ' })).toBe('192.168.1.9');
  });

  it('ignores an empty AEON_BIND rather than binding to ""', () => {
    expect(bind.resolveBind({ AEON_BIND: '   ' })).toBe('127.0.0.1');
  });

  it('recognises the whole 127.0.0.0/8 block plus IPv6 loopback', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', 'localhost', 'LOCALHOST']) {
      expect(bind.isLoopback(a)).toBe(true);
    }
    for (const a of ['0.0.0.0', '192.168.1.9', '10.0.0.5', '', null, undefined]) {
      expect(bind.isLoopback(a)).toBe(false);
    }
  });

  it('reports exposure from the resolved bind', () => {
    expect(bind.isExposed({})).toBe(false);
    expect(bind.isExposed({ AEON_BIND: '0.0.0.0' })).toBe(true);
  });
});

describe('first-run lockdown — no account on an exposed bind', () => {
  let server;
  let baseUrl;
  const originalBind = process.env.AEON_BIND;

  beforeEach(async () => {
    // No account seeded: this is the fresh-install window.
    const app = express();
    app.use(express.json());
    authGate.mountAuth(app);
    app.use(authGate.guard);
    app.get('/api/god/vault/tree', (req, res) => res.json({ ok: true, folders: ['secrets'] }));
    app.get('/api/auth/status', (req, res) => res.json({ ok: true, hasAccount: false }));
    app.post('/api/auth/setup', (req, res) => res.json({ ok: true, created: true }));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (originalBind === undefined) delete process.env.AEON_BIND;
    else process.env.AEON_BIND = originalBind;
    await new Promise(resolve => server.close(resolve));
  });

  afterAll(() => {
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  it('the guard is genuinely inactive in this window (the premise of the flag)', () => {
    expect(sessions.hasAccount()).toBe(false);
    expect(sessions.guardActive(sessions.loadPolicy())).toBe(false);
  });

  it('refuses God Mode from off-machine before setup', async () => {
    process.env.AEON_BIND = '0.0.0.0';
    const res = await fetch(`${baseUrl}/api/god/vault/tree`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('SETUP_INCOMPLETE');
    expect(body.folders).toBeUndefined();
  });

  it('refuses account creation from off-machine, so a stranger cannot claim the operator account', async () => {
    process.env.AEON_BIND = '0.0.0.0';
    const res = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'attacker', password: 'Whatever9!' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('SETUP_INCOMPLETE');
  });

  it('still answers the tiny pre-setup surface, so a client is told why', async () => {
    process.env.AEON_BIND = '0.0.0.0';
    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('leaves the local first-run flow untouched on the default bind', async () => {
    delete process.env.AEON_BIND; // loopback default
    const tree = await fetch(`${baseUrl}/api/god/vault/tree`);
    expect(tree.status).toBe(200);
    const setup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'CorrectHorse9!' }),
    });
    expect(setup.status).toBe(200);
  });
});
