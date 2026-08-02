// requireOperator — the console must not depend on a switch that defaults off.
//
// The Operator Console router was mounted with NO middleware, relying entirely
// on the global auth gate. That gate returns next() whenever guardActive() is
// false, and DEFAULT_POLICY.guardEnabled is false — so on a stock install every
// console route, including /file-save (an arbitrary-filename vault write), was
// reachable by anyone who could talk to the port.
//
// The fix has to hold one line it must never cross: the owner cannot be locked
// out of their own fresh install. A brand-new install has no account, so there
// is no session that could possibly exist yet — that window is allowed, but
// only from the machine itself. It is never opened to the network.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(__dirname, '..', 'src', 'kernel', 'server-utils', 'sessionValidator.cjs');

/** Load requireOperator with a stubbed session validator. */
function loadGate({ sessionOk, accountExists }) {
  delete require.cache[require.resolve('../src/kernel/server-utils/requireOperator.cjs')];
  delete require.cache[VALIDATOR];
  require.cache[VALIDATOR] = {
    id: VALIDATOR,
    filename: VALIDATOR,
    loaded: true,
    exports: {
      validateSession: () => (sessionOk ? { ok: true } : { ok: false, reason: 'no-session' }),
      hasAccount: () => accountExists,
    },
  };
  const { requireOperator } = require('../src/kernel/server-utils/requireOperator.cjs');
  return requireOperator({ name: 'Test Console' });
}

function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip }, method: 'POST', originalUrl: '/api/console/file-save', headers: {} };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function run(gate, ip) {
  const req = fakeReq(ip);
  const res = fakeRes();
  let passed = false;
  gate(req, res, () => { passed = true; });
  return { passed, res };
}

const LOOPBACK = '127.0.0.1';
const LAN = '192.168.1.50';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('requireOperator', () => {
  it('allows a valid session from anywhere', () => {
    const gate = loadGate({ sessionOk: true, accountExists: true });
    expect(run(gate, LOOPBACK).passed).toBe(true);
    expect(run(gate, LAN).passed).toBe(true);
  });

  it('refuses a session-less caller once an account exists — including loopback', () => {
    // This is the case the old code got wrong. Loopback is not authentication:
    // a malicious local process, a compromised browser tab and an exposed dev
    // proxy all originate from 127.0.0.1.
    const gate = loadGate({ sessionOk: false, accountExists: true });
    const local = run(gate, LOOPBACK);
    expect(local.passed).toBe(false);
    expect(local.res.statusCode).toBe(401);

    const lan = run(gate, LAN);
    expect(lan.passed).toBe(false);
    expect(lan.res.statusCode).toBe(401);
  });

  it('refuses a session-less LAN caller before any account exists', () => {
    // The pre-account window must never be reachable from the network — that
    // was the "fresh install serves the console to the whole LAN" hole.
    const gate = loadGate({ sessionOk: false, accountExists: false });
    const lan = run(gate, LAN);
    expect(lan.passed).toBe(false);
    expect(lan.res.statusCode).toBe(401);
  });

  it('allows loopback before any account exists, so the owner can set up', () => {
    // Owner control: a fresh install has no account, so no session can exist.
    // Refusing here would lock the owner out of their own machine.
    const gate = loadGate({ sessionOk: false, accountExists: false });
    expect(run(gate, LOOPBACK).passed).toBe(true);
  });

  it('fails closed when the session validator throws', () => {
    delete require.cache[require.resolve('../src/kernel/server-utils/requireOperator.cjs')];
    delete require.cache[VALIDATOR];
    require.cache[VALIDATOR] = {
      id: VALIDATOR, filename: VALIDATOR, loaded: true,
      exports: {
        validateSession: () => { throw new Error('vault unreadable'); },
        hasAccount: () => true,
      },
    };
    const { requireOperator } = require('../src/kernel/server-utils/requireOperator.cjs');
    const gate = requireOperator({ name: 'Test Console' });
    const out = run(gate, LOOPBACK);
    expect(out.passed).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });

  it('the console router is actually mounted behind it', () => {
    const fs = require('fs');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    expect(server).toMatch(/app\.use\('\/api\/console',\s*requireOperator\(/);
  });
});
