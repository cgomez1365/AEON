/**
 * A046 — with port 3001 taken, the launcher opened the other program's page.
 *
 * Measured 2026-09-30: a plain HTTP server on the port, then `node launch.js`.
 * The launcher printed "[OK] Opened in your browser." and opened
 * http://localhost:<port> — the other program — because ANY HTTP reply counted
 * as AEON. The kernel then gave up ("Port … is already in use by another
 * program … start this one on another port (for example PORT=…)"): a foreign
 * page and a dead AEON, with an environment variable as the only remedy.
 *
 * Now: with no PORT set the launcher takes the first free port from 3001
 * (tools/free-port.cjs, as the carried drive's launchers already do), hands it
 * to the server, and opens the browser only when AEON's own /api/ping answers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = require(path.join(ROOT, 'launch.js'));
const freePort = require(path.join(ROOT, 'tools', 'free-port.cjs'));

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});
const serve = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(s.address().port));
});

describe('choosing the port', () => {
  it('PORT, when set, is used as given', async () => {
    let asked = false;
    const r = await launcher.choosePort({ env: { PORT: '4555' }, find: async () => { asked = true; return 1; } });
    expect(r).toEqual({ port: '4555', chosen: false });
    expect(asked).toBe(false);
  });

  it('otherwise the first free port from 3001 to 3020', async () => {
    const calls = [];
    const r = await launcher.choosePort({ env: {}, find: async (from, to) => { calls.push([from, to]); return 3002; } });
    expect(r).toEqual({ port: '3002', chosen: true });
    expect(calls).toEqual([[3001, 3020]]);
  });

  it('every port taken is said, not guessed', async () => {
    expect(await launcher.choosePort({ env: {}, find: async () => null })).toEqual({ port: null, chosen: true });
  });

  it('free-port skips a port another program holds', async () => {
    const held = await serve((_q, res) => res.end('other'));
    const got = await freePort.firstFreePort(held, held + 5);
    expect(got).not.toBe(held);
    expect(got).toBeGreaterThan(held);
  });

  // Review 2026-09-30: most programs listen the Node-default way, listen(port)
  // with no host — '::', both families. On macOS a 127.0.0.1 bind succeeds
  // beside that, so the port read as free; AEON took 127.0.0.1 and the
  // browser's `localhost` reached the other program over ::1.
  for (const host of [undefined, '::', '::1', '0.0.0.0']) {
    it(`free-port skips a port held on ${host === undefined ? 'listen(port) with no host' : host}`, async () => {
      const s = http.createServer((_q, res) => res.end('other'));
      const port = await new Promise((resolve, reject) => {
        s.once('error', reject);
        const done = () => resolve(s.address().port);
        if (host === undefined) s.listen(0, done); else s.listen(0, host, done);
      }).catch((e) => (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code) ? null : Promise.reject(e)));
      if (port == null) return; // this machine has no IPv6 loopback
      servers.push(s);
      expect(await freePort.isFree(port)).toBe(false);
    });
  }

  it('free-port still calls a port nothing holds free', async () => {
    const port = await serve(() => {});
    await new Promise((r) => servers.pop().close(r));
    expect(await freePort.isFree(port)).toBe(true);
  });
});

describe('only AEON counts as AEON', () => {
  it('reads /api/ping the way the home lock does', () => {
    expect(launcher.isAeonPing(200, JSON.stringify({ ok: true, name: 'aeon', version: '3.1.0' }))).toBe(true);
    expect(launcher.isAeonPing(401, JSON.stringify({ error: 'UNAUTHORIZED_SESSION' }))).toBe(true);
    expect(launcher.isAeonPing(200, '<h1>Grafana</h1>')).toBe(false);
    expect(launcher.isAeonPing(200, JSON.stringify({ ok: true }))).toBe(false);
    expect(launcher.isAeonPing(404, 'Not Found')).toBe(false);
  });

  it('another program on the port is "other", AEON is "aeon", nothing is "none"', async () => {
    const otherPort = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Some other program</h1>'); });
    expect(await launcher.probeAeon(`http://127.0.0.1:${otherPort}`)).toBe('other');

    const aeonPort = await serve((q, res) => {
      if (q.url === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: 'aeon' })); }
      else { res.writeHead(404); res.end(); }
    });
    expect(await launcher.probeAeon(`http://127.0.0.1:${aeonPort}`)).toBe('aeon');

    const closed = await serve(() => {});
    await new Promise((r) => servers.pop().close(r));
    expect(await launcher.probeAeon(`http://127.0.0.1:${closed}`)).toBe('none');
  });
});

describe('the launcher uses both', () => {
  const src = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');

  it('hands the chosen port to the server', () => {
    expect(src).toMatch(/const \{ port: PORT, chosen \} = await choosePort\(\)/);
    expect(src).toMatch(/env: \{ \.\.\.process\.env, PORT, AEON_SUPERVISED: '1' \}/);
  });

  it('opens the browser on AEON\'s answer, not on any answer', () => {
    expect(src).toMatch(/const who = await probeAeon\(url\)/);
    expect(src).toMatch(/if \(who === 'aeon'\) \{ opened = true; openBrowser\(\); return; \}/);
    expect(src).not.toMatch(/http\.get\(url, \(res\) => \{\s*res\.resume\(\);\s*if \(!opened\)/);
  });

  it('says so when another program answers there, instead of a silent minute (R-05)', () => {
    expect(src).toMatch(/warn\(`Another program answers at \$\{url\}/);
    expect(src).toMatch(/warn\(`AEON never answered at \$\{url\}; another program does/);
  });
});
