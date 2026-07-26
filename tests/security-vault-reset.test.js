// Deleting the Vault data (an operator's account record) is the intended
// factory-reset escape hatch — distinct from deleting the security block's
// CODE (see security-block-missing.test.js, which proves that case does NOT
// bypass anything). This assumes filesystem access to the machine already,
// the same trust tier as physical access, and must land back on a clean
// "create your account" state — never a crash, never a stuck guardEnabled
// policy with no way to authenticate against it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const mountSecurity = require('../src/blocks/security/api/security.js');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');

describe('Vault data deletion — safe factory reset, not a broken state', () => {
  let tempDir;
  let server;
  let sessionValidator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-vault-reset-'));
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

  const post = async (url, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const setupPayload = (username = 'operator') => ({
    username, password: 'CorrectHorse9!',
    recoveryQuestions: [
      { questionId: 'q01', answer: 'Pine Street School' },
      { questionId: 'q02', answer: 'Portland' },
      { questionId: 'q03', answer: 'Comet' },
    ],
  });

  it('deleting the auth file drops both hasAccount and guardActive, even if policy.json still says guardEnabled: true', async () => {
    const created = await post('/api/auth/setup', setupPayload());
    expect(created.status).toBe(200);
    expect(sessionValidator.hasAccount()).toBe(true);
    expect(sessionValidator.guardActive()).toBe(true);

    // Simulate a user deleting the Vault security data folder.
    fs.rmSync(sessionValidator.AUTH_FILE, { force: true });

    // The stale policy file (guardEnabled: true, written at account setup)
    // is left behind on disk — this is the scenario worth being paranoid
    // about: a "protected" policy with no user to protect must never be
    // reported as still guarding anything.
    expect(fs.existsSync(sessionValidator.POLICY_FILE)).toBe(true);
    expect(sessionValidator.hasAccount()).toBe(false);
    expect(sessionValidator.guardActive()).toBe(false);
  });

  it('a fresh account can be created again after the reset — the escape hatch actually works, not a dead end', async () => {
    await post('/api/auth/setup', setupPayload());
    fs.rmSync(sessionValidator.AUTH_FILE, { force: true });

    const recreated = await post('/api/auth/setup', setupPayload());
    expect(recreated.status).toBe(200);
    expect(recreated.body.user.username).toBe('operator');

    const login = await post('/api/auth/login', { username: 'operator', password: 'CorrectHorse9!' });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
  });

  it('GET /api/auth/status reflects the reset immediately, with no crash', async () => {
    await post('/api/auth/setup', setupPayload());
    fs.rmSync(sessionValidator.AUTH_FILE, { force: true });

    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/status`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.configured).toBe(false);
    expect(body.authenticated).toBe(false);
  });
});
