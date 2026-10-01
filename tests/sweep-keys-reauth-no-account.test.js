/**
 * C36 — the credential export works before an account exists, from the
 * machine itself; once an account exists the password is confirmed each time.
 *
 * The export needs a one-time token from POST /api/auth/reauth, which sat
 * behind requireAuth. With no account there is no session and no password, so
 * every attempt answered 401 — on a fresh install that already holds keys,
 * beside a warning that a lost .env locks the vault for good. The pre-account
 * rule requireOperator applies: loopback may act, the network may not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const reauth = require('../src/kernel/reauth.cjs');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountSecurityApi = require('../src/blocks/security/api/security.js');

const PASS = 'FixturePass1';
const QUESTIONS = [
  { questionId: 'q01', answer: 'Fixture School' },
  { questionId: 'q02', answer: 'Fixture City' },
  { questionId: 'q03', answer: 'Fixture Pet' },
];

let tempDir;
let server;
let origin;
let audit;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-reauth-'));
  const validator = createSessionValidator({
    securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
    legacyUserFile: null,
    bootTime: Date.now() - 1000,
    mobileSecret: null,
  });
  audit = [];
  const app = express();
  // So a test can present a non-loopback peer (X-Forwarded-For) to req.ip.
  app.set('trust proxy', true);
  app.use(express.json());
  mountSecurityApi(app, { sessionValidator: validator, writeOSAudit: (action, details) => audit.push({ action, details }) });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const post = async (route, body, headers = {}) => {
  const r = await fetch(`${origin}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};

describe('POST /api/auth/reauth with no account yet', () => {
  it('issues the export token to the machine itself — there is no password to confirm', async () => {
    const r = await post('/api/auth/reauth', { password: '', purpose: 'export-credentials' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, noAccount: true });
    expect(reauth.consume(r.body.token, 'export-credentials')).toBe(true);
    expect(audit.map((a) => a.action)).toContain('AUTH_REAUTH');
  });

  it('never to the network', async () => {
    const r = await post('/api/auth/reauth', { purpose: 'export-credentials' }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
    expect(r.body.error).toMatch(/Create an AEON account first/);
  });
});

// Review follow-up: loopback is only the socket. The Vite dev server's proxy
// forwards from 127.0.0.1 with no forwarding headers (vite.config.js now
// listens on 127.0.0.1 only), and a cloudflared tunnel arrives from localhost
// too — each with a tell the socket does not show.
describe('POST /api/auth/reauth with no account, through a proxy on this machine', () => {
  it('a browser on another device, through the dev server, is refused (its Origin is not this machine)', async () => {
    const r = await post('/api/auth/reauth', { purpose: 'export-credentials' }, { Origin: 'http://192.168.1.20:3000' });
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it('a tunnel is refused (its proxy headers)', async () => {
    for (const h of [{ 'CF-Connecting-IP': '203.0.113.9' }, { Via: '1.1 cloudflared' }, { Forwarded: 'for=203.0.113.9' }, { 'X-Real-IP': '203.0.113.9' }]) {
      const r = await post('/api/auth/reauth', { purpose: 'export-credentials' }, h);
      expect(r.status, JSON.stringify(h)).toBe(401);
    }
  });

  it('this machine\'s own browser still gets it', async () => {
    const r = await post('/api/auth/reauth', { purpose: 'export-credentials' }, { Origin: 'http://localhost:3000' });
    expect(r.status).toBe(200);
    expect(r.body.noAccount).toBe(true);
  });
});

describe('POST /api/auth/reauth once an account exists', () => {
  it('still needs a session and the password', async () => {
    expect((await post('/api/auth/setup', { username: 'operator', password: PASS, recoveryQuestions: QUESTIONS })).status).toBe(200);

    const noSession = await post('/api/auth/reauth', { password: PASS, purpose: 'export-credentials' });
    expect(noSession.status).toBe(401);
    expect(noSession.body.token).toBeUndefined();

    const login = await post('/api/auth/login', { username: 'operator', password: PASS });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect((await post('/api/auth/reauth', { password: 'Wrong-Pass-1', purpose: 'export-credentials' }, auth)).status).toBe(401);
    const ok = await post('/api/auth/reauth', { password: PASS, purpose: 'export-credentials' }, auth);
    expect(ok.status).toBe(200);
    expect(ok.body.noAccount).toBeUndefined();
    expect(reauth.consume(ok.body.token, 'export-credentials')).toBe(true);
  });
});
