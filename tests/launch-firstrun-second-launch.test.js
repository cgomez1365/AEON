/**
 * A second double-click while AEON runs (review of the A046 fix, 2026-09-30).
 *
 * Once the launcher stopped assuming 3001, a second launch saw 3001 busy —
 * held by the AEON already running — printed "Port 3001 is in use — AEON will
 * use 3002 instead" and "AEON IS STARTING -> http://localhost:3002", started a
 * server that refused at the home lock, and opened the running AEON only when
 * that server's minute-long redirect ended: about 65 s, after two false lines.
 *
 * Now the launcher reads the home lock first (src/kernel/runtime.cjs
 * homeHolder) and, when a live AEON holds this home, opens it and ends —
 * nothing is chosen, printed as starting, or spawned.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = require(path.join(ROOT, 'launch.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-second-launch-'));
const children = [];
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the home lock names the running AEON', () => {
  it('a live holder: its port', () => {
    expect(launcher.runningAeon('/h', { holderOf: () => ({ pid: 42, port: 3001 }) }))
      .toEqual({ port: 3001, pid: 42, starting: false });
  });

  it('one still starting keeps its port, and says so', () => {
    expect(launcher.runningAeon('/h', { holderOf: () => ({ pid: 42, port: 3004, starting: true }) }))
      .toEqual({ port: 3004, pid: 42, starting: true });
  });

  it('no holder, no port, or an unreadable lock: nothing is running', () => {
    expect(launcher.runningAeon('/h', { holderOf: () => null })).toBeNull();
    expect(launcher.runningAeon('/h', { holderOf: () => ({ starting: true }) })).toBeNull();
    expect(launcher.runningAeon('/h', { holderOf: () => { throw new Error('EACCES'); } })).toBeNull();
  });
});

describe('waiting for the running AEON', () => {
  it('stops as soon as AEON answers', async () => {
    let asked = 0;
    const who = await launcher.waitForAeon('http://x', { tries: 10, everyMs: 1, probe: async () => (++asked === 3 ? 'aeon' : 'none') });
    expect(who).toBe('aeon');
    expect(asked).toBe(3);
  });

  it('gives the last answer when AEON never comes', async () => {
    const who = await launcher.waitForAeon('http://x', { tries: 3, everyMs: 1, probe: async () => 'other' });
    expect(who).toBe('other');
  });
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Windows opens URLs with the shell's own `start`, which a test cannot stub.
describe.skipIf(process.platform === 'win32')('a second launch, end to end', () => {
  it('opens the AEON that holds this home at once, and starts nothing', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });

    // The AEON already running: it holds the home through the real lock code
    // and answers /api/ping the way server.js does.
    const fake = path.join(tmp, 'running-aeon.cjs');
    fs.writeFileSync(fake, `
const http = require('http');
const runtime = require(process.argv[2]);
const s = http.createServer((q, r) => {
  if (q.url === '/api/ping') { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, name: 'aeon' })); }
  else { r.writeHead(404); r.end(); }
});
s.listen(0, '127.0.0.1', () => {
  const port = s.address().port;
  const lock = runtime.holdHome({ home: process.argv[3], port, bind: '127.0.0.1', app: process.argv[4] });
  process.stdout.write((lock.ok && lock.held ? 'READY ' : 'NOLOCK ') + port + '\\n');
});
`);
    const running = spawn(process.execPath, [fake, path.join(ROOT, 'src/kernel/runtime.cjs'), home, ROOT], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(running);
    const runningPort = await new Promise((resolve, reject) => {
      let out = '';
      running.stdout.on('data', (d) => {
        out += d;
        const m = /^(READY|NOLOCK) (\d+)/m.exec(out);
        if (m) (m[1] === 'READY' ? resolve(Number(m[2])) : reject(new Error('the fake AEON could not take the home lock')));
      });
      running.on('exit', (c) => reject(new Error(`the fake AEON exited ${c}`)));
    });

    // No browser opens: `open` / `xdg-open` only write down what they were given.
    const bin = path.join(tmp, 'bin');
    const opened = path.join(tmp, 'opened.log');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AEON_HOME: home,
      AEON_SECRETS_DIR: path.join(home, 'secrets'),
      AEON_ENV_FILE: path.join(home, '.env'),
      AEON_HOME_MIGRATE: '0', // the install's .aeon-home pointer stays as it is
      AEON_NO_DESKTOP_ICON: '1',
      AEON_LOCAL_ONLY: 'true',
      // A port of its own, never 3001-3020: if the launcher ever got past the
      // running check, its server would start there, not on a real install's.
      PORT: String(await freePort()),
    };
    delete env.AEON_VAULT_MASTER_KEY;

    const t0 = Date.now();
    const second = spawn(process.execPath, [path.join(ROOT, 'launch.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.push(second);
    let out = '';
    second.stdout.on('data', (d) => { out += d; });
    second.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { try { process.kill(-second.pid, 'SIGKILL'); } catch { /* gone */ } resolve('timeout'); }, 30000);
      second.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    const text = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

    expect(code, text).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(fs.readFileSync(opened, 'utf8').trim()).toBe(`http://localhost:${runningPort}`);
    expect(text).toMatch(new RegExp(`already running on this computer at http://localhost:${runningPort}`));
    expect(text).not.toMatch(/AEON IS STARTING/);
    expect(text).not.toMatch(/AEON will use \d+ instead/);
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false); // nothing set up a second time
  }, 45000);
});
