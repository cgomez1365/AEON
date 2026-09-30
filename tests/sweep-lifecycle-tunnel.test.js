/**
 * The Cloudflare tunnel lives and dies with AEON, not with one mount of the
 * Settings block (sweep C26), and each host runs its own cloudflared build
 * (sweep C29), 2026-09-28.
 *
 * C26 — every block rescan ran Settings' cleanup, which killed cloudflared: an
 *   operator using AEON through the tunnel who removed or installed any block
 *   cut off their own session. And process.exit (RESTART exits 75 on the
 *   drive) ran no cleanup, so cloudflared was orphaned, still proxying the
 *   public URL to the relaunched AEON, which believed no tunnel was running.
 * C29 — macOS and Linux stored one arch-less tools/bin/cloudflared, fetched
 *   only when missing. On the carried drive the first host's build was spawned
 *   on every later host: ENOEXEC on Linux, Bad CPU type on Apple Silicon.
 *
 * No download and no real cloudflared: the route runs a COPY of
 * connectivity.js inside a scratch app folder (its kernel and services are
 * symlinks to this repo), so its tools/bin is scratch too, and a fake
 * cloudflared there prints a trycloudflare URL and records its pid.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(require.resolve('../package.json')));
const SOURCE = path.join(REPO, 'src', 'blocks', 'settings', 'api', 'connectivity.js');
const connectivity = require(SOURCE);
const { cloudflaredTarget } = connectivity;
const TARGET = cloudflaredTarget();
// Worked out here, not imported, so the file still runs against the old module.
const HOST_BIN = TARGET && TARGET.filename.replace(/\.tgz$/, '');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

const strays = new Set();
afterAll(() => { for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch {} } });

let tmp, app, copy, pidFile, origFetch, requested;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-tunnel-')));
  app = path.join(tmp, 'app');
  copy = path.join(app, 'src', 'blocks', 'settings', 'api', 'connectivity.js');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(SOURCE, copy);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(REPO, 'src', 'kernel'), path.join(app, 'src', 'kernel'));
    fs.symlinkSync(path.join(REPO, 'services'), path.join(app, 'services'));
  }
  fs.mkdirSync(path.join(app, 'tools', 'bin'), { recursive: true });
  pidFile = path.join(tmp, 'cloudflared.pid');
  origFetch = globalThis.fetch;
  requested = [];
  globalThis.fetch = (url) => { requested.push(String(url)); return Promise.resolve({ ok: false, status: 599 }); };
});
afterEach(() => {
  globalThis.fetch = origFetch;
  delete require.cache[copy];
  try { if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in cloudflared: records its pid, prints a tunnel URL, runs until signalled. */
function plantFake(name) {
  const p = path.join(app, 'tools', 'bin', name);
  fs.writeFileSync(p, [
    `#!${process.execPath}`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.stderr.write('INF |  https://sweep-lifecycle.trycloudflare.com  |\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.chmodSync(p, 0o755);
}
const fakePid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null);

/** Mount the copy on a stub app and return a caller for its handlers. */
function mount(lifecycle) {
  const routes = {};
  const stub = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  require(copy)(stub, {
    sessionValidator: { hasAccount: () => true, guardActive: () => true },
    ...(lifecycle ? { lifecycle } : {}),
  });
  return (key, body = {}) => new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b }); } };
    Promise.resolve(routes[key]({ body }, res)).catch(reject);
  });
}
const lifecycle = () => {
  const cleanups = [];
  return { cleanups, onCleanup: (fn) => cleanups.push(fn) };
};
const START = 'POST /api/settings/connectivity/tunnel/start';
const STOP = 'POST /api/settings/connectivity/tunnel/stop';
const STATUS = 'GET /api/settings/connectivity';

