/**
 * The server-side interface rebuild (src/kernel/uiBuild.cjs) — the one place
 * the running server runs `npm run build` after a block goes live.
 *
 * Driven with an injected fake spawn, so nothing here starts npm: how npm is
 * found (the carried drive has none on PATH), why a failed build is reported
 * the way it is, the timeout and the kill, the one-at-a-time chain, and that
 * build() never rejects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createUiBuilder, failureReason } = require('../src/kernel/uiBuild.cjs');

let ROOT;          // an install that CAN build (vite is there)
let BARE;          // one that cannot (production-only install)
let CLI;           // a stand-in npm-cli.js
beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-uibuild-'));
  ROOT = path.join(tmp, 'app');
  BARE = path.join(tmp, 'bare');
  fs.mkdirSync(path.join(ROOT, 'node_modules', 'vite'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'node_modules', 'vite', 'package.json'), '{}');
  fs.mkdirSync(BARE, { recursive: true });
  CLI = path.join(tmp, 'npm-cli.js');
  fs.writeFileSync(CLI, '// stand-in');
});
afterAll(() => { fs.rmSync(path.dirname(ROOT), { recursive: true, force: true }); });

/** A child process that does what the test tells it. No pid, so killTree uses child.kill. */
function fakeChild({ dieOn = [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (sig = 'SIGTERM') => {
    child.signals.push(sig);
    if (dieOn.includes(sig)) setImmediate(() => child.emit('close', null, sig));
    return true;
  };
  return child;
}

/** A builder over a fake spawn; `children` is what spawn hands out, in order. */
function setup({ root = ROOT, children = [fakeChild()], env = {}, ...opts } = {}) {
  const calls = [];
  const said = [];
  const logged = { log: [], warn: [] };
  let n = 0;
  const builder = createUiBuilder({
    root,
    spawn: (file, args, o) => { calls.push({ file, args, opts: o }); return children[n++]; },
    env,
    say: (level, msg) => said.push([level, msg]),
    log: { log: (m) => logged.log.push(m), warn: (m) => logged.warn.push(m) },
    findNpm: () => ({ command: 'npm', args: [], via: 'npm on PATH' }),
    ...opts,
  });
  return { builder, calls, said, logged, children };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('how npm is found', () => {
  it('on a normal install it runs npm run build in the install folder, with piped output', async () => {
    const { builder, calls, children } = setup({ platform: 'linux' });
    const p = builder.build('calendar');
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('npm');
    expect(calls[0].args).toEqual(['run', 'build']);
    expect(calls[0].opts).toMatchObject({ cwd: ROOT, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children[0].emit('close', 0, null);
    expect((await p).ok).toBe(true);
  });

  it('on the carried drive (AEON_NPM_CLI) it runs THIS Node on that npm-cli, with this Node first on PATH', async () => {
    const { builder, calls, children } = setup({ env: { AEON_NPM_CLI: CLI, PATH: '/usr/bin' } });
    const p = builder.build('calendar');
    await tick();
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args).toEqual([CLI, 'run', 'build']);
    expect(calls[0].opts.shell).toBe(false);
    expect(calls[0].opts.env.PATH).toBe(`${path.dirname(process.execPath)}${path.delimiter}/usr/bin`);
    children[0].emit('close', 0, null);
    await p;
  });

  it('an npm found beside this Node runs under this Node too', async () => {
    const found = path.join(path.dirname(CLI), 'beside-npm-cli.js');
    const { builder, calls, children } = setup({
      env: { PATH: '/usr/bin' },
      findNpm: () => ({ command: process.execPath, args: [found], via: found }),
    });
    const p = builder.build();
    await tick();
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args).toEqual([found, 'run', 'build']);
    expect(calls[0].opts.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter)).toBe(true);
    children[0].emit('close', 0, null);
    await p;
  });

  it('on Windows with no npm beside Node it goes through a shell as one command (no args array)', async () => {
    const { builder, calls, children } = setup({ platform: 'win32', findNpm: () => null });
    const p = builder.build();
    await tick();
    expect(calls[0].file).toBe('npm run build');
    expect(calls[0].args).toEqual([]);
    expect(calls[0].opts).toMatchObject({ shell: true, windowsHide: true, detached: false });
    children[0].emit('close', 0, null);
    await p;
  });

  it('an install with no build tooling is skipped without starting anything', async () => {
    const { builder, calls, said, logged } = setup({ root: BARE });
    const r = await builder.build('calendar');
    expect(r).toEqual({ ok: false, skipped: true, reason: 'this install cannot rebuild the interface (no build tooling)' });
    expect(calls).toHaveLength(0);
    expect(logged.warn.join('\n')).toMatch(/\[UI BUILD\] skipped/);
    expect(said[0][0]).toBe('WARN');
  });
});

describe('a build that passes or fails', () => {
  it('success: { ok, ms }, logged to the console and the event bus with the [UI BUILD] prefix', async () => {
    const { builder, said, logged, children } = setup();
    const p = builder.build('calendar');
    await tick();
    children[0].stdout.emit('data', Buffer.from('vite v6 building…\n'));
    children[0].emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe('number');
    expect(logged.log[0]).toMatch(/^\[UI BUILD\] rebuilding the interface for calendar/);
    expect(logged.log.at(-1)).toMatch(/^\[UI BUILD\] interface rebuilt in \d+s — reload the tab to see calendar/);
    expect(said.map(([l]) => l)).toEqual(['INFO', 'OK']);
  });

  it('failure: the Error line is the reason, not the last stack frame', async () => {
    const { builder, children } = setup();
    const p = builder.build('calendar');
    await tick();
    children[0].stderr.emit('data', Buffer.from([
      'error during build:',
      "Error: Cannot find module './widget' imported from src/blocks/calendar/index.jsx",
      '    at ssrImport (file:///app/node_modules/vite/dist/node/chunks/dep.js:1:1)',
      '    at async run (file:///app/node_modules/vite/dist/node/cli.js:2:2)',
      'npm error code 1',
      'npm error command failed',
    ].join('\n')));
    children[0].emit('close', 1, null);
    const r = await p;
    expect(r).toEqual({ ok: false, code: 1, signal: null, error: "Error: Cannot find module './widget' imported from src/blocks/calendar/index.jsx" });
  });

  it('failure reason also comes from stdout when stderr says nothing useful', async () => {
    const { builder, children } = setup();
    const p = builder.build('x');
    await tick();
    children[0].stdout.emit('data', Buffer.from('gen-block-routes: routes for calendar are stale — run it\nFAILED: 1 block\n'));
    children[0].emit('close', 1, null);
    expect((await p).error).toBe('FAILED: 1 block');
  });

  it('failure with no recognisable line reports the last three lines', async () => {
    const { builder, children } = setup();
    const p = builder.build('x');
    await tick();
    children[0].stderr.emit('data', Buffer.from('alpha\nbeta\ngamma\ndelta\n'));
    children[0].emit('close', 2, null);
    expect((await p).error).toBe('beta | gamma | delta');
  });

  it('a child killed by a signal says so, not "exit null"', async () => {
    const { builder, logged, children } = setup();
    const p = builder.build('x');
    await tick();
    children[0].stderr.emit('data', Buffer.from('transforming 1200 modules\n'));
    children[0].emit('close', null, 'SIGKILL');
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: null, signal: 'SIGKILL' });
    expect(r.error).toMatch(/^killed by SIGKILL/);
    expect(r.error).not.toMatch(/exit null/);
    expect(logged.warn[0]).toMatch(/signal SIGKILL/);
  });

  it('only the tail of a chatty build is kept, so memory cannot grow and an old line is not the reason', async () => {
    const { builder, children } = setup();
    const p = builder.build('x');
    await tick();
    children[0].stderr.emit('data', Buffer.from('Error: an early problem that scrolled away\n'));
    for (let i = 0; i < 400; i++) children[0].stderr.emit('data', Buffer.from(`${'transforming module '.repeat(3)}${i}\n`.repeat(50)));
    children[0].stderr.emit('data', Buffer.from('Error: the last problem\n'));
    children[0].emit('close', 1, null);
    expect((await p).error).toBe('Error: the last problem');
  });

  it('failureReason is the one rule: a signal, then a matching line, then the last three lines', () => {
    expect(failureReason(['Error: x'], [], null, 'SIGTERM')).toBe('killed by SIGTERM');
    expect(failureReason(['at a (b:1:1)', 'TypeError: nope'], [], 1, null)).toBe('TypeError: nope');
    expect(failureReason([], [], 3, null)).toBe('exit 3');
  });

  it('npm missing: the spawn error is reported, nothing is thrown', async () => {
    const { builder, children } = setup();
    const p = builder.build('x');
    await tick();
    children[0].emit('error', Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));
    expect(await p).toEqual({ ok: false, error: 'npm was not found' });
  });

  it('a spawn that throws resolves a failure, it does not reject', async () => {
    const builder = createUiBuilder({
      root: ROOT, env: {}, spawn: () => { throw new Error('EACCES'); }, log: { log() {}, warn() {} },
      findNpm: () => ({ command: 'npm', args: [], via: 'x' }),
    });
    expect(await builder.build('x')).toMatchObject({ ok: false, error: expect.stringMatching(/EACCES/) });
  });

  it('never puts an environment value in a message', async () => {
    const { builder, said, logged, children } = setup({ env: { OPENAI_API_KEY: 'sk-secret-value-123', PATH: '/usr/bin' } });
    const p = builder.build('x');
    await tick();
    children[0].stderr.emit('data', Buffer.from('Error: boom\n'));
    children[0].emit('close', 1, null);
    await p;
    const everything = JSON.stringify([said, logged]);
    expect(everything).not.toMatch(/sk-secret-value-123/);
  });
});

