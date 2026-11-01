import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const express = require('express');
const mountSecurityApi = require('../src/blocks/security/api/security.js');

describe('Vault-backed session validator', () => {
  let tempDir;
  let securityDir;
  let legacyUserFile;
  let validator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-session-test-'));
    securityDir = path.join(tempDir, 'Vault', 'blocks', 'security');
    legacyUserFile = path.join(tempDir, 'secrets', 'aeon-user.json');
    validator = createSessionValidator({
      securityDir,
      legacyUserFile,
      bootTime: Date.now() - 1000,
      mobileSecret: null,
    });
  });

  afterEach(() => {
    global.__AEON_SECURITY_RESTART_REQUIRED = false;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const userWithSession = (overrides = {}) => {
    const now = Date.now();
    return {
      username: 'operator',
      displayName: 'Operator',
      email: '',
      role: 'operator',
      salt: 'salt',
      passHash: 'hash',
      sessions: {
        valid: {
          created: now,
          lastSeen: now,
          expires: now + 60_000,
        },
      },
      ...overrides,
    };
  };

  it('keeps security off until an account and enabled policy both exist', () => {
    expect(validator.guardActive()).toBe(false);
    validator.saveUser(userWithSession());
    expect(validator.guardActive()).toBe(false);
    validator.savePolicy({ guardEnabled: true });
    expect(validator.guardActive()).toBe(true);
  });

  it('stores credentials in Vault and leaves only a redacted compatibility profile', () => {
    validator.saveUser(userWithSession());

    const auth = JSON.parse(fs.readFileSync(validator.AUTH_FILE, 'utf8'));
    const legacy = JSON.parse(fs.readFileSync(legacyUserFile, 'utf8'));

    expect(auth.passHash).toBe('hash');
    expect(auth.sessions.valid).toBeTruthy();
    expect(legacy.credentialStore).toBe('Vault/blocks/security/local_auth.json');
    expect(legacy.passHash).toBeUndefined();
    expect(legacy.sessions).toBeUndefined();
  });

  it('accepts a provider-verified cloud identity without inventing a local password', () => {
    validator.saveUser({
      username: 'admin@example.com',
      email: 'admin@example.com',
      role: 'operator',
      authMode: 'cloud',
      cloudProvider: 'supabase',
      sessions: {},
    });
    const saved = validator.loadUser();
    expect(saved.authMode).toBe('cloud');
    expect(saved.passHash).toBeUndefined();
  });

  it('migrates legacy credential hashes into Vault without retaining them in secrets', () => {
    fs.mkdirSync(path.dirname(legacyUserFile), { recursive: true });
    fs.writeFileSync(legacyUserFile, JSON.stringify({
      username: 'legacy',
      passwordHash: { salt: 'legacy-salt', hash: 'legacy-hash' },
      sessions: {},
    }));

    const migrated = validator.loadUser();
    const legacy = JSON.parse(fs.readFileSync(legacyUserFile, 'utf8'));

    expect(migrated.passHash).toBe('legacy-hash');
    expect(fs.existsSync(validator.AUTH_FILE)).toBe(true);
    expect(legacy.passwordHash).toBeUndefined();
    expect(validator.loadPolicy().guardEnabled).toBe(true);
  });

  it('accepts a live Vault session and rejects an expired session', () => {
    validator.saveUser(userWithSession());
    const request = {
      method: 'GET',
      path: '/core/status',
      query: {},
      headers: { authorization: 'Bearer valid' },
    };

    expect(validator.validateSession(request, validator.loadPolicy()).ok).toBe(true);

    const expired = userWithSession();
    expired.sessions.valid.expires = Date.now() - 1;
    validator.saveUser(expired);
    expect(validator.validateSession(request, validator.loadPolicy()).reason).toBe('expired');
  });

  // CEO 2026-10-31: auto-lock at 10 min never fired, at 1 min it did. The open
  // UI polls every few seconds and every poll counted as activity.
  describe('idle auto-lock counts input, not polls', () => {
    const T = Date.parse('2026-10-31T12:00:00Z');
    const poll = (inputAgeMs) => ({
      method: 'GET', path: '/api/audit', query: {},
      headers: { authorization: 'Bearer valid', ...(inputAgeMs == null ? {} : { 'x-aeon-input-age': String(inputAgeMs) }) },
    });
    const policy = { guardEnabled: true, idleMinutes: 10 };
    const sessionAt = (t) => userWithSession({ sessions: { valid: { created: t, lastSeen: t, expires: t + 86_400_000 } } });

    afterEach(() => vi.useRealTimers());

    it('locks after 10 minutes even with a poll every minute', () => {
      vi.useFakeTimers();
      vi.setSystemTime(T);
      validator.saveUser(sessionAt(T));
      for (let m = 1; m <= 10; m++) {
        vi.setSystemTime(T + m * 60_000 - 1);
        expect(validator.validateSession(poll(m * 60_000 - 1), policy).ok).toBe(true);
      }
      vi.setSystemTime(T + 10 * 60_000 + 5_000);
      expect(validator.validateSession(poll(10 * 60_000 + 5_000), policy).reason).toBe('idle');
    });

    it('stays unlocked when the person keeps using it', () => {
      vi.useFakeTimers();
      validator.saveUser(sessionAt(T));
      for (let m = 1; m <= 30; m++) {
        vi.setSystemTime(T + m * 60_000);
        expect(validator.validateSession(poll(2_000), policy).ok).toBe(true);
      }
    });

    it('a client without the header (CLI, scripts) still counts as active', () => {
      vi.useFakeTimers();
      validator.saveUser(sessionAt(T));
      for (let m = 1; m <= 30; m++) {
        vi.setSystemTime(T + m * 60_000);
        expect(validator.validateSession(poll(null), policy).ok).toBe(true);
      }
    });

    it('a bad header value counts as active instead of breaking', () => {
      vi.useFakeTimers();
      vi.setSystemTime(T + 60_000);
      validator.saveUser(sessionAt(T));
      for (const v of ['abc', '-5', 'Infinity']) expect(validator.validateSession(poll(v), policy).ok).toBe(true);
    });
  });

  it('keeps only explicit pre-auth routes open', () => {
    const request = (method, requestPath) => ({ method, path: requestPath, headers: {}, query: {} });

    expect(validator.isPreAuthRequest(request('GET', '/api/auth/status'))).toBe(true);
    expect(validator.isPreAuthRequest(request('POST', '/api/auth/login'))).toBe(true);
    expect(validator.isPreAuthRequest(request('GET', '/api/security/policy'))).toBe(true);
    expect(validator.isPreAuthRequest(request('POST', '/api/security/policy'))).toBe(false);
    expect(validator.isPreAuthRequest(request('GET', '/core/status'))).toBe(false);
  });

  it('returns the standardized unauthorized response', () => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    validator.unauthorized(response, 'expired');
    expect(response.statusCode).toBe(401);
    expect(response.payload).toEqual({
      success: false,
      error: 'UNAUTHORIZED_SESSION',
      requires_auth: true,
      reason: 'expired',
    });
  });

  it('creates an account in Vault without changing .env', async () => {
    const envFile = path.join(process.cwd(), '.env');
    const envBefore = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
    const app = express();
    app.use(express.json());
    mountSecurityApi(app, { sessionValidator: validator, writeOSAudit: () => {} });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'operator',
          password: 'ValidPass1',
          displayName: 'Operator',
          email: 'operator@example.test',
          recoveryQuestions: [
            { questionId: 'q01', answer: 'Pine Street School' },
            { questionId: 'q02', answer: 'Portland' },
            { questionId: 'q03', answer: 'Comet' },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(fs.existsSync(validator.AUTH_FILE)).toBe(true);
      expect(validator.loadPolicy().guardEnabled).toBe(true);
      expect(validator.loadPolicy().bootSequence).toBe(true);
      const saved = JSON.parse(fs.readFileSync(validator.AUTH_FILE, 'utf8'));
      expect(saved.recoveryQuestions).toHaveLength(3);
      expect(new Set(saved.recoveryQuestions.map(item => item.salt)).size).toBe(3);
      expect(saved.recoveryQuestions.every(item => item.answerHash && !item.answer)).toBe(true);
      expect(JSON.stringify(saved)).not.toContain('Pine Street School');
      expect(JSON.stringify(saved)).not.toContain('Portland');
      expect(JSON.stringify(saved)).not.toContain('Comet');
      const envAfter = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
      expect(envAfter).toEqual(envBefore);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
