/**
 * BO-C3 · The shell-auth gate, exercised rather than read.
 *
 * tests/security.test.js proves that the characters "validateSession" appear
 * inside requireShellAuth's source text. It regex-extracts the function body
 * and asserts strings are present or absent in it. It never imports the gate
 * and never calls it, so it cannot observe what the gate DOES.
 *
 * That is why BO-C2's defect shipped with every gate green: a read-only widget
 * was mounted behind the raw-execution gate, and 401'd the operator on an
 * install whose auth guard was off. No string match can see that.
 *
 * §18, earned expensively: "Every security fix needs a functional test, not
 * only an absence test. If a fix cannot pass a test that drives the happy path
 * and asserts a real result, the fix is not done."
 *
 * This file drives all four real states. It keeps the source-level assertions
 * that are genuinely structural (no loopback exemption ANYWHERE in the body)
 * and adds the behaviour they were standing in for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** A security layer wired to throwaway paths — observes, never provisions. */
function makeSecurity(tmp) {
  const createSecurity = require(path.join(ROOT, 'security', 'security.js'));
  return createSecurity({
    supabase: null,
    getLocalFile: (f) => path.join(tmp, f),
    WORKSPACE: path.join(tmp, 'workspace'),
    AUDIT_FILE: path.join(tmp, 'audit.json'),
    SDI_VIOLATION_LOG: path.join(tmp, 'sdi.json'),
  });
}

/** Minimal express-shaped req/res that records what the handler did. */
function fakeReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    ip: '127.0.0.1',
    path: '/api/os/execute',
    method: 'POST',
    correlationId: 'TEST',
    ...overrides,
  };
}

function fakeRes() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    setHeader(k, v) { out.headers[k] = v; },
    _out: out,
  };
}

/** Run the middleware, reporting whether it called next(). */
function drive(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status: res._out.statusCode, body: res._out.body };
}

let tmp;
let savedSecret;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-shellauth-'));
  savedSecret = process.env.AEON_MOBILE_SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.AEON_MOBILE_SECRET;
  else process.env.AEON_MOBILE_SECRET = savedSecret;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('requireShellAuth — behaviour, not source text', () => {
  it('fails CLOSED with no session and no configured secret', () => {
    delete process.env.AEON_MOBILE_SECRET;
    const { requireShellAuth } = makeSecurity(tmp);
    const r = drive(requireShellAuth, fakeReq());

    expect(r.passed, 'must not reach the route').toBe(false);
    expect(r.status).toBe(503);
    // §08 — an error must name the remedy. Both remedies, cheapest first.
    expect(String(r.body.error)).toMatch(/sign in/i);
    expect(String(r.body.error)).toMatch(/AEON_MOBILE_SECRET/);
  });

  it('rejects a wrong Bearer when a secret IS configured', () => {
    process.env.AEON_MOBILE_SECRET = 'the-real-secret';
    const { requireShellAuth } = makeSecurity(tmp);
    const r = drive(requireShellAuth, fakeReq({
      headers: { authorization: 'Bearer not-the-secret' },
    }));

    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts the exact machine Bearer', () => {
    process.env.AEON_MOBILE_SECRET = 'the-real-secret';
    const { requireShellAuth } = makeSecurity(tmp);
    const r = drive(requireShellAuth, fakeReq({
      headers: { authorization: 'Bearer the-real-secret' },
    }));

    expect(r.passed, 'a valid machine token must reach the route').toBe(true);
    expect(r.status).toBeNull();
  });

  it('loopback earns no exemption — 127.0.0.1 with no credential is refused', () => {
    // §13's position, asserted as behaviour. It previously rested on the
    // ABSENCE of the string "127.0.0.1" in the function body, which would stay
    // green if someone reintroduced the bypass under a different spelling
    // (req.ip === '::1', a helper named isLoopback, a CIDR check).
    process.env.AEON_MOBILE_SECRET = 'the-real-secret';
    const { requireShellAuth } = makeSecurity(tmp);

    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']) {
      const r = drive(requireShellAuth, fakeReq({ ip }));
      expect(r.passed, `origin ${ip} must not bypass the gate`).toBe(false);
      expect(r.status).toBe(401);
    }
  });

  it('a client-supplied Host header cannot buy access', () => {
    process.env.AEON_MOBILE_SECRET = 'the-real-secret';
    const { requireShellAuth } = makeSecurity(tmp);
    const r = drive(requireShellAuth, fakeReq({
      headers: { host: 'localhost:3001' },
      get: (h) => (h.toLowerCase() === 'host' ? 'localhost:3001' : undefined),
    }));

    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it('the refusal never leaks the configured secret', () => {
    process.env.AEON_MOBILE_SECRET = 'super-secret-value';
    const { requireShellAuth } = makeSecurity(tmp);
    const r = drive(requireShellAuth, fakeReq({
      headers: { authorization: 'Bearer wrong' },
    }));

    expect(JSON.stringify(r.body)).not.toContain('super-secret-value');
  });
});

describe('the absence assertions that are still worth keeping', () => {
  const securityJs = fs.readFileSync(path.join(ROOT, 'security', 'security.js'), 'utf8');

  // Structural, not behavioural: these say "this shape appears nowhere",
  // which no single call can demonstrate. Kept deliberately, alongside the
  // behavioural gates above rather than instead of them.
  it('no loopback literal is used as an authentication decision', () => {
    const body = /const requireShellAuth = \(req, res, next\) => \{[\s\S]*?\n  \};/.exec(securityJs);
    expect(body, 'requireShellAuth not found — did it move?').toBeTruthy();
    expect(body[0]).not.toMatch(/isLocalhost/);
    expect(body[0]).not.toMatch(/127\.0\.0\.1/);
  });
});
