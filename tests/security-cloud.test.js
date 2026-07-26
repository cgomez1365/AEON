import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// See tests/vault.test.js — AEON_SECRETS_DIR is resolved at module scope, so
// it has to be set before the vault is required. The per-test tempDir below
// isolates the security Vault; this isolates the encrypted secret store that
// sits underneath it.
const SECRETS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cloud-secrets-'));
process.env.AEON_SECRETS_DIR = SECRETS_TMP;

const crypto = require('crypto');
const express = require('express');
const mountCloudSecurity = require('../src/blocks/security/api/index.cjs');
const vault = require('../src/kernel/vault.cjs');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');

describe('Security cloud provider and OTP flow', () => {
  let tempDir;
  let server;
  let nowValue;
  let verifyCalls;
  let previousMasterKey;
  let sessionValidator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cloud-security-'));
    previousMasterKey = process.env.AEON_VAULT_MASTER_KEY;
    process.env.AEON_VAULT_MASTER_KEY = 'test-only-master-key';
    nowValue = 1_000_000;
    verifyCalls = 0;

    const app = express();
    app.use(express.json());
    sessionValidator = createSessionValidator({
      securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
      legacyUserFile: path.join(tempDir, 'legacy-user.json'),
      bootTime: nowValue - 1,
      mobileSecret: null,
    });
    mountCloudSecurity(app, {
      getVaultFile: rel => path.join(tempDir, 'Vault', rel),
      getCloudProviderMetadata: () => ({
        active: ['supabase', 'firebase'],
        supabase: { configured: true },
        firebase: { configured: true },
      }),
      getCloudCredentials: () => null,
      vaultSeal: vault.seal,
      vaultUnseal: vault.unseal,
      now: () => nowValue,
      sessionValidator,
      cloudOtpAdapter: () => ({
        send: async () => true,
        verify: async (email, code) => {
          verifyCalls += 1;
          return email === 'admin@example.com' && code === '123456';
        },
      }),
      cloudOAuthVerifier: async (provider, token) => (
        provider === 'supabase' && token === 'provider-token'
          ? { subject: 'subject-1', email: 'admin@example.com', displayName: 'Admin' }
          : null
      ),
    });
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
  });

  afterEach(() => {
    if (server) server.close();
    global.__AEON_SECURITY_RESTART_REQUIRED = false;
    if (previousMasterKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY;
    else process.env.AEON_VAULT_MASTER_KEY = previousMasterKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const request = async (route, body, extraHeaders) => {
    const headers = body === undefined
      ? { ...(extraHeaders || {}) }
      : { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: Object.keys(headers).length ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };

  async function lockAndSend() {
    await request('/api/security/cloud/lock', { provider: 'supabase' });
    return request('/api/security/cloud/otp/send', { email: 'admin@example.com' });
  }

  const LOCAL_PASSWORD = 'Sup3rSecret!';

  function seedLocalAccount(password = LOCAL_PASSWORD) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return sessionValidator.saveUser({
      username: 'local-admin',
      displayName: 'Local Admin',
      email: 'local@site.internal',
      role: 'operator',
      salt,
      passHash,
      createdAt: new Date().toISOString(),
      sessions: {},
    });
  }

  // Session meta uses real wall-clock: sessionValidator validates against
  // Date.now() internally, independent of the injected `now()`.
  function issueSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const t = Date.now();
    const next = { ...user, sessions: { ...(user.sessions || {}) } };
    next.sessions[token] = { created: t, lastSeen: t, expires: t + 3_600_000 };
    sessionValidator.saveUser(next);
    return token;
  }

  // Lock provider → send → verify the administrative email (raises emailVerified
  // without creating/overwriting an existing local account).
  async function verifyAdminEmail() {
    const sent = await lockAndSend();
    nowValue = sent.body.expiresAt - 1;
    return request('/api/security/cloud/otp/verify', { code: '123456' });
  }

  const authFilePath = () => path.join(tempDir, 'Vault', 'blocks', 'security', 'local_auth.json');
  const readState = () => vault.unseal(JSON.parse(
    fs.readFileSync(path.join(tempDir, 'Vault', 'blocks', 'security', 'state.json'), 'utf8'),
  ));

  it('locks the OAuth provider once and refuses a provider switch', async () => {
    const first = await request('/api/security/cloud/lock', { provider: 'supabase' });
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ provider: 'supabase', is_locked: true });

    const configFile = path.join(tempDir, 'Vault', 'blocks', 'security', 'oauth_config.json');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({
      provider: 'supabase',
      is_locked: true,
    });

    const switched = await request('/api/security/cloud/lock', { provider: 'firebase' });
    expect(switched.response.status).toBe(423);
    expect(switched.body.code).toBe('OAUTH_PROVIDER_LOCKED');
  });

  it('enforces an exact 120-second challenge and 60-second resend cooldown', async () => {
    const sent = await lockAndSend();
    expect(sent.body).toMatchObject({ delivered: true, expiresIn: 120, resendIn: 60 });
    expect(sent.body.expiresAt - nowValue).toBe(120_000);
    expect(sent.body.resendAt - nowValue).toBe(60_000);

    nowValue += 59_999;
    const earlyResend = await request('/api/security/cloud/otp/send', { email: 'admin@example.com' });
    expect(earlyResend.response.status).toBe(429);

    nowValue += 1;
    const allowedResend = await request('/api/security/cloud/otp/send', { email: 'admin@example.com' });
    expect(allowedResend.response.status).toBe(200);

    nowValue = allowedResend.body.expiresAt;
    const expired = await request('/api/security/cloud/otp/verify', { code: '123456' });
    expect(expired.response.status).toBe(410);
    expect(expired.body.code).toBe('OTP_EXPIRED');
    expect(verifyCalls).toBe(0);
  });

  it('persists verified state encrypted and raises the restart barrier', async () => {
    const sent = await lockAndSend();
    nowValue = sent.body.expiresAt - 1;
    const verified = await request('/api/security/cloud/otp/verify', { code: '123456' });
    expect(verified.response.status).toBe(200);
    expect(verified.body).toMatchObject({ verified: true, restartRequired: true });
    expect(global.__AEON_SECURITY_RESTART_REQUIRED).toBe(true);

    const stateFile = path.join(tempDir, 'Vault', 'blocks', 'security', 'state.json');
    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(raw).not.toContain('admin@example.com');
    expect(raw).not.toContain('123456');
    const state = vault.unseal(JSON.parse(raw));
    expect(state).toMatchObject({
      verifiedEmail: 'admin@example.com',
      emailVerified: true,
      restartRequired: true,
      oauth: { provider: 'supabase', state: 'verified', is_locked: true },
    });
  });

  it('exchanges a verified provider token for an AEON session without storing the provider token', async () => {
    const sent = await lockAndSend();
    nowValue = sent.body.expiresAt - 1;
    await request('/api/security/cloud/otp/verify', { code: '123456' });

    const exchanged = await request('/api/security/oauth/exchange', { token: 'provider-token' });
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.user).toMatchObject({
      username: 'admin@example.com',
      email: 'admin@example.com',
    });
    expect(exchanged.body.token).toMatch(/^[a-f0-9]{64}$/);

    const authFile = path.join(tempDir, 'Vault', 'blocks', 'security', 'local_auth.json');
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    expect(auth.authMode).toBe('cloud');
    expect(Object.keys(auth.sessions)).toContain(exchanged.body.token);
    expect(fs.readFileSync(authFile, 'utf8')).not.toContain('provider-token');
  });

  // ── BO1: existing account cannot be silently converted ────────────────────

  it('refuses to convert an existing local account without an authenticated migration', async () => {
    seedLocalAccount();
    await verifyAdminEmail(); // emailVerified is true, mimicking the post-restart state

    const exchanged = await request('/api/security/oauth/exchange', { token: 'provider-token' });
    expect(exchanged.response.status).toBe(403);
    expect(exchanged.body.code).toBe('MIGRATION_REQUIRED');

    // The local account is byte-safe: still local, still its own email + hash.
    const auth = JSON.parse(fs.readFileSync(authFilePath(), 'utf8'));
    expect(auth.authMode).toBeUndefined();
    expect(auth.email).toBe('local@site.internal');
    expect(auth.passHash).toBeTruthy();
  });

  it('rejects migration without a valid operator session', async () => {
    seedLocalAccount();
    await verifyAdminEmail();

    const res = await request('/api/security/cloud/migrate', {
      password: LOCAL_PASSWORD, email: 'admin@example.com', provider: 'supabase',
    });
    expect(res.response.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED_SESSION');
  });

  it('rejects migration when the local password is not re-verified', async () => {
    const user = seedLocalAccount();
    const token = issueSession(user);
    await verifyAdminEmail();

    const res = await request(
      '/api/security/cloud/migrate',
      { password: 'wrong-password', email: 'admin@example.com', provider: 'supabase' },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.response.status).toBe(403);
    expect(res.body.code).toBe('REVERIFY_FAILED');
  });

  it('rejects migration aimed at an unconfirmed email or provider', async () => {
    const user = seedLocalAccount();
    const token = issueSession(user);
    await verifyAdminEmail();

    const res = await request(
      '/api/security/cloud/migrate',
      { password: LOCAL_PASSWORD, email: 'attacker@evil.test', provider: 'supabase' },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.response.status).toBe(409);
    expect(res.body.code).toBe('TARGET_MISMATCH');
  });

  it('completes an authenticated migration, strips the local credential, and consumes the single-use approval', async () => {
    const user = seedLocalAccount();
    const token = issueSession(user);
    await verifyAdminEmail();

    const migrated = await request(
      '/api/security/cloud/migrate',
      { password: LOCAL_PASSWORD, email: 'admin@example.com', provider: 'supabase' },
      { Authorization: `Bearer ${token}` },
    );
    expect(migrated.response.status).toBe(200);
    expect(migrated.body.migrationApproved).toBe(true);

    const exchanged = await request('/api/security/oauth/exchange', { token: 'provider-token' });
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.user).toMatchObject({ email: 'admin@example.com' });

    const auth = JSON.parse(fs.readFileSync(authFilePath(), 'utf8'));
    expect(auth.authMode).toBe('cloud');
    expect(auth.email).toBe('admin@example.com');
    expect(auth.passHash).toBeUndefined(); // former local credential removed
    expect(auth.salt).toBeUndefined();

    // Approval is single-use: the exchange consumed it from sealed state.
    expect(readState().migration).toBeUndefined();
  });
});
