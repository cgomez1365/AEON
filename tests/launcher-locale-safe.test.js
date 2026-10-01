/**
 * A launcher variable must be fenced before any non-ASCII character.
 *
 * `echo "Configuring for $USB_ROOT…"` read as the variable `USB_ROOT…` under a
 * non-UTF-8 locale (bash 3.2 counts the ellipsis bytes as name characters), so
 * with `set -u` the portable launcher stopped with "unbound variable" before
 * AEON started. Found by CI's macOS runner, 2026-09-30. Every generated shell
 * launcher is scanned: `$NAME` followed directly by a byte above 0x7F fails.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-launcher-locale-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const UNFENCED = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

function shellTexts() {
  const out = {};
  const usb = path.join(tmp, 'usb');
  fs.mkdirSync(usb);
  require('../scripts/build-usb.js').writeLaunchers(usb, 'v22.14.0');
  for (const f of ['launch.sh', 'launch.command']) out[`build-usb ${f}`] = fs.readFileSync(path.join(usb, f), 'utf8');
  const carry = require('../scripts/build-usb-carry.cjs');
  out['carried mac'] = carry.macLauncher();
  out['carried linux'] = carry.linuxLauncher();
  for (const f of ['launch.command', 'launch.sh']) out[`repo ${f}`] = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  return out;
}


describe('shell launchers fence variables before non-ASCII text', () => {
  for (const [name, text] of Object.entries(shellTexts())) {
    it(name, () => {
      const bad = text.split('\n').filter((l) => UNFENCED.test(l));
      expect(bad, `${name}: use \${NAME} before non-ASCII text`).toEqual([]);
    });
  }
});
