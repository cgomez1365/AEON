/**
 * BO-C2 · The widget gate matches the surface it guards.
 *
 * GET /api/host_os/widget returns a read-only audit tail. It was mounted behind
 * requireShellAuth — the raw-EXECUTION gate — which demands a session
 * unconditionally, while the global auth gate is opt-in and off by default. On
 * a stock install (no account, guardEnabled false) the operator uses AEON
 * legitimately with no session, so their own control surface answered 401 on
 * every Settings load and again every 30 seconds.
 *
 * Every gate was green when that shipped, because the security tests asserted
 * the presence of strings in a file rather than the behaviour of a request.
 * These drive it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shouldBannerResponse } from '../src/utils/interceptorPolicy.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VALIDATOR = path.join(ROOT, 'src', 'kernel', 'server-utils', 'requireOperator.cjs');
const SESSIONS = path.join(ROOT, 'src', 'kernel', 'server-utils', 'sessionValidator.cjs');

/** requireOperator with a stubbed session validator — observes, never provisions. */
function loadGate({ sessionOk, accountExists }) {
  delete require.cache[require.resolve(VALIDATOR)];
  delete require.cache[SESSIONS];
  require.cache[SESSIONS] = {
    id: SESSIONS, filename: SESSIONS, loaded: true,
    exports: {
      validateSession: () => (sessionOk ? { ok: true } : { ok: false, reason: 'no-session' }),
      hasAccount: () => accountExists,
    },
  };
  const { requireOperator } = require(VALIDATOR);
  return requireOperator({ name: 'Operator Console widget' });
}

function drive(mw, { ip = '127.0.0.1' } = {}) {
  const req = { ip, socket: { remoteAddress: ip }, method: 'GET',
                originalUrl: '/api/host_os/widget', headers: {} };
  const out = { status: null, body: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, ...out };
}

let saved;
beforeEach(() => { saved = process.env.AEON_MOBILE_SECRET; delete process.env.AEON_MOBILE_SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.AEON_MOBILE_SECRET; else process.env.AEON_MOBILE_SECRET = saved; });

describe('the widget route is not behind the execution gate', () => {
  it('host_os mounts the widget with requireOperator, not requireShellAuth', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'os.cjs'), 'utf8');
    const line = src.split('\n').find(l => l.includes("router.get('/host_os/widget'"));
    expect(line, 'widget route not found').toBeTruthy();
    expect(line).toContain('requireOperator');
    expect(line).not.toContain('requireShellAuth');
  });

  it('the execution routes keep requireShellAuth', () => {
    // §13 is untouched by this change. If this fails, the fix went too far.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'os.cjs'), 'utf8');
    expect(src).toMatch(/requireShellAuth/);
  });
});

describe('the widget answers the owner and refuses the network', () => {
  it('a stock install — no account, owner at the keyboard — is allowed', () => {
    // The exact state of the operator whose screenshot opened BO-C:
    // hasAccount() false, guardEnabled false, request from 127.0.0.1.
    const r = drive(loadGate({ sessionOk: false, accountExists: false }));
    expect(r.passed, 'the owner must not be locked out of their own console').toBe(true);
    expect(r.status).toBeNull();
  });

  it('the same request from off-box is refused', () => {
    const r = drive(loadGate({ sessionOk: false, accountExists: false }), { ip: '192.168.1.50' });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it('once an account exists, a session is required even on loopback', () => {
    const r = drive(loadGate({ sessionOk: false, accountExists: true }));
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
    expect(String(r.body.error)).toMatch(/sign in/i);
  });

  it('a valid session is allowed from any origin', () => {
    const r = drive(loadGate({ sessionOk: true, accountExists: true }), { ip: '10.0.0.9' });
    expect(r.passed).toBe(true);
  });
});

describe('one failure, one rendering', () => {
  it('a self-reported 401 does not also raise the forensics banner', () => {
    expect(shouldBannerResponse({
      url: '/api/host_os/widget', ok: false, status: 401, selfReported: true,
    })).toBe(false);
  });

  it('a NON-self-reported 401 still banners', () => {
    expect(shouldBannerResponse({
      url: '/api/host_os/widget', ok: false, status: 401,
    })).toBe(true);
  });

  it('a self-reported 500 still banners — a defect is not a permission state', () => {
    expect(shouldBannerResponse({
      url: '/api/host_os/widget', ok: false, status: 500, selfReported: true,
    })).toBe(true);
  });

  it('the widget sends the opt-out header', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    expect(src).toContain('x-aeon-self-reported');
  });

  it('widgets fetch with credentials attached', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    // A bare fetch() sends no Bearer, so signing in would not have helped.
    expect(src).toMatch(/authFetch\(w\.endpoint/);
    expect(src).toMatch(/authFetch\('\/api\/blocks\/widgets'\)/);
  });
});
