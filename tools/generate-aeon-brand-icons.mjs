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
 * ONE WRITER, ONE CHECKER. `npm run brand:icons` is the only thing that writes
 * these files - including the six block-icon fallbacks (the sidebar icon of a
 * block with no artwork of its own), which carry the mark's chevron and so
 * derive from it too. That is enforced at runtime: generate() refuses to write
 * unless npm's npm_lifecycle_event says "brand:icons" (or AEON_BRAND_WRITE=1
 * overrides on purpose), so a helper chained into build cannot regenerate
 * either. `npm run build` deliberately does NOT run this script: a
 * build on another machine would regenerate every PNG with that machine's
 * rasteriser and, if its SIMD path differs by a level, dirty the tree on every
 * build - "truth" would move to whichever box built last. Instead
 * tests/brand-mark.test.js re-renders every output from the SVGs on every CI
 * leg and compares: byte-exact when the machine reproduces the rasteriser
 * probes recorded in tools/aeon-brand.stamp.json, one-level (premultiplied)
 * tolerance when it does not. An edited SVG without a regeneration fails that
 * test on the stamp machine and is named as the cause everywhere.
 *
 * THE STAMP. tools/aeon-brand.stamp.json (outside public/, so it never ships)
 * records sha256 of three SENTINEL renders - fixed drawings embedded below
 * that exercise the rasteriser's paths (antialiased stroke over a gradient,
 * a hairline stroke at 16px, a blurred scaled group) and never change with
 * the mark - plus sha256 of the two source SVGs. Identical sentinels mean an
 * identical rasteriser, whatever the platform label says (Rosetta, CPU
 * feature sets and a bumped @napi-rs/canvas all change pixels without
 * changing the label). Re-running on a machine whose sentinels differ while
 * the sources are unchanged would re-rasterise every icon for no visual
 * reason and move the stamp there; that is refused unless
 * AEON_BRAND_RESTAMP=1 says it is meant.
 *
 * Three renderings of ONE mark:
 *   aeon-mark.svg          the full mark - hollow chevron, inner ring, segmented
 *                          outer ring with three node circles. Used from 64px up.
 *   aeon-mark-compact.svg  the same chevron and ring with the outer ring dropped
 *                          and the glow removed. Used for every PNG of 48px or
 *                          less. Those are the tab-icon frames - a 16 CSS px tab
 *                          at 1x, 2x and 3x - and Chrome and Safari show the 32
 *                          frame on a 2x display, so it must be this cut or the
 *                          tab shows one mark and the sidebar beside it another.
 *                          They are also listed as 16/32/48 "any" icons in both
 *                          web manifests, because an installed PWA builds its
 *                          taskbar and title-bar icons from the manifest, never
 *                          from favicon.ico, and downscales the largest listed
 *                          icon for any size it lacks. The in-app <img>s choose
 *                          their cut by CSS size and load the SVGs directly; the
 *                          one <img> whose CSS size can land under 48 device px
 *                          on a 1x or 1.5x screen (the 28px mobile header) is a
 *                          <picture> that hands those screens this cut.
 *   aeon-mark-maskable.svg DERIVED here from aeon-mark.svg, never edited: the
 *                          same drawing on a square ground with no corner radius,
 *                          scaled to 80% about the centre. Android and PWA
 *                          launchers crop a "maskable" icon to their own shape
 *                          and only guarantee the central circle of radius 40%;
 *                          the full mark's node circles sit outside that circle
 *                          and its transparent corners let wallpaper through.
 *                          iOS composites transparent corners on black under its
 *                          own mask, so apple-touch-icon is this cut too.
 *
 * HOW A PNG IS MADE, AND WHY IT MATTERS. The SVG root's width/height are
 * rewritten to the target size BEFORE loadImage(), so the vector engine
 * rasterises the geometry at that size with coverage anti-aliasing - what a
 * browser does with an <img>. The first version loaded the SVG at 512 and
 * drawImage()'d it into a smaller canvas; in @napi-rs/canvas that is a
 * point-sample of the 512 raster whatever imageSmoothingQuality says, and it
 * shipped a 16px favicon whose 0.6px ring was eight dashes and eight holes.
 * The review harness ran on the same path, so it could not see it.
 *
 * The poster is left exactly where it is. It is a good poster; it was never an
 * icon, and nothing here reads it any more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { AEON_FALLBACK, FALLBACK_BLOCKS, renderPng as renderBlockPng } from './generate-block-icons.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const MARK_DIR = path.join(BRAND, 'aeon-mark');
const FULL_SVG = path.join(MARK_DIR, 'aeon-mark.svg');
const COMPACT_SVG = path.join(MARK_DIR, 'aeon-mark-compact.svg');
/** Where the bytes were made: rasteriser sentinels and source hashes. Not under public/: it describes a machine, not the mark, and must not ship. */
export const STAMP_FILE = path.join(ROOT, 'tools', 'aeon-brand.stamp.json');

