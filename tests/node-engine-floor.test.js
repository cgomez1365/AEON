// The launcher's Node floor and package.json "engines" must agree.
//
// launch.js enforced >=18 while pdfjs-dist — a runtime dependency required
// server-side — needs >=22.13, and package.json declared no engines at all.
// npm only warns on EBADENGINE, so a user on Node 18 or 20 passed the launcher
// check, was told their environment was fine, and then hit a broken install.
//
// Two locks: the launcher stops the user early with a readable message, and
// engines lets npm enforce the same floor independently. This test fails if
// either moves without the other.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const launchSrc = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');

describe('Node version floor', () => {
  it('package.json declares engines.node', () => {
    expect(pkg.engines?.node, 'engines.node missing — npm cannot enforce the floor').toBeTruthy();
  });

  it('the launcher declares its floor as named constants', () => {
    expect(launchSrc).toMatch(/NODE_MIN_MAJOR\s*=\s*\d+/);
    expect(launchSrc).toMatch(/NODE_MIN_MINOR\s*=\s*\d+/);
  });

  it('the launcher floor and engines.node are the same version', () => {
    const major = Number(/NODE_MIN_MAJOR\s*=\s*(\d+)/.exec(launchSrc)[1]);
    const minor = Number(/NODE_MIN_MINOR\s*=\s*(\d+)/.exec(launchSrc)[1]);
    const engines = /(\d+)\.(\d+)/.exec(pkg.engines.node);
    expect(engines, `could not parse engines.node "${pkg.engines.node}"`).toBeTruthy();
    expect(Number(engines[1])).toBe(major);
    expect(Number(engines[2])).toBe(minor);
  });

  it('the floor is at least as high as every declared dependency requires', () => {
    // Read the real floors out of the lockfile rather than trusting a comment.
    const lockPath = path.join(ROOT, 'package-lock.json');
    if (!fs.existsSync(lockPath)) return; // nothing to check against
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const ours = Number(/NODE_MIN_MAJOR\s*=\s*(\d+)/.exec(launchSrc)[1]);

    let highest = 0;
    let culprit = null;
    for (const [name, meta] of Object.entries(lock.packages || {})) {
      const req = meta?.engines?.node;
      if (typeof req !== 'string') continue;
      // Lowest major this package will accept — a range like
      // "^20 || >=22" is satisfied by 20, so only a hard floor counts.
      const majors = [...req.matchAll(/(\d+)\./g)].map(m => Number(m[1]));
      if (!majors.length) continue;
      const floor = Math.min(...majors);
      if (floor > highest) { highest = floor; culprit = name || 'root'; }
    }

    expect(
      ours,
      `${culprit} requires Node >=${highest}, launcher allows ${ours}`,
    ).toBeGreaterThanOrEqual(highest);
  });
});

// GitHub audit 2026-10-03 #13: the "too old" stop sent every user to the
// current LTS download, which on macOS 11–13.4 installs a Node 24 that cannot
// start there (its macOS builds need 13.5). launch.command already used Node 22
// on those Macs; the message now says the same.
describe('the "Node too old" stop names a Node this computer can run', () => {
  const { nodeDownloadAdvice } = createRequire(import.meta.url)(path.join(ROOT, 'launch.js'));

  it.each(['11.7.10', '12.7.6', '13.0', '13.4.1'])('macOS %s is told to install Node 22 LTS', (v) => {
    const msg = nodeDownloadAdvice('darwin', v);
    expect(msg).toContain(`macOS ${v}`);
    expect(msg).toMatch(/Node\.js 22 LTS/);
    expect(msg).not.toMatch(/current LTS/);
  });

  it.each([
    ['darwin', '13.5'], ['darwin', '14.6.1'], ['darwin', '26.0'],
    ['darwin', null], ['win32', null], ['linux', null],
  ])('%s %s is sent to the current LTS', (platform, v) => {
    expect(nodeDownloadAdvice(platform, v)).toBe('Download the current LTS from https://nodejs.org and run LAUNCH again.');
  });

  it('the stop asks sw_vers on macOS and prints that advice', () => {
    const stop = launchSrc.slice(launchSrc.indexOf('const NODE_MIN_MAJOR'), launchSrc.indexOf("ok(`Node.js ${nodeVer}"));
    expect(stop).toMatch(/fail\(nodeDownloadAdvice\(os\.platform\(\), os\.platform\(\) === 'darwin' \? sh\('sw_vers -productVersion'\) : null\)\);/);
  });
});
