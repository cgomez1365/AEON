import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ROOT = path.resolve(import.meta.dirname, '..');
// Source artwork lives inside the repo by default. It previously defaulted to
// <home>/Desktop/AEON-Icons — one operator's machine layout, which meant this
// script could only ever run on that machine. AEON_ICON_SOURCE still overrides.
const SOURCE_DIR = process.env.AEON_ICON_SOURCE
  ? path.resolve(process.env.AEON_ICON_SOURCE)
  : path.join(ROOT, 'assets', 'block-icons-src');
const OUTPUT_DIR = path.join(ROOT, 'public', 'brand', 'block-icons');
const PNG_DIR = path.join(OUTPUT_DIR, 'png');
const SECTION_DIR = path.join(OUTPUT_DIR, 'sections');

export const BLOCK_ICONS = [
  '_blank', '_template', 'activity', 'aeon_matrix', 'cookbook',
  'council', 'dashboard', 'deep_research', 'files', 'fleet_control', 'host_os',
  'master', 'memory_core', 'orion_search', 'quick_links', 'resume_grader', 'security', 'settings',
  'writer', 'payroll', 'system', 'finance',
];
const SOURCE_NAMES = Object.fromEntries(BLOCK_ICONS.map((id) => [id, id.replaceAll('_', '-')]));
const SECTION_ICONS = ['finance', 'agent', 'work', 'content', 'tools', 'system'];

/**
 * The blocks that have no artwork of their own and therefore show the AEON
 * fallback. Their SVG and PNG are written by tools/generate-aeon-brand-icons.mjs
 * (`npm run brand:icons`) - the one writer for anything that carries the mark -
 * and checked by tests/brand-mark.test.js. This list is the contract: exactly
 * these six carry the fallback, and no section icon ever does.
 */
export const FALLBACK_BLOCKS = ['_blank', '_template', 'finance', 'host_os', 'payroll', 'system'];

// The fallback for a block with no source artwork carries the AEON glyph, and
// the app shows it: host_os has no source, so this renders in the sidebar. It
// used to be an "A" with a crossbar (d="M4 18 12 3l8 15M7 13h10") - a second,
// hand-drawn AEON mark that matched neither the poster nor the real mark, and
// exactly the glyph the CEO rejected on 2026-09-11. It is now the mark's
// chevron: public/brand/aeon-mark/aeon-mark.svg's six-vertex hollow chevron
// scaled by 0.105 into this 24-unit box about (12,12). No crossbar. The tilted
// orbit ellipse and its node are NOT from the mark: they are this block-icon
// family's device, carried over from the previous glyph so the fallback keeps
// reading as "a block" beside the other block icons. If the mark's chevron
// changes, change this in step; tests/brand-mark.test.js fails on the crossbar
// segment coming back, and ties the six fallback PNGs on disk to a fresh
// render of this string.
export const AEON_FALLBACK = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
  '<path fill="currentColor" d="M4.3 19.6 12 5.3l7.7 14.3h-2.3L12 9.6l-5.4 10z"/>',
  '<ellipse cx="12" cy="12" rx="10" ry="4.5" fill="none" stroke="currentColor" stroke-width="1.2" transform="rotate(-24 12 12)"/>',
  '<circle cx="19.7" cy="7.5" r="1.3" fill="currentColor"/>',
  '</svg>',
].join('');

function themeAware(svg) {
  return svg
    .replaceAll('fill="#000000"', 'fill="currentColor"')
    .replaceAll("fill='#000000'", 'fill="currentColor"')
    .replaceAll('stroke="#000000"', 'stroke="currentColor"')
    .replaceAll("stroke='#000000'", 'stroke="currentColor"');
}

export const PNG_SIZE = 64;

/**
 * The 64px PNG the app uses when a block's SVG fails to load. Exported so a
 * test can prove the six fallback PNGs on disk are this.
 *
 * The root is resized to 64 BEFORE loadImage(), so the vector engine
 * rasterises at 64 with coverage anti-aliasing. The previous version loaded the
 * 24-unit SVG at its natural 24px and drawImage()'d it up to 64 - a bilinear
 * smear of a 24px raster (measured: 1211 intermediate-alpha pixels against 291
 * for the same SVG rasterised at a 64px root). Same rule as the brand
 * generator: the size goes into the SVG, never into drawImage().
 */
export async function renderPng(svg) {
  const themed = svg.replaceAll('currentColor', '#00e2ff');
  const m = themed.match(/<svg\b[^>]*>/);
  if (!m) throw new Error('renderPng: no <svg> root element');
  const root = m[0].replace(/\s(?:width|height)="[^"]*"/g, '').replace(/>$/, ` width="${PNG_SIZE}" height="${PNG_SIZE}">`);
  const sized = themed.slice(0, m.index) + root + themed.slice(m.index + m[0].length);
  const image = await loadImage(Buffer.from(sized));
  const canvas = createCanvas(PNG_SIZE, PNG_SIZE);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;   // 1:1 - nothing to resample
  context.clearRect(0, 0, PNG_SIZE, PNG_SIZE);
  context.drawImage(image, 0, 0);
  return canvas.encode('png');
}

/**
 * Regenerate the block icons that HAVE source artwork. Refuses to run without
 * the source directory: the first version fell back for every id it could not
 * find, so on any clone without assets/block-icons-src it rewrote all 22 block
 * icons and all 6 section icons with the AEON fallback - and a test's
 * remediation message told people to run it. Per id, an on-disk SVG that is
 * not already the fallback is never overwritten when its source is absent; the
 * six fallback ids are owned by `npm run brand:icons` and skipped here.
 */
export async function generateBlockIcons() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(
      `[block-icons] no source artwork at ${path.relative(ROOT, SOURCE_DIR)} - set AEON_ICON_SOURCE to the artwork directory. `
      + `The six fallback icons (${FALLBACK_BLOCKS.join(', ')}) are written by npm run brand:icons, not here.`,
    );
  }
  fs.mkdirSync(PNG_DIR, { recursive: true });
  fs.mkdirSync(SECTION_DIR, { recursive: true });

  const written = [], skipped = [];
  for (const id of BLOCK_ICONS) {
    if (FALLBACK_BLOCKS.includes(id)) continue;
    const file = path.join(SOURCE_DIR, `${SOURCE_NAMES[id]}.svg`);
    if (!fs.existsSync(file)) { skipped.push(id); continue; }
    const svg = themeAware(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${id}.svg`), svg);
    fs.writeFileSync(path.join(PNG_DIR, `${id}.png`), await renderPng(svg));
    written.push(id);
  }
  for (const id of SECTION_ICONS) {
    const file = path.join(SOURCE_DIR, `group-${id}.svg`);
    if (!fs.existsSync(file)) { skipped.push(`section:${id}`); continue; }
    fs.writeFileSync(path.join(SECTION_DIR, `${id}.svg`), themeAware(fs.readFileSync(file, 'utf8')));
    written.push(`section:${id}`);
  }
  console.log(`[block-icons] wrote ${written.length} from source artwork${skipped.length ? `; no source for: ${skipped.join(', ')} (left as they are)` : ''}.`);
  return { written, skipped };
}

// Run as a script; importable by tests. fileURLToPath, never `.pathname` -
// see the note in generate-aeon-brand-icons.mjs about Windows.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await generateBlockIcons(); }
  catch (e) { console.error(e.message); process.exit(1); }
}
