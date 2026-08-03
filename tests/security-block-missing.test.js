// authGate.cjs reads the module-level default sessionValidator singleton
// (not dependency-injected like the security block's own routes), so
// isolation here follows the established VAULT_PATH-before-require pattern
// (see tests/vault-keyslots.test.js) rather than the deps-injection pattern
// used elsewhere — the env var must be set before storage.js resolves
// VAULT_ROOT at module load time.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-block-missing-'));
process.env.VAULT_PATH = tempVault;
// VAULT_PATH alone is NOT isolation: sessionValidator also writes the legacy
// secrets/aeon-user.json, which follows AEON_SECRETS_DIR, not VAULT_PATH.
// Without this line saveUser() below lands in the operator's real install.
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-block-missing-secrets-'));
delete process.env.VERCEL;

const express = require('express');
const authGate = require('../src/kernel/authGate.cjs');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const crypto = require('crypto');

// A directory that will never exist — simulates a deleted security block
// without touching the real repo.
const MISSING_DIR = path.join(tempVault, '__never_created__');
const REAL_SECURITY_DIR = path.join(__dirname, '..', 'src', 'blocks', 'security');

describe('Kernel security-availability — block deletion cannot bypass the guard', () => {
  let server;

  const PASSWORD = 'CorrectHorse9!';

  function seedProtectedAccount() {
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
    sessions.saveUser({
      username: 'operator',
      displayName: 'Operator',
      role: 'operator',
      salt,
      passHash,
      failedAttempts: 0,
      lockedUntil: 0,
      sessions: {},
      createdAt: new Date().toISOString(),
    });
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: true });
  }

  beforeEach(async () => {
    authGate._setSecurityBlockDirForTests(REAL_SECURITY_DIR);
    const app = express();
    app.use(express.json());
    authGate.mountAuth(app);
    app.use(authGate.guard);
    app.get('/api/some-guarded-route', (req, res) => res.json({ ok: true }));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
  });

  afterEach(() => {
    if (server) server.close();
    authGate._setSecurityBlockDirForTests(REAL_SECURITY_DIR);
    // Reset to an unconfigured account between tests.
    try { fs.rmSync(sessions.AUTH_FILE, { force: true }); } catch {}
    try { fs.rmSync(sessions.POLICY_FILE, { force: true }); } catch {}
  });

  afterAll(() => {
    delete process.env.VAULT_PATH;
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  const availability = async (headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/kernel/security-availability`, { headers });
    return { status: r.status, body: await r.json() };
  };

  it('reports blockPresent: true when the real security block directory exists', async () => {
    const r = await availability();
    expect(r.body.blockPresent).toBe(true);
  });

  it('reports blockPresent: false for a directory that does not exist, without disturbing account/guard reads', async () => {
    seedProtectedAccount();
    authGate._setSecurityBlockDirForTests(MISSING_DIR);
    const r = await availability();
    expect(r.body.blockPresent).toBe(false);
    expect(r.body.hasAccount).toBe(true);
    expect(r.body.guardActive).toBe(true);
    expect(r.body.authenticated).toBe(false);
  });

  it('NEVER bypasses the guard on a real route just because the block is missing', async () => {
    seedProtectedAccount();
    authGate._setSecurityBlockDirForTests(MISSING_DIR);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/some-guarded-route`);
    expect(r.status).toBe(401);
  });

  it('an already-valid session is still reported authenticated even with the block missing', async () => {
    seedProtectedAccount();
    const user = sessions.loadUser();
    const token = crypto.randomBytes(32).toString('hex');
    user.sessions[token] = { created: Date.now(), lastSeen: Date.now(), expires: Date.now() + 60_000, ua: 'test', ip: 'local' };
    sessions.saveUser(user);

    authGate._setSecurityBlockDirForTests(MISSING_DIR);
    const r = await availability({ Authorization: `Bearer ${token}` });
    expect(r.body.blockPresent).toBe(false);
    expect(r.body.authenticated).toBe(true);

    const guarded = await fetch(`http://127.0.0.1:${server.address().port}/api/some-guarded-route`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(guarded.status).toBe(200);
  });

  it('the availability endpoint itself is always reachable pre-auth, even when locked out', async () => {
    seedProtectedAccount();
    authGate._setSecurityBlockDirForTests(MISSING_DIR);
    // No token at all — this must still be a 200, not a 401, or the frontend
    // could never learn *why* it's locked out.
    const r = await availability();
    expect(r.status).toBe(200);
  });
});
