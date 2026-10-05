/**
 * RESTART works from the drive (CEO, 2026-09-28: the header's RESTART said
 * "AEON cannot restart itself in this launch mode"). The carried launchers
 * ended with `exec node server.cjs`, so nothing could bring AEON back and the
 * restart routes rightly refused. They now set AEON_SUPERVISED and loop:
 * exit 75 = "restart me", any other exit ends the launcher.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const carry = require('../scripts/build-usb-carry.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-supervisor-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The loop exactly as the generated launcher writes it.
const loopOf = (script) => {
  const start = script.indexOf('export AEON_SUPERVISED=1');
  const end = script.indexOf('done', start) + 'done'.length;
  expect(start).toBeGreaterThan(-1);
  return script.slice(start, end);
};

describe.each([['macOS', carry.macLauncher()], ['Linux', carry.linuxLauncher()]])('%s launcher', (_name, script) => {
  it('no longer execs the server (nothing could restart it)', () => {
    expect(script).not.toMatch(/exec "\$NODE" server\.cjs/);
  });

  it.skipIf(process.platform === 'win32')('restarts on 75 and stops on anything else', () => {
    const count = path.join(tmp, `runs-${_name}`);
    const fake = path.join(tmp, `fake-node-${_name}.sh`);
    // A stand-in for node: records AEON_SUPERVISED, exits 75, 75, then 0.
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho "$AEON_SUPERVISED" >> "${count}"\nn=$(wc -l < "${count}")\nif [ "$n" -lt 3 ]; then exit 75; fi\nexit 0\n`, { mode: 0o755 });
    execFileSync('bash', ['-c', `NODE="${fake}"\n${loopOf(script)}\n`], { cwd: tmp, stdio: 'pipe' });
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toEqual(['1', '1', '1']);
  });

  it.skipIf(process.platform === 'win32')('a crash is not a restart', () => {
    const fake = path.join(tmp, `crash-${_name}.sh`);
    const count = path.join(tmp, `crash-runs-${_name}`);
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho x >> "${count}"\nexit 1\n`, { mode: 0o755 });
    let code = 0;
    try { execFileSync('bash', ['-c', `NODE="${fake}"\n${loopOf(script)}\n`], { cwd: tmp, stdio: 'pipe' }); }
    catch (e) { code = e.status; }
    expect(code).toBe(1);
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('Windows launcher', () => {
  it('loops on errorlevel 75 under AEON_SUPERVISED', () => {
    const bat = carry.windowsLauncher();
    expect(bat).toMatch(/set AEON_SUPERVISED=1/);
    expect(bat).toMatch(/if "%errorlevel%"=="75" \(\r?\n\s+echo {3}Restarting AEON\.\.\.\r?\n[\s\S]*?\r?\n\s+goto run\r?\n\)/);
  });
});

describe('the restart routes exit with 75 when supervised', () => {
  for (const f of ['src/blocks/settings/api/settings.js', 'src/blocks/host_os/api/system.cjs', 'server/server.js']) {
    it(f, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src).toMatch(/process\.exit\([^)]*75\)/);
    });
  }
});
