/**
 * One app: AEON recognises the drive it runs from.
 *
 * CEO, 2026-09-22: "id want ... one app — if one app does it all great." Until
 * now a drive only worked through a launcher that exported the right variables;
 * start the same install any other way (its own launch.command, `npm start`,
 * `node server.cjs`) and it silently used the HOST's ~/AEON — or made a fresh
 * empty one there. That is both host pollution and a stranger's data mixed with
 * the drive's code.
 *
 * The drive layout written by `scripts/build-usb.js --carry-home`:
 *
 *     <drive>/AEON          the install
 *     <drive>/AEON-Data     the home — its home.json says
 *                           { "layout": "carried", "appFolder": "AEON" }
 *
 * The marker is an explicit opt-in (only the drive builder writes it) and names
 * the install beside it, so a stray folder is never picked up by accident.
 * Explicit settings still win: AEON_PORTABLE, then AEON_HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const aeonHome = require('../src/kernel/aeonHome.cjs');

let tmp, drive, app, data, fakeHome;
const homedir = () => fakeHome;

function marker(fields) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'home.json'), JSON.stringify({ schema: 1, ...fields }, null, 2));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-carried-')));
  drive = path.join(tmp, 'drive');
  app = path.join(drive, 'AEON');
  data = path.join(drive, 'AEON-Data');
  fakeHome = path.join(tmp, 'host-user');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('carried home detection', () => {
  it('uses the drive\'s AEON-Data when its home.json names this install', () => {
    marker({ layout: 'carried', appFolder: 'AEON' });
    expect(aeonHome.resolveHome({ appRoot: app, env: {}, homedir })).toBe(data);
    const r = aeonHome.roots({ appRoot: app, env: {}, homedir });
    expect(r.vault).toBe(path.join(data, 'Vault'));
    expect(r.secrets).toBe(path.join(data, 'secrets'));
    expect(r.envFile).toBe(path.join(data, '.env'));
    expect(r.settings).toBe(path.join(data, 'aeon-settings.json'));
    expect(r.db).toBe(path.join(data, 'db'));
    expect(r.workspace).toBe(data);
    expect(aeonHome.isCarried({ appRoot: app, env: {}, homedir })).toBe(true);
  });

  it('ignores a sibling AEON-Data that has no marker', () => {
    fs.mkdirSync(data, { recursive: true });
    expect(aeonHome.resolveHome({ appRoot: app, env: {}, homedir })).toBe(path.join(fakeHome, 'AEON'));
    expect(aeonHome.isCarried({ appRoot: app, env: {}, homedir })).toBe(false);
  });

  it('ignores a marker for another layout or another install folder', () => {
    marker({ layout: 'home', appFolder: 'AEON' });
    expect(aeonHome.resolveHome({ appRoot: app, env: {}, homedir })).toBe(path.join(fakeHome, 'AEON'));
    marker({ layout: 'carried', appFolder: 'AEON-old' });
    expect(aeonHome.resolveHome({ appRoot: app, env: {}, homedir })).toBe(path.join(fakeHome, 'AEON'));
  });

  it('explicit settings win: AEON_HOME, then AEON_PORTABLE', () => {
    marker({ layout: 'carried', appFolder: 'AEON' });
    const elsewhere = path.join(tmp, 'elsewhere');
    expect(aeonHome.resolveHome({ appRoot: app, env: { AEON_HOME: elsewhere }, homedir })).toBe(elsewhere);
    expect(aeonHome.resolveHome({ appRoot: app, env: { AEON_PORTABLE: 'true' }, homedir })).toBe(app);
  });

  it('a home.json update keeps the marker', () => {
    marker({ layout: 'carried', appFolder: 'AEON' });
    aeonHome.updateManifest(data, { lastBoot: 'now' });
    const m = JSON.parse(fs.readFileSync(path.join(data, 'home.json'), 'utf8'));
    expect(m.layout).toBe('carried');
    expect(m.appFolder).toBe('AEON');
  });
});

describe('a carried drive never puts an icon on the host', () => {
  it('ensureDesktopShortcut skips, and writes nothing to the host Desktop', () => {
    marker({ layout: 'carried', appFolder: 'AEON' });
    const { ensureDesktopShortcut } = require('../tools/desktop-shortcut.cjs');
    const desktopDir = path.join(fakeHome, 'Desktop');
    fs.mkdirSync(desktopDir, { recursive: true });
    const calls = [];
    const run = (...a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; };
    const r = ensureDesktopShortcut({ root: app, platform: 'darwin', env: {}, desktopDir, run, dataRoot: path.join(data, 'data') });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('carried-drive');
    expect(fs.readdirSync(desktopDir)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
