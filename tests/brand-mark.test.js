/**
 * The AEON mark is a vector, and every icon is derived from it.
 *
 * CEO, 2026-09-10: "the main icon for aeon is just a random image". It was the
 * marketing poster. tools/generate-aeon-brand-icons.mjs read
 * public/brand/aeon-primary-logo.png - 1256x1256, grid background, ~40% dead
 * margin, and a three-line text block reading "AEON / MODULAR. LOCAL. YOURS. /
 * INITIALIZE CONNECTION" - and drew that whole square into every icon size. The
 * "scalable" favicon was no better: aeon-mark.svg was 276 bytes of
 * <image href="...aeon-primary-logo.png">, a raster in vector clothing.
 *
 * At the sizes actually used - 16px and 22px in the sidebar, 32px favicon, 48px
 * boot gate - that is a blue smudge with unreadable text in it.
 *
 * What is locked here is the DIRECTION, because that is the part that quietly
 * reverts: the SVG is the source and the PNGs are derived. Nothing in the icon
 * pipeline may read the poster again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const MARK = path.join(BRAND, 'aeon-mark');

const read = (p) => fs.readFileSync(p, 'utf8');
const bytes = (p) => fs.statSync(p).size;
/** Strip XML comments — a rule described in prose is not a rule being broken.
 *  Both marks document the <image href="…poster.png"> wrapper they replaced. */
const markup = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

describe('the mark is real vector art', () => {
  const svgs = ['aeon-mark.svg', 'aeon-mark-compact.svg'].map(f => path.join(MARK, f));

  it('both cuts exist and are drawn, not wrapped', () => {
    for (const file of svgs) {
      expect(fs.existsSync(file), `${path.basename(file)} must exist`).toBe(true);
      const src = markup(read(file));
      // The exact regression: an <image> element, or any href to a raster.
      expect(src, `${path.basename(file)} must not embed a raster`).not.toMatch(/<image\b/i);
      expect(src).not.toMatch(/href\s*=\s*["'][^"']*\.(png|jpe?g|webp|gif)/i);
      // It must actually draw something.
      expect(src).toMatch(/<(path|circle|rect|polygon)\b/);
    }
  });

  it('the full mark carries the A, the inner ring and the segmented outer ring', () => {
    const src = markup(read(path.join(MARK, 'aeon-mark.svg')));
    expect(src).toMatch(/stroke-dasharray/);        // the segmented outer ring
    expect(src.match(/<circle\b/g).length).toBeGreaterThanOrEqual(5); // ring + 3 nodes + inner
    expect(src.match(/<path\b/g).length).toBeGreaterThanOrEqual(2);   // A body + crossbar
  });

  it('the compact cut drops the outer ring rather than redrawing the logo', () => {
    const full = markup(read(path.join(MARK, 'aeon-mark.svg')));
    const compact = markup(read(path.join(MARK, 'aeon-mark-compact.svg')));
    expect(compact).not.toMatch(/stroke-dasharray/);   // no segmented ring at 16px
    expect(compact.match(/<circle\b/g).length).toBe(1); // one ring only
    // Same subject in both: an A drawn as two paths.
    for (const src of [full, compact]) expect(src.match(/<path\b/g).length).toBe(2);
  });

  it('a vector mark is small — the old "svg" was a 1256px poster by reference', () => {
    for (const file of svgs) expect(bytes(file)).toBeLessThan(16 * 1024);
  });
});

describe('every icon is derived from the mark', () => {
  const gen = read(path.join(ROOT, 'tools', 'generate-aeon-brand-icons.mjs'));

  it('the generator reads the SVGs and never the poster', () => {
    expect(gen).toMatch(/aeon-mark\.svg/);
    expect(gen).toMatch(/aeon-mark-compact\.svg/);
    // The poster may be named in the explanation, but never loaded.
    const code = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the icon pipeline must not read the marketing poster').not.toMatch(/aeon-primary-logo/);
  });

  it('small sizes come from the compact cut', () => {
    expect(gen).toMatch(/COMPACT_AT_OR_BELOW/);
    expect(gen).toMatch(/size <= COMPACT_AT_OR_BELOW \? compact : full/);
  });

  it('it fails loudly on a missing source instead of shipping blank squares', () => {
    expect(gen).toMatch(/process\.exit\(1\)/);
  });

  it('every size referenced by the app exists on disk', () => {
    // The sizes index.html, manifest.json and the layouts ask for.
    for (const size of [16, 32, 48, 64, 128, 192, 256, 512, 1024]) {
      const f = path.join(MARK, `aeon-icon-${size}.png`);
      expect(fs.existsSync(f), `aeon-icon-${size}.png`).toBe(true);
      expect(bytes(f)).toBeGreaterThan(0);
    }
    for (const f of ['favicon.ico', 'logo.png']) {
      expect(fs.existsSync(path.join(ROOT, 'public', f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(ROOT, 'AEON.ico'))).toBe(true);
  });

  it('the scalable favicon is the mark itself, byte for byte', () => {
    // aeon-icon.svg used to be a second copy of the poster wrapper. It is now
    // generated from the mark, so the two cannot describe different logos.
    expect(read(path.join(BRAND, 'aeon-icon.svg'))).toBe(read(path.join(MARK, 'aeon-mark.svg')));
  });
});

describe('nothing in the app points at the poster', () => {
  const surfaces = [
    'index.html',
    'vite.config.js',
    'public/manifest.json',
    'src/components/DesktopLayout.jsx',
    'src/components/MobileLayout.jsx',
    'src/blocks/security/AeonBootGate.jsx',
    'src/blocks/security/components/RecoveryModal.jsx',
  ];

  it('every icon reference resolves to a generated asset, not the poster', () => {
    for (const rel of surfaces) {
      const src = read(path.join(ROOT, rel));
      expect(src, `${rel} must not use the poster as an icon`).not.toMatch(/aeon-primary-logo/);
    }
  });

  it('the referenced files actually exist', () => {
    const missing = [];
    for (const rel of surfaces) {
      const src = read(path.join(ROOT, rel));
      for (const m of src.matchAll(/["'`](\/(?:brand|logo|favicon)[^"'`\s)]*)["'`]/g)) {
        const file = path.join(ROOT, 'public', m[1]);
        if (!fs.existsSync(file)) missing.push(`${rel} -> ${m[1]}`);
      }
    }
    expect(missing, `broken icon references:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
