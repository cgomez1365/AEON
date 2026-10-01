/**
 * Host and Origin are checked before anything answers (audit A001, A055, A058,
 * A117, A031 items "CORS any-localhost-port" and "tunnel looks local").
 *
 * Measured live on fe93dbf (temp home, port 3341, no account):
 *  - `Host: evil.example:3341` (DNS rebinding) read GET /api/settings,
 *    /api/store/source and /api/build/queue: 200.
 *  - `Origin: http://localhost:8080` was let in with credentials, reached
 *    POST /api/store/install, and took POST /api/auth/reauth's token and then
 *    POST /api/settings/export-credentials — the vault master key.
 *  - `Origin: https://aeon-cortex.vercel.app` (never deployed) was trusted.
 *  - a refused origin answered 500.
 *
 * The stack below is server.js's: the request guard and CORS from
 * server/earlyware.cjs ahead of the real Security and Settings APIs, over a
 * temp home. No network: every request goes to 127.0.0.1 on an ephemeral
 * port, and no tunnel is started (the tunnel registry entry is a fixture).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ls-host-'));
const saved = Object.fromEntries(['AEON_HOME', 'AEON_SECRETS_DIR', 'AEON_ENV_FILE', 'AEON_ALLOWED_ORIGINS'].map((k) => [k, process.env[k]]));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
delete process.env.AEON_ALLOWED_ORIGINS;
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
fs.writeFileSync(process.env.AEON_ENV_FILE, 'AEON_VAULT_MASTER_KEY=fixture0123456789\n');

const express = require('express');
const policy = require('../src/kernel/ws.cjs');
const { createRequestGuard } = require('../server/earlyware.cjs');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');
const mountSecurityApi = require('../src/blocks/security/api/security.js');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

const PASS = 'FixturePass1';
const QUESTIONS = [
  { questionId: 'q01', answer: 'Fixture School' },
  { questionId: 'q02', answer: 'Fixture City' },
  { questionId: 'q03', answer: 'Fixture Pet' },
];
const TUNNEL = 'https://fixture-tunnel.trycloudflare.com';

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ── The rule itself ────────────────────────────────────────────────────────
describe('checkHost — which names this AEON answers to', () => {
  const ok = (h, port = 3341, o) => policy.checkHost(h, { port, env: {}, tunnelHosts: new Set(), ...o }).ok;

  it('a rebinding name is refused, on the right port or not', () => {
    expect(ok('evil.example:3341')).toBe(false);
    expect(ok('evil.example')).toBe(false);
    expect(ok('localhost.evil.example:3341')).toBe(false);
  });

  it.each([['localhost:3341'], ['LOCALHOST:3341'], ['127.0.0.1:3341'], ['[::1]:3341'], ['aeon.localhost:3341'], ['192.168.1.5:3341'], ['[fe80::1]:3341']])(
    '%s is answered (loopback, or an address DNS cannot re-point)', (h) => {
      expect(ok(h)).toBe(true);
    });

  it('a loopback name on another port is not this server', () => {
    expect(ok('localhost:9999')).toBe(false);
    expect(ok('localhost')).toBe(false); // port 80
    expect(ok('localhost', 80)).toBe(true);
  });

  it('the running tunnel\'s name, and names in AEON_ALLOWED_ORIGINS, are answered', () => {
    expect(ok('fixture-tunnel.trycloudflare.com', 3341, { tunnelHosts: new Set(['fixture-tunnel.trycloudflare.com']) })).toBe(true);
    expect(ok('aeon.example.com', 3341, { env: { AEON_ALLOWED_ORIGINS: 'https://aeon.example.com' } })).toBe(true);
  });

  it('no Host header (HTTP/1.0, never a browser) is not refused', () => {
    expect(ok(undefined)).toBe(true);
  });
});

describe('checkOrigin — which pages this AEON answers', () => {
  const ok = (o, h = '127.0.0.1:3341', env = {}) => policy.checkOrigin(o, h, { env }).ok;

  it('its own page, by either loopback name, and the Vite dev server', () => {
    expect(ok('http://127.0.0.1:3341')).toBe(true);
    expect(ok('http://localhost:3341')).toBe(true);
    expect(ok('http://localhost:3000')).toBe(true);
    expect(ok('http://127.0.0.1:3000')).toBe(true);
  });

  it('not any other localhost port (A055), not the dead Vercel name (A117), not null', () => {
    expect(ok('http://localhost:8080')).toBe(false);
    expect(ok('http://127.0.0.1:5173')).toBe(false);
    expect(ok('https://aeon-cortex.vercel.app')).toBe(false);
    expect(ok('null')).toBe(false);
    expect(ok('http://evil.example:3341')).toBe(false);
  });

  it('a tunnel page matches its own Host by name; AEON_ALLOWED_ORIGINS is honoured', () => {
    expect(ok(TUNNEL, 'fixture-tunnel.trycloudflare.com')).toBe(true);
    expect(ok(TUNNEL, '127.0.0.1:3341')).toBe(false);
    expect(ok('https://aeon.example.com', '127.0.0.1:3341', { AEON_ALLOWED_ORIGINS: 'https://aeon.example.com' })).toBe(true);
  });
});

// ── server.js's stack over the real Security + Settings APIs ───────────────
let server, port, base, validator;
const tunnels = () => (globalThis[policy.TUNNELS_KEY] ||= new Map());
const FIXTURE_KEY = path.join(tmp, 'fixture-tunnel-entry');

beforeEach(async () => {
  validator = createSessionValidator({
    securityDir: path.join(tmp, `Vault-${Date.now()}-${Math.random()}`, 'blocks', 'security'),
    legacyUserFile: null, bootTime: Date.now() - 1000, mobileSecret: null,
  });
  const app = express();
  const guard = createRequestGuard({ sessions: validator, log: { warn() {} }, env: {} });
  app.use(guard.requestGuard);
  app.use(guard.cors);
  app.use(express.json());
  // Stand-ins for the read-only routes measured on fe93dbf; the guard is under
  // test, not their handlers. The export route is Settings' real one.
  app.get('/api/settings', (req, res) => res.json({ settings: 'fixture' }));
  app.get('/api/store/source', (req, res) => res.json({ source: 'fixture' }));
  mountSecurityApi(app, { sessionValidator: validator });
  mountSettingsApi(app, { cloudCredentials: { metadata: () => ({ supabase: {}, firebase: {} }) }, providerCredentials: null, supabase: null });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  tunnels().delete(FIXTURE_KEY);
  await new Promise((r) => server.close(r));
});

// fetch() will not send a Host it did not derive, so Host cases use http.request.
function raw(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('DNS rebinding (A001): a Host this AEON does not answer to is 421', () => {
  it.each([['/api/settings'], ['/api/store/source'], ['/api/auth/status']])('GET %s', async (p) => {
    const evil = await raw('GET', p, { Host: `evil.example:${port}` });
    expect(evil.status).toBe(421);
    expect(evil.json.reason).toBe('host-not-allowed');
    expect(evil.json.error).toMatch(/not to "evil\.example/);
    expect((await raw('GET', p, { Host: `localhost:${port}` })).status).toBe(200);
  });

  it('a loopback name on another port is refused too', async () => {
    expect((await raw('GET', '/api/settings', { Host: 'localhost:9999' })).status).toBe(421);
  });
});

describe('Origin (A055, A117): 403 with a reason, never 500, and no CORS headers', () => {
  it.each([['http://localhost:8080'], ['https://aeon-cortex.vercel.app'], [`http://evil.example:PORT`], ['null']])('%s', async (o) => {
    const origin = o.replace('PORT', String(port));
    const get = await raw('GET', '/api/settings', { Origin: origin });
    expect(get.status).toBe(403);
    expect(get.json.reason).toBe('origin-not-allowed');
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
    const post = await raw('POST', '/api/auth/setup', { Origin: origin }, { username: 'intruder', password: PASS, recoveryQuestions: QUESTIONS });
    expect(post.status).toBe(403);
    expect(validator.hasAccount()).toBe(false);
    const pre = await raw('OPTIONS', '/api/auth/reauth', { Origin: origin, 'Access-Control-Request-Method': 'POST' });
    expect(pre.status).toBe(403);
  });

  it('its own page and the Vite dev server get credentialed CORS', async () => {
    for (const o of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:3000']) {
      const r = await raw('GET', '/api/settings', { Origin: o });
      expect(r.status, o).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe(o);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
    }
    const pre = await raw('OPTIONS', '/api/auth/reauth', { Origin: `http://localhost:${port}`, 'Access-Control-Request-Method': 'POST' });
    expect(pre.status).toBe(204);
  });

  it('no Origin (curl, the CLI, a same-origin GET) still works', async () => {
    expect((await raw('GET', '/api/settings')).status).toBe(200);
  });
});

describe('A058: the pre-account credential export is not reachable cross-origin', () => {
  const exportFrom = async (origin) => {
    const r = await raw('POST', '/api/auth/reauth', origin ? { Origin: origin } : {}, { purpose: 'export-credentials' });
    const token = r.json && r.json.token;
    const ex = await raw('POST', '/api/settings/export-credentials', origin ? { Origin: origin } : {}, { reauthToken: token || 'none' });
    return { reauth: r, token, ex };
  };

  it('a page on another localhost port gets neither the token nor the bundle', async () => {
    const { reauth, token, ex } = await exportFrom('http://localhost:8080');
    expect(reauth.status).toBe(403);
    expect(token).toBeUndefined();
    expect(ex.status).toBe(403);
    expect(ex.text).not.toMatch(/AEON_VAULT_MASTER_KEY/);
  });

  it('AEON\'s own page on this machine still can (the backup exists for a fresh install)', async () => {
    const { reauth, token, ex } = await exportFrom(`http://localhost:${port}`);
    expect(reauth.status).toBe(200);
    expect(reauth.json.noAccount).toBe(true);
    expect(token).toBeTruthy();
    expect(ex.status).toBe(200);
    expect(ex.text).toMatch(/AEON_VAULT_MASTER_KEY=fixture0123456789/);
  });
  // The Security block's own pre-account check, without this guard in front:
  // tests/launch-security-reauth-ws.test.js.
});

describe('the tunnel ("tunnel looks local", A031)', () => {
  const startFixtureTunnel = () => tunnels().set(FIXTURE_KEY, { proc: {}, url: TUNNEL, startedAt: null, mounts: 1 });
  const viaTunnel = (method, p, body, extra = {}) =>
    raw(method, p, { Host: 'fixture-tunnel.trycloudflare.com', 'CF-Connecting-IP': '203.0.113.9', ...extra }, body);

  it('its name is answered only while it runs', async () => {
    expect((await viaTunnel('GET', '/api/auth/status')).status).toBe(421);
    startFixtureTunnel();
    expect((await viaTunnel('GET', '/api/auth/status')).status).not.toBe(421);
  });

  it('while login is off (no account yet, or switched off) every tunnel request is refused', async () => {
    startFixtureTunnel();
    const r = await viaTunnel('GET', '/api/settings');
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe('tunnel-without-login');
    // This machine itself is unaffected.
    expect((await raw('GET', '/api/settings')).status).toBe(200);
  });

  it('with an account and login on, the tunnel page reaches AEON (sign-in included)', async () => {
    expect((await raw('POST', '/api/auth/setup', {}, { username: 'operator', password: PASS, recoveryQuestions: QUESTIONS })).status).toBe(200);
    startFixtureTunnel();
    const login = await viaTunnel('POST', '/api/auth/login', { username: 'operator', password: PASS }, { Origin: TUNNEL });
    expect(login.status).toBe(200);
    expect(login.headers['access-control-allow-origin']).toBe(TUNNEL);
    validator.savePolicy({ ...validator.loadPolicy(), guardEnabled: false });
    expect((await viaTunnel('GET', '/api/auth/status')).status).toBe(403);
  });

  it('Settings keeps its tunnels where this rule reads them (src/blocks/settings/api/connectivity.js)', () => {
    require('../src/blocks/settings/api/connectivity.js');
    const reg = globalThis[policy.TUNNELS_KEY];
    expect(reg).toBeInstanceOf(Map);
    const entry = [...reg.entries()].find(([k]) => String(k).endsWith(path.join('settings', 'api')))?.[1];
    expect(entry).toBeTruthy();
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['proc', 'url']));
  });
});

describe('server.js mounts the guard first and the old CORS not at all', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  it('requestGuard and its CORS come before helmet and every router', () => {
    const g = code.indexOf('app.use(_requestGuard.requestGuard)');
    const c = code.indexOf('app.use(_requestGuard.cors)');
    expect(g).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(g);
    expect(code.indexOf('app.use(security.helmetMiddleware)')).toBeGreaterThan(c);
    expect(code.indexOf("app.use('/api'")).toBeGreaterThan(c);
  });
  it('security.corsMiddleware (any localhost port, aeon-cortex.vercel.app) is not mounted', () => {
    expect(code).not.toMatch(/security\.corsMiddleware/);
  });
});
