/**
 * build-usb --carry-home never deletes a git checkout (sweep C08, 2026-09-28).
 *
 * The drive's AEON/ is a real checkout — committed and pushed from, with
 * stashes. The documented update step (re-run the builder) copied tracked
 * files, dist/ and node_modules into AEON.incoming, then rmSync'd AEON/ and
 * renamed: .git, the stashes, uncommitted edits and untracked store blocks
 * were gone. Run from the drive itself, ROOT was that folder, so not even
 * extraBlocks survived. The builder now refuses before it writes anything —
 * dry run included — and names the command that updates a checkout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const carry = require('../scripts/build-usb-carry.cjs');
const ROOT = path.join(path.dirname(require.resolve('../scripts/build-usb-carry.cjs')), '..');

let tmp, origFetch;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-carry-')));
  // The builder pings 127.0.0.1:3001 for a running AEON. A test never asks.
  origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('no network in tests'));
});
afterEach(() => {
  globalThis.fetch = origFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/** A drive whose AEON/ is a checkout with work in it that git alone holds. */
function checkoutDrive() {
  const drive = path.join(tmp, 'drive');
  const app = path.join(drive, 'AEON');
  write(path.join(app, '.git', 'HEAD'), 'ref: refs/heads/memory-retrieval-fixes\n');
  write(path.join(app, '.git', 'refs', 'stash'), 'a'.repeat(40) + '\n');
  write(path.join(app, 'notes.txt'), 'uncommitted');
  write(path.join(app, 'src', 'blocks', 'clients', 'block.manifest.json'), '{"id":"clients"}');
  write(path.join(drive, 'AEON-Data', 'home.json'), '{}');
  return { drive, app };
}
const survived = (app) => [
  path.join(app, '.git', 'HEAD'), path.join(app, '.git', 'refs', 'stash'),
  path.join(app, 'notes.txt'), path.join(app, 'src', 'blocks', 'clients', 'block.manifest.json'),
].every((p) => fs.existsSync(p));

describe('a git checkout on the drive is never replaced', () => {
  it('the plan sees the checkout and the refusal names the in-place update', () => {
    const { drive } = checkoutDrive();
    const plan = carry.planCarry(drive);
    expect(plan.checkout).toBe(true);
    const why = carry.carryRefusal(plan);
    expect(why).toMatch(/is a git checkout/);
    expect(why).toContain('git pull && npm ci && npm run build');
    expect(carry.carryRefusal(carry.planCarry(path.join(tmp, 'blank')))).toBeNull();
  });

  it('a dry run refuses too — it must not report a plan the real run cannot carry out', async () => {
    const { drive, app } = checkoutDrive();
    await expect(carry.buildCarried({ target: drive, dryRun: true }, { log: () => {} }))
      .rejects.toThrow(/git checkout[\s\S]*git pull && npm ci && npm run build/);
    expect(survived(app)).toBe(true);
  });

  it('a real run refuses before writing anything: .git, stashes, uncommitted and untracked files survive', async () => {
    const { drive, app } = checkoutDrive();
    await expect(carry.buildCarried({ target: drive, skipRuntime: true }, { log: () => {} }))
      .rejects.toThrow(/git checkout/);
    expect(survived(app)).toBe(true);
    expect(fs.existsSync(`${app}.incoming`)).toBe(false);
  });

  it('refuses to replace the folder the builder is running from', () => {
    expect(carry.carryRefusal({ app: path.join(tmp, 'd', 'AEON'), checkout: false, self: true }))
      .toMatch(/running from .*the app it would replace/);
  });

  it.skipIf(process.platform === 'win32')('recognises its own folder behind a symlink', () => {
    const drive = path.join(tmp, 'selfdrive');
    fs.mkdirSync(drive);
    fs.symlinkSync(ROOT, path.join(drive, 'AEON'));
    expect(carry.planCarry(drive).self).toBe(true);
  });

  it('the drive README tells a checkout how to update', () => {
    carry.writeDriveReadme(tmp, { built: '2026-09-28', runtimes: { mac: 'universal', win: 'x64', linux: 'x64' } });
    const txt = fs.readFileSync(path.join(tmp, 'README_DRIVE.txt'), 'utf8');
    expect(txt).toMatch(/git checkout[\s\S]*refuses[\s\S]*git pull && npm ci && npm run build/);
  });

  it('verify-usb --carry-home says the app is a checkout and how to update it', () => {
    const { drive } = checkoutDrive();
    let out;
    try { out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-usb.js'), '--target', drive, '--carry-home'], { encoding: 'utf8' }); }
    catch (e) { out = String(e.stdout || ''); } // the fixture is incomplete; only this line matters
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/AEON\/ is a git checkout.*git pull && npm ci && npm run build/);
  });
});
