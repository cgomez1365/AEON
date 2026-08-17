/**
 * The launchers are the first thing a new operator touches, and the only part
 * of AEON that runs before AEON does. Nothing else in the suite covers them.
 *
 * The 2026-08-12 macOS run — the one that closed DoD §20 #1 on clean physical
 * hardware — needed a manual `chmod +x launch.command` before it would start.
 * That is NOT a missing git mode: the file is committed 100755, and this gate
 * keeps it that way so the obvious cause stays ruled out. The remaining
 * candidates (a zip download, which drops modes, or Gatekeeper quarantining a
 * downloaded file) are not reproducible in CI, so that friction is still an
 * open defect — see TASKS.md. Recording which half is closed matters, because
 * "it needed a chmod" has been repeated for days without anyone checking
 * whether the repo was at fault.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** Mode as git stores it — platform independent, unlike fs.statSync on Windows. */
function gitMode(file) {
  const out = execFileSync('git', ['ls-files', '-s', '--', file], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  if (!out) return null;
  return out.split(/\s+/)[0];
}

describe('shell launchers stay executable in the index', () => {
  // Windows checkouts cannot express the bit on disk, but the INDEX carries it
  // and that is what a macOS or Linux clone materialises.
  for (const f of ['launch.command', 'launch.sh']) {
    it(`${f} is committed 100755`, () => {
      const mode = gitMode(f);
      expect(mode, `${f} is not tracked by git`).not.toBeNull();
      expect(mode,
        `${f} is committed ${mode}. Every macOS/Linux operator would have to ` +
        `chmod +x it before AEON would start. Fix: git update-index --chmod=+x ${f}`
      ).toBe('100755');
    });
  }
});

describe('shell launchers are syntactically valid', () => {
  // A launcher that does not parse fails at the worst possible moment: on a
  // machine that has never run AEON, in front of someone deciding whether the
  // product works. `bash -n` parses without executing.
  const hasBash = (() => {
    try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();

  for (const f of ['launch.command', 'launch.sh']) {
    it.skipIf(!hasBash)(`${f} parses`, () => {
      expect(() => execFileSync('bash', ['-n', path.join(ROOT, f)], { stdio: 'pipe' }))
        .not.toThrow();
    });
  }
});

describe('the launchers agree about the floor they declare', () => {
  it('every launcher names the same Node major as package.json engines', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const engines = pkg.engines?.node;
    expect(engines, 'package.json declares no engines.node').toBeTruthy();

    // The floor as a bare major, e.g. ">=22.13.0" -> 22
    const floor = Number(String(engines).match(/(\d+)/)[1]);
    expect(Number.isFinite(floor)).toBe(true);

    // A launcher that hardcodes a LOWER major than engines would install a
    // runtime the product refuses to run on — the exact shape of the defect
    // that let Node 18 through while pdfjs-dist needed >=22.13.
    for (const f of ['launch.command', 'launch.sh', 'launch.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/node@(\d+)|nodejs[_-](\d+)|NODE_MAJOR[= ]+(\d+)/gi)) {
        const named = Number(m[1] || m[2] || m[3]);
        expect(named,
          `${f} names Node ${named} but package.json engines requires >=${floor}`
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});
