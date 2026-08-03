/**
 * The clean-room property, as a gate.
 *
 * On 2026-08-03 `npm test` locked the operator out of AEON: a committed test
 * talked to whatever answered port 3001 — on a dev machine, the real install —
 * found no operator account, called /api/auth/setup, and that call also flipped
 * guardEnabled, lockEveryLaunch and a 5-minute idle lock. Two live-write
 * defects were fixed and proven by md5 across a full run.
 *
 * That proof was a MANUAL check somebody thought to perform. This file makes it
 * a test, because the property regressed the moment nobody was looking: the
 * BO-A stress test found a bare clone growing an empty `secrets/` directory
 * after `npm test`, from a module-scope mkdirSync in endpoints.cjs reached by a
 * test that had not set AEON_SECRETS_DIR.
 *
 * Empty and harmless, and exactly the same rule:
 *
 *     A test may OBSERVE a live instance. It may not PROVISION one.
 *
 * The static checks below are what a test file can honestly assert about its
 * siblings. The end-to-end proof — clone, install, run, look — is in the build
 * report, because a suite cannot fully audit itself from inside.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TESTS = __dirname;

const testFiles = fs.readdirSync(TESTS)
  .filter(f => /\.test\.js$/.test(f))
  .map(f => ({ name: f, src: fs.readFileSync(path.join(TESTS, f), 'utf8') }));

/** Strip comments — a rule described in prose is not a rule being broken. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the suite scans a meaningful number of its own files', () => {
  it('found the test files', () => {
    expect(testFiles.length).toBeGreaterThan(40);
  });
});

describe('no test provisions state in the install it runs from', () => {
  it('every test requiring endpoints.cjs sets AEON_SECRETS_DIR first', () => {
    // endpoints.cjs mkdirSync's SECRETS_DIR at MODULE SCOPE, so the env var
    // must be set before the require, not before the first call.
    const offenders = testFiles
      .filter(f => /require\(['"][^'"]*endpoints\.cjs['"]\)/.test(code(f.src)))
      .filter(f => !/AEON_SECRETS_DIR/.test(code(f.src)))
      .map(f => f.name);

    expect(
      offenders,
      `these tests create secrets/ in the repo:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every test requiring vault.cjs sets AEON_SECRETS_DIR first', () => {
    // Same module-scope path resolution (vault.cjs:22).
    const offenders = testFiles
      .filter(f => /require\(['"][^'"]*vault\.cjs['"]\)/.test(code(f.src)))
      .filter(f => !/AEON_SECRETS_DIR/.test(code(f.src)))
      .map(f => f.name);

    expect(offenders, `these tests may touch the live vault:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('no test provisions an account on a server it did not start', () => {
    // /api/auth/setup is the call that claimed the only operator slot AND
    // flipped guardEnabled. Calling it is not itself wrong — several tests
    // legitimately exercise the setup flow. What matters is WHERE.
    //
    // A test may call it if it starts its own ephemeral server
    // (`app.listen(0, '127.0.0.1')`, random port, temp vault), or if it is
    // gated behind an explicit opt-in flag. Anything else is talking to
    // whatever happens to be answering, which on a developer machine is the
    // operator's real install.
    const offenders = testFiles
      .filter(f => /auth\/setup/.test(code(f.src)))
      .filter(f => {
        const c = code(f.src);
        const ownsServer = /listen\(\s*0\s*,/.test(c);
        const optIn = /AEON_LIVE_STRESS/.test(c);
        return !ownsServer && !optIn;
      })
      .map(f => f.name);

    expect(
      offenders,
      `these tests provision an account on a server they did not start:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no test writes to the repo root', () => {
    // writeFileSync/mkdirSync against a path built from the repo root rather
    // than a temp dir.
    //
    // KNOWN EXCEPTION, listed rather than hidden — the same discipline the
    // audit gate uses for reviewed advisories. block-customize.test.js drives
    // the REAL customize router, which resolves BLOCKS_DIR from the install,
    // so it mutates two committed manifests and restores them afterwards. It
    // is the reason block manifests have intermittently shown as modified in
    // `git status`. It backs up, restores in afterAll, and registers a
    // process-exit safety net — but a SIGKILL mid-run still leaves the tree
    // dirty, which is why it is written down here as debt rather than treated
    // as fine.
    const KNOWN = new Set(['block-customize.test.js']);

    const offenders = [];
    for (const f of testFiles) {
      if (KNOWN.has(f.name)) continue;
      const c = code(f.src);
      if (!/writeFileSync|mkdirSync|cpSync|rmSync/.test(c)) continue;
      const usesTmp = /mkdtempSync|os\.tmpdir\(\)|aeon-empty-shell-test/.test(c);
      if (!usesTmp) offenders.push(f.name);
    }
    expect(
      offenders,
      `these tests write without an established temp root:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the known exception still restores what it mutates', () => {
    const src = fs.readFileSync(path.join(TESTS, 'block-customize.test.js'), 'utf8');
    expect(src).toMatch(/BACKUP/);
    expect(src).toMatch(/afterAll/);
    // The safety net, so an aborted run is less likely to leave source dirty.
    expect(src).toMatch(/process\.on\('exit'/);
  });
});

describe('the install-time artifacts are not committed', () => {
  it('secrets/ and .env are gitignored, so a leak cannot be committed either', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^secrets\/$/m);
  });
});
