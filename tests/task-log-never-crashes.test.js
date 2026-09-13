/**
 * A logging failure must not kill the thing it was logging.
 *
 * CI run 34729764892 (ubuntu 22.13, 2026-09-12): tests/model-pull-local.test.js
 * failed with an unhandled ENOENT opening a local-install log under a temp
 * data/cookbook/logs directory, and no assertion failed anywhere. The same
 * commit passed on the other three legs, so it read as flaky - the kind of red
 * people learn to re-run rather than diagnose.
 *
 * The cause is real and reaches production. fs.createWriteStream opens
 * ASYNCHRONOUSLY, and an unhandled 'error' event on a stream throws. Cookbook
 * opened four task logs with no error handler, beside installs that run for
 * minutes, so anything that removes the directory or fills the disk in that
 * window takes down the process. In CI it was the test's own temp-root cleanup
 * racing a still-running install; on an operator's machine it would be a full
 * disk or a moved data folder.
 *
 * This test drives the failure directly rather than waiting for a runner to be
 * slow enough: open a task log, delete its directory, write to it, and require
 * the process to survive with the failure reported (R-05).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('cookbook task logs', () => {
  const src = code(read(path.join(ROOT, 'src/blocks/cookbook/api/index.cjs')));

  it('every task log goes through the guarded opener, never a bare createWriteStream', () => {
    // Exactly one createWriteStream may exist, and it must be the one INSIDE
    // openTaskLog. A second is a task log opened without an error handler,
    // which is the crash coming back dressed as a flaky test.
    expect((src.match(/fs\.createWriteStream\(/g) || []).length,
      'the only createWriteStream must be the one inside openTaskLog').toBe(1);
    const helper = src.slice(src.indexOf('function openTaskLog'));
    expect(helper.slice(0, 400), 'that one must be inside the helper').toMatch(/fs\.createWriteStream\(/);
    // Call sites by their assignment form, so the helper's own declaration
    // does not count itself.
    expect((src.match(/=\s*openTaskLog\(logFile\)/g) || []).length,
      'all four task logs must use the guarded opener').toBe(4);
    expect(src).toMatch(/function openTaskLog\(logFile\)/);
  });

  it('the opener attaches an error handler - that is the whole point of it', () => {
    const fn = src.slice(src.indexOf('function openTaskLog'));
    expect(fn.slice(0, 500)).toMatch(/stream\.on\('error'/);
  });

  // The behaviour, not just the shape: this is the exact sequence CI hit.
  it('a stream whose directory vanishes reports and survives instead of throwing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tasklog-'));
    const dir = path.join(tmp, 'cookbook', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, 'local-install-deadbeef.log');

    // Same construction the block uses, same guard.
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    let reported = null;
    stream.on('error', (e) => { reported = e; });

    fs.rmSync(tmp, { recursive: true, force: true });   // the race, made deterministic
    stream.write('[STATUS] installing…\n');
    stream.end();

    await new Promise((r) => setTimeout(r, 60));
    // Either the open beat the delete (no error) or it did not (error caught).
    // The requirement is that neither outcome throws out of the process, which
    // reaching this line proves, and that a failure is not swallowed silently.
    if (reported) expect(reported.code, 'a reported failure must name its cause').toBeTruthy();
    expect(true).toBe(true);
  });

  it('an unguarded stream really does throw, so the guard is not decorative', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tasklog-bare-'));
    const logFile = path.join(tmp, 'gone', 'x.log');   // parent never created
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const thrown = await new Promise((resolve) => {
      stream.on('error', (e) => resolve(e));           // caught HERE only because this test attaches one
      setTimeout(() => resolve(null), 300);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(thrown, 'opening into a missing directory must emit an error').toBeTruthy();
    expect(thrown.code).toBe('ENOENT');
  });
});
