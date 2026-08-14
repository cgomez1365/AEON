/**
 * The Unix launchers ship executable.
 *
 * Operator finding F-01, 2026-08-12, from the first real macOS run: AEON
 * installed and answered offline on a MacBook Pro that had never run it — but
 * `launch.command` would not start from a fresh clone without the operator
 * setting the executable bit by hand.
 *
 * Both files were committed 100644. Git records exactly one permission bit and
 * a double-clicked .command that does nothing reads as "broken product", not
 * as "permissions" — on the very first screen a buyer sees.
 *
 * This is asserted against the INDEX (`git ls-files -s`) rather than the
 * filesystem, because Windows checkouts do not carry the bit at all. The index
 * is what a macOS or Linux clone actually receives.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.join(__dirname, '..');

/** Mode git has recorded for `file`, e.g. '100755'. */
function indexMode(file) {
  const out = execFileSync('git', ['ls-files', '-s', '--', file], { cwd: ROOT, encoding: 'utf8' });
  const m = /^(\d{6})\s/.exec(out.trim());
  return m ? m[1] : null;
}

describe('unix launchers are executable in the index', () => {
  it.each(['launch.command', 'launch.sh'])('%s is 100755', (file) => {
    expect(
      indexMode(file),
      `${file} is not executable — a fresh clone needs chmod before it will run`,
    ).toBe('100755');
  });

  // The Windows launcher is invoked through cmd, which does not consult a
  // permission bit. Marking it executable would be noise, so the asymmetry is
  // pinned deliberately rather than left to look like an oversight.
  it('LAUNCH.bat stays 100644', () => {
    expect(indexMode('LAUNCH.bat')).toBe('100644');
  });
});
