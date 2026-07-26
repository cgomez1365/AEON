// Found by the settings/terminal stress test (2026-07-26): commandRegistry.cjs
// dispatches a command via an internal fetch() from the server to itself.
// That internal request is a BRAND NEW HTTP request with no headers unless
// forwarded explicitly. With the guard active, the internal call used to hit
// authGate.guard and 401 for any non-preauth route -- so a fully
// authenticated terminal session saw every such command fail with
// UNAUTHORIZED_SESSION. 17 of 21 registered commands in a real install route
// to non-preauth endpoints.
//
// commandRegistry.cjs scans the REAL src/blocks/*/block.manifest.json at
// require time, so this test drives dispatch through a REAL declared command
// (cookbook.gpu -> GET /api/cookbook/gpus) rather than an injected fixture --
// simplest way to exercise the actual scan+dispatch path end to end. A
// stand-in handler for that exact route is registered in this isolated test
// app (the real cookbook block is never mounted here), so the internal
// proxy fetch lands on our handler instead of touching anything real.
//
// authGate.cjs reads the module-level default sessionValidator singleton
// (same as tests/security-block-missing.test.js), so isolation here follows
// the VAULT_PATH-before-require pattern -- the env var must be set before
// storage.js resolves VAULT_ROOT at module load time.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cmd-registry-'));
process.env.VAULT_PATH = tempVault;
delete process.env.VERCEL;

const express = require('express');
const authGate = require('../src/kernel/authGate.cjs');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const crypto = require('crypto');
const commandRegistryFactory = require('../src/kernel/commandRegistry.cjs');

describe('commandRegistry dispatch forwards the caller session to the internal proxy fetch', () => {
  let server;
  let port;

  const PASSWORD = 'CorrectHorse9!';

  function seedProtectedAccountWithSession() {
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.saveUser({
      username: 'operator',
      displayName: 'Operator',
      role: 'operator',
      salt,
      passHash,
      failedAttempts: 0,
      lockedUntil: 0,
      sessions: { [token]: { created: Date.now(), lastSeen: Date.now(), expires: Date.now() + 60_000, ua: 'test', ip: 'local' } },
      createdAt: new Date().toISOString(),
    });
    sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: true });
    return token;
  }

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    authGate.mountAuth(app);
    app.use(authGate.guard);

    // Stand-in for the real cookbook block's handler. It is behind the same
    // guard as any real command target -- unauthenticated calls must 401.
    app.get('/api/cookbook/gpus', (req, res) => res.json({ ok: true, stand_in: true }));

    const registry = commandRegistryFactory({ blockReadiness: {}, isVercel: false });
    app.use('/api', registry.router);

    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    port = server.address().port;
    // The dispatch handler builds its internal fetch URL from process.env.PORT.
    process.env.PORT = String(port);
  });

  afterEach(() => {
    if (server) server.close();
    try { fs.rmSync(sessions.AUTH_FILE, { force: true }); } catch {}
    try { fs.rmSync(sessions.POLICY_FILE, { force: true }); } catch {}
    delete process.env.PORT;
  });

  afterAll(() => {
    delete process.env.VAULT_PATH;
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  const dispatch = (token) => fetch(`http://127.0.0.1:${port}/api/commands/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ id: 'cookbook.gpu', arg: '' }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('sanity check: the target route is genuinely guarded, not accidentally pre-auth', async () => {
    seedProtectedAccountWithSession();
    const direct = await fetch(`http://127.0.0.1:${port}/api/cookbook/gpus`);
    expect(direct.status).toBe(401);
  });

  it('an unauthenticated dispatch still 401s (the guard is not bypassed by the command bus)', async () => {
    seedProtectedAccountWithSession();
    const r = await dispatch(null);
    // The OUTER /api/commands/dispatch call itself is guarded too, so this
    // never even reaches the handler without a session -- confirming the
    // fix does not accidentally turn the dispatcher into a bypass.
    expect(r.status).toBe(401);
  });

  it('an authenticated dispatch succeeds end-to-end -- the fix', async () => {
    const token = seedProtectedAccountWithSession();
    const r = await dispatch(token);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data?.stand_in).toBe(true);
  });
});
