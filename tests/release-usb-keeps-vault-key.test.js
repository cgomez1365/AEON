/**
 * A portable USB drive keeps its vault key from one boot to the next.
 *
 * The portable launchers (scripts/build-usb.js, the non-carried layout) rebuild
 * AEON/.env from the .env.usb template at every boot, substituting the drive's
 * mount point. In portable mode the server writes the vault master key into
 * that same AEON/.env on first boot (src/kernel/aeonHome.cjs keeps <appRoot>/.env
 * when AEON_PORTABLE=true), and `node launch.js --recover-vault` writes a new
 * one there. Rebuilding the file from the template alone dropped the key, so
 * from the second boot the server found keyslots with no key and printed
 * SEALED, and a recovery was undone the same way. The launchers now carry the
 * AEON_VAULT_MASTER_KEY line across the rebuild.
 *
 * Runs the env step of the generated launch.sh with bash in a temp drive; the
 * .bat cannot run here, so its order of operations is checked as text.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const buildUsb = require('../scripts/build-usb.js');

// Windows runs LAUNCH.bat, never launch.sh; Git-for-Windows bash would also
// read a backslash path through sed (\U, \A…), which is not the product's case.
const posix = process.platform !== 'win32';
const hasBash = (() => {
  try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-usb-key-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const launchers = path.join(tmp, 'launchers');
fs.mkdirSync(launchers);
buildUsb.writeLaunchers(launchers, 'v22.14.0');

// The env step of a generated shell launcher: from "Configuring for" up to the
// line that tightens the file's mode.
function envStep(file) {
  const lines = fs.readFileSync(path.join(launchers, file), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('Configuring for'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('chmod 600 "$AEON_ENV"'));
  expect(start, `${file} has an env step`).toBeGreaterThan(-1);
  expect(end, `${file} ends its env step by tightening .env`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
}

const KEY_LINE = `AEON_VAULT_MASTER_KEY=${'ab'.repeat(32)}`;

describe.each(['launch.sh', 'launch.command'])('%s env step', (file) => {
  it.skipIf(!hasBash || !posix)('keeps the master key the server wrote, boot after boot', () => {
    const drive = path.join(tmp, `drive-${file}`);
    fs.mkdirSync(path.join(drive, 'AEON'), { recursive: true });
    buildUsb.writeEnvUsb(path.join(drive, 'AEON'), {});
    const script = `set -uo pipefail\nUSB_ROOT=${JSON.stringify(drive)}\n${envStep(file)}\n`;
    // A failure carries bash's own words, not a byte count.
    const boot = () => {
      try { execFileSync('bash', ['-c', script], { stdio: 'pipe' }); }
      catch (e) { throw new Error(`env step exited ${e.status}: ${String(e.stderr || '').trim()}`); }
    };
    const env = () => fs.readFileSync(path.join(drive, 'AEON', '.env'), 'utf8');

    // First boot: no .env yet, so no key to keep.
    boot();
    expect(env()).toContain(`VAULT_PATH=${drive}/AEON/Vault`);
    expect(env()).not.toMatch(/__USB_ROOT__/);
    expect(env()).not.toMatch(/AEON_VAULT_MASTER_KEY=/);

    // The server mints the key into AEON/.env (vault.cjs appends this line).
    fs.appendFileSync(path.join(drive, 'AEON', '.env'), `${KEY_LINE}\n`);

    // Second and third boots rebuild .env and must keep that key, once.
    for (let i = 0; i < 2; i++) {
      boot();
      const text = env();
      expect(text.match(/^AEON_VAULT_MASTER_KEY=.*$/gm)).toEqual([KEY_LINE]);
      expect(text).toContain(`DATA_PATH=${drive}/AEON/data`);
      expect(text).not.toMatch(/__USB_ROOT__/);
    }
    expect(fs.existsSync(path.join(drive, 'AEON', '.env.tmp'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(drive, 'AEON', '.env')).mode & 0o777).toBe(0o600);
    }
  });
});

describe('LAUNCH.bat env step', () => {
  it('reads the key before the template overwrites .env, and appends it after', () => {
    const bat = fs.readFileSync(path.join(launchers, 'LAUNCH.bat'), 'utf8');
    const read = bat.indexOf('findstr /b /c:"AEON_VAULT_MASTER_KEY="');
    const rebuild = bat.indexOf("Set-Content -NoNewline '%AEON_ENV%'");
    const append = bat.indexOf('if defined KEEP_KEY >>"%AEON_ENV%" echo(!KEEP_KEY!');
    expect(read).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(read);
    expect(append).toBeGreaterThan(rebuild);
    // The !KEEP_KEY! form needs delayed expansion, which the launcher enables.
    expect(bat).toMatch(/setlocal enabledelayedexpansion/);
  });
});
