import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountSecurityApi = require('../src/blocks/security/api/security.js');

const RECOVERY_QUESTIONS = [
  { questionId: 'q01', answer: 'Pine Street School' },
  { questionId: 'q02', answer: 'Portland' },
  { questionId: 'q03', answer: 'Comet' },
];

describe('local break-glass recovery', () => {
  let tempDir;
  let validator;
  let server;
  let origin;
  let nowValue;
  let nowQueue;
  // Controlled clock: shift a scripted queue when present (to distinguish
  // handler-entry from post-derivation issuance), else a pinned wall time.
  const clock = () => (nowQueue && nowQueue.length ? nowQueue.shift() : nowValue);

  async function request(route, body) {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  }

  async function setup() {
    return request('/api/auth/setup', {
      username: 'operator',
      password: 'ValidPass1',
      displayName: 'Operator',
      email: 'operator@example.test',
      recoveryQuestions: RECOVERY_QUESTIONS,
    });
  }

  async function verifyCorrectAnswers() {
    return request('/api/security/recovery/verify', {
      username: 'operator',
      answers: RECOVERY_QUESTIONS,
    });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-recovery-test-'));
    nowValue = 1_700_000_000_000;
    nowQueue = null;
    validator = createSessionValidator({
      securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
      legacyUserFile: null,
      bootTime: Date.now() - 1000,
      mobileSecret: null,
    });
    const app = express();
    app.use(express.json());
    mountSecurityApi(app, { sessionValidator: validator, writeOSAudit: () => {}, now: clock });
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores three independent answer hashes and returns only question text', async () => {
    const created = await setup();
    expect(created.response.status).toBe(200);

    const raw = fs.readFileSync(validator.AUTH_FILE, 'utf8');
    expect(raw).not.toContain('Pine Street School');
    expect(raw).not.toContain('Portland');
    expect(raw).not.toContain('Comet');
    const user = JSON.parse(raw);
    expect(new Set(user.recoveryQuestions.map(item => item.salt)).size).toBe(3);
    expect(user.recoveryQuestions.every(item => item.answerHash && !item.answer)).toBe(true);

    const challenge = await request('/api/security/recovery/challenge', { username: 'operator' });
    expect(challenge.response.status).toBe(200);
    expect(challenge.body.questions).toEqual([
      { questionId: 'q01', text: 'What was the name of your first school?' },
      { questionId: 'q02', text: 'What city were you born in?' },
      { questionId: 'q03', text: 'What was your childhood nickname?' },
    ]);
  });

  it('rejects duplicate standardized questions during setup', async () => {
    const result = await request('/api/auth/setup', {
      username: 'operator',
      password: 'ValidPass1',
      email: 'operator@example.test',
      recoveryQuestions: [
        { questionId: 'q01', answer: 'One' },
        { questionId: 'q01', answer: 'Two' },
        { questionId: 'q03', answer: 'Three' },
      ],
    });
    expect(result.response.status).toBe(400);
    expect(fs.existsSync(validator.AUTH_FILE)).toBe(false);
  });

  it('locks recovery for 15 minutes on the fifth failed challenge', async () => {
    await setup();
    const wrong = {
      username: 'operator',
      answers: RECOVERY_QUESTIONS.map(item => ({ ...item, answer: 'incorrect' })),
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await request('/api/security/recovery/verify', wrong);
      expect(result.response.status).toBe(401);
      expect(result.body.attemptsRemaining).toBe(5 - attempt);
    }
    const locked = await request('/api/security/recovery/verify', wrong);
    expect(locked.response.status).toBe(429);
    expect(locked.body.retryAfter).toBe(900);

    const challenge = await request('/api/security/recovery/challenge', { username: 'operator' });
    expect(challenge.response.status).toBe(429);
  });

  it('starts both expiry windows at post-derivation issuance, not handler entry', async () => {
    await setup();
    // now() returns handler-entry time on the first call, then a LATER issuance
    // time after the scrypt derivations. Expiry must key off the later value —
    // the caller gets the full 5/10 minutes, not minus the derivation cost.
    nowQueue = [5_000_000, 5_050_000];
    const verified = await verifyCorrectAnswers();
    expect(verified.response.status).toBe(200);
    expect(verified.body.expiresAt).toBe(5_050_000 + 300_000);
    expect(verified.body.emergencyExpiresAt).toBe(5_050_000 + 600_000);

    // Neither plaintext credential is ever persisted.
    const raw = fs.readFileSync(validator.AUTH_FILE, 'utf8');
    expect(raw).not.toContain(verified.body.recoveryToken);
    expect(raw).not.toContain(verified.body.temporaryPassphrase);
  });

  it('accepts the recovery token 1 ms before expiry, resets, and is single-use', async () => {
    await setup();
    nowValue = 6_000_000;
    const verified = await verifyCorrectAnswers(); // expiresAt = 6_300_000

    nowValue = 6_300_000 - 1; // 1 ms before expiry → accepted
    const reset = await request('/api/security/recovery/reset', {
      recoveryToken: verified.body.recoveryToken,
      newPassword: 'NewValidPass2',
    });
    expect(reset.response.status).toBe(200);
    expect(reset.body.token).toHaveLength(64);

    const replay = await request('/api/security/recovery/reset', {
      recoveryToken: verified.body.recoveryToken,
      newPassword: 'AnotherPass3',
    });
    expect(replay.response.status).toBe(401);

    const login = await request('/api/auth/login', { username: 'operator', password: 'NewValidPass2' });
    expect(login.response.status).toBe(200);
    const audit = fs.readFileSync(path.join(validator.SECURITY_DIR, 'audit.log'), 'utf8');
    expect(audit).toContain('"event":"RECOVERY_SUCCESS"');
    expect(audit).toContain('"event":"RECOVERY_PASSWORD_RESET"');
  });

  it('rejects the recovery token exactly at expiry', async () => {
    await setup();
    nowValue = 6_000_000;
    const verified = await verifyCorrectAnswers(); // expiresAt = 6_300_000
    nowValue = 6_300_000; // exactly at expiry → rejected
    const expired = await request('/api/security/recovery/reset', {
      recoveryToken: verified.body.recoveryToken,
      newPassword: 'NewValidPass2',
    });
    expect(expired.response.status).toBe(401);
  });

  it('accepts the ten-minute emergency passphrase once within its window', async () => {
    await setup();
    nowValue = 7_000_000;
    const verified = await verifyCorrectAnswers(); // emergencyExpiresAt = 7_600_000

    nowValue = 7_500_000; // inside the window
    const first = await request('/api/auth/login', {
      username: 'operator',
      password: verified.body.temporaryPassphrase,
    });
    expect(first.response.status).toBe(200);

    const second = await request('/api/auth/login', {
      username: 'operator',
      password: verified.body.temporaryPassphrase,
    });
    expect(second.response.status).toBe(401); // single-use
  });

  it('rejects the emergency passphrase exactly at expiry', async () => {
    await setup();
    nowValue = 7_000_000;
    const verified = await verifyCorrectAnswers(); // emergencyExpiresAt = 7_600_000
    nowValue = 7_600_000; // at expiry → no longer valid
    const late = await request('/api/auth/login', {
      username: 'operator',
      password: verified.body.temporaryPassphrase,
    });
    expect(late.response.status).toBe(401);
  });
});
