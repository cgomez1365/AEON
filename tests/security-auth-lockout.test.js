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

// BO2 — every wrong-password login flows through one shared lockout counter.
describe('Security auth — unified failure accounting and lockout', () => {
  let tempDir;
  let server;
  let sessionValidator;

  const PASSWORD = 'CorrectHorse9!';

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
  });
});
