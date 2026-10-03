/**
 * launch.command installs a Node this Mac can run (A099), and a pinned one
 * (GitHub audit 2026-10-03 #13).
 *
 * The macOS launcher offered `brew install node`, which installs the current
 * LTS (Node 24). Node 24's macOS builds need macOS 13.5, so on macOS 11–13.4
 * the launcher installed a Node that could not start, and AEON never ran. It
 * now installs node@22 there — keg-only in Homebrew, so the launcher puts it on
 * PATH itself — and finds it again on the next launch.
 *
 * Homebrew's plain `node` follows the newest release (26.10.0 on 2026-10-03),
 * which no CI leg runs, so on 13.5 and newer the launcher installs node@24 —
 * also keg-only — the same way.
 *
 * Runs the real launch.command under bash with stub `sw_vers`, `brew` and
 * `node` on a PATH that holds nothing else. Nothing is installed and nothing
 * is fetched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = process.platform !== 'win32' && fs.existsSync('/bin/bash') && fs.existsSync('/bin/sh')
  && fs.existsSync('/bin/mkdir') && fs.existsSync('/bin/cp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-launch-command-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

let n = 0;
function launch(macosVersion, { kegInstalled = null } = {}) {
  const dir = path.join(tmp, `run-${n++}`);
  const bin = path.join(dir, 'bin');
  const cellar = path.join(dir, 'Cellar');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launch.command'), path.join(dir, 'launch.command'));
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  const fakeNode = path.join(dir, 'fake-node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\necho "node $*" >> "$LOG"\n');
  fs.chmodSync(fakeNode, 0o755);
  stub('sw_vers', 'echo "$SWV"');
  stub('dirname', 'echo "${1%/*}"');
  stub('open', 'exit 0');
  stub('true', 'exit 0');
  // Versioned formulae are keg-only: installed under their prefix, not on PATH.
  // Plain `node` is linked onto PATH, as Homebrew does.
  stub('brew', [
    'echo "brew $*" >> "$LOG"',
    'case "$1" in',
    '  --prefix) echo "$CELLAR/$2" ;;',
    '  install) case "$2" in',
    '    node@*) /bin/mkdir -p "$CELLAR/$2/bin"; /bin/cp "$FAKE_NODE" "$CELLAR/$2/bin/node" ;;',
    '    *) /bin/cp "$FAKE_NODE" "$BIN/node" ;;',
    '  esac ;;',
    'esac',
  ].join('\n'));
  if (kegInstalled) {
    fs.mkdirSync(path.join(cellar, kegInstalled, 'bin'), { recursive: true });
    fs.copyFileSync(fakeNode, path.join(cellar, kegInstalled, 'bin', 'node'));
  }
  execFileSync('/bin/bash', [path.join(dir, 'launch.command')], {
    input: 'y\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: bin, HOME: dir, SHELL: path.join(bin, 'true'),
      SWV: macosVersion, LOG: log, CELLAR: cellar, BIN: bin, FAKE_NODE: fakeNode,
    },
  });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe.skipIf(!posix)('launch.command with no Node installed', () => {
  it.each(['11.7.10', '12.7.6', '13.4.1'])('macOS %s gets Node 22 LTS, put on PATH for this launch', (v) => {
    const calls = launch(v);
    expect(calls.filter((c) => c.startsWith('brew install'))).toEqual(['brew install node@22']);
    expect(calls.at(-1)).toBe('node launch.js');
  });

  it.each(['13.5', '14.6.1', '15.0', '26.0'])('macOS %s gets Node 24 LTS (node@24, not the unpinned node), put on PATH for this launch', (v) => {
    const calls = launch(v);
    expect(calls.filter((c) => c.startsWith('brew install'))).toEqual(['brew install node@24']);
    expect(calls.at(-1)).toBe('node launch.js');
  });

  it.each([['12.7.6', 'node@22'], ['15.0', 'node@24']])('on macOS %s a %s installed by an earlier launch is found again, not reinstalled', (v, keg) => {
    const calls = launch(v, { kegInstalled: keg });
    expect(calls.filter((c) => c.startsWith('brew install'))).toEqual([]);
    expect(calls.at(-1)).toBe('node launch.js');
  });
});
