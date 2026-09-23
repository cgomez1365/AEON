/**
 * Every authentication event reaches the audit trail the operator can read.
 *
 * Measured 2026-09-23 on a live server (throwaway home): after login, logout,
 * five wrong passwords, a lockout, break-glass recovery, an emergency-passphrase
 * login and a password reset, GET /api/host_os/audit (the audit screen) and
 * GET /api/audit showed AUTH_SETUP, AUTH_LOGIN ×n and one AUTH_LOCKOUT — and
 * nothing else:
 *   - the five wrong passwords left no entry (only the lockout they caused);
 *   - logout left no entry;
 *   - the emergency-passphrase login was an ordinary AUTH_LOGIN;
 *   - RECOVERY_SUCCESS / RECOVERY_EMERGENCY_LOGIN / RECOVERY_PASSWORD_RESET went
 *     only to Vault/blocks/security/audit.log, which no screen reads.
 * Someone guessing the password, or resetting it through recovery, was
 * invisible on the screen meant to show it.
 *
 * Entries must never carry a secret: no password, passphrase or token.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountSecurityApi = require('../src/blocks/security/api/security.js');

const QUESTIONS = [
  { questionId: 'q01', answer: 'Fixture School' },
  { questionId: 'q02', answer: 'Fixture City' },
  { questionId: 'q03', answer: 'Fixture Pet' },
];
const PASS = 'FixturePass1';

let tempDir;
let server;
let origin;
let audit;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-audit-trail-'));
  const validator = createSessionValidator({
    securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
    legacyUserFile: null,
    bootTime: Date.now() - 1000,
    mobileSecret: null,
  });
  audit = [];
  const app = express();
  app.use(express.json());
  mountSecurityApi(app, {
    sessionValidator: validator,
    writeOSAudit: (action, details, status) => audit.push({ action, details: String(details), status }),
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const post = async (route, body, token) => {
  const r = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const setup = () => post('/api/auth/setup', { username: 'operator', password: PASS, recoveryQuestions: QUESTIONS });
const actions = () => audit.map((a) => a.action);

describe('the audit trail sees what happened', () => {
  it('a wrong password is recorded, without the password', async () => {
    await setup();
    const r = await post('/api/auth/login', { username: 'operator', password: 'Guess-Nr-1' });
    expect(r.status).toBe(401);
    const fail = audit.find((a) => a.action === 'AUTH_FAIL');
    expect(fail, `audit: ${actions().join(',')}`).toBeTruthy();
    expect(fail.details).not.toContain('Guess-Nr-1');
  });

  it('five wrong passwords: five failures, then the lockout', async () => {
    await setup();
    for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: 'operator', password: `Guess-${i}` });
    expect(actions().filter((a) => a === 'AUTH_FAIL')).toHaveLength(5);
    expect(actions()).toContain('AUTH_LOCKOUT');
  });

  it('logout is recorded', async () => {
    await setup();
    const login = await post('/api/auth/login', { username: 'operator', password: PASS });
    await post('/api/auth/logout', {}, login.body.token);
    expect(actions()).toContain('AUTH_LOGOUT');
  });

  it('recovery, the emergency login and the reset appear on the same trail', async () => {
    await setup();
    const bad = await post('/api/security/recovery/verify', { username: 'operator', answers: QUESTIONS.map((q) => ({ ...q, answer: 'wrong' })) });
    expect(bad.status).toBe(401);
    expect(actions()).toContain('RECOVERY_FAIL');

    const ok = await post('/api/security/recovery/verify', { username: 'operator', answers: QUESTIONS });
    expect(ok.status).toBe(200);
    expect(actions()).toContain('RECOVERY_SUCCESS');

    const em = await post('/api/auth/login', { username: 'operator', password: ok.body.temporaryPassphrase });
    expect(em.status).toBe(200);
    const emLogin = audit.filter((a) => a.action === 'AUTH_LOGIN').pop();
    expect(emLogin.details).toMatch(/emergency passphrase/i);

    const reset = await post('/api/security/recovery/reset', { recoveryToken: ok.body.recoveryToken, newPassword: 'FixturePass2' });
    expect(reset.status).toBe(200);
    expect(actions()).toContain('RECOVERY_PASSWORD_RESET');

    const everything = JSON.stringify(audit);
    for (const secret of [PASS, 'FixturePass2', ok.body.temporaryPassphrase, ok.body.recoveryToken, em.body.token, reset.body.token]) {
      expect(everything, 'a secret reached the audit trail').not.toContain(secret);
    }
  });

  it('the recovery file is still written (nothing that read it loses it)', async () => {
    await setup();
    await post('/api/security/recovery/verify', { username: 'operator', answers: QUESTIONS });
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'audit.log');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/RECOVERY_SUCCESS/);
  });
});
