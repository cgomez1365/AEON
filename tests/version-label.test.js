/**
 * The version on screen is the release's (package.json), never typed by hand.
 * Found 2026-10-02: the header, the sidebar and the sign-in card said "v5.0"
 * (and "Hive Mind Active") while the release was 3.1.1 — the first thing a
 * customer reads to support is a version, and it was wrong.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the version on screen', () => {
  it('vite.config.js defines __AEON_VERSION__ from package.json', () => {
    const cfg = read('vite.config.js');
    expect(cfg).toMatch(/readFileSync\(new URL\('\.\/package\.json', import\.meta\.url\)/);
    expect(cfg).toMatch(/__AEON_VERSION__: JSON\.stringify\(version\)/);
  });

  it('no screen types a version by hand', () => {
    const files = ['src/components/DesktopLayout.jsx', 'src/components/MobileLayout.jsx', 'src/components/GoogleSignIn.jsx'];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bv\d+\.\d+\b/);
      expect(src, f).toMatch(/versionLabel\(\)/);
    }
    expect(read('src/components/MobileLayout.jsx')).not.toMatch(/Hive Mind/);
  });

  it('versionLabel is blank where nothing defined the version', async () => {
    const { AEON_VERSION, versionLabel } = await import('../src/utils/version.js');
    expect(AEON_VERSION).toBe('');
    expect(versionLabel()).toBe('');
  });
});
