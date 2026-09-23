/**
 * A dead console must not become a disk-filling loop.
 *
 * Seen live 2026-09-22: AEON was launched twice two seconds apart. The loser
 * of the port race sat in the old EADDRINUSE loop, logging once a second; its
 * terminal went away, so every console write failed with EIO and became an
 * uncaught exception. The crash handler logged each one — to the same dead
 * terminal, and to data/logs/uncaught.log — and fed itself: 1 h 42 min at 90%
 * CPU, 20.6 GB.
 *
 *   - stdout/stderr get a permanent 'error' listener: any error there is
 *     absorbed and reported once per stream and code, never raised.
 *   - the crash log rotates at a size cap, so no loop can grow it without
 *     bound again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARDS = path.join(ROOT, 'src', 'kernel', 'processGuards.cjs');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-guards-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Run a script in a child; report whether an uncaught exception fired. */
function child(script) {
  const flag = path.join(tmp, 'uncaught');
  const r = spawnSync(process.execPath, ['-e', `
    process.on('uncaughtException', (e) => { require('fs').writeFileSync(${JSON.stringify(flag)}, String(e.code || e.message)); });
    ${script}
    setTimeout(() => process.exit(0), 100);
  `], { encoding: 'utf8', timeout: 10000 });
  return { uncaught: fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : null, status: r.status };
}
const eio = "Object.assign(new Error('write EIO'), { code: 'EIO' })";

