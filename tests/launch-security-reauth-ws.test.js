/**
 * The two checks that stand on their own, without server/earlyware.cjs in front
 * (audit A058, A001):
 *
 *  - The Security block's pre-account rule for POST /api/auth/reauth. Before an
 *    account exists this hands out the token for the credential export (the
 *    vault master key and keyslots). On fe93dbf it accepted any localhost
 *    Origin, so a page another program served on localhost:8080 took the token
 *    — and with it the export (measured live, temp home, port 3341). It must
 *    take AEON's own page or the Vite dev server only, and treat a rebinding
 *    Host as the network.
 *  - /ws upgrades never pass through Express, so the Host rule has to be
 *    checked in src/kernel/ws.cjs too.
 *
 * Both use only APIs that existed on fe93dbf, so this file fails there on
 * behaviour, not on a missing export.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ls-reauth-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');

const express = require('express');
const { checkUpgrade } = require('../src/kernel/ws.cjs');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountSecurityApi = require('../src/blocks/security/api/security.js');

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('POST /api/auth/reauth before an account exists (the Security block alone)', () => {
  it('only AEON\'s own page on this machine, or the dev server, gets the export token', async () => {
    const validator = createSessionValidator({
      securityDir: path.join(tmp, 'Vault', 'blocks', 'security'),
      legacyUserFile: null, bootTime: Date.now() - 1000, mobileSecret: null,
    });
    const app = express();
    app.use(express.json());
    mountSecurityApi(app, { sessionValidator: validator });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const p = s.address().port;
    const post = (headers) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: '/api/auth/reauth', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      });
      req.end(JSON.stringify({ purpose: 'export-credentials' }));
    });
    try {
      for (const h of [{ Origin: 'http://localhost:8080' }, { Origin: 'http://127.0.0.1:5173' }, { Host: `evil.example:${p}` }]) {
        const r = await post(h);
        expect(r.status, JSON.stringify(h)).toBe(401);
        expect(r.json.token).toBeUndefined();
      }
      expect((await post({ Origin: `http://127.0.0.1:${p}` })).status).toBe(200);
      expect((await post({ Origin: `http://localhost:${p}` })).status).toBe(200);
      expect((await post({ Origin: 'http://localhost:3000' })).status).toBe(200);
      expect((await post({})).status).toBe(200);
    } finally { await new Promise((r) => s.close(r)); }
  });
});

describe('/ws upgrades get the Host rule too', () => {
  const sessions = { hasAccount: () => false, guardActive: () => false, validateSession: () => ({ ok: false }) };
  const upgrade = (headers) => checkUpgrade({ headers, socket: { localPort: 3341 }, url: '/ws' }, { sessions });

  it('a rebinding Host is refused before the upgrade, with or without an Origin', () => {
    expect(upgrade({ host: 'evil.example:3341' })).toMatchObject({ ok: false, status: 403 });
    expect(upgrade({ host: 'evil.example:3341', origin: 'http://evil.example:3341' })).toMatchObject({ ok: false, status: 403 });
    expect(upgrade({ host: 'localhost:9999', origin: 'http://localhost:9999' })).toMatchObject({ ok: false, status: 403 });
  });

  it('AEON\'s own page and the dev server still connect; another localhost port does not', () => {
    expect(upgrade({ host: '127.0.0.1:3341', origin: 'http://localhost:3341' }).ok).toBe(true);
    expect(upgrade({ host: '127.0.0.1:3341', origin: 'http://localhost:3000' }).ok).toBe(true);
    expect(upgrade({ host: '127.0.0.1:3341' }).ok).toBe(true);
    expect(upgrade({ host: '127.0.0.1:3341', origin: 'http://localhost:8080' }).ok).toBe(false);
  });
});
