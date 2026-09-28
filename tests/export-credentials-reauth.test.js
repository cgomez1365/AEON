/**
 * The credential export is the whole vault — .env master key and keyslots,
 * both halves. CEO, 2026-09-28: a logged-in session alone must not be enough
 * to download it. The password is confirmed for each export (a single-use,
 * two-minute token from POST /api/auth/reauth).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-reauth-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const reauth = require('../src/kernel/reauth.cjs');
const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('re-auth tokens', () => {
  it('are single use and bound to one purpose', () => {
    const t = reauth.issue('export-credentials');
    expect(reauth.consume(t, 'something-else')).toBe(false);
    const t2 = reauth.issue('export-credentials');
    expect(reauth.consume(t2, 'export-credentials')).toBe(true);
    expect(reauth.consume(t2, 'export-credentials')).toBe(false);
    expect(reauth.consume(undefined, 'export-credentials')).toBe(false);
  });
});

describe('POST /api/settings/export-credentials', () => {
  const mount = async () => {
    const app = express();
    app.use(express.json());
    mountSettingsApi(app, { cloudCredentials: { metadata: () => ({ supabase: {}, firebase: {} }) }, providerCredentials: null, supabase: null });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const post = (base, body) => fetch(`${base}/api/settings/export-credentials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('refuses without a confirmed password, and a token works once', async () => {
    const { server, base } = await mount();
    try {
      const none = await post(base, {});
      expect(none.status).toBe(401);
      expect((await none.json()).reauthRequired).toBe(true);

      const token = reauth.issue('export-credentials');
      expect((await post(base, { reauthToken: token })).status).not.toBe(401);
      expect((await post(base, { reauthToken: token })).status).toBe(401);
    } finally { server.close(); }
  });

  it('the old GET no longer serves the bundle', async () => {
    const { server, base } = await mount();
    try {
      const r = await fetch(`${base}/api/settings/export-credentials`);
      expect(r.status).toBe(404);
    } finally { server.close(); }
  });
});
