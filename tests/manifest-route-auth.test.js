/**
 * A route that declares auth:true must require a session.
 *
 * Audit 2026-08-11 P0-02, the highest-consequence finding of the marathon.
 * 234 of 239 declared routes carry `"auth": true`. blockHost.cjs contained
 * ZERO occurrences of the string "auth" — the declaration was read by nothing.
 * The only protection was the global guard, and authGate.guard() returns
 * next() unconditionally when guardActive() is false, so with the guard off a
 * same-machine caller reached Settings' credential-export and connection-
 * mutation handlers unauthenticated.
 *
 * Loopback is not authentication. The Bible's lineage card claims "the manifest
 * became executable governance"; for auth that was false until this landed.
 *
 * The lockout constraint is asserted here too, because it is the one way this
 * fix could do more harm than the defect: before an operator account exists
 * NOBODY can hold a session, so enforcing would make first-run setup
 * impossible. Security must never lock the owner out of their own machine.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { manifestAuthGuard, compilePath, protectedRoutes } from '../src/kernel/manifestRouteAuth.cjs';

const manifest = {
  id: 'testblock',
  routes: [
    { method: 'POST', path: '/api/testblock/export', auth: true },
    { method: 'GET', path: '/api/testblock/doc/:id', auth: true },
    { method: 'GET', path: '/api/testblock/public', auth: false },
    { method: 'GET', path: '/api/testblock/undeclared-auth' },
  ],
};

/** A session validator stub — the real one reads the operator's auth store. */
function fakeSessions({ hasAccount = true, valid = false } = {}) {
  return {
    hasAccount: () => hasAccount,
    isPreAuthRequest: (req) => req.method === 'OPTIONS',
    validateSession: () => (valid ? { ok: true, user: { username: 'op' } } : { ok: false, reason: 'no-session' }),
  };
}

function appWith(sessions) {
  const app = express();
  app.use(manifestAuthGuard(manifest, sessions));
  // Terminal middleware rather than a path pattern: Express 5 changed splat
  // syntax, and the subject under test is the guard, not the router's matcher.
  app.use((req, res) => res.json({ reached: true }));
  return app;
}

/**
 * Drive a real request through a real Express stack on an ephemeral port —
 * the same harness shape connectivity-supabase-fallback.test.js uses. No new
 * dependency: adding supertest to ship a test would widen the supply chain
 * this build order is separately trying to pin down.
 */
async function call(app, method, url) {
  const server = await new Promise((resolve) => {
    const inst = app.listen(0, '127.0.0.1', () => resolve(inst));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: r.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('path compilation', () => {
  it('matches a param segment but not a missing one', () => {
    const re = compilePath('/api/testblock/doc/:id');
    expect(re.test('/api/testblock/doc/abc')).toBe(true);
    expect(re.test('/api/testblock/doc')).toBe(false);
    expect(re.test('/api/testblock/doc/abc/extra')).toBe(false);
  });

  it('collects only routes that explicitly declare auth:true', () => {
    const p = protectedRoutes(manifest);
    expect(p.map((r) => r.path)).toEqual([
      '/api/testblock/export',
      '/api/testblock/doc/:id',
    ]);
  });
});

describe('with an operator account present', () => {
  it('refuses a declared-auth route without a session', async () => {
    const res = await call(appWith(fakeSessions({ valid: false })), 'POST', '/api/testblock/export');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED_SESSION');
    // The refusal must name the declaration, or a 401 here is a mystery.
    expect(res.body.declaredBy).toMatch(/testblock manifest: POST \/api\/testblock\/export/);
  });

  it('refuses a param route without a session', async () => {
    const res = await call(appWith(fakeSessions({ valid: false })), 'GET', '/api/testblock/doc/abc123');
    expect(res.status).toBe(401);
  });

  it('allows a declared-auth route with a valid session', async () => {
    const res = await call(appWith(fakeSessions({ valid: true })), 'POST', '/api/testblock/export');
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('leaves routes that do not declare auth to the global guard', async () => {
    const sessions = fakeSessions({ valid: false });
    for (const p of ['/api/testblock/public', '/api/testblock/undeclared-auth']) {
      const res = await call(appWith(sessions), 'GET', p);
      expect(res.status, `${p} was refused, but it declares no auth`).toBe(200);
    }
  });

  it('does not refuse a path that merely resembles a protected one', async () => {
    const res = await call(appWith(fakeSessions({ valid: false })), 'GET', '/api/testblock/exportable');
    expect(res.status).toBe(200);
  });

  it('is method-specific — GET on a POST-protected path is not refused', async () => {
    const res = await call(appWith(fakeSessions({ valid: false })), 'GET', '/api/testblock/export');
    expect(res.status).toBe(200);
  });
});

describe('the lockout constraint', () => {
  // Enforcing before an account exists would make setup impossible.
  it('does not enforce when no operator account exists', async () => {
    const res = await call(appWith(fakeSessions({ hasAccount: false, valid: false })), 'POST', '/api/testblock/export');
    expect(res.status, 'first-run setup would be impossible').toBe(200);
  });

  it('lets preflight through', async () => {
    const res = await call(appWith(fakeSessions({ valid: false })), 'OPTIONS', '/api/testblock/export');
    expect(res.status).toBe(200);
  });
});
