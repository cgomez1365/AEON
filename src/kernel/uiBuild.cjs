'use strict';
/**
 * The server-side interface rebuild — the ONLY place the running server runs
 * `npm run build`.
 *
 * A block's screen is found by a build-time glob (blockRegistry.js), so a block
 * that just went live has no UI until the interface is rebuilt. The build
 * pipeline calls build() through its rebuildUI hook at the points where an
 * install or an update goes live (server.js wires it). The block is already
 * live when this runs, so build() RESOLVES, never rejects: a failure is a
 * result the caller reports, not an error that undoes the install.
 *
 *   resolves { ok: true, ms }
 *            { ok: false, skipped: true, reason }        no build tooling here
 *            { ok: false, code, signal, error }          the build ran and failed
 *            { ok: false, timedOut: true, error }        it was stopped at the limit
 *
 * How npm is found is the launcher's rule (tools/ensure-interface.cjs): the
 * carried drive has no npm on PATH and points AEON_NPM_CLI at its npm-cli.js,
 * which runs under THIS Node. Elsewhere the npm beside this Node (engineInstall
 * findNpm), else `npm` on PATH.
 *
 * One build at a time (a promise chain). The in-flight child is tracked so
 * kill() can stop it on Restart or shutdown — otherwise the launcher's own
 * rebuild would race an orphan into the same dist/.
 */
const path = require('path');
const childProcess = require('child_process');
const { canBuild: installCanBuild, npmCliBuild } = require('../../tools/ensure-interface.cjs');
const { findNpm: findNpmBesideNode } = require('./engineInstall.cjs');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;     // SIGTERM, then SIGKILL this much later
const GIVE_UP_MS = 2000;        // after SIGKILL: stop waiting for a child that will not report
const TAIL_LINES = 40;
const TAIL_BYTES = 16 * 1024;   // per stream — the build's output never grows memory
const MAX_REASON = 300;

const REASON_RE = /error|SyntaxError|failed|cannot|ERR_/i;
// Lines that match REASON_RE but say nothing: stack frames, npm's own wrapper
// lines, and vite's generic headers (the line after the header is the cause).
const NOISE_RE = /^(at\s|npm (error|err!|warn|notice)(\s|$)|error during build:?$|.*\bbuild failed in\b)/i;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const clip = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > MAX_REASON ? `${t.slice(0, MAX_REASON - 1)}…` : t; };

/** Keeps the last TAIL_BYTES of a stream, as lines on request. */
function makeTail() {
  let buf = '';
  return {
    push(chunk) { buf = (buf + stripAnsi(chunk)).slice(-TAIL_BYTES); },
    lines() { return buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES); },
  };
}

/** Why a build failed, in one line a person can act on. */
function failureReason(errLines, outLines, code, signal) {
  if (signal) return `killed by ${signal}${signal === 'SIGKILL' ? ' (often the system running out of memory)' : ''}`;
  const hit = (lines) => lines.find((l) => REASON_RE.test(l) && !NOISE_RE.test(l));
  const line = hit(errLines) || hit(outLines);
  if (line) return clip(line);
  const last = (errLines.length ? errLines : outLines).slice(-3);
  return last.length ? clip(last.join(' | ')) : `exit ${code}`;
}

