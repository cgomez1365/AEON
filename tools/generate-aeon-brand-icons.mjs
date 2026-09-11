/**
 * Generate every AEON icon from the vector mark.
 *
 * WHAT CHANGED, AND WHY (CEO, 2026-09-10: "the main icon is just a random image")
 *
 * This script used to read public/brand/aeon-primary-logo.png - the 1256x1256
 * marketing poster - and drawImage() it into each icon square. So every icon
 * was the entire poster squeezed down: grid background, ~40% dead margin, and
 * the "AEON / MODULAR. LOCAL. YOURS. / INITIALIZE CONNECTION" text block. It
 * also wrote an aeon-mark.svg that was nothing but <image href="...poster.png">,
 * so even the "vector" favicon was that raster. At the sizes actually used -
 * 16px and 22px in the sidebar, 32px favicon, 48px boot gate - the result is a
 * blue smudge.
 *
 * The direction is now inverted. The SVG mark is the source and every raster is
 * derived from it, which is the only arrangement where the favicon and the
 * 1024px icon cannot drift apart.
 *
 * Two cuts of one mark:
 *   aeon-mark.svg          the full mark - A, inner ring, segmented outer ring
 *                          with three node circles. Used from 32px up.
 *   aeon-mark-compact.svg  the same A and ring with the outer ring dropped and
 *                          the glow removed. Used at 16px and 24px, where the
 *                          outer ring's band is under a pixel wide and can only
 *                          average into grey haze at the glyph's expense.
 *
 * The poster is left exactly where it is. It is a good poster; it was never an
 * icon, and nothing here reads it any more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const MARK_DIR = path.join(BRAND, 'aeon-mark');
const FULL_SVG = path.join(MARK_DIR, 'aeon-mark.svg');
const COMPACT_SVG = path.join(MARK_DIR, 'aeon-mark-compact.svg');

const SIZES = [16, 32, 48, 64, 128, 192, 256, 512, 1024];
/** At or below this, the full mark's outer ring is sub-pixel: use the small cut. */
const COMPACT_AT_OR_BELOW = 24;

function createIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries = Buffer.alloc(frames.length * 16);
  let offset = header.length + entries.length;
  frames.forEach(({ size, png }, index) => {
    const entry = index * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, entry);
    entries.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    entries.writeUInt8(0, entry + 2);
    entries.writeUInt8(0, entry + 3);
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(png.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...frames.map(({ png }) => png)]);
}

// A missing or malformed source must stop the run. Writing icons from a
// half-read SVG would quietly ship a blank square to every surface at once.
for (const file of [FULL_SVG, COMPACT_SVG]) {
  if (!fs.existsSync(file)) {
    console.error(`[brand] missing source: ${path.relative(ROOT, file)}`);
    process.exit(1);
  }
}

const full = await loadImage(fs.readFileSync(FULL_SVG));
const compact = await loadImage(fs.readFileSync(COMPACT_SVG));

fs.mkdirSync(MARK_DIR, { recursive: true });
const frames = [];

for (const size of SIZES) {
  const source = size <= COMPACT_AT_OR_BELOW ? compact : full;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  // Smoothing on: the sources are vector, so this is a proper resample of
  // clean geometry rather than the poster's already-lossy pixels.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, size, size);
  const png = await canvas.encode('png');
  fs.writeFileSync(path.join(MARK_DIR, `aeon-icon-${size}.png`), png);
  frames.push({ size, png });
}

// The scalable favicon is now the mark itself, not a wrapper around a poster.
const markSvg = fs.readFileSync(FULL_SVG);
fs.writeFileSync(path.join(BRAND, 'aeon-icon.svg'), markSvg);

// Legacy duplicates at the brand root. Nothing in src/ references these any
// more - index.html, manifest.json and the layouts all point at aeon-mark/ -
// but they are public URLs, so they are kept in step rather than deleted.
for (const size of [32, 64, 192, 256, 512, 1024]) {
  const frame = frames.find((item) => item.size === size);
  fs.writeFileSync(path.join(BRAND, `aeon-icon-${size}.png`), frame.png);
}

const icon = createIco(frames.filter(({ size }) => [16, 32, 48, 256].includes(size)));
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'AEON.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'public', 'logo.png'), frames.find(({ size }) => size === 512).png);

console.log(
  `[brand] ${SIZES.length} icons from the vector mark `
  + `(<=${COMPACT_AT_OR_BELOW}px from the compact cut), plus favicon.ico, AEON.ico and logo.png`
);