/** 24 was generated for a while and had no consumer: the 22px <img> loads the SVG and no ico has a 24 frame. */
export const SIZES = [16, 32, 48, 64, 128, 192, 256, 512, 1024];
/** 180 is what iOS asks for as apple-touch-icon; it composites transparency on
 *  black under its own mask, so that slot needs the full-bleed cut too. */
export const MASKABLE_SIZES = [180, 192, 512];
/** At or below this a PNG is a tab-icon frame (16 CSS px x DPR): the compact cut. */
export const COMPACT_AT_OR_BELOW = 48;
/** Scale of the drawing inside the maskable square: node outer edge at r 198 < 204.8 (40%). */
export const MASKABLE_SCALE = 0.8;
/** favicon.ico frames. No 256: that frame alone made the tab icon 59 KB per first load. */
export const FAVICON_FRAMES = [16, 32, 48];
/** AEON.ico (Windows shortcuts) keeps the large frame. Its 48 frame is the compact
 *  cut like favicon.ico's, so a Windows "medium icons" shortcut at 1x shows the
 *  compact cut while the boot gate at 48 CSS px shows the full mark - accepted,
 *  because the ico's job is the tab and taskbar, and the frames are shared. */
export const WINDOWS_ICO_FRAMES = [16, 32, 48, 256];

export function createIco(frames) {
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

/** Parse an .ico: [{ size, offset, length, png }]. Exported so the test can check frames, not directory bytes. */
export function parseIco(buf) {
  const n = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const w = buf.readUInt8(e) || 256;
    const length = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12);
    frames.push({ size: w, offset, length, png: buf.subarray(offset, offset + length) });
  }
  return frames;
}

/**
 * The maskable cut is the full mark with two textual edits, so the geometry
 * has exactly one home. Each edit is checked: a silent no-op here would ship
 * the un-maskable icon under the maskable name.
 */
export function deriveMaskable(fullSvg) {
  const square = fullSvg.replace('<rect width="512" height="512" rx="112"', '<rect width="512" height="512"');
  if (square === fullSvg) throw new Error('maskable: the ground rect was not found in aeon-mark.svg');
  const scaled = square.replace(
    '<g filter="url(#aeonGlow)"',
    `<g transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)"><g filter="url(#aeonGlow)"`,
  );
  if (scaled === square) throw new Error('maskable: the drawing group was not found in aeon-mark.svg');
  const closed = scaled.replace(/<\/svg>\s*$/, '</g>\n</svg>\n');
  if (closed === scaled) throw new Error('maskable: could not close the scaled group');
  const note = '\n  <!-- GENERATED from aeon-mark.svg by tools/generate-aeon-brand-icons.mjs. Do not edit; edit the source. -->';
  return closed.replace('</title>', `</title>${note}`);
}

/**
 * The SVG text with its root width/height set to `size`, so the vector engine
 * rasterises at that size. Anchored to the document's FIRST <svg>, and the two
 * attributes must be present, double-quoted, width then height, as both
 * sources write them - anything else is refused loudly rather than resized
 * somewhere else in the document.
 */
export function sizedSvg(svgText, size) {
  const m = svgText.match(/<svg\b[^>]*>/);
  if (!m) throw new Error('sizedSvg: no <svg> root element');
  const root = m[0];
  if (!/\swidth="\d+"\s+height="\d+"/.test(root)) {
    throw new Error(`sizedSvg: the root <svg> must carry width="N" height="N" (double-quoted, in that order); got: ${root.slice(0, 120)}`);
  }
  const resized = root.replace(/\swidth="\d+"\s+height="\d+"/, ` width="${size}" height="${size}"`);
  return svgText.slice(0, m.index) + resized + svgText.slice(m.index + root.length);
}

/**
 * Render one SVG (as text) to a square PNG of `size`. Exported so a test can
 * prove derivation and rasterise the sources the same way.
 * See the header: the size goes into the SVG, never into drawImage().
 */
