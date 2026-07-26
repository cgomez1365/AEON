import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const express = require('express');
const mountSecurity = require('../src/blocks/security/api/security.js');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');

// BO2 — every login failure path (wrong password, wrong TOTP, wrong backup code)
// must flow through one shared lockout counter; a backup code is consumed only
// when the whole login succeeds; lockout is checked before any second factor.
describe('Security auth — unified failure accounting and lockout', () => {
  let tempDir;
  let server;
  let sessionValidator;

  const PASSWORD = 'CorrectHorse9!';
  // Valid base32 so verifyTOTP()/base32Decode() never throw. We never submit a
  // real TOTP code — 'ZZZZZZ' is guaranteed-invalid (generateTOTP emits digits).
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-auth-lockout-'));
    const app = express();
    app.use(express.json());
    sessionValidator = createSessionValidator({
      securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
      legacyUserFile: path.join(tempDir, 'legacy-user.json'),
      bootTime: Date.now() - 1,
      mobileSecret: null,
    });
    mountSecurity(app, { sessionValidator, writeOSAudit: () => {} });
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
  });

  afterEach(() => {
    if (server) server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const login = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };

  function seedUser(extra = {}) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
    return sessionValidator.saveUser({
      username: 'operator',
      displayName: 'Operator',
      email: 'op@site.internal',
      role: 'operator',
      salt,
      passHash,
      failedAttempts: 0,
      lockedUntil: 0,
      sessions: {},
      createdAt: new Date().toISOString(),
      ...extra,
    });
  }

  function emergencyCredential(passphrase) {
    const emergencySalt = crypto.randomBytes(16).toString('hex');
    const emergencyHash = crypto.scryptSync(passphrase, emergencySalt, 64).toString('hex');
    return { emergencySalt, emergencyHash, emergencyExpiresAt: Date.now() + 600_000, emergencyUsed: false };
  }

  const readUser = () => sessionValidator.loadUser();

  it('locks the account after five wrong passwords and then refuses the correct one', async () => {
    seedUser();
    for (let i = 0; i < 4; i++) {
      const r = await login({ username: 'operator', password: 'nope' });
      expect(r.response.status).toBe(401);
    }
    expect(readUser().failedAttempts).toBe(4);

    const fifth = await login({ username: 'operator', password: 'nope' });
    expect(fifth.response.status).toBe(401);
    const locked = readUser();
    expect(locked.failedAttempts).toBe(0);
    expect(locked.lockedUntil).toBeGreaterThan(Date.now());

    const afterLock = await login({ username: 'operator', password: PASSWORD });
    expect(afterLock.response.status).toBe(429);
  });

  it('locks the account after five wrong 2FA codes (the former bypass) with a generic error', async () => {
    seedUser({ totp: { enabled: true, secret: TOTP_SECRET } });
    for (let i = 0; i < 5; i++) {
      const r = await login({ username: 'operator', password: PASSWORD, code: 'ZZZZZZ' });
      expect(r.response.status).toBe(401);
      expect(r.body.error).toBe('Invalid credentials'); // never "Invalid 2FA code"
    }
    expect(readUser().lockedUntil).toBeGreaterThan(Date.now());
  });

  it('returns requires2FA for a password-only step without touching the counter', async () => {
    seedUser({ totp: { enabled: true, secret: TOTP_SECRET }, failedAttempts: 2 });
    const r = await login({ username: 'operator', password: PASSWORD });
    expect(r.response.status).toBe(200);
    expect(r.body.requires2FA).toBe(true);
    expect(r.body.ok).toBeUndefined();
    expect(readUser().failedAttempts).toBe(2);
  });

  it('never consumes a backup code on a rejected or locked login', async () => {
    // Wrong password + valid backup → rejected before the second factor is read.
    seedUser({ totp: { enabled: true, secret: TOTP_SECRET }, totpBackupCodes: [{ code: 'aaaa1111', used: false }] });
    const rejected = await login({ username: 'operator', password: 'wrong', code: 'aaaa1111' });
    expect(rejected.response.status).toBe(401);
    expect(readUser().totpBackupCodes[0].used).toBe(false);

    // Locked account + correct password + valid backup → 429, backup untouched.
    seedUser({
      lockedUntil: Date.now() + 600_000,
      totp: { enabled: true, secret: TOTP_SECRET },
      totpBackupCodes: [{ code: 'aaaa1111', used: false }],
    });
    const locked = await login({ username: 'operator', password: PASSWORD, code: 'aaaa1111' });
    expect(locked.response.status).toBe(429);
    expect(readUser().totpBackupCodes[0].used).toBe(false);
  });

  it('consumes a valid backup code only on success and resets the counter', async () => {
    seedUser({
      failedAttempts: 3,
      totp: { enabled: true, secret: TOTP_SECRET },
      totpBackupCodes: [{ code: 'aaaa1111', used: false }, { code: 'bbbb2222', used: false }],
    });
    const r = await login({ username: 'operator', password: PASSWORD, code: 'aaaa1111' });
    expect(r.response.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const after = readUser();
    expect(after.failedAttempts).toBe(0);
    expect(after.totpBackupCodes.find(b => b.code === 'aaaa1111').used).toBe(true);
    expect(after.totpBackupCodes.find(b => b.code === 'bbbb2222').used).toBe(false);
  });

  it('clears the failure counter on a successful password login', async () => {
    seedUser({ failedAttempts: 3 });
    const r = await login({ username: 'operator', password: PASSWORD });
    expect(r.response.status).toBe(200);
    expect(readUser().failedAttempts).toBe(0);
  });

  it('lets the emergency passphrase bypass lockout (no owner boot-lockout) but still blocks a wrong password', async () => {
    const emergency = emergencyCredential('EMERGENCY-PASS-1234');
    seedUser({ lockedUntil: Date.now() + 600_000, recoverySession: emergency });

    // A wrong password while locked is still refused — lockout stays intact.
    const wrong = await login({ username: 'operator', password: 'still-wrong' });
    expect(wrong.response.status).toBe(429);

    // The emergency passphrase gets the owner back in AND clears the lockout,
    // so a password brute-force can never brick their own local system.
    const rescued = await login({ username: 'operator', password: 'EMERGENCY-PASS-1234' });
    expect(rescued.response.status).toBe(200);
    expect(rescued.body.ok).toBe(true);
    const after = readUser();
    expect(after.lockedUntil).toBe(0);
    expect(after.recoverySession.emergencyUsed).toBe(true);

    // Bypasses the second factor too (break-glass) even with TOTP enabled.
    seedUser({ totp: { enabled: true, secret: TOTP_SECRET }, recoverySession: emergencyCredential('EMERGENCY-PASS-5678') });
    const twofa = await login({ username: 'operator', password: 'EMERGENCY-PASS-5678' });
    expect(twofa.response.status).toBe(200);
  });
});