/** Stop a build and everything it started (npm → sh → vite), not just the top process. */
function killTree(child, signal, { platform, spawn }) {
  try {
    if (platform === 'win32') {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill(signal);
    } else if (child.pid) process.kill(-child.pid, signal);   // the child leads its own group (detached)
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function createUiBuilder({
  root,
  spawn = childProcess.spawn,
  env = process.env,
  timeoutMs,
  say = () => {},
  log = console,
  killGraceMs = KILL_GRACE_MS,
  execPath = process.execPath,
  platform = process.platform,
  findNpm = findNpmBesideNode,
  canBuild = installCanBuild,
} = {}) {
  if (!root) throw new Error('createUiBuilder: root is required');
  const envMs = Number(env.AEON_UI_BUILD_TIMEOUT_MS);
  const limitMs = timeoutMs > 0 ? timeoutMs : envMs > 0 ? envMs : DEFAULT_TIMEOUT_MS;
  const limitText = limitMs >= 1000 ? `${Math.round(limitMs / 1000)} s` : `${limitMs} ms`;

  let chain = Promise.resolve();
  let current = null;   // the build in flight: { child, timer, killTimer, hardTimer, timedOut, stopped }
  let epoch = 0;        // kill() bumps it, so builds still waiting their turn do not start

  // Console (server.log) and the terminal event bus. Never a place for env values.
  const note = (level, msg) => {
    try { (level === 'WARN' ? log.warn : log.log).call(log, msg); } catch { /* logging must not fail a build */ }
    try { say(level, msg); } catch { /* neither must the bus */ }
  };

  /** What to run: the drive's npm-cli under this Node, else npm beside this Node, else npm on PATH. */
  function command() {
    const drive = npmCliBuild(env);
    if (drive) return { file: drive.command, args: drive.args, env: drive.env, shell: false };
    const npm = findNpm({ execPath, env, platform });
    if (npm && npm.command !== 'npm') {
      const sep = platform === 'win32' ? ';' : ':';
      return { file: npm.command, args: [...npm.args, 'run', 'build'], env: { ...env, PATH: path.dirname(execPath) + sep + (env.PATH || '') }, shell: false };
    }
    // npm.cmd is a batch file: on Windows Node starts it only through a shell.
    if (platform === 'win32') return { file: 'npm run build', args: [], env, shell: true };
    return { file: 'npm', args: ['run', 'build'], env, shell: false };
  }

  function terminate(run) {
    if (!run.child) return;
    killTree(run.child, 'SIGTERM', { platform, spawn });
    run.killTimer = setTimeout(() => {
      killTree(run.child, 'SIGKILL', { platform, spawn });
      run.hardTimer = setTimeout(() => run.giveUp && run.giveUp(), GIVE_UP_MS);
      if (run.hardTimer.unref) run.hardTimer.unref();
    }, killGraceMs);
    if (run.killTimer.unref) run.killTimer.unref();
  }

  function runOnce(blockId, myEpoch) {
    return new Promise((resolve) => {
      const what = blockId || 'a new block';
      const run = { child: null, timer: null, killTimer: null, hardTimer: null, timedOut: false, stopped: false, giveUp: null };
      const out = makeTail();
      const err = makeTail();
      const started = Date.now();
      let settled = false;
      const finish = (result, level, msg, detail = []) => {
        if (settled) return;
        settled = true;
        clearTimeout(run.timer); clearTimeout(run.killTimer); clearTimeout(run.hardTimer);
        if (current === run) current = null;
        note(level, msg);
        for (const line of detail) note(level, `[UI BUILD]   ${line}`);
        resolve(result);
      };
      const skip = (reason, why = reason) => finish({ ok: false, skipped: true, reason }, 'WARN', `[UI BUILD] skipped: ${why}`);
      const fail = (error, extra = {}) => finish({ ok: false, ...extra, error }, 'WARN', `[UI BUILD] failed: ${error} — ${what} is installed; run npm run build by hand to see why`);

      if (myEpoch !== epoch) return skip('the interface build was cancelled because AEON is restarting');
      if (!canBuild(root)) return skip('this install cannot rebuild the interface (no build tooling)');

      let cmd;
      try { cmd = command(); } catch (e) { return fail(e.message); }
      note('INFO', `[UI BUILD] rebuilding the interface for ${what}…`);
      let child;
      try {
        child = spawn(cmd.file, cmd.args, {
          cwd: root, env: cmd.env, shell: cmd.shell, windowsHide: true,
          detached: platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return fail(`could not start the build: ${e.message}`);
      }
      run.child = child;
      current = run;
      run.giveUp = () => (run.timedOut ? timedOut() : fail('the build did not stop when asked'));
      if (child.stdout) child.stdout.on('data', (b) => out.push(b));
      if (child.stderr) child.stderr.on('data', (b) => err.push(b));

      const timedOut = () => finish({ ok: false, timedOut: true, error: `the interface build timed out after ${limitText}` },
        'WARN', `[UI BUILD] failed: the interface build timed out after ${limitText} — it was stopped; ${what} is installed, run npm run build by hand`);

      run.timer = setTimeout(() => { run.timedOut = true; terminate(run); }, limitMs);

      child.on('error', (e) => fail(e.code === 'ENOENT' ? 'npm was not found' : e.message));
      child.on('close', (code, signal) => {
        const ms = Date.now() - started;
        if (run.timedOut) return timedOut();
        if (run.stopped) return finish({ ok: false, stopped: true, code, signal, error: 'the interface build was stopped because AEON is restarting' },
          'WARN', '[UI BUILD] stopped: AEON is restarting — the launcher rebuilds the interface on start');
        if (code === 0 && !signal) return finish({ ok: true, ms }, 'OK', `[UI BUILD] interface rebuilt in ${Math.round(ms / 1000)}s — reload the tab to see ${what}`);
        const errLines = err.lines();
        const outLines = out.lines();
        const why = failureReason(errLines, outLines, code, signal);
        const detail = (errLines.length ? errLines : outLines).slice(-10);
        finish({ ok: false, code, signal, error: why }, 'WARN',
          `[UI BUILD] failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${why} — ${what} is installed; run npm run build by hand to see why`, detail);
      });
    });
  }

  /** Rebuild the interface. Serialized; never rejects. */
  function build(blockId) {
    const myEpoch = epoch;
    const next = chain
      .then(() => runOnce(blockId, myEpoch))
      .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
    chain = next;
    return next;
  }

  /** Stop the build in flight (Restart, shutdown) and drop the ones still waiting. true if one was running. */
  function kill() {
    epoch += 1;
    const run = current;
    if (!run) return false;
    run.stopped = true;
    terminate(run);
    return true;
  }

  return { build, kill };
}

module.exports = { createUiBuilder, failureReason, DEFAULT_TIMEOUT_MS };