export async function renderPng(svgText, size) {
  const image = await loadImage(Buffer.from(sizedSvg(svgText, size)));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;   // 1:1 - nothing to resample
  context.drawImage(image, 0, 0);
  return canvas.encode('png');
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Three fixed drawings that fingerprint the RASTERISER, independent of the
 * mark. They exercise what the icons exercise: an antialiased stroke over a
 * radial gradient on a rounded ground, a hairline (0.875px at 16) stroke -
 * Skia's thin-stroke path, which the compact ring at 16 goes through - and a
 * two-pass feGaussianBlur inside a scaled group, which the maskable cut goes
 * through. If a machine reproduces these three hashes it reproduces every
 * output; the test then demands byte equality. Never derive these from the
 * source SVGs: the first version did, so editing a source changed the probe,
 * mismatched the stamp, and demoted the very machine that should have caught
 * the un-regenerated edit to the tolerant path.
 */
export const SENTINELS = {
  stroke64: { size: 64, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><radialGradient id="g" cx="50%" cy="42%" r="78%"><stop offset="0%" stop-color="#0b1428"/><stop offset="62%" stop-color="#050a16"/><stop offset="100%" stop-color="#01030a"/></radialGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><circle cx="256" cy="256" r="180" fill="none" stroke="#7fb2ff" stroke-width="28"/><path d="M141 369 L256 155 L371 369 L333 369 L256 226 L179 369 Z" fill="#ffffff"/></svg>' },
  hairline16: { size: 16, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#050a16"/><circle cx="256" cy="256" r="210" fill="none" stroke="#7fb2ff" stroke-width="28"/><circle cx="256" cy="256" r="120" fill="none" stroke="#ffffff" stroke-width="20"/></svg>' },
  blur128: { size: 128, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><filter id="f" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur in="SourceGraphic" stdDeviation="6" result="wide"/><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="tight"/><feMerge><feMergeNode in="wide"/><feMergeNode in="tight"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="512" height="512" fill="#01030a"/><g transform="translate(256 256) scale(0.8) translate(-256 -256)"><g filter="url(#f)" fill="none"><circle cx="256" cy="256" r="205" stroke="#bcd8ff" stroke-width="14" stroke-dasharray="257.61 64.40" transform="rotate(-36 256 256)"/><circle cx="410.15" cy="101.85" r="24" stroke="#eaf3ff" stroke-width="10"/></g></g></svg>' },
  // 180 is not a power of two and lands the scaled group's blur on fractional
  // device pixels. Its absence is why windows-latest reproduced the other three
  // sentinels, was classed EXACT, and then differed on aeon-icon-maskable-180
  // alone (CI run 34679256019, 2026-09-12). A sentinel set that misses a path
  // the outputs use classes a machine exact that is not.
  scaledBlur180: { size: 180, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><filter id="f" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur in="SourceGraphic" stdDeviation="6" result="wide"/><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="tight"/><feMerge><feMergeNode in="wide"/><feMergeNode in="tight"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="512" height="512" fill="#01030a"/><g transform="translate(256 256) scale(0.8) translate(-256 -256)"><g filter="url(#f)"><circle cx="256" cy="256" r="118" fill="none" stroke="#7fb2ff" stroke-width="9"/><path d="M183 328 L256 192 L329 328 L307 328 L256 233 L205 328 Z" fill="#ffffff"/></g></g></svg>' },
};

export async function probeHashes() {
  const out = {};
  for (const [name, { size, svg }] of Object.entries(SENTINELS)) out[name] = sha256(await renderPng(svg, size));
  return out;
}

export function sourceHashes() {
  return { full: sha256(fs.readFileSync(FULL_SVG)), compact: sha256(fs.readFileSync(COMPACT_SVG)) };
}

export function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')); } catch { return null; }
}

export async function generate({ write = true, restamp = process.env.AEON_BRAND_RESTAMP === '1' } = {}) {
  // A missing or malformed source must stop the run. Writing icons from a
  // half-read SVG would quietly ship a blank square to every surface at once.
  for (const file of [FULL_SVG, COMPACT_SVG]) {
    if (!fs.existsSync(file)) throw new Error(`[brand] missing source: ${path.relative(ROOT, file)}`);
  }

  const fullSvg = fs.readFileSync(FULL_SVG);
  const compactSvg = fs.readFileSync(COMPACT_SVG);
  const maskableSvg = Buffer.from(deriveMaskable(fullSvg.toString('utf8')));
  const full = fullSvg.toString('utf8');
  const compact = compactSvg.toString('utf8');
  const maskable = maskableSvg.toString('utf8');

  const out = new Map(); // repo-relative path -> Buffer
  const frames = [];
  for (const size of SIZES) {
    const png = await renderPng(size <= COMPACT_AT_OR_BELOW ? compact : full, size);
    out.set(`public/brand/aeon-mark/aeon-icon-${size}.png`, png);
    frames.push({ size, png });
  }
  for (const size of MASKABLE_SIZES) {
    out.set(`public/brand/aeon-mark/aeon-icon-maskable-${size}.png`, await renderPng(maskable, size));
  }
  out.set('public/brand/aeon-mark/aeon-mark-maskable.svg', maskableSvg);

  // A legacy URL, kept equal to the mark.
  out.set('public/brand/aeon-icon.svg', fullSvg);

  // Duplicates at the brand root and public/logo.png. Nothing in this repo
  // references them any more; they are public URLs that may be linked from
  // outside (docs, stores, bookmarks), so they are kept in step rather than
  // deleted - removing a served file is a deletion-protocol decision, not a
  // build script's. When that decision is taken, delete this block and them.
  for (const size of [32, 64, 192, 256, 512, 1024]) {
    out.set(`public/brand/aeon-icon-${size}.png`, frames.find((f) => f.size === size).png);
  }

  out.set('public/favicon.ico', createIco(frames.filter(({ size }) => FAVICON_FRAMES.includes(size))));
  out.set('AEON.ico', createIco(frames.filter(({ size }) => WINDOWS_ICO_FRAMES.includes(size))));
  out.set('public/logo.png', frames.find(({ size }) => size === 512).png);

  // The six block-icon fallbacks carry the mark's chevron, so they are written
  // here, by the one writer, and checked by the same derivation test.
  // tools/generate-block-icons.mjs owns the drawing and the 64px renderer; it
  // is for machines with the real block artwork and refuses to run without it.
  const fallbackPng = await renderBlockPng(AEON_FALLBACK);
  for (const id of FALLBACK_BLOCKS) {
    out.set(`public/brand/block-icons/${id}.svg`, Buffer.from(AEON_FALLBACK));
    out.set(`public/brand/block-icons/png/${id}.png`, fallbackPng);
  }

  if (write) {
    // Only `npm run brand:icons` may write. npm names the running script in
    // npm_lifecycle_event, so a helper that imports generate() and is chained
    // into build (or prestart, or a workflow) sees "build" here and is refused
    // - the one-writer rule holds at runtime, not only in a test's grep of
    // package.json. AEON_BRAND_WRITE=1 is the explicit override for tooling.
    const via = process.env.npm_lifecycle_event;
    if (via !== 'brand:icons' && process.env.AEON_BRAND_WRITE !== '1') {
      throw new Error(
        `[brand] refusing to write icons from "${via || 'a direct node call'}": only npm run brand:icons writes them `
        + '(the test is the gate on every other path). Set AEON_BRAND_WRITE=1 to override deliberately.',
      );
    }
    const probes = await probeHashes();
    const sources = { full: sha256(fullSvg), compact: sha256(compactSvg) };
    const prev = readStamp();
    const sameSources = prev?.sources && prev.sources.full === sources.full && prev.sources.compact === sources.compact;
    // Compare only the sentinels the stamp already knows. A sentinel ADDED to
    // the set (as scaledBlur180 was, 2026-09-12) is a change to the probe, not
    // to the rasteriser: refusing there would make it impossible to extend the
    // set without also declaring a machine change. A sentinel the stamp has and
    // this machine renders differently is the real signal.
    const shared = prev?.probes ? Object.keys(SENTINELS).filter((k) => k in prev.probes) : [];
    const driftsOnShared = shared.length > 0 && shared.some((k) => prev.probes[k] !== probes[k]);
    if (prev && sameSources && driftsOnShared && !restamp) {
      throw new Error(
        '[brand] refusing: the sources are unchanged but this rasteriser differs from the one that made the '
        + `committed icons (${prev.platform}/${prev.arch}, canvas ${prev.canvas}). Regenerating here would rewrite every `
        + 'icon for no visual reason and move the stamp to this machine. If that is intended, set AEON_BRAND_RESTAMP=1.',
      );
    }
    fs.mkdirSync(MARK_DIR, { recursive: true });
    fs.mkdirSync(path.join(BRAND, 'block-icons', 'png'), { recursive: true });
    for (const [rel, buf] of out) fs.writeFileSync(path.join(ROOT, rel), buf);
    fs.writeFileSync(STAMP_FILE, JSON.stringify({
      generatedBy: 'npm run brand:icons',
      platform: process.platform, arch: process.arch, node: process.versions.node,
      canvas: packageVersion('@napi-rs/canvas'),
      probes, sources,
    }, null, 2) + '\n');
  }
  return out;
}

function packageVersion(pkg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

// Run as a script (`npm run brand:icons`); importable by tests. The comparison
// MUST go through fileURLToPath: `new URL(...).pathname` is "/C:/Users/..." on
// Windows and path.resolve makes that "C:\C:\Users\...", so a guard written
// that way is false where AEON ships and the script would exit 0 having
// regenerated nothing. AEON_BRAND_WRITE=0 runs everything but the writes, so a
// test can prove the script path executes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = await generate({ write: process.env.AEON_BRAND_WRITE !== '0' });
    console.log(
      `[brand] ${SIZES.length} icons from the vector mark (<=${COMPACT_AT_OR_BELOW}px from the compact cut), `
      + `${MASKABLE_SIZES.length} maskable, ${FALLBACK_BLOCKS.length} block fallbacks, plus favicon.ico, AEON.ico and logo.png - ${out.size} files`,
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