describe('the timeout and the kill', () => {
  it('a build over the limit is stopped (SIGTERM, then SIGKILL) and the next build still runs', async () => {
    const stuck = fakeChild({ dieOn: ['SIGKILL'] });      // ignores SIGTERM, dies to SIGKILL
    const next = fakeChild();
    const { builder, calls } = setup({ children: [stuck, next], timeoutMs: 30, killGraceMs: 20 });
    const first = builder.build('a');
    const second = builder.build('b');
    const r = await first;
    expect(r).toEqual({ ok: false, timedOut: true, error: 'the interface build timed out after 30 ms' });
    expect(stuck.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await tick();
    next.emit('close', 0, null);                          // the chain is not wedged
    expect((await second).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('the limit is read from AEON_UI_BUILD_TIMEOUT_MS when no option is given; a longer limit does not fire early', async () => {
    const quick = fakeChild({ dieOn: ['SIGTERM'] });
    const { builder } = setup({ children: [quick], env: { AEON_UI_BUILD_TIMEOUT_MS: '25' }, killGraceMs: 20 });
    const r = await builder.build('a');
    expect(r).toMatchObject({ ok: false, timedOut: true, error: 'the interface build timed out after 25 ms' });
    expect(quick.signals).toEqual(['SIGTERM']);

    const slow = fakeChild({ dieOn: ['SIGTERM'] });
    const b2 = setup({ children: [slow], timeoutMs: 1000, killGraceMs: 10 }).builder;
    const p = b2.build('a');
    await tick();
    expect(slow.signals).toEqual([]);                     // not yet — the limit is a full second
    slow.emit('close', 0, null);
    expect((await p).ok).toBe(true);
  });

  it('kill() stops the build in flight and cancels the ones still waiting; later builds run again', async () => {
    const running = fakeChild({ dieOn: ['SIGTERM'] });
    const later = fakeChild();
    const { builder, calls } = setup({ children: [running, later], killGraceMs: 20 });
    const first = builder.build('a');
    const waiting = builder.build('b');
    await tick();
    expect(builder.kill()).toBe(true);
    expect(await first).toMatchObject({ ok: false, stopped: true });
    expect(await waiting).toMatchObject({ ok: false, skipped: true });
    expect(calls).toHaveLength(1);                        // the waiting build never started
    expect(builder.kill()).toBe(false);                   // nothing in flight now

    const again = builder.build('c');
    await tick();
    later.emit('close', 0, null);
    expect((await again).ok).toBe(true);
  });
});

describe('one build at a time', () => {
  it('two builds requested together run one after the other', async () => {
    const a = fakeChild();
    const b = fakeChild();
    const { builder, calls } = setup({ children: [a, b] });
    const p1 = builder.build('a');
    const p2 = builder.build('b');
    await tick();
    expect(calls).toHaveLength(1);                        // the second waits
    a.emit('close', 0, null);
    await p1;
    await tick();
    expect(calls).toHaveLength(2);
    b.emit('close', 1, null);
    expect((await p2).ok).toBe(false);
  });

  it('a failed build does not stop the next one', async () => {
    const a = fakeChild();
    const b = fakeChild();
    const { builder } = setup({ children: [a, b] });
    const p1 = builder.build('a');
    const p2 = builder.build('b');
    await tick();
    a.emit('close', 1, null);
    expect((await p1).ok).toBe(false);
    await tick();
    b.emit('close', 0, null);
    expect((await p2).ok).toBe(true);
  });
});