describe('stream guards', () => {
  it('control: without them, an EIO on stdout IS an uncaught exception', () => {
    expect(child(`process.stdout.emit('error', ${eio});`).uncaught).toBe('EIO');
  });

  it('with them, any error on stdout or stderr is absorbed, never raised', () => {
    // Raising an unknown code would rebuild the loop for any error that
    // repeats on every write; on a console stream it only means "no output".
    const r = child(`
      require(${JSON.stringify(GUARDS)}).installStreamGuards(process);
      for (const code of ['EIO', 'EPIPE', 'ERR_STREAM_DESTROYED', 'EBOOM']) {
        process.stdout.emit('error', Object.assign(new Error(code), { code }));
        process.stderr.emit('error', Object.assign(new Error(code), { code }));
      }`);
    expect(r.uncaught).toBeNull();
  });

  it('each loss is reported once per stream and code, not once per failed write', () => {
    const { installStreamGuards } = require(GUARDS);
    const EventEmitter = require('events');
    const fake = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    const seen = [];
    installStreamGuards(fake, { onLost: (stream, code) => seen.push(`${stream}:${code}`) });
    const err = (code) => Object.assign(new Error(code), { code });
    for (let i = 0; i < 1000; i++) fake.stderr.emit('error', err('EIO'));
    fake.stderr.emit('error', err('EPIPE'));
    fake.stdout.emit('error', err('EIO'));
    expect(seen).toEqual(['stderr:EIO', 'stderr:EPIPE', 'stdout:EIO']);
  });

  it('a reporter that throws cannot re-open the loop', () => {
    const { installStreamGuards } = require(GUARDS);
    const EventEmitter = require('events');
    const fake = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    installStreamGuards(fake, { onLost: () => { throw new Error('disk gone too'); } });
    expect(() => fake.stderr.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' }))).not.toThrow();
  });

  it('installing twice adds one listener, not two', () => {
    const { installStreamGuards } = require(GUARDS);
    const fake = { stdout: new (require('events'))(), stderr: new (require('events'))() };
    installStreamGuards(fake);
    installStreamGuards(fake);
    expect(fake.stdout.listenerCount('error')).toBe(1);
    expect(fake.stderr.listenerCount('error')).toBe(1);
  });
});

/**
 * The production failure, end to end, on a real terminal (macOS, where it was
 * measured). script(1) gives the child a pty; killing script hangs that pty
 * up, and the child ignores SIGHUP as the production process evidently did.
 * The child then logs a line every 50 ms, as the old port-retry loop did once
 * a second, with a crash handler shaped like server.js's.
 *
 * Why spaced writes: Node's console absorbs the FIRST failed write on each
 * stream, but leaves a stale "error emitted" flag behind, so every later
 * failure on that stream is uncaught. Three spaced writes are the minimum to
 * start the loop — measured, and the same shape as the log's first entries.
 * A pipe with its reader gone does not reproduce it (async write errors take
 * the path the console does guard), so the harness must be a terminal.
 */
const TTY_CHILD = `
const fs = require('fs');
const { READY, GO, OUT, GUARDS } = process.env;
process.on('SIGHUP', () => {});
let n = 0;
process.on('uncaughtException', () => {
  if (++n === 2000) { fs.writeFileSync(OUT, String(n)); process.exit(0); }
  console.error('crash handler logging');
});
if (GUARDS) require(GUARDS).installStreamGuards(process);
// Both streams exist before the terminal dies, as in a server that logged at boot.
fs.writeFileSync(READY, process.pid + ':' + (process.stdout.isTTY && process.stderr.isTTY));
const wait = setInterval(() => {
  if (!fs.existsSync(GO)) return;
  clearInterval(wait);
  for (let i = 0; i < 5; i++) setTimeout(() => console.log('line after the terminal died'), i * 50);
  setTimeout(() => { fs.writeFileSync(OUT, String(n)); process.exit(0); }, 800);
}, 20);
`;

/** Crash-handler runs in the child after its terminal died, or 'no-pty'. */
function deadTerminalRun(guarded) {
  const dir = fs.mkdtempSync(path.join(tmp, 'tty-'));
  const child = path.join(dir, 'child.cjs');
  fs.writeFileSync(child, TTY_CHILD);
  const env = { ...process.env, READY: path.join(dir, 'ready'), GO: path.join(dir, 'go'), OUT: path.join(dir, 'out'), GUARDS: guarded ? GUARDS : '' };
  // stdin must not be a socket: BSD script calls tcgetattr on it.
  const s = spawn('script', ['-q', '/dev/null', process.execPath, child], { stdio: ['ignore', 'pipe', 'pipe'], env });
  s.stdout.resume();
  s.stderr.resume();
  s.on('error', () => {});
  const t0 = Date.now();
  return new Promise((resolve) => {
    const finish = (result) => {
      try { process.kill(Number(fs.readFileSync(env.READY, 'utf8').split(':')[0]), 'SIGKILL'); } catch { /* already exited */ }
      resolve(result);
    };
    const poll = setInterval(() => {
      if (fs.existsSync(env.READY)) {
        clearInterval(poll);
        s.kill('SIGKILL'); // the terminal goes away
        setTimeout(() => fs.writeFileSync(env.GO, ''), 300);
        const done = setInterval(() => {
          if (!fs.existsSync(env.OUT) && Date.now() - t0 < 8000) return;
          clearInterval(done);
          finish(fs.existsSync(env.OUT) ? Number(fs.readFileSync(env.OUT, 'utf8')) : 'timeout');
        }, 25);
      } else if (Date.now() - t0 > 4000) {
        clearInterval(poll);
        s.kill('SIGKILL');
        resolve('no-pty');
      }
    }, 20);
  });
}

describe.skipIf(process.platform !== 'darwin')('dead terminal, end to end (macOS)', () => {
  it('control: without the guards, the crash handler feeds itself', async (ctx) => {
    const r = await deadTerminalRun(false);
    if (r === 'no-pty') return ctx.skip('script(1) could not open a pty here (sandboxed?)');
    expect(r).toBe(2000);
  }, 20000);

  it('with the guards, the crash handler never runs', async (ctx) => {
    const r = await deadTerminalRun(true);
    if (r === 'no-pty') return ctx.skip('script(1) could not open a pty here (sandboxed?)');
    expect(r).toBe(0);
  }, 20000);
});

describe('crash log', () => {
  it('rotates at the cap, so its size is bounded', () => {
    const { appendCrashLog } = require(GUARDS);
    const file = path.join(tmp, 'logs', 'uncaught.log');
    const line = 'x'.repeat(100);
    for (let i = 0; i < 50; i++) appendCrashLog(file, line, { limitBytes: 1000 });
    const total = fs.statSync(file).size + (fs.existsSync(`${file}.1`) ? fs.statSync(`${file}.1`).size : 0);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(total).toBeLessThanOrEqual(2 * 1000 + 2 * 101);
  });

  it('never throws, even when the directory cannot be written', () => {
    const { appendCrashLog } = require(GUARDS);
    const blocker = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocker, 'file');
    expect(() => appendCrashLog(path.join(blocker, 'uncaught.log'), 'line')).not.toThrow();
  });
});

describe('the server installs both', () => {
  it('server.js wires the stream guards and the capped crash log', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    expect(src).toMatch(/installStreamGuards\(process[,)]/);
    // Before the first boot log line, or a console lost during boot is unguarded.
    expect(src.indexOf('installStreamGuards(process')).toBeLessThan(src.indexOf('console.log('));
    expect(src).toMatch(/appendCrashLog\(/);
    expect(src).not.toMatch(/appendFileSync\(\s*path\.join\(logDir,\s*'uncaught\.log'\)/);
  });
});
