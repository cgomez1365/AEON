/**
 * Settings → Account → "Require login" must switch the login requirement.
 *
 * Measured 2026-09-23 on a live server (account present, guard ON): the switch
 * wrote PUT /api/prefs/require_login {value:false} and toasted "Login
 * requirement disabled" — and GET /api/security/policy still said
 * guardEnabled:true, and a request with no session still answered 401. The
 * preference is a mirror the Security Guardian writes; nothing reads it to
 * decide anything. The control said one thing and did another (§08).
 *
 * The switch now reads and writes the Guardian's policy. This drives the
 * client against the REAL Guardian router over an isolated Vault.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-login-guard-'));
process.env.VAULT_PATH = path.join(TMP, 'Vault');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
// The Guardian mirrors its state to http://127.0.0.1:$PORT/api/settings. Point
// that at a closed port: a test must never write to a live AEON on 3001.
const savedPort = process.env.PORT;
process.env.PORT = '9';
delete process.env.VERCEL;

const express = require('express');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountGuardian = require('../src/blocks/security/api/guardian.cjs');
const { createLoginGuardClient, loginGuardText } = await import('../src/blocks/settings/loginGuard.js');

let server;
let base;
const TOKEN = 'login-guard-fixture-token';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountGuardian(app, { registerEarlyMiddleware: () => {}, writeOSAudit: () => {}, lifecycle: { setInterval: () => ({ unref() {} }), onCleanup() {} } });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(sessions.AUTH_FILE, { force: true }); } catch {}
  try { fs.rmSync(sessions.POLICY_FILE, { force: true }); } catch {}
  delete process.env.VAULT_PATH;
  if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const withToken = (fetchImpl = fetch) => (url, init = {}) =>
  fetchImpl(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${TOKEN}` } });

function seedAccount() {
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  sessions.saveUser({
    username: 'operator', role: 'operator', salt,
    passHash: crypto.scryptSync('Fixture-Pass-1', salt, 64).toString('hex'),
    sessions: { [TOKEN]: { created: now, lastSeen: now, expires: now + 3_600_000 } },
  });
  sessions.savePolicy({ ...sessions.loadPolicy(), guardEnabled: true, lockEveryLaunch: false });
}

describe('no account yet', () => {
  it('reads as off, and says an account is needed', async () => {
    const r = await createLoginGuardClient({ base }).read();
    expect(r).toMatchObject({ ok: true, enabled: false, accountConfigured: false });
    expect(loginGuardText(r)).toMatch(/Create one under Security/);
  });

  it('turning it on is refused with the Guardian\'s reason, inline', async () => {
    const r = await createLoginGuardClient({ base }).set(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/account/i);
  });
});

describe('account present', () => {
  it('reads the real guard state', async () => {
    seedAccount();
    const r = await createLoginGuardClient({ base, fetchImpl: withToken() }).read();
    expect(r).toMatchObject({ ok: true, enabled: true, accountConfigured: true });
  });

  it('turning it off changes the Guardian policy — not just a preference', async () => {
    seedAccount();
    const r = await createLoginGuardClient({ base, fetchImpl: withToken() }).set(false);
    expect(r).toMatchObject({ ok: true, enabled: false });
    expect(sessions.loadPolicy().guardEnabled).toBe(false);
    expect(loginGuardText(r)).toMatch(/without a password/);
  });

  it('turning it back on changes it back', async () => {
    const r = await createLoginGuardClient({ base, fetchImpl: withToken() }).set(true);
    expect(r).toMatchObject({ ok: true, enabled: true });
    expect(sessions.loadPolicy().guardEnabled).toBe(true);
  });

  it('without a session the change is refused and nothing moves', async () => {
    const r = await createLoginGuardClient({ base }).set(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sign in again/i);
    expect(sessions.loadPolicy().guardEnabled).toBe(true);
  });
});

describe('the Account tab uses it', () => {
  it('no longer renders the require_login preference as the login switch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    expect(src).not.toMatch(/prefKey="require_login"/);
    expect(src).toMatch(/createLoginGuardClient/);
  });
});
