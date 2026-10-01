/**
 * launch.command installs a Node this Mac can run (A099).
 *
 * The macOS launcher offered `brew install node`, which installs the current
 * LTS (Node 24). Node 24's macOS builds need macOS 13.5, so on macOS 11–13.4
 * the launcher installed a Node that could not start, and AEON never ran. It
 * now installs node@22 there — keg-only in Homebrew, so the launcher puts it on
 * PATH itself — and finds it again on the next launch.
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
function launch(macosVersion, { keg22Installed = false } = {}) {
  const dir = path.join(tmp, `run-${n++}`);
  const bin = path.join(dir, 'bin');
  const prefix22 = path.join(dir, 'Cellar', 'node@22');
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
  stub('brew', [
    'echo "brew $*" >> "$LOG"',
    'case "$1" in',
    '  --prefix) echo "$PREFIX22" ;;',
    '  install) if [ "$2" = "node@22" ]; then /bin/mkdir -p "$PREFIX22/bin"; /bin/cp "$FAKE_NODE" "$PREFIX22/bin/node";',
    '           else /bin/cp "$FAKE_NODE" "$BIN/node"; fi ;;',
    'esac',
  ].join('\n'));
  if (keg22Installed) {
    fs.mkdirSync(path.join(prefix22, 'bin'), { recursive: true });
    fs.copyFileSync(fakeNode, path.join(prefix22, 'bin', 'node'));
  }
  execFileSync('/bin/bash', [path.join(dir, 'launch.command')], {
    input: 'y\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: bin, HOME: dir, SHELL: path.join(bin, 'true'),
      SWV: macosVersion, LOG: log, PREFIX22: prefix22, BIN: bin, FAKE_NODE: fakeNode,
    },
  });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe.skipIf(!posix)('launch.command with no Node installed', () => {
  it.each(['11.7.10', '12.7.6', '13.4.1'])('macOS %s gets Node 22 LTS, put on PATH for this launch', (v) => {
    const calls = launch(v);
    expect(calls).toContain('brew install node@22');
    expect(calls).not.toContain('brew install node');
    expect(calls.at(-1)).toBe('node launch.js');
  });

  it.each(['13.5', '14.6.1', '15.0'])('macOS %s gets the current LTS', (v) => {
    const calls = launch(v);
    expect(calls).toContain('brew install node');
    expect(calls).not.toContain('brew install node@22');
    expect(calls.at(-1)).toBe('node launch.js');
  });

  it('a Node 22 installed by an earlier launch is found again, not reinstalled', () => {
    const calls = launch('12.7.6', { keg22Installed: true });
    expect(calls.filter((c) => c.startsWith('brew install'))).toEqual([]);
    expect(calls.at(-1)).toBe('node launch.js');
  });
});