describe('each host stores and runs its own cloudflared build (C29)', () => {
  it('names the stored binary by platform AND CPU', () => {
    const name = (p, a) => connectivity.cloudflaredBinName(cloudflaredTarget(p, a));
    expect(name('darwin', 'x64')).toBe('cloudflared-darwin-amd64');
    expect(name('darwin', 'arm64')).toBe('cloudflared-darwin-arm64');
    expect(name('linux', 'x64')).toBe('cloudflared-linux-amd64');
    expect(name('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(connectivity.cloudflaredBinName(null)).toBeNull();
  });

  it.skipIf(process.platform === 'win32' || !TARGET)('never runs an arch-less binary another host left behind — it fetches this host\'s own', async () => {
    plantFake('cloudflared'); // what the first host to start a tunnel stored
    const call = mount();
    const r = await call(START);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Could not download/);
    expect(requested).toContain(TARGET.url);
    await sleep(200);
    expect(fakePid(), 'the other host\'s binary was spawned').toBeNull();
  });
});

describe.skipIf(process.platform === 'win32' || !TARGET)('the tunnel belongs to AEON\'s process (C26)', () => {
  beforeEach(() => { plantFake(HOST_BIN); plantFake('cloudflared'); /* the old code's name, so it runs too */ });

  it('survives a rescan: the remounted Settings still reports it and can stop it', async () => {
    const lc1 = lifecycle();
    const first = mount(lc1);
    const started = await first(START);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const pid = fakePid(); strays.add(pid);
    expect(alive(pid)).toBe(true);

    // What blockHost.rescan() does: teardown, purge the require cache, mount again.
    for (const fn of lc1.cleanups) fn();
    delete require.cache[copy];
    const second = mount(lifecycle());
    await new Promise((r) => setImmediate(r));
    await sleep(100);

    expect(alive(pid), 'the rescan killed the tunnel').toBe(true);
    const status = await second(STATUS);
    expect(status.body.tunnel.running).toBe(true);
    expect(status.body.tunnel.url).toBe('https://sweep-lifecycle.trycloudflare.com');

    const stop = await second(STOP);
    expect(stop.body.ok).toBe(true);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  }, 20000);

  it('is stopped, and says so, when Settings goes away and nothing remounts it', async () => {
    const lc = lifecycle();
    const call = mount(lc);
    expect((await call(START)).status).toBe(200);
    const pid = fakePid(); strays.add(pid);
    for (const fn of lc.cleanups) fn();
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect((await call(STATUS)).body.tunnel.running).toBe(false);
  }, 20000);

  it('dies with AEON: an exit 75 restart leaves no cloudflared behind', async () => {
    const child = path.join(tmp, 'aeon-child.cjs');
    fs.writeFileSync(child, `
      const routes = {};
      const stub = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
      require(${JSON.stringify(copy)})(stub, { sessionValidator: { hasAccount: () => true, guardActive: () => true } });
      const res = { code: 200, status(c) { this.code = c; return this; },
        json(b) { console.log(JSON.stringify({ status: this.code, ...b })); process.exit(75); } };
      routes[${JSON.stringify(START)}]({ body: {} }, res);
    `);
    const r = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 30000, env: process.env });
    expect(r.status, r.stderr).toBe(75);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()).url).toBe('https://sweep-lifecycle.trycloudflare.com');
    const pid = fakePid(); strays.add(pid);
    expect(pid).toBeTruthy();
    expect(await waitFor(() => !alive(pid)), 'cloudflared outlived the AEON that started it').toBe(true);
  }, 40000);
});

// Review follow-ups: the download path. A fetched build is served from a
// stand-in "release" (fetch stub): a raw file on Linux, a .tgz on macOS.
describe.skipIf(process.platform === 'win32' || !TARGET)('downloading this host\'s build', () => {
  const fakeRelease = () => {
    const src = path.join(tmp, 'release');
    fs.mkdirSync(src, { recursive: true });
    const fake = path.join(src, 'cloudflared');
    fs.writeFileSync(fake, [
      `#!${process.execPath}`,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.stderr.write('INF |  https://sweep-lifecycle.trycloudflare.com  |\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    fs.chmodSync(fake, 0o755);
    if (TARGET.archive !== 'tgz') return fs.readFileSync(fake);
    const tgz = path.join(tmp, 'release.tgz');
    const r = spawnSync('tar', ['-czf', tgz, '-C', src, 'cloudflared']);
    expect(r.status).toBe(0);
    return fs.readFileSync(tgz);
  };
  const serve = (bytes) => { globalThis.fetch = (url) => { requested.push(String(url)); return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }); }; };

  it('removes the arch-less binary an earlier AEON stored, once its own build is in place', async () => {
    plantFake('cloudflared');
    serve(fakeRelease());
    const lc = lifecycle();
    const r = await mount(lc)(START);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    strays.add(fakePid());
    expect(fs.existsSync(path.join(app, 'tools', 'bin', HOST_BIN))).toBe(true);
    expect(fs.existsSync(path.join(app, 'tools', 'bin', 'cloudflared'))).toBe(false);
    for (const fn of lc.cleanups) fn();
  }, 20000);

  it.skipIf(TARGET?.archive !== 'tgz')('a write that fails leaves no unpack- folder behind', async () => {
    serve(fakeRelease());
    const realWrite = fs.writeFileSync;
    const { vi } = await import('vitest');
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(function (file, ...rest) {
      if (String(file).endsWith(TARGET.filename)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realWrite.call(fs, file, ...rest);
    });
    try {
      const r = await mount()(START);
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/ENOSPC/);
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(path.join(app, 'tools', 'bin')).filter((f) => f.startsWith('unpack-'))).toEqual([]);
  }, 20000);
});
