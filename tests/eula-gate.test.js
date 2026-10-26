/**
 * The AEON License Agreement gate (src/kernel/eula.cjs, EULA.md).
 *
 * Before 2026-10-25 the shipped terms said "by installing you agree" and
 * nothing recorded that anyone had: no screen showed them and no API refused
 * to work without them. These pin the gate: the API answers 428 until the
 * current version is accepted, the record lives in the AEON home and nowhere
 * else, a new version asks again, a headless install accepts only by naming the
 * exact version, and the interface shows the agreement before setup, with no Skip.
 *
 * tests/setup-isolation.js sets AEON_ACCEPT_EULA for the rest of the suite;
 * every test here starts without it, in a fresh home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const eula = () => require('../src/kernel/eula.cjs');

let home; let saved;
beforeEach(() => {
  saved = { home: process.env.AEON_HOME, accept: process.env.AEON_ACCEPT_EULA, portable: process.env.AEON_PORTABLE };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-eula-'));
  process.env.AEON_HOME = home;
  delete process.env.AEON_ACCEPT_EULA;
  delete process.env.AEON_PORTABLE;
});
afterEach(() => {
  for (const [k, v] of [['AEON_HOME', saved.home], ['AEON_ACCEPT_EULA', saved.accept], ['AEON_PORTABLE', saved.portable]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function gate(p) {
  let passed = false; const res = fakeRes();
  eula().middleware({ path: p }, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

describe('EULA.md', () => {
  it('has a version line, names the licensor, and covers paid blocks and the 7-day refund', () => {
    const cur = eula().current();
    expect(cur.version).toMatch(/^\d+\.\d+$/);
    expect(cur.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cur.text).toMatch(/Broken Gear Industries/);
    expect(cur.text).toMatch(/licensed, not sold/);
    expect(cur.text).toMatch(/within 7 days of purchase/);
    expect(cur.text).toContain(`AEON_ACCEPT_EULA=${cur.version}`);
  });

  it('travels with the app to a portable drive', () => {
    expect(require('../scripts/build-usb.js').shouldExclude('EULA.md')).toBe(false);
  });
});

describe('acceptance', () => {
  it('a fresh home has not accepted, and reading the status writes nothing', () => {
    const st = eula().status();
    expect(st.accepted).toBe(false);
    expect(st.recordPath.startsWith(home)).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('accept() records version, hash and time in legal/eula-acceptance.json, and then it counts', () => {
    const cur = eula().current();
    const rec = eula().accept(cur.version, { source: 'ui', now: () => new Date('2026-10-25T12:00:00Z') });
    const file = path.join(home, 'legal', 'eula-acceptance.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: cur.version, sha256: cur.sha256, acceptedAt: '2026-10-25T12:00:00.000Z', source: 'ui' });
    expect(rec.version).toBe(cur.version);
    const st = eula().status();
    expect(st.accepted).toBe(true);
    expect(st.via).toBe('record');
  });

  it('refuses any version but the current one', () => {
    expect(() => eula().accept('0.1')).toThrow(/version/);
    expect(eula().status().accepted).toBe(false);
  });

  it('a record of an older version does not count, and reports which version was accepted before', () => {
    fs.mkdirSync(path.join(home, 'legal'), { recursive: true });
    fs.writeFileSync(path.join(home, 'legal', 'eula-acceptance.json'), JSON.stringify({ version: '0.1', acceptedAt: '2026-01-01T00:00:00Z' }));
    const st = eula().status();
    expect(st.accepted).toBe(false);
    expect(st.previousVersion).toBe('0.1');
  });

  it('AEON_ACCEPT_EULA counts only when it names the current version', () => {
    process.env.AEON_ACCEPT_EULA = 'Y';
    expect(eula().status().accepted).toBe(false);
    process.env.AEON_ACCEPT_EULA = eula().current().version;
    const st = eula().status();
    expect(st.accepted).toBe(true);
    expect(st.via).toBe('env');
  });
});

describe('the API gate', () => {
  it('answers 428 EULA_REQUIRED on every kernel and block API until accepted', () => {
    for (const p of ['/api/settings', '/api/auth/login', '/api/commands/dispatch', '/core/telemetry', '/blocks/x', '/block/x', '/events']) {
      const r = gate(p);
      expect(r.passed, p).toBe(false);
      expect(r.status, p).toBe(428);
      expect(r.body.error, p).toBe('EULA_REQUIRED');
      expect(r.body.version, p).toBe(eula().current().version);
    }
  });

  it('lets the liveness probe, the agreement routes and the interface files through', () => {
    for (const p of ['/api/ping', '/api/eula', '/api/eula/accept', '/', '/assets/index.js', '/sw.js']) {
      expect(gate(p).passed, p).toBe(true);
    }
  });

  it('opens once the current version is accepted', () => {
    eula().accept(eula().current().version);
    expect(gate('/api/settings').passed).toBe(true);
  });

  it('POST /api/eula/accept works over HTTP from this machine, refuses the wrong version, then the API opens', async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    eula().mount(app);
    app.use(eula().middleware);
    app.get('/api/settings', (_q, r) => r.json({ ok: true }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect((await fetch(`${base}/api/settings`)).status).toBe(428);
      const info = await (await fetch(`${base}/api/eula`)).json();
      expect(info.accepted).toBe(false);
      expect(info.text).toMatch(/AEON License Agreement/);
      const post = (version) => fetch(`${base}/api/eula/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
      expect((await post('0.1')).status).toBe(409);
      const ok = await post(info.version);
      expect(ok.status).toBe(200);
      expect((await ok.json()).version).toBe(info.version);
      expect((await fetch(`${base}/api/settings`)).status).toBe(200);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('refuses acceptance from another machine without a signed-in session', () => {
    const routes = {};
    eula().mount({ get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } });
    const res = fakeRes();
    routes['POST /api/eula/accept']({ ip: '192.168.1.50', headers: {}, body: { version: eula().current().version } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EULA_ACCEPT_LOCAL_ONLY');
    expect(eula().status().accepted).toBe(false);
  });
});

describe('where the gate is wired', () => {
  it('the server mounts it after the tunnel gate and before earlyware, search, ping routes and the auth gate', () => {
    const src = read('server/server.js');
    const at = (s) => { const i = src.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const gateAt = at('app.use(_eula.middleware)');
    expect(at("app.use('/api', security.tunnelGate)")).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(at('app.use(earlyware.middleware)'));
    expect(gateAt).toBeLessThan(at("app.use('/api', search.router)"));
    expect(gateAt).toBeLessThan(at('_authGate.mountAuth(app)'));
    expect(src).toMatch(/eulaRequired:/);
  });

  it('the interface shows the agreement before anything else mounts, with no Skip', () => {
    // Outermost, around <App />: App's providers and timers call the API on mount,
    // and before acceptance every one of those calls would be a 428.
    const main = read('src/main.jsx');
    expect(main).toMatch(/<EulaGate>\s*<App \/>\s*<\/EulaGate>/);
    expect(read('src/App.jsx')).not.toMatch(/EulaGate/);
    const gateUi = read('src/components/EulaGate.jsx');
    expect(gateUi).not.toMatch(/skip/i);
    expect(gateUi).toMatch(/I agree, continue/);
    expect(gateUi).toMatch(/\/api\/eula\/accept/);
  });

  it('the terminal has aeon eula, and explains a 428 instead of printing it raw', () => {
    expect(read('tools/aeon-cli.cjs')).toMatch(/async eula\(\)/);
    expect(read('tools/terminal/client.cjs')).toMatch(/res\.status === 428 && data\?\.error === 'EULA_REQUIRED'/);
  });
});
