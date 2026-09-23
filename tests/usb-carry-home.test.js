/**
 * build-usb --carry-home: the operator's own AEON and home, on an exFAT drive,
 * startable on macOS (Intel + Apple Silicon), Windows and Linux.
 *
 * These drive the builder's pieces against real files. The full build (a
 * gigabyte of node_modules and three Node downloads) is exercised live, not
 * here. Also pinned: two bugs in the stock bundle found alongside —
 *   - its Mac runtime was arm64-only, so a bundle could never start on an
 *     Intel Mac (Rosetta translates Intel → ARM, never the reverse);
 *   - with no starter library in the install it created no Vault folder, so
 *     its own verifier failed the bundle it had just built.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const carry = require('../scripts/build-usb-carry.cjs');
const buildUsb = require('../scripts/build-usb.js');
const aeonHome = require('../src/kernel/aeonHome.cjs');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-carry-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

describe('launchers', () => {
  beforeEach(() => carry.writeCarriedLaunchers(tmp));
  const read = (f) => fs.readFileSync(path.join(tmp, f), 'latin1');

  it('mac and linux are LF bash scripts; windows is CRLF', () => {
    for (const f of ['launch.command', 'launch.sh']) {
      expect(read(f).startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(read(f)).not.toContain('\r');
    }
    const bat = read('LAUNCH.bat');
    expect(bat.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  it('each finds its data beside itself, picks a free port, and never forces local-only', () => {
    for (const f of ['launch.command', 'launch.sh']) {
      const s = read(f);
      expect(s).toContain('export AEON_HOME="$ROOT/AEON-Data"');
      expect(s).toContain('tools/free-port.cjs" 3001 3020');
      expect(s).toContain('runtime/npm/bin/npm-cli.js');
      expect(s).toContain('npm_config_cache="$ROOT/.npm-cache"');
      expect(s).not.toMatch(/AEON_PORTABLE|AEON_LOCAL_ONLY|taskkill|kill -9/);
    }
    const bat = read('LAUNCH.bat');
    expect(bat).toContain('set "AEON_HOME=%ROOT%\\AEON-Data"');
    expect(bat).toContain('tools\\free-port.cjs" 3001 3020');
    expect(bat).toContain('runtime\\npm\\bin\\npm-cli.js');
    expect(bat).not.toMatch(/AEON_PORTABLE|AEON_LOCAL_ONLY|taskkill/);
  });

  it('the mac launcher covers Intel and Apple Silicon', () => {
    const s = read('launch.command');
    expect(s).toContain('uname -m');
    expect(s).toContain('runtime/node/mac/node');
    expect(s).toContain('runtime/node/mac/$ARCH/node');
  });
});

describe('copying for exFAT', () => {
  it('materializes links, cuts cycles, skips OS junk, keeps mtime', () => {
    const src = path.join(tmp, 'src');
    write(path.join(src, 'real.txt'), 'hello');
    write(path.join(src, 'lib', 'libthing.0.0.1.dylib'), 'binary');
    fs.symlinkSync('libthing.0.0.1.dylib', path.join(src, 'lib', 'libthing.0.dylib'));
    fs.symlinkSync('lib', path.join(src, 'lib-alias'));
    fs.symlinkSync('nowhere.txt', path.join(src, 'broken.txt'));
    fs.symlinkSync('..', path.join(src, 'lib', 'up'));        // a cycle back to src
    write(path.join(src, '._real.txt'), 'junk');
    write(path.join(src, '.DS_Store'), 'junk');
    const when = new Date(1789950852778);
    fs.utimesSync(path.join(src, 'real.txt'), when, when);

    const dst = path.join(tmp, 'dst');
    const s = carry.copyTreeMaterialized(src, dst);

    const lst = (p) => fs.lstatSync(path.join(dst, p));
    expect(lst('lib/libthing.0.dylib').isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'lib/libthing.0.dylib'), 'utf8')).toBe('binary');
    expect(lst('lib-alias').isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dst, 'broken.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dst, '._real.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dst, '.DS_Store'))).toBe(false);
    expect(s.broken).toBe(1);
    expect(s.cycles).toBeGreaterThanOrEqual(1);
    expect(Math.abs(fs.statSync(path.join(dst, 'real.txt')).mtimeMs - 1789950852778)).toBeLessThan(1);

    const links = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) links.push(p); else if (e.isDirectory()) walk(p); } })(dst);
    expect(links).toEqual([]);
  });

  it('sweeps OS junk left behind by other tools', () => {
    write(path.join(tmp, 'a', '._x.cjs'));
    write(path.join(tmp, 'a', 'b', '.DS_Store'));
    write(path.join(tmp, 'a', 'b', 'keep.md'));
    expect(carry.sweepOsJunk(path.join(tmp, 'a'))).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'a', 'b', 'keep.md'))).toBe(true);
  });
});

describe('the carried home', () => {
  it('copies every root, leaves host-only records behind, and AEON finds it', () => {
    const h = path.join(tmp, 'host-home');
    write(path.join(h, 'Vault', 'notes', 'a.md'), '# a');
    write(path.join(h, 'data', 'vault_index.json'), '{}');
    write(path.join(h, 'data', 'desktop-shortcut.json'), '{"path":"/Users/x/Desktop/AEON.app"}');
    write(path.join(h, 'db', 'chat_log.json'), '[]');
    write(path.join(h, 'secrets', 'aeon-keyslots.json'), '{}');
    write(path.join(h, '.env'), 'AEON_VAULT_MASTER_KEY=test\n');
    write(path.join(h, 'aeon-settings.json'), '{}');
    write(path.join(h, 'home.json'), '{"schema":1}');
    write(path.join(h, 'Vault', 'notes', '._a.md'), 'junk');

    const drive = path.join(tmp, 'drive');
    const data = path.join(drive, 'AEON-Data');
    fs.mkdirSync(path.join(drive, 'AEON'), { recursive: true });
    const src = aeonHome.roots({ appRoot: path.join(tmp, 'install'), env: { AEON_HOME: h } });
    carry.copyHome(src, carry.driveRoots(path.join(drive, 'AEON'), data));
    carry.writeCarriedMarker(data);

    for (const p of ['Vault/notes/a.md', 'data/vault_index.json', 'db/chat_log.json', 'secrets/aeon-keyslots.json', '.env', 'aeon-settings.json']) {
      expect(fs.existsSync(path.join(data, p)), p).toBe(true);
    }
    expect(fs.existsSync(path.join(data, 'data', 'desktop-shortcut.json'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'Vault', 'notes', '._a.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'home.json'), 'utf8')).layout).toBe('carried');
    expect(aeonHome.resolveHome({ appRoot: path.join(drive, 'AEON'), env: {}, homedir: () => tmp })).toBe(data);
    expect(carry.unparseableJson(data)).toEqual([]);
  });

  it('never overwrites data already on the drive unless asked, and keeps installed blocks', () => {
    const drive = path.join(tmp, 'drive');
    write(path.join(drive, 'AEON-Data', 'Vault', 'newer.md'));
    write(path.join(drive, 'AEON', 'src', 'blocks', 'bought_pack', 'block.manifest.json'), '{}');
    const keep = carry.planCarry(drive);
    expect(keep.dataAction).toBe('keep');
    expect(keep.extraBlocks).toEqual(['bought_pack']);
    expect(carry.planCarry(drive, { replaceData: true }).dataAction).toBe('replace');
    expect(carry.planCarry(path.join(tmp, 'empty-drive')).dataAction).toBe('create');
  });

  it('an unparseable JSON copy is reported', () => {
    write(path.join(tmp, 'd', 'data', 'torn.json'), '{"half":');
    expect(carry.unparseableJson(path.join(tmp, 'd'))).toEqual([path.join('data', 'torn.json')]);
  });
});

describe('runtime helpers', () => {
  it('recognises a universal Mach-O and nothing else', () => {
    const fat = path.join(tmp, 'fat'); fs.writeFileSync(fat, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
    const thin = path.join(tmp, 'thin'); fs.writeFileSync(thin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]));
    const elf = path.join(tmp, 'elf'); fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(carry.isUniversalMachO(fat)).toBe(true);
    expect(carry.isUniversalMachO(thin)).toBe(false);
    expect(carry.isUniversalMachO(elf)).toBe(false);
  });

  it('parses nodejs.org SHASUMS256.txt', () => {
    const sha = 'a'.repeat(64);
    const m = carry.parseShasums(`${sha}  node-v24.20.0-win-x64.zip\nnot a line\n`);
    expect(m.get('node-v24.20.0-win-x64.zip')).toBe(sha);
    expect(m.size).toBe(1);
  });
});

describe('stock bundle fixes', () => {
  it('stages Node for both Mac architectures', () => {
    const files = buildUsb.NODE_ASSET.mac.files || [buildUsb.NODE_ASSET.mac.file];
    expect(files.some((f) => /darwin-x64/.test(f))).toBe(true);
    expect(files.some((f) => /darwin-arm64/.test(f))).toBe(true);
  });

  it('the stock mac launcher picks the archive for this Mac\'s CPU', () => {
    buildUsb.writeLaunchers(tmp, 'v24.20.0');
    const cmd = fs.readFileSync(path.join(tmp, 'launch.command'), 'utf8');
    expect(cmd).toContain('uname -m');
    expect(cmd).toMatch(/darwin-\$ARCH/);
  });

  it('creates a Vault folder even when the install has no starter library', () => {
    const aeonDir = path.join(tmp, 'bundle', 'AEON');
    const r = buildUsb.seedVault(path.join(tmp, 'no-such-install'), aeonDir);
    expect(r.seeded).toBe(false);
    expect(fs.existsSync(path.join(aeonDir, 'Vault'))).toBe(true);
  });
});

describe('verify-usb --carry-home', () => {
  const { execFileSync } = require('child_process');
  const VERIFY = path.join(process.cwd(), 'scripts', 'verify-usb.js');

  /** A small drive that is complete in every way the auditor checks. */
  function fixtureDrive() {
    const d = path.join(tmp, 'drive');
    const A = path.join(d, 'AEON');
    write(path.join(A, 'server.cjs'), '// server\n');
    write(path.join(A, 'package.json'), '{"name":"aeon"}');
    write(path.join(A, 'dist', 'index.html'), '<!doctype html>');
    write(path.join(A, 'node_modules', 'express', 'package.json'), '{"name":"express"}');
    write(path.join(A, 'tools', 'free-port.cjs'), '// probe\n');
    write(path.join(A, 'src', 'kernel', 'aeonHome.cjs'), fs.readFileSync(path.join(process.cwd(), 'src', 'kernel', 'aeonHome.cjs')));
    const D = path.join(d, 'AEON-Data');
    write(path.join(D, 'Vault', 'note.md'), '# note');
    write(path.join(D, 'data', 'vault_index.json'), '{}');
    write(path.join(D, 'secrets', 'aeon-keyslots.json'), '{}');
    write(path.join(D, '.env'), `GROQ_API_KEY=gsk_${'A'.repeat(40)}\n`); // a key is EXPECTED here
    write(path.join(D, 'aeon-settings.json'), '{}');
    carry.writeCarriedMarker(D);
    carry.writeCarriedLaunchers(d);
    write(path.join(d, 'README_DRIVE.txt'), 'readme');
    write(path.join(d, 'runtime', 'node', 'mac', 'node'), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
    write(path.join(d, 'runtime', 'node', 'win', 'node.exe'), 'MZ');
    write(path.join(d, 'runtime', 'node', 'linux', 'node'), '\x7fELF');
    write(path.join(d, 'runtime', 'npm', 'bin', 'npm-cli.js'), '// npm');
    return d;
  }
  const verify = (d) => {
    try { return { code: 0, out: execFileSync(process.execPath, [VERIFY, '--target', d, '--carry-home'], { encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('passes a complete drive — a key inside AEON-Data is expected, not a leak', () => {
    const r = verify(fixtureDrive());
    expect(strip(r.out)).toContain('BUNDLE VERIFIED');
    expect(r.code).toBe(0);
  });

  it('fails a key that leaked into the app folder', () => {
    const d = fixtureDrive();
    write(path.join(d, 'AEON', 'server.cjs'), `const k = "gsk_${'B'.repeat(40)}";\n`);
    const r = verify(d);
    expect(r.code).toBe(1);
    expect(strip(r.out)).toMatch(/credential-shaped string outside AEON-Data/);
  });

  it('fails OS junk and symlinks, which Windows and Linux cannot use', () => {
    const d = fixtureDrive();
    write(path.join(d, 'AEON-Data', 'Vault', '._note.md'), 'junk');
    fs.symlinkSync('note.md', path.join(d, 'AEON-Data', 'Vault', 'alias.md'));
    const out = strip(verify(d).out);
    expect(out).toMatch(/1 OS junk file/);
    expect(out).toMatch(/1 symlink/);
  });

  it('fails a launcher that forces local-only, and a missing marker', () => {
    const d = fixtureDrive();
    fs.appendFileSync(path.join(d, 'launch.sh'), 'export AEON_PORTABLE=true\n');
    fs.rmSync(path.join(d, 'AEON-Data', 'home.json'));
    const out = strip(verify(d).out);
    expect(out).toMatch(/launch\.sh forces local-only/);
    expect(out).toMatch(/resolves its home elsewhere|does not mark a carried home/);
  });
});

describe('the real CLI entry path', () => {
  // Unit tests load build-usb.js as a module, where its exports are complete.
  // The CLI runs main() from inside that file BEFORE `module.exports = …`
  // executed, so the carry builder's require('./build-usb.js') got an empty
  // object and crashed on EXCLUDE ("Cannot read properties of undefined") —
  // found running the real build against the drive, 2026-09-22.
  it('`build-usb.js --carry-home --dry-run` plans without crashing and writes nothing', () => {
    const { execFileSync } = require('child_process');
    const target = path.join(tmp, 'drive');
    fs.mkdirSync(target);
    const out = execFileSync(process.execPath,
      [path.join(process.cwd(), 'scripts', 'build-usb.js'), '--target', target, '--carry-home', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, AEON_HOME: path.join(tmp, 'no-home') } });
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/DRY RUN/);
    expect(out).toMatch(/tracked files/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
