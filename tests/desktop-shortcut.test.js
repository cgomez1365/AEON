/**
 * First run puts an AEON icon on the Desktop.
 *
 * CEO, 2026-09-13: "on first run launch.command or [LAUNCH.bat] can we have
 * aeon generate a desktop icon that replaces [them]? this icon will also serve
 * as a natural index so everytime aeon opens, new files are auto indexed".
 *
 * What "replaces" means here: the launchers stay (the icon runs them, README
 * and the USB build depend on them) — the operator just never has to find them
 * inside a cloned folder again. macOS gets ~/Desktop/AEON.app, a tiny bundle
 * whose only job is `open -a Terminal <install>/launch.command`, so the console
 * stays visible and closing it still shuts AEON down. Windows gets AEON.lnk
 * pointing at LAUNCH.bat with AEON.ico.
 *
 * The indexing half needed no new machinery: server.js already runs an
 * incremental scan 15 s into every boot. The icon starts the server, so every
 * open indexes. What was missing was the log saying what it embedded.
 *
 * Rules this suite holds, each with a reason:
 *   - Portable/USB mode writes NOTHING to the host (BO-USB). No icon.
 *   - The operator can opt out, and an icon they deleted stays deleted until
 *     they ask for it back (--desktop-icon). Total control.
 *   - A moved install updates its own icon; a foreign AEON.app is never touched.
 *   - The Desktop is asked of the OS, never built from a home directory: that is
 *     what scan:paths forbids, and on Windows the Desktop is often redirected
 *     into OneDrive, where %USERPROFILE%\Desktop is the wrong folder.
 *   - Paths reach PowerShell and the bundle script as data, not as code.
 *
 * It also retires the tracked "AEON Command Center.lnk", which hardcoded
 * C:\Users\cgome\... and an icon in a folder nothing writes — broken for every
 * install but one (§21: the absence is asserted here).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shortcut = require('../tools/desktop-shortcut.cjs');

let TMP, root, desktop;

/** A fake install: the files the shortcut points at, and the icon source. */
function makeInstall(dir) {
  fs.mkdirSync(path.join(dir, 'public', 'brand', 'aeon-mark'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'launch.command'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(dir, 'LAUNCH.bat'), '@echo off\r\n');
  fs.writeFileSync(path.join(dir, 'AEON.ico'), 'ico');
  for (const px of [16, 32, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(dir, 'public', 'brand', 'aeon-mark', `aeon-icon-${px}.png`), `png-${px}`);
  }
  return dir;
}

/** Records calls; fakes iconutil by writing its -o target. */
function fakeRun(overrides = {}) {
  const calls = [];
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    if (overrides[cmd]) return overrides[cmd](args, opts);
    if (cmd === 'iconutil') {
      calls[calls.length - 1].iconset = fs.readdirSync(args[2]).sort();
      const out = args[args.indexOf('-o') + 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'icns-fake');
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const base = (extra = {}) => ({ root, platform: 'darwin', env: {}, desktopDir: desktop, run: fakeRun(), ...extra });
const APP = () => path.join(desktop, 'AEON.app');

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-shortcut-'));
  root = makeInstall(path.join(TMP, 'AEON install'));
  desktop = path.join(TMP, 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
});
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('macOS: AEON.app on the Desktop', () => {
  it('creates a bundle that opens launch.command in Terminal, with the AEON icon', () => {
    const run = fakeRun();
    const r = shortcut.ensureDesktopShortcut(base({ run }));
    expect(r.status).toBe('created');
    expect(r.path).toBe(APP());

    const plist = fs.readFileSync(path.join(APP(), 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain(`<string>${shortcut.BUNDLE_ID}</string>`);
    expect(plist).toMatch(/<key>CFBundleIconFile<\/key>\s*<string>AEON<\/string>/);
    expect(plist).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>AEON<\/string>/);

    const exe = path.join(APP(), 'Contents', 'MacOS', 'AEON');
    // POSIX file modes do not exist on Windows (CI windows-latest read 0); the
    // bundle only ever runs on macOS, where the executable bit is what matters.
    if (process.platform !== 'win32') expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(exe, 'utf8')).toMatch(/open -a Terminal/);

    // Assembled from the committed per-size brand PNGs — the compact cut at
    // 16/32, the full mark above — never resampled from one master.
    const icon = run.calls.find(c => c.cmd === 'iconutil');
    expect(icon.args.slice(0, 2)).toEqual(['-c', 'icns']);
    expect(icon.iconset).toHaveLength(10);
    expect(icon.iconset).toEqual(expect.arrayContaining(['icon_16x16.png', 'icon_32x32.png', 'icon_512x512@2x.png']));
    expect(run.calls.some(c => c.cmd === 'sips')).toBe(false);
    expect(fs.existsSync(path.join(APP(), 'Contents', 'Resources', 'AEON.icns'))).toBe(true);

    // Recorded inside the install, so the next launch knows it made this.
    const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'desktop-shortcut.json'), 'utf8'));
    expect(state.path).toBe(APP());
    expect(state.root).toBe(root);
  });

  it('a second launch leaves a correct icon alone', () => {
    shortcut.ensureDesktopShortcut(base());
    const exe = path.join(APP(), 'Contents', 'MacOS', 'AEON');
    const before = fs.statSync(exe).mtimeMs;
    const r = shortcut.ensureDesktopShortcut(base());
    expect(r.status).toBe('present');
    expect(fs.statSync(exe).mtimeMs).toBe(before);
  });

  it('a moved install updates its own icon to the new location', () => {
    shortcut.ensureDesktopShortcut(base());
    const moved = makeInstall(path.join(TMP, 'AEON moved'));
    // The state file travels with the install's data/ folder.
    fs.mkdirSync(path.join(moved, 'data'), { recursive: true });
    fs.copyFileSync(path.join(root, 'data', 'desktop-shortcut.json'), path.join(moved, 'data', 'desktop-shortcut.json'));
    const r = shortcut.ensureDesktopShortcut(base({ root: moved }));
    expect(r.status).toBe('updated');
    expect(fs.readFileSync(path.join(APP(), 'Contents', 'MacOS', 'AEON'), 'utf8')).toContain('AEON moved');
  });

  it('never touches an AEON.app it did not make', () => {
    fs.mkdirSync(path.join(APP(), 'Contents'), { recursive: true });
    const foreign = '<plist><dict><key>CFBundleIdentifier</key><string>com.someone.else</string></dict></plist>';
    fs.writeFileSync(path.join(APP(), 'Contents', 'Info.plist'), foreign);
    const r = shortcut.ensureDesktopShortcut(base());
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('foreign');
    expect(fs.readFileSync(path.join(APP(), 'Contents', 'Info.plist'), 'utf8')).toBe(foreign);
  });

  it('an icon the operator deleted stays deleted, until they ask for it back', () => {
    shortcut.ensureDesktopShortcut(base());
    fs.rmSync(APP(), { recursive: true, force: true });
    const again = shortcut.ensureDesktopShortcut(base());
    expect(again.status).toBe('skipped');
    expect(again.reason).toBe('removed-by-user');
    expect(fs.existsSync(APP())).toBe(false);
    const forced = shortcut.ensureDesktopShortcut(base({ force: true }));
    expect(forced.status).toBe('created');
    expect(fs.existsSync(APP())).toBe(true);
  });

  it('a failed icon build still leaves a working launcher, and says so', () => {
    const run = fakeRun({ iconutil: () => ({ status: 1, stdout: '', stderr: 'iconutil: bad iconset' }) });
    const r = shortcut.ensureDesktopShortcut(base({ run }));
    expect(r.status).toBe('created');
    expect(r.warning).toMatch(/icon/i);
    expect(fs.existsSync(path.join(APP(), 'Contents', 'MacOS', 'AEON'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('the bundle passes the install path as data — spaces and quotes survive', () => {
    const odd = makeInstall(path.join(TMP, `it's AEON $HOME "x"`));
    shortcut.ensureDesktopShortcut(base({ root: odd }));
    const exe = path.join(APP(), 'Contents', 'MacOS', 'AEON');
    // Shim `open` so running the real bundle script records exactly what it asked for.
    const bin = path.join(TMP, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(TMP, 'open.log');
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/bash\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
    execFileSync('/bin/bash', ['-n', exe]);
    execFileSync(exe, [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['-a', 'Terminal', path.join(odd, 'launch.command')]);
  });

  it.runIf(process.platform === 'darwin')('real iconutil produces a valid .icns from the committed brand PNGs', () => {
    const real = makeInstall(path.join(TMP, 'real'));
    for (const px of [16, 32, 64, 128, 256, 512, 1024]) {
      fs.copyFileSync(path.join(ROOT, 'public', 'brand', 'aeon-mark', `aeon-icon-${px}.png`),
        path.join(real, 'public', 'brand', 'aeon-mark', `aeon-icon-${px}.png`));
    }
    const r = shortcut.ensureDesktopShortcut({ root: real, platform: 'darwin', env: {}, desktopDir: desktop });
    expect(r.status).toBe('created');
    expect(r.warning).toBeUndefined();
    const icns = fs.readFileSync(path.join(APP(), 'Contents', 'Resources', 'AEON.icns'));
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(icns.length).toBeGreaterThan(10_000);
  }, 60000);
});

describe('Windows: AEON.lnk on the Desktop', () => {
  it('builds the shortcut through PowerShell with paths passed as environment, not code', () => {
    const run = fakeRun({ powershell: () => ({ status: 0, stdout: 'created\n', stderr: '' }) });
    const r = shortcut.ensureDesktopShortcut(base({ platform: 'win32', run }));
    expect(r.status).toBe('created');
    expect(r.path).toBe(path.join(desktop, 'AEON.lnk'));
    const call = run.calls.find(c => c.cmd === 'powershell');
    expect(call.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command', '-']));
    // The script text carries no install path: nothing a folder name contains can run.
    expect(call.opts.input).not.toContain(root);
    expect(call.opts.input).toMatch(/WScript\.Shell/);
    expect(call.opts.env.AEON_SC_TARGET).toBe(path.join(root, 'LAUNCH.bat'));
    expect(call.opts.env.AEON_SC_ICON).toBe(path.join(root, 'AEON.ico'));
    expect(call.opts.env.AEON_SC_WORKDIR).toBe(root);
    expect(call.opts.env.AEON_SC_LINK).toBe(path.join(desktop, 'AEON.lnk'));
  });

  it('a PowerShell failure is reported, never swallowed', () => {
    const run = fakeRun({ powershell: () => ({ status: 1, stdout: '', stderr: 'COM blocked by policy' }) });
    const r = shortcut.ensureDesktopShortcut(base({ platform: 'win32', run }));
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/COM blocked by policy/);
  });

  it.runIf(process.platform === 'win32')('real PowerShell writes a .lnk that points at LAUNCH.bat with AEON.ico', () => {
    const r = shortcut.ensureDesktopShortcut({ root, platform: 'win32', env: process.env, desktopDir: desktop });
    expect(r.status).toBe('created');
    const link = path.join(desktop, 'AEON.lnk');
    expect(fs.existsSync(link)).toBe(true);
    const read = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L); "$($s.TargetPath)|$($s.IconLocation)|$($s.WorkingDirectory)"'],
      { env: { ...process.env, L: link }, encoding: 'utf8' });
    const [target, icon, wd] = read.stdout.trim().split('|');
    // os.tmpdir() on the runner is an 8.3 short path (C:\\Users\\RUNNER~1\\...); the
    // saved shortcut holds the long form. Same folder, different spelling —
    // compare resolved long paths, not strings (CI run 34849001725).
    const long = (p) => fs.realpathSync.native(p).toLowerCase();
    expect(long(target)).toBe(long(path.join(root, 'LAUNCH.bat')));
    expect(long(icon.replace(/,\d+$/, ''))).toBe(long(path.join(root, 'AEON.ico')));
    expect(long(wd)).toBe(long(root));
  }, 60000);
});

describe('when there is no icon, on purpose', () => {
  it('portable/USB mode writes nothing to the host', () => {
    const r = shortcut.ensureDesktopShortcut(base({ env: { AEON_PORTABLE: 'true' } }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'portable' });
    expect(fs.readdirSync(desktop)).toEqual([]);
  });

  it('the operator can opt out', () => {
    const r = shortcut.ensureDesktopShortcut(base({ env: { AEON_NO_DESKTOP_ICON: '1' } }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'opted-out' });
    expect(fs.readdirSync(desktop)).toEqual([]);
  });

  it('platforms without a shortcut format say so', () => {
    const r = shortcut.ensureDesktopShortcut(base({ platform: 'linux' }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'unsupported-platform' });
  });

  it('no Desktop found is a skip, not a crash', () => {
    const run = fakeRun({ osascript: () => ({ status: 1, stdout: '', stderr: 'no desktop' }) });
    const r = shortcut.ensureDesktopShortcut(base({ desktopDir: undefined, run }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-desktop' });
  });
});

describe('the Desktop is asked of the OS', () => {
  it('macOS asks Finder for the desktop folder', () => {
    const run = fakeRun({ osascript: () => ({ status: 0, stdout: '/Users/x/Desktop/\n', stderr: '' }) });
    expect(shortcut.resolveDesktopDir({ platform: 'darwin', run })).toBe('/Users/x/Desktop');
    expect(run.calls[0].args.join(' ')).toMatch(/path to desktop folder/);
  });

  it('Windows asks .NET, which follows a OneDrive-redirected Desktop', () => {
    const run = fakeRun({ powershell: () => ({ status: 0, stdout: 'C:\\Users\\x\\OneDrive\\Desktop\r\n', stderr: '' }) });
    expect(shortcut.resolveDesktopDir({ platform: 'win32', run })).toBe('C:\\Users\\x\\OneDrive\\Desktop');
    expect(run.calls[0].args.join(' ')).toMatch(/GetFolderPath\('Desktop'\)/);
  });

  it('the module never builds the Desktop from a home directory (scan:paths)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'desktop-shortcut.cjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/os\.homedir\s*\(|process\.env\.(HOME|USERPROFILE|HOMEPATH)\b/);
  });
});

describe('wired into the launch, and the index it triggers', () => {
  const launch = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');

  it('launch.js ensures the icon, and a shortcut problem can never stop AEON booting', () => {
    expect(launch).toMatch(/require\([^)]*desktop-shortcut\.cjs['"]\)/);
    expect(launch).toMatch(/ensureDesktopShortcut\(/);
    expect(launch).toMatch(/--desktop-icon/);
    const at = launch.indexOf('ensureDesktopShortcut(');
    expect(launch.slice(Math.max(0, at - 400), at)).toMatch(/try\s*\{/);
  });

  it('every boot indexes, and the boot log says what it embedded', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    expect(server).toMatch(/runSecondBrainScan\(\)/);
    expect(server).toMatch(/Boot sync complete:[^\n]*embedded/);
  });

  it('the hardcoded "AEON Command Center.lnk" is retired', () => {
    const tracked = execFileSync('git', ['ls-files', 'AEON Command Center.lnk'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
  });
});
