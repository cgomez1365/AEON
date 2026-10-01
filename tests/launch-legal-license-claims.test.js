/**
 * Every shipped statement of AEON's licence names the AEON Community License
 * (A114).
 *
 * scripts/build-usb.js wrote "AEON · Broken Gear Industries · Apache-2.0" into
 * every portable drive's README_USB.txt, contradicting LICENSE. The app goes to
 * <drive>/AEON and LICENSE is not excluded from the copy, so the drive's README
 * points there. package.json once said "Apache-2.0" too (fixed in 8d51c6a; that
 * history cannot change). Third-party licences are deliberately not scanned:
 * services/local-runtime/*.json (model and runtime licences), package-lock.json,
 * tests/, and the vendored SPDX MIT headers under src/blocks/aeon_matrix/public/vendor/.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('the portable drive README', () => {
  it('build-usb.js names the AEON Community License, not Apache or MIT', () => {
    const src = read('scripts/build-usb.js');
    expect(src).not.toMatch(/Apache-2\.0|\bMIT\b/);
    expect(src).toMatch(/AEON Community License/);
  });

  it('the README_USB.txt it writes says so and points at the LICENSE that travels with the app', () => {
    const buildUsb = require('../scripts/build-usb.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-usb-readme-'));
    try {
      buildUsb.writeReadme(dir, {}, 'v22.14.0');
      const txt = fs.readFileSync(path.join(dir, 'README_USB.txt'), 'utf8');
      expect(txt).toMatch(/AEON Community License — see AEON\/LICENSE/);
      expect(txt).not.toMatch(/Apache|\bMIT\b/);
      // LICENSE is copied with the app, so the pointer is true.
      expect(buildUsb.shouldExclude('LICENSE')).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the shipped legal and project files', () => {
  it.each(['README.md', 'LICENSE', 'TERMS_OF_USE.md', 'PRIVACY.md', 'package.json'])('%s claims no other licence', (f) => {
    expect(read(f)).not.toMatch(/Apache-2\.0|\bMIT License\b|"license":\s*"(MIT|Apache-2\.0)"/);
  });
});
