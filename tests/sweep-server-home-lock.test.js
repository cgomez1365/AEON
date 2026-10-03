/**
 * One AEON per home (C25) — and a lock that never locks the operator out.
 *
 * 2026-09-28: nothing stopped two servers on one AEON-Data. The drive's
 * launchers take the first free port from 3001, so a second double-click on
 * launch.command started a second AEON on 3002 over the same home; both wrote
 * the Matrix index, and the second one's Guardian boot-revoke signed the
 * operator out of the first. <home>/aeon.lock now names the AEON holding the
 * home; a second one is refused, a dead one's lock is taken over.
 *
 * Review of the first cut: closing the launcher window (SIGHUP) ended AEON
 * without 'exit', so the lock stayed; the next launch judged it by pid alone,
 * and a pid that was alive — the launcher itself, or anything Windows had
 * handed the pid to — refused every start, pointing at a URL nothing
 * answered. A live pid is now the AEON only if the OS says it started when
 * the lock says (or, when the OS will not say, if AEON answers on its port).
 *
 * Every home here is a mkdtemp folder, and the full boots run a copy of the
 * app in a mkdtemp folder; nothing touches a real install or the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import net from 'net';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'src', 'kernel', 'runtime.cjs');
const runtime = require(RUNTIME);

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-home-lock-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const lockFile = () => path.join(home, 'aeon.lock');
const readLock = () => JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
const writeLock = (fields) => fs.writeFileSync(lockFile(), JSON.stringify(fields));
const ageLock = (ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(lockFile(), t, t); };
// This machine's boot time, injected: os.uptime() is refused inside a macOS
// sandbox, and the lock must work there too (see the uptime test).
const bootAt = Date.parse('2026-09-28T08:00:00Z');
// A pid that existed and has exited: the lock of an AEON that crashed.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const ownStart = () => Math.round(Date.now() - process.uptime() * 1000);
const notAsked = (what) => () => { throw new Error(`${what} was asked, and should not have been`); };
// A judge that can ask neither the OS nor the port: the pid alone decides,
// as it did before the review. Tests widen it where that is the point.
const pidOnly = { bootAt, ppid: null, startedAt: () => null, probe: () => 'unknown' };

describe('holdHome (C25)', () => {
  it('takes a free home and records pid, port, bind and when this process started', () => {
    const r = runtime.holdHome({ home, port: 3001, bind: '127.0.0.1', app: '/x/AEON', ...pidOnly });
    expect(r.ok).toBe(true);
    expect(r.held).toBe(true);
    const lock = readLock();
    expect(lock).toMatchObject({ pid: process.pid, port: 3001, bind: '127.0.0.1', app: '/x/AEON' });
    expect(Math.abs(lock.procStart - ownStart())).toBeLessThan(1000);
    expect(runtime.homeLockPath(home)).toBe(lockFile());
  });

  it('refuses a second AEON while the first is alive, and names where it runs', () => {
    // The first AEON is this test process, holding 3001; the OS confirms it
    // started when its lock says.
    expect(runtime.holdHome({ home, port: 3001, ...pidOnly }).held).toBe(true);
    const judge = { ...pidOnly, pid: process.pid + 100000, startedAt: (p) => (p === process.pid ? ownStart() : null), probe: notAsked('the port') };
    const second = runtime.holdHome({ home, port: 3002, ...judge });
    expect(second.ok).toBe(false);
    expect(second.holder).toMatchObject({ pid: process.pid, port: 3001 });
    expect(second.holder.starting).toBeUndefined();
    expect(second.message).toMatch(/already running/);
    expect(second.message).toMatch(/http:\/\/localhost:3001/);
    expect(second.message).toContain(lockFile());
    // The running AEON's lock is untouched.
    expect(readLock().port).toBe(3001);
    expect(runtime.homeHolder(home, judge)).toMatchObject({ port: 3001 });
  });

  it('takes over the lock of an AEON that died without releasing it', () => {
    writeLock({ pid: deadPid(), port: 3001, bootAt });
    const r = runtime.holdHome({ home, port: 3002, ...pidOnly });
    expect(r.held).toBe(true);
    expect(readLock()).toMatchObject({ pid: process.pid, port: 3002 });
  });

  it('a lock from before this machine last started is stale, even if its pid is alive now', () => {
    // After a power cut the recorded pid can belong to anything.
    writeLock({ pid: process.pid, port: 3001, bootAt: bootAt - 3 * 24 * 3600 * 1000 });
    expect(runtime.holdHome({ home, port: 3001, ...pidOnly, pid: process.pid + 100000 }).held).toBe(true);
  });

  it('a lock naming our own pid is a dead run, not a rival', () => {
    writeLock({ pid: process.pid, port: 3001, bootAt });
    expect(runtime.holdHome({ home, port: 3001, ...pidOnly }).held).toBe(true);
  });

  it('a lock still being written is another AEON starting; an old unreadable one is stale', () => {
    fs.writeFileSync(lockFile(), '');
    const racing = runtime.holdHome({ home, port: 3002, ...pidOnly, pid: process.pid + 100000 });
    expect(racing.ok).toBe(false);
    expect(racing.message).toMatch(/starting/);

    ageLock(60 * 1000);
    expect(runtime.holdHome({ home, port: 3002, ...pidOnly }).held).toBe(true);
  });

  it('release removes only its own lock', () => {
    const r = runtime.holdHome({ home, port: 3001, ...pidOnly });
    r.release();
    expect(fs.existsSync(lockFile())).toBe(false);

    writeLock({ pid: process.pid + 100000, port: 3009, bootAt });
    runtime.releaseHome(lockFile(), process.pid);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('a home it cannot write never stops the boot', () => {
    const notADir = path.join(home, 'file');
    fs.writeFileSync(notADir, 'x');
    const r = runtime.holdHome({ home: notADir, port: 3001, ...pidOnly });
    expect(r.ok).toBe(true);
    expect(r.held).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('works where the machine refuses its uptime (a macOS sandbox): the pid decides', () => {
    const spy = vi.spyOn(os, 'uptime').mockImplementation(() => { const e = new Error('uv_uptime returned EPERM'); e.code = 'EPERM'; throw e; });
    const judge = { ppid: null, startedAt: () => null, probe: () => 'unknown' };
    try {
      expect(runtime.holdHome({ home, port: 3001, ...judge }).held).toBe(true);
      expect(runtime.holdHome({ home, port: 3002, ...judge, pid: process.pid + 100000 }).ok).toBe(false);
      fs.rmSync(lockFile());
      writeLock({ pid: deadPid(), port: 3001, bootAt });
      expect(runtime.holdHome({ home, port: 3002, ...judge }).held).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

describe('a live pid is not a live AEON (review of C25)', () => {
  it('a lock naming our parent — the launcher that started us — is stale however alive it is', () => {
    // The reviewer's case: this returned "AEON is already running" for a
    // lock whose pid was process.ppid.
    writeLock({ pid: process.ppid, port: 3001, bootAt, procStart: ownStart() });
    const r = runtime.holdHome({ home, port: 3001, bootAt, startedAt: notAsked('the OS'), probe: notAsked('the port') });
    expect(r.held).toBe(true);
    expect(readLock().pid).toBe(process.pid);
  });

  it('a live pid that the OS says started at another time is someone else now (pid reuse; Fast Startup)', () => {
    // Windows hands pids on within minutes, and Fast Startup keeps the boot
    // time across a shutdown, so neither the pid nor bootAt clears this lock.
    const procStart = Date.now() - 3600 * 1000;
    writeLock({ pid: process.pid, port: 3001, bootAt, procStart });
    const r = runtime.holdHome({ home, port: 3002, ...pidOnly, pid: process.pid + 100000,
      startedAt: () => Date.now() - 2000, probe: notAsked('the port') });
    expect(r.held).toBe(true);
    expect(readLock().port).toBe(3002);
  });

  it('the pid that started when the lock says is the AEON that wrote it — refused even before it listens', () => {
    const procStart = Date.now() - 20 * 1000;
    writeLock({ pid: process.pid, port: 3001, bootAt, procStart });
    const r = runtime.holdHome({ home, port: 3002, ...pidOnly, pid: process.pid + 100000,
      startedAt: () => procStart + 1500, probe: notAsked('the port') });
    expect(r.ok).toBe(false);
    expect(r.holder).toMatchObject({ pid: process.pid, port: 3001 });
    expect(r.message).toMatch(/already running/);
  });

  it('when the OS will not say, an AEON that answers on its port (or holds the connection, or cannot be asked) is running', () => {
    for (const answer of ['aeon', 'busy', 'unknown']) {
      writeLock({ pid: process.pid, port: 3001, bootAt, procStart: ownStart() });
      ageLock(10 * 60 * 1000);
      const seen = [];
      const r = runtime.holdHome({ home, port: 3002, ...pidOnly, pid: process.pid + 100000,
        probe: (lock) => { seen.push(lock.port); return answer; } });
      expect(r.ok, answer).toBe(false);
      expect(r.holder.starting, answer).toBeUndefined();
      expect(seen, answer).toEqual([3001]);
      fs.rmSync(lockFile());
    }
  });

  it('when the OS will not say and nothing AEON answers: "starting" while the lock is young, taken over once it is older than a boot', () => {
    for (const answer of ['none', 'other']) {
      writeLock({ pid: process.pid, port: 3001, bootAt, procStart: ownStart() });
      const judge = { ...pidOnly, pid: process.pid + 100000, probe: () => answer };
      const young = runtime.holdHome({ home, port: 3002, ...judge });
      expect(young.ok, answer).toBe(false);
      expect(young.holder.starting, answer).toBe(true);
      expect(young.message).toMatch(/starting/);
      expect(young.message).toMatch(/http:\/\/localhost:3001/);

      ageLock(4 * 60 * 1000);
      expect(runtime.holdHome({ home, port: 3002, ...judge }).held, answer).toBe(true);
      fs.rmSync(lockFile());
    }
  });
});

// ── The OS and the port, asked for real ───────────────────────────────────

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A child that prints one line when ready and lives until killed.
function child(script, args = []) {
  const c = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  const ready = new Promise((resolve, reject) => {
    const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); resolve(out.split('\n')[0]); } }, 20);
    c.on('exit', (code) => { clearInterval(t); reject(new Error(`child exited ${code}: ${err}`)); });
  });
  ready.catch(() => {});
  return { c, ready };
}

describe('asking the OS and the port (real processes)', () => {
  // Windows only: one retry. processStartedAt asks PowerShell with a 10 s
  // timeout (runtime.cjs), and a cold PowerShell on a CI runner sometimes
  // takes longer, so the OS "will not say" and the CI assertion below fails —
  // about 1 Windows run in 19 to 27 (v3.1.1 tag, run 36837612895, 11.27 s;
  // audit #41). One retry, on Windows only: a pid the OS really cannot date
  // still fails twice in a row, and on macOS and Linux a first failure still
  // fails.
  it('processStartedAt says when a live process started, and null for a dead pid', {
    retry: process.platform === 'win32' ? 1 : 0,
    timeout: 30000,
  }, async () => {
    const p = child('console.log(Date.now() - process.uptime() * 1000); setInterval(() => {}, 1e6);');
    try {
      const childStart = Number(await p.ready);
      await new Promise((r) => setTimeout(r, 1200));
      const said = runtime.processStartedAt(p.c.pid);
      // A macOS sandbox refuses ps; CI runners have ps and PowerShell.
      if (process.env.CI) expect(said, 'the OS would not say when a live pid started').not.toBeNull();
      if (said !== null) expect(Math.abs(said - childStart)).toBeLessThan(5000);
      expect(runtime.processStartedAt(deadPid())).toBeNull();
    } finally { p.c.kill('SIGKILL'); }
  });

  it('probeHolder tells AEON from nothing, from something else, and from a server that never answers', async () => {
    const SERVERS = `
      const http = require('http');
      const kinds = {
        aeon: (q, s) => s.end(JSON.stringify({ ok: true, name: 'aeon' })),
        guard: (q, s) => { s.statusCode = 401; s.end(JSON.stringify({ success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true })); },
        tunnel: (q, s) => { s.statusCode = 401; s.end(JSON.stringify({ correlation_id: 'AEON-REQ-1-2', error: 'Unauthorized. Invalid Token.' })); },
        other: (q, s) => s.end(JSON.stringify({ ok: true, name: 'grafana' })),
        other401: (q, s) => { s.statusCode = 401; s.end('nope'); },
        busy: () => {},
      };
      const ports = {};
      let left = Object.keys(kinds).length;
      for (const [k, h] of Object.entries(kinds)) {
        const srv = http.createServer(h).listen(0, '127.0.0.1', () => { ports[k] = srv.address().port; if (!--left) console.log(JSON.stringify(ports)); });
      }
      setInterval(() => {}, 1e6);`;
    const p = child(SERVERS);
    try {
      const ports = JSON.parse(await p.ready);
      const ask = (port) => runtime.probeHolder({ port, bind: '127.0.0.1' }, { timeoutMs: 800 });
      expect(ask(ports.aeon)).toBe('aeon');
      expect(ask(ports.guard)).toBe('aeon');
      expect(ask(ports.tunnel)).toBe('aeon');
      expect(ask(ports.other)).toBe('other');
      expect(ask(ports.other401)).toBe('other');
      expect(ask(ports.busy)).toBe('busy');
      expect(ask(await freePort())).toBe('none');
      // A bind of every interface is asked on loopback.
      expect(runtime.probeHolder({ port: ports.aeon, bind: '0.0.0.0' })).toBe('aeon');
      expect(runtime.probeHolder({ port: null })).toBe('unknown');
    } finally { p.c.kill('SIGKILL'); }
  }, 30000);
});

describe('server.js takes the home before it writes to it (C25)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const lockAt = src.indexOf('holdHome(');

  it('holds the home right after the .env load, before the vault guard and any block', () => {
    expect(lockAt).toBeGreaterThan(src.indexOf("require('dotenv').config("));
    for (const later of ['// ── Vault first-run guard', 'ensureKeyslots()', 'migrateEnvKeysToVault(', "require('./block-loader.js')", 'startServer();']) {
      expect(src.indexOf(later), later).toBeGreaterThan(lockAt);
    }
  });

  it('a refused boot ends before the server starts; a held lock is released on exit and on hang-up', () => {
    const refusal = src.slice(lockAt, src.indexOf('// ── Vault first-run guard'));
    expect(refusal).toMatch(/HOME_LOCK\.ok === false/);
    expect(refusal).toMatch(/process\.exit\(1\)/);
    expect(refusal).toMatch(/\breturn;/);
    expect(refusal).toMatch(/process\.on\('exit', HOME_LOCK\.release\)/);
    // Closing the window: SIGHUP everywhere, SIGBREAK too on Windows —
    // released synchronously, then the normal shutdown.
    expect(refusal).toMatch(/process\.platform === 'win32' \? \['SIGHUP', 'SIGBREAK'\] : \['SIGHUP'\]/);
    expect(refusal).toMatch(/process\.on\(sig, \(\) => \{ HOME_LOCK\.release\(\); shutdown\(sig\); \}\)/);
    // Called from the top of the file, so it must be hoisted.
    expect(src).toMatch(/\nasync function shutdown\(sig\)/);
  });

  it('records the port and the address the server listens on', () => {
    expect(src.match(/const PORT = /g)).toHaveLength(1);
    expect(src.indexOf('const PORT = ')).toBeLessThan(lockAt);
    expect(src).toMatch(/holdHome\(\{[^}]*port: PORT, bind: bind\.resolveBind\(\)/);
  });
});

// ── The real server ───────────────────────────────────────────────────────
// Every root is inside the mkdtemp home and the home migration is off, so a
// child reads and moves nothing in this checkout.

function serverEnv(port) {
  // What a Windows child needs to open sockets and temp files at all — a Node
  // child without SystemRoot/TEMP commonly fails with WSAEPROVIDERFAILEDINIT —
  // passed through by name; everything AEON reads is still set below.
  const winBase = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return {
    PATH: process.env.PATH,
    ...winBase,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
    HOME: home,
    AEON_HOME: home,
    AEON_HOME_MIGRATE: '0',
    AEON_ENV_FILE: path.join(home, '.env'),
    AEON_SECRETS_DIR: path.join(home, 'secrets'),
    DATA_PATH: path.join(home, 'data'),
    VAULT_PATH: path.join(home, 'Vault'),
    AEON_DB_DIR: path.join(home, 'db'),
    AEON_SETTINGS_FILE: path.join(home, 'aeon-settings.json'),
    AEON_WORKSPACE: path.join(home, 'workspace'),
    AEON_NO_DESKTOP_ICON: '1',
    PORT: String(port),
  };
}

function bootServer(port, appRoot = ROOT) {
  const c = spawn(process.execPath, [path.join(appRoot, 'server', 'server.js')], { cwd: appRoot, env: serverEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal })));
  return { child: c, exited, output: () => out };
}

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still running'), ms))]);
const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const pingOk = async (port) => {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`); return r.status === 200 || r.status === 401; }
  catch { return false; }
};

// A running AEON, as far as the lock can tell: a separate process that took
// the home through holdHome and answers /api/ping as AEON.
const HOLDER = `
const [runtime, home, port] = process.argv.slice(1);
const r = require(runtime).holdHome({ home, port: Number(port), bind: '127.0.0.1', app: 'holder' });
if (!r.held) { console.error('the holder could not take the home'); process.exit(3); }
require('http').createServer((q, s) => s.end(JSON.stringify({ ok: true, name: 'aeon' })))
  .listen(Number(port), '127.0.0.1', () => console.log('ready'));
setInterval(() => {}, 1e6);`;

describe('server.js refuses a second AEON on a held home (C25)', () => {
  // The first-run vault guard mints a key into .env and keyslots into secrets/:
  // a refused AEON must end before it.
  const mintedNothing = (holderPid) => {
    expect(fs.existsSync(path.join(home, '.env')), '.env was written').toBe(false);
    expect(fs.existsSync(path.join(home, 'secrets', 'aeon-keyslots.json')), 'keyslots were written').toBe(false);
    expect(readLock().pid).toBe(holderPid);
  };

  it('same port: exits 1 with the reason, before the vault guard', async () => {
    const port = await freePort();
    const holder = child(HOLDER, [RUNTIME, home, String(port)]);
    let b = null;
    try {
      await holder.ready;
      b = bootServer(port);
      const r = await within(b.exited, 20000);
      expect(r.code, b.output().slice(-3000)).toBe(1);
      expect(b.output()).toMatch(/already running on this home/);
      expect(b.output()).toContain(`http://localhost:${port}`);
      mintedNothing(holder.c.pid);
    } finally { b?.child.kill('SIGKILL'); holder.c.kill('SIGKILL'); }
  }, 30000);

  it('another port (the launcher picked the next free one): sends the browser to the running AEON', async () => {
    const running = await freePort();
    let mine = await freePort();
    while (mine === running) mine = await freePort();
    const holder = child(HOLDER, [RUNTIME, home, String(running)]);
    let b = null;
    try {
      await holder.ready;
      b = bootServer(mine);
      let res = null;
      for (let i = 0; i < 100 && !res; i++) {
        try { res = await fetch(`http://127.0.0.1:${mine}/block/settings?tab=keys`, { redirect: 'manual' }); }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      expect(res?.status, b.output().slice(-3000)).toBe(307);
      expect(res.headers.get('location')).toBe(`http://localhost:${running}/block/settings?tab=keys`);
      expect(b.output()).toMatch(/already running on this home/);
      mintedNothing(holder.c.pid);
    } finally { b?.child.kill('SIGKILL'); holder.c.kill('SIGKILL'); }
  }, 30000);
});

// ── Full boots, from a copy of the app ────────────────────────────────────
// A full boot flashes block runtime files and normalizes manifests under the
// app's own src/blocks; a copy keeps that off this checkout (and off other
// test files reading those manifests). child.kill('SIGHUP') is TerminateProcess
// on Windows, so these run on macOS and Linux.

describe.skipIf(process.platform === 'win32')('server.js never locks the operator out (review of C25)', () => {
  let app;
  beforeAll(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-app-'));
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
      .filter((f) => f && !/^(tests|docs|public|\.github|\.claude)\//.test(f) && fs.existsSync(path.join(ROOT, f)));
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'junction');
  });
  afterAll(() => { if (app) fs.rmSync(app, { recursive: true, force: true }); });

  // Boots on `home`, waits until it answers, closes its "window", and checks
  // that it stopped cleanly and gave the home back.
  async function bootThenHangUp(port) {
    const b = bootServer(port, app);
    try {
      await waitFor(() => { try { return readLock().pid === b.child.pid; } catch { return false; } }, 20000, 'the server to take the home')
        .catch((e) => { throw new Error(`${e.message}\n${b.output().slice(-3000)}`); });
      await waitFor(() => pingOk(port), 60000, 'the server to answer')
        .catch((e) => { throw new Error(`${e.message}\n${b.output().slice(-3000)}`); });
      b.child.kill('SIGHUP');
      const r = await within(b.exited, 20000);
      expect(r, b.output().slice(-3000)).toEqual({ code: 0, signal: null });
      expect(fs.existsSync(lockFile()), 'aeon.lock was left behind').toBe(false);
      expect(b.output()).not.toMatch(/already running on this home/);
    } finally { b.child.kill('SIGKILL'); }
  }

  it('closing the window (SIGHUP) stops AEON and gives the home back', async () => {
    await bootThenHangUp(await freePort());
    // ...so the next launch starts.
    await bootThenHangUp(await freePort());
  }, 120000);

  it('a lock naming the launcher that starts AEON does not stop the boot', async () => {
    // This test process is the server's parent, as launch.js is: alive, and
    // named by a lock that looks fresh in every other way.
    writeLock({ pid: process.pid, port: await freePort(), bind: '127.0.0.1', procStart: ownStart(), bootAt: Math.round(Date.now() - os.uptime() * 1000) });
    await bootThenHangUp(await freePort());
  }, 120000);

  it('a lock naming a live process that is not AEON (a reused pid) does not stop the boot', async () => {
    const other = child('console.log("up"); setInterval(() => {}, 1e6);');
    try {
      await other.ready;
      // An AEON that died an hour ago on a port nothing answers; its pid now
      // belongs to an unrelated live process.
      writeLock({ pid: other.c.pid, port: await freePort(), bind: '127.0.0.1', procStart: Date.now() - 3600 * 1000, bootAt: Math.round(Date.now() - os.uptime() * 1000) });
      ageLock(10 * 60 * 1000);
      await bootThenHangUp(await freePort());
    } finally { other.c.kill('SIGKILL'); }
  }, 120000);
});
