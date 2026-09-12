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
 * CEO, 2026-09-11: "icon isn't really an A - more like a chevron". The first
 * vector cut had drawn a crossbar that exists nowhere in the emblem. The glyph
 * is a HOLLOW CHEVRON - an outlined lambda, parallel edges, flat feet.
 *
 * What is locked here, in order of how quietly each would otherwise revert:
 *   1. DERIVATION - every raster on disk is what the generator renders from the
 *      SVGs, block-icon fallbacks included: byte-exact on a machine that
 *      reproduces the four rasteriser sentinels in tools/aeon-brand.stamp.json
 *      (fixed drawings, so an edited SVG cannot demote the gate), else equal
 *      within DRIFT_LEVELS in PREMULTIPLIED space - the space Skia drifts in;
 *      comparing un-premultiplied channels turns a one-level drift at a
 *      low-alpha corner pixel into twenty. .ico files are compared frame by
 *      frame, never by directory bytes, and every frame must be its sibling
 *      PNG. The stamp also carries the source hashes, so an edited SVG is
 *      named as the cause instead of the platform. `npm run build` does NOT
 *      regenerate: this test is the gate, on every leg, and the mode it ran in
 *      is printed.
 *   2. SHAPE - one filled six-vertex path, notch centred, parallel edges at
 *      the poster's slope, no crossbar, in both cuts and the block-icon
 *      fallback; the compact chevron is the full mark's, scaled; exactly six
 *      block icons carry the fallback and no section icon does.
 *   3. WIRING - every in-app <img> loads the vector cut for its CSS size (and,
 *      where CSS size can land under 48 device px on a 1x screen, a <picture>
 *      hands those screens the compact cut), the tab icon is right in all
 *      three engines, the maskable slots get the full-bleed cut, and both
 *      manifests list an own-size render for every size a launcher wants.
 *   4. LEGIBILITY - rasters made the way a browser makes them (the vector
 *      rendered AT the target size, coverage-antialiased) show a ring, a notch,
 *      and daylight between foot and ring. The first version of this section
 *      measured point-sampled renders and could not fail; every probe here is
 *      shown to fail on a control that lacks the property.
 *   5. PROVENANCE - the pipeline reads the SVGs and nothing else; no served
 *      file points at the poster; only `npm run brand:icons` writes icons.
 *
 * Platform notes, MEASURED 2026-09-12 on CI run 34679256019 (icons generated on
 * darwin/x64, canvas 1.0.2):
 *   ubuntu-latest x64  reproduced every sentinel and every byte - exact.
 *   windows-latest x64 reproduced every byte too. It first differed on
 *                      aeon-icon-maskable-180.png alone, which is what added
 *                      the scaledBlur180 sentinel: 180 is not a power of two
 *                      and lands the scaled group's blur on fractional device
 *                      pixels, a path the other three never touched.
 *   macos-latest arm64 drifts. Up to 4 premultiplied levels at opaque pixels
 *                      across ten files (worst aeon-icon-64.png at (43,39)).
 *                      Apple Silicon's Skia NEON path, not tampering - the
 *                      legibility probes pass on every leg, because 4/255 is
 *                      invisible. Hence DRIFT_LEVELS = 8, with the margin and
 *                      the reading written down beside it.
 * Safari's favicon choice is asserted from its source, not observed. A tracked
 * Windows shortcut, "AEON Command Center.lnk", points its icon at
 * Desktop\aeon3\AEON.ico, a sibling folder nothing here writes; rebuilding it
 * on the Windows box is the CEO's.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = await import('@napi-rs/canvas'));
} catch (e) {
  throw new Error(`the brand gate needs the @napi-rs/canvas native binding for ${process.platform}/${process.arch}; npm ci installs it (${e.message})`);
}
import {
  generate, deriveMaskable, sizedSvg, parseIco, probeHashes, sourceHashes, readStamp, SENTINELS, STAMP_FILE,
  SIZES, MASKABLE_SIZES, COMPACT_AT_OR_BELOW, FAVICON_FRAMES, WINDOWS_ICO_FRAMES,
} from '../tools/generate-aeon-brand-icons.mjs';
import { AEON_FALLBACK, FALLBACK_BLOCKS } from '../tools/generate-block-icons.mjs';

// fileURLToPath, never `new URL(...).pathname`: that is "/C:/Users/..." on
// Windows and the whole file failed at collection on the windows-latest leg.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const MARK = path.join(BRAND, 'aeon-mark');

const read = (p) => fs.readFileSync(p, 'utf8');
const bytes = (p) => fs.statSync(p).size;
/** Strip XML comments - a rule described in prose is not a rule being broken. */
const markup = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
/** Strip JS comments for the same reason. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CUTS = ['aeon-mark.svg', 'aeon-mark-compact.svg'];
const pathVertices = (src) => {
  const d = src.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1] || '';
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
};

/** Decode any image buffer to a luminance sampler at its own size, no resampling. */
async function decode(buf) {
  const img = await loadImage(buf);
  const w = img.width, h = img.height;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h).data;
  const lum = (x, y) => { const i = (y * w + x) * 4; return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; };
  const alpha = (x, y) => data[(y * w + x) * 4 + 3];
  return { w, h, lum, alpha, data };
}
/** An SVG rasterised AT `size` by the vector engine - what a browser does with an <img>. */
const rasterSvg = (svgText, size) => decode(Buffer.from(sizedSvg(svgText, size)));
/** A PNG file's own pixels. */
const rasterPng = (file) => decode(fs.readFileSync(file));

/**
 * How far one rasteriser may sit from another before it stops being drift.
 *
 * MEASURED, not guessed (§23). CI run 34679256019, 2026-09-12, icons generated
 * on darwin/x64 canvas 1.0.2: darwin/arm64 differed by at most 4 premultiplied
 * levels (worst case aeon-icon-64.png at (43,39), alpha 255; 2-4 across ten
 * files); ubuntu/x64 and win32/x64 reproduced every byte. The first bound was
 * 1, a guess, and it called a 1.6%-of-full-scale difference tampering. 8 keeps
 * a margin over the measured 4 and is still far below anything visible: a
 * one-level edit to a gradient stop moves an antialiased edge pixel by 2, a
 * 15-level edit by 13-15, and an upscaled raster by 255 - all caught.
 *
 * The differing-pixel COUNT is deliberately not bounded yet: nobody has
 * measured it on arm64. It is reported below so the next CI run supplies the
 * number, and a bound can be set from a reading instead of a guess.
 */
const DRIFT_LEVELS = 8;

/**
 * Two PNG buffers equal within DRIFT_LEVELS in premultiplied space.
 * getImageData hands back un-premultiplied channels; the rasteriser drifts in
 * premultiplied ones and the encoder divides by alpha on the way out, so a
 * one-level drift at alpha 12 reads as 21 un-premultiplied. Returns null when
 * within bound, else a message naming the worst pixel and the spread.
 */
async function pixelsWithinDrift(aBuf, bBuf) {
  const a = await decode(aBuf), b = await decode(bBuf);
  if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} vs ${b.w}x${b.h}`;
  let worst = 0, where = null, differing = 0, total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aA = a.data[i + 3], bA = b.data[i + 3];
    let d = Math.abs(aA - bA);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(Math.round(a.data[i + c] * aA / 255) - Math.round(b.data[i + c] * bA / 255)));
    if (d) { differing++; total += d; }
    if (d > worst) { worst = d; where = { x: (i / 4) % a.w, y: Math.floor(i / 4 / a.w), alpha: aA }; }
  }
  const px = a.w * a.h;
  const spread = `${differing} of ${px} pixels differ (${(100 * differing / px).toFixed(1)}%), mean ${(total / Math.max(1, differing)).toFixed(2)} levels`;
  return worst <= DRIFT_LEVELS ? null
    : `premultiplied difference of ${worst} levels at (${where.x},${where.y}) alpha ${where.alpha} - over the ${DRIFT_LEVELS}-level drift bound; ${spread}`;
}

/** The gate's mode on this machine, from the stamp: exact when the sentinels reproduce. */
async function gateMode() {
  expect(fs.existsSync(STAMP_FILE), 'tools/aeon-brand.stamp.json is written by npm run brand:icons').toBe(true);
  const stamp = readStamp();
  expect(stamp, 'stamp must be valid JSON').toBeTruthy();
  for (const k of Object.keys(SENTINELS)) expect(stamp.probes?.[k], `stamp malformed (probe ${k}) - run npm run brand:icons`).toMatch(/^[0-9a-f]{64}$/);
  for (const k of ['full', 'compact']) expect(stamp.sources?.[k], `stamp malformed (source ${k}) - run npm run brand:icons`).toMatch(/^[0-9a-f]{64}$/);
  for (const k of ['platform', 'arch', 'canvas']) expect(stamp[k], `stamp malformed (${k})`).toBeTruthy();
  const here = await probeHashes();
  const exact = Object.keys(SENTINELS).every(k => here[k] === stamp.probes[k]);
  const src = sourceHashes();
  const edited = ['full', 'compact'].filter(k => src[k] !== stamp.sources[k]);
  const why = exact
    ? 'exact (this machine reproduces the rasteriser sentinels)'
    : `tolerant (generated on ${stamp.platform}/${stamp.arch} canvas ${stamp.canvas}; here ${process.platform}/${process.arch})`;
  return { exact, edited, why };
}

const walk = (p, out = []) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) if (n !== 'node_modules') walk(path.join(p, n), out); }
  else out.push(p);
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
describe('1. every icon on disk is what the generator renders from the SVGs', () => {
  const full = read(path.join(MARK, 'aeon-mark.svg'));

  it('all outputs - exact where the sentinels reproduce, one premultiplied level elsewhere; ico frame by frame; an edited SVG is named', async () => {
    const { exact, edited, why } = await gateMode();
    console.info(`[brand] derivation gate: ${why}`);
    const out = await generate({ write: false });
    expect(out.size).toBeGreaterThan(30);
    const stale = [];
    for (const [rel, buf] of out) {
      const file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) { stale.push(`${rel}: missing`); continue; }
      const disk = fs.readFileSync(file);
      if (buf.equals(disk)) continue;
      const cause = edited.length
        ? `${edited.join(' and ')} SVG edited since the last npm run brand:icons - regenerate`
        : exact
          ? 'differs from a fresh render on the stamp machine - either an output was edited by hand, or this rasteriser differs on a path the sentinels do not exercise'
          : why;
      if (exact || !/\.(png|ico)$/.test(rel)) { stale.push(`${rel}: ${cause}`); continue; }
      if (rel.endsWith('.ico')) {
        const want = parseIco(buf), have = parseIco(disk);
        if (want.length !== have.length || want.some((f, i) => f.size !== have[i].size)) { stale.push(`${rel}: frame set differs (${cause})`); continue; }
        for (let i = 0; i < want.length; i++) {
          const msg = await pixelsWithinDrift(want[i].png, have[i].png);
          if (msg) stale.push(`${rel}: frame ${want[i].size} ${msg} (${cause})`);
        }
        continue;
      }
      const msg = await pixelsWithinDrift(buf, disk);
      if (msg) stale.push(`${rel}: ${msg} (${cause})`);
    }
    expect(stale, `stale icons:\n  ${stale.join('\n  ')}`).toEqual([]);
  }, 90000);

  it('the stamp records the sources that made the icons; unchanged sources with a different rasteriser are refused', () => {
    const stamp = readStamp();
    const src = sourceHashes();
    expect(stamp.sources, 'SVG edited since the last npm run brand:icons').toEqual(src);
    const gen = code(read(path.join(ROOT, 'tools', 'generate-aeon-brand-icons.mjs')));
    expect(gen).toMatch(/AEON_BRAND_RESTAMP/);
    expect(gen).toMatch(/refusing: the sources are unchanged but this rasteriser differs/);
  });

  it('every ico frame IS its sibling PNG, on every platform', () => {
    for (const [ico, frames] of [['public/favicon.ico', FAVICON_FRAMES], ['AEON.ico', WINDOWS_ICO_FRAMES]]) {
      const parsed = parseIco(fs.readFileSync(path.join(ROOT, ico)));
      expect(parsed.map(f => f.size), `${ico} frames`).toEqual(frames);
      for (const f of parsed) {
        expect(f.png.equals(fs.readFileSync(path.join(MARK, `aeon-icon-${f.size}.png`))), `${ico} frame ${f.size} = aeon-icon-${f.size}.png`).toBe(true);
      }
    }
  });

  it('the generator runs as a script - proven by running it, not by reading package.json', () => {
    // The first guard used `new URL(import.meta.url).pathname`, which is false
    // on Windows, so a script run there exited 0 having regenerated nothing.
    const r = spawnSync(process.execPath, ['tools/generate-aeon-brand-icons.mjs'], {
      cwd: ROOT, env: { ...process.env, AEON_BRAND_WRITE: '0' }, encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[brand\] \d+ icons from the vector mark/);
    for (const f of ['tools/generate-aeon-brand-icons.mjs', 'tools/generate-block-icons.mjs']) {
      const src = code(read(path.join(ROOT, f)));
      expect(src, `${f}: never .pathname on a file URL`).not.toMatch(/import\.meta\.url\)\.pathname/);
      expect(src, `${f}: guard goes through fileURLToPath`).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    }
  }, 30000);

  it('one writer: no script, hook or workflow regenerates icons except brand:icons, and the stamp lives outside public/', async () => {
    // A build on another machine would rewrite every PNG with that machine's
    // rasteriser and dirty the tree on every build. This test is the gate.
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    expect(pkg.scripts['brand:icons']).toBe('node tools/generate-aeon-brand-icons.mjs');
    // brand:block-icons is the writer for blocks WITH source artwork (it refuses
    // to run without it); it never touches the six fallbacks or the mark.
    expect(pkg.scripts['brand:block-icons']).toBe('node tools/generate-block-icons.mjs');
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === 'brand:icons' || name === 'brand:block-icons') continue;
      expect(cmd, `script "${name}" must not regenerate icons`).not.toMatch(/brand:icons|generate-aeon-brand-icons|brand:block-icons|generate-block-icons/);
    }
    expect(Object.keys(pkg.scripts).filter(k => /^(pre|post)(build|install|prepare|test|start)$/.test(k)), 'no lifecycle hooks').toEqual([]);
    const workflows = fs.existsSync(path.join(ROOT, '.github', 'workflows')) ? walk(path.join(ROOT, '.github', 'workflows')) : [];
    for (const f of workflows) expect(read(f), `${path.relative(ROOT, f)} must not regenerate icons`).not.toMatch(/brand:icons|generate-aeon-brand-icons|brand:block-icons|generate-block-icons/);
    // Nothing else imports the generator: a helper that imports generate() and
    // is chained into build would evade a scan of script names.
    const importers = ['scripts', 'tools', 'server', 'src', 'services', 'api']
      .filter(d => fs.existsSync(path.join(ROOT, d)))
      .flatMap(d => walk(path.join(ROOT, d)))
      .filter(f => /\.(m?js|cjs|jsx)$/.test(f) && path.relative(ROOT, f) !== path.join('tools', 'generate-aeon-brand-icons.mjs'))
      .filter(f => /generate-aeon-brand-icons/.test(code(read(f))))
      .map(f => path.relative(ROOT, f));
    expect(importers, 'files importing the brand generator').toEqual([]);
    // And the generator itself refuses to write from any other npm script.
    // In-process, not through a subprocess: the first version asserted on a
    // spawned child's stderr and the ubuntu floor leg saw it empty (CI run
    // 34679256019) - subprocess stream capture varies by platform and runner,
    // the refusal does not.
    const gen = code(read(path.join(ROOT, 'tools', 'generate-aeon-brand-icons.mjs')));
    expect(gen).toMatch(/npm_lifecycle_event/);
    const before = { ev: process.env.npm_lifecycle_event, w: process.env.AEON_BRAND_WRITE };
    process.env.npm_lifecycle_event = 'build';
    delete process.env.AEON_BRAND_WRITE;
    try {
      await expect(generate({ write: true })).rejects.toThrow(/refusing to write icons from "build"/);
    } finally {
      if (before.ev === undefined) delete process.env.npm_lifecycle_event; else process.env.npm_lifecycle_event = before.ev;
      if (before.w === undefined) delete process.env.AEON_BRAND_WRITE; else process.env.AEON_BRAND_WRITE = before.w;
    }
    expect(path.relative(ROOT, STAMP_FILE).startsWith('tools' + path.sep)).toBe(true);
    expect(fs.readdirSync(MARK).filter(f => f.endsWith('.json')), 'no stamp or json under public/brand/aeon-mark').toEqual([]);
  }, 30000);

  it('the block-icon generator refuses to run without its source artwork instead of overwriting 22 icons with the fallback', () => {
    const gen = code(read(path.join(ROOT, 'tools', 'generate-block-icons.mjs')));
    expect(gen).toMatch(/no source artwork at/);
    expect(gen).toMatch(/if \(FALLBACK_BLOCKS\.includes\(id\)\) continue;/);
    if (!fs.existsSync(path.join(ROOT, 'assets', 'block-icons-src'))) {
      const r = spawnSync(process.execPath, ['tools/generate-block-icons.mjs'], { cwd: ROOT, encoding: 'utf8' });
      expect(r.status, 'must exit non-zero with no source artwork').not.toBe(0);
      expect(r.stderr).toMatch(/no source artwork/);
    }
  }, 30000);

  it('sizes: every PNG of 48px or less is the compact cut (they are tab-icon frames); no 24; maskable covers 180, 192, 512', () => {
    expect(SIZES).toEqual([16, 32, 48, 64, 128, 192, 256, 512, 1024]);
    expect(COMPACT_AT_OR_BELOW).toBe(48);
    expect(MASKABLE_SIZES).toEqual([180, 192, 512]);
    for (const size of SIZES) expect(fs.existsSync(path.join(MARK, `aeon-icon-${size}.png`)), `aeon-icon-${size}.png`).toBe(true);
    expect(fs.existsSync(path.join(MARK, 'aeon-icon-24.png')), 'aeon-icon-24.png has no consumer').toBe(false);
  });

  it('favicon.ico frames 16/32/48 are all the compact cut and there is no 256 frame; AEON.ico keeps 256', () => {
    expect(FAVICON_FRAMES).toEqual([16, 32, 48]);
    for (const f of FAVICON_FRAMES) expect(f).toBeLessThanOrEqual(COMPACT_AT_OR_BELOW);
    expect(WINDOWS_ICO_FRAMES).toContain(256);
    expect(bytes(path.join(ROOT, 'public', 'favicon.ico'))).toBeLessThan(16 * 1024);
  });

  it('public/brand/aeon-icon.svg (a legacy URL) is kept equal to the full mark; the maskable SVG is derived, not hand-edited', () => {
    expect(read(path.join(BRAND, 'aeon-icon.svg'))).toBe(full);
    expect(read(path.join(MARK, 'aeon-mark-maskable.svg'))).toBe(deriveMaskable(full));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. the glyph is one filled hollow chevron', () => {
  it('both cuts are drawn, not wrapped around a raster', () => {
    for (const f of CUTS) {
      const src = markup(read(path.join(MARK, f)));
      expect(src, `${f} must not embed a raster`).not.toMatch(/<image\b/i);
      expect(src).not.toMatch(/href\s*=\s*["'][^"']*\.(png|jpe?g|webp|gif)/i);
      expect(bytes(path.join(MARK, f))).toBeLessThan(16 * 1024);
    }
  });

  it('one path, six vertices, filled, closed - a crossbar needs more, a triangle fewer', () => {
    for (const f of CUTS) {
      const src = markup(read(path.join(MARK, f)));
      const paths = src.match(/<path\b[^>]*>/g) || [];
      expect(paths.length, `${f}: one path`).toBe(1);
      expect(paths[0]).toMatch(/fill="#ffffff"/);
      expect(paths[0]).toMatch(/stroke="none"/);
      expect(paths[0]).toMatch(/Z"/);
      expect(pathVertices(src).length, `${f}: six vertices`).toBe(6);
    }
  });

  it('the notch is centred, the feet are flat, the sides mirror', () => {
    for (const f of CUTS) {
      const [oL, oApex, oR, iR, iApex, iL] = pathVertices(markup(read(path.join(MARK, f))));
      expect(oApex[0]).toBe(256); expect(iApex[0]).toBe(256);
      expect(iApex[1]).toBeGreaterThan(oApex[1]);
      expect(iApex[1]).toBeLessThan(oL[1]);
      expect(iL[1]).toBe(oL[1]); expect(iR[1]).toBe(oR[1]);
      expect(256 - oL[0]).toBe(oR[0] - 256); expect(256 - iL[0]).toBe(iR[0] - 256);
    }
  });

  // The poster's two edges of each leg are parallel (fit: 0.537 and 0.540).
  // The second cut had them 1 degree apart and the band tapering to the apex;
  // the inner apex must sit exactly where the inward-shifted edges meet.
  it('the band is constant: inner edge parallel to outer, poster slope 0.537', () => {
    for (const f of CUTS) {
      const [oL, oApex, , , iApex, iL] = pathVertices(markup(read(path.join(MARK, f))));
      const outer = (oApex[0] - oL[0]) / (oL[1] - oApex[1]);
      const inner = (iApex[0] - iL[0]) / (iL[1] - iApex[1]);
      expect(Math.abs(outer - 0.537), `${f}: outer slope ${outer.toFixed(3)}`).toBeLessThan(0.01);
      expect(Math.abs(inner - outer), `${f}: inner slope ${inner.toFixed(3)} vs outer ${outer.toFixed(3)}`).toBeLessThan(0.006);
      const band = Math.abs(iL[0] - oL[0]);
      expect(Math.abs((iApex[1] - oApex[1]) - band / outer), `${f}: notch depth = band / slope`).toBeLessThan(1.5);
    }
  });

  it('the compact chevron is the full mark\'s outer chevron scaled 186/118 about the centre', () => {
    const fullV = pathVertices(markup(read(path.join(MARK, 'aeon-mark.svg'))));
    const compactV = pathVertices(markup(read(path.join(MARK, 'aeon-mark-compact.svg'))));
    const k = 186 / 118;
    for (const i of [0, 1, 2]) {   // outer left foot, apex, outer right foot
      const [fx, fy] = fullV[i], [cx, cy] = compactV[i];
      expect(Math.abs(256 + (fx - 256) * k - cx), `vertex ${i} x`).toBeLessThan(0.6);
      expect(Math.abs(256 + (fy - 256) * k - cy), `vertex ${i} y`).toBeLessThan(0.6);
    }
  });

  it('the compact ring is a 16px budget: a device pixel clear of the feet, >= 0.8px thick, inside the tile', () => {
    const compact = markup(read(path.join(MARK, 'aeon-mark-compact.svg')));
    expect(compact).not.toMatch(/stroke-dasharray/);
    expect(compact.match(/<circle\b/g).length).toBe(1);
    const [, r, stroke] = compact.match(/<circle\b[^>]*\br="(\d+)"[^>]*stroke-width="(\d+)"/).map(Number);
    const [, , oR] = pathVertices(compact);
    const feet = Math.hypot(oR[0] - 256, oR[1] - 256);   // the chevron's farthest point from the centre
    expect(r - stroke / 2 - feet).toBeGreaterThanOrEqual(32);
    expect(stroke * 16 / 512).toBeGreaterThanOrEqual(0.8);
    expect(r + stroke / 2).toBeLessThanOrEqual(256 - 24);
    const full = markup(read(path.join(MARK, 'aeon-mark.svg')));
    expect(full).toMatch(/stroke-dasharray/);
    expect(full.match(/<circle\b/g).length).toBeGreaterThanOrEqual(5);
  });

  it('exactly the six fallback blocks carry the chevron fallback, no section icon does, and it is not the crossbar A', () => {
    expect(code(read(path.join(ROOT, 'tools', 'generate-block-icons.mjs')))).not.toMatch(/M7 13h10/);
    expect(AEON_FALLBACK).not.toMatch(/M7 13h10/);
    const dir = path.join(BRAND, 'block-icons');
    const svgs = fs.readdirSync(dir).filter(f => f.endsWith('.svg'));
    const carrying = svgs.filter(f => read(path.join(dir, f)) === AEON_FALLBACK).map(f => f.replace(/\.svg$/, '')).sort();
    expect(carrying, 'blocks carrying the fallback').toEqual([...FALLBACK_BLOCKS].sort());
    const withCrossbar = svgs.filter(f => /M7 13h10/.test(read(path.join(dir, f))));
    expect(withCrossbar, 'block icons still carrying the crossbar A').toEqual([]);
    const sections = fs.readdirSync(path.join(dir, 'sections')).filter(f => f.endsWith('.svg'));
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(read(path.join(dir, 'sections', s)), `sections/${s} must be real artwork, not the fallback`).not.toBe(AEON_FALLBACK);
  });

  it('nothing in the pipeline calls the glyph an A', () => {
    const gen = read(path.join(ROOT, 'tools', 'generate-aeon-brand-icons.mjs'));
    expect(gen).not.toMatch(/\bthe same A\b|- A,/);
    expect(gen).toMatch(/hollow chevron/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. the surfaces load the cut made for their size', () => {
  const html = read(path.join(ROOT, 'index.html'));
  const sources = walk(path.join(ROOT, 'src')).filter(f => /\.(jsx|js|cjs|mjs|css|html)$/.test(f));
  const FULL_NEEDS_DEVICE_PX = 48;

  // Every in-app <img> of the mark is the VECTOR cut for its CSS size, so 1x,
  // 1.25x, 2x and 3x screens each rasterise the right cut at their own size.
  // A PNG plus a 2x srcSet handed 2x screens the full mark at 32 device px.
  it('every <img> of the mark: <= 24 CSS px loads the compact SVG, larger loads the full SVG, never a raster; a full mark that can land under 48 device px at 1x is a <picture> with a compact source', () => {
    const found = [];
    for (const f of sources) {
      const text = read(f);
      // src as a string literal OR as a {"..."} expression; any /brand/ or /logo.png target.
      for (const m of text.matchAll(/<img\b[^>]*?\bsrc=\{?["'`](\/(?:brand\/[^"'`]+|logo\.png))["'`]\}?[^>]*>/g)) {
        const before = text.slice(Math.max(0, m.index - 600), m.index);
        const pictureOpen = before.lastIndexOf('<picture');
        const pictureClose = before.lastIndexOf('</picture');
        const inPicture = pictureOpen > pictureClose;
        found.push({ file: path.relative(ROOT, f), tag: m[0], src: m[1], picture: inPicture ? before.slice(pictureOpen) : null });
      }
    }
    expect(found.length, 'expected the sidebar, top nav, mobile header, boot gate and recovery modal').toBeGreaterThanOrEqual(5);
    for (const { file, tag, src, picture } of found) {
      const width = Number(tag.match(/width="(\d+)"/)?.[1]);
      expect(width, `${file}: img needs an explicit width`).toBeGreaterThan(0);
      expect(src, `${file}: PNGs are for favicons and manifests; <img> loads the vector`).toMatch(/\.svg$/);
      expect(tag, `${file}: no srcSet on the img - the SVG scales itself`).not.toMatch(/srcSet=/i);
      const want = width <= 24 ? '/brand/aeon-mark/aeon-mark-compact.svg' : '/brand/aeon-mark/aeon-mark.svg';
      expect(src, `${file}: ${width}px img`).toBe(want);
      if (want.endsWith('aeon-mark.svg') && width < FULL_NEEDS_DEVICE_PX) {
        // At 1x this img is under the device pixels the full mark needs, so a
        // <picture> must hand low-DPR screens the compact cut. The source's
        // 1.5dppx cut-off leaves DPRs in (1.5, 48/width) - for 28px, up to
        // 1.71, e.g. a 2x screen at 80% zoom - on the full mark at 42-47
        // device px; measured with section 4's probes, it still reads there.
        expect(picture, `${file}: ${width}px full-mark img must be inside a <picture>`).toBeTruthy();
        expect(picture).toMatch(/<source\b[^>]*media="\(max-resolution:\s*1\.5dppx\)"[^>]*srcSet="\/brand\/aeon-mark\/aeon-mark-compact\.svg"/);
        expect(width * 2, `${file}: at 2x the full mark must reach ${FULL_NEEDS_DEVICE_PX} device px`).toBeGreaterThanOrEqual(FULL_NEEDS_DEVICE_PX);
      }
    }
    // No raster of the mark referenced from the app at all, under any path, and
    // no <img> of any raster that looks like an icon of ours.
    const rasterRefs = sources.filter(f => /\/(?:brand\/aeon-icon-[\w-]+\.png|brand\/aeon-mark\/aeon-icon-[\w-]+\.png|logo\.png)/.test(code(read(f)))).map(f => path.relative(ROOT, f));
    expect(rasterRefs, 'files referencing a PNG of the mark').toEqual([]);
    const rasterImgs = sources.flatMap(f => [...read(f).matchAll(/<img\b[^>]*?\bsrc=\{?["'`]([^"'`]*\/(?:brand|logo)[^"'`]*\.(?:png|jpe?g|webp|gif))["'`]/gi)].map(m => `${path.relative(ROOT, f)}: ${m[1]}`));
    expect(rasterImgs, '<img> tags loading a raster from brand paths').toEqual([]);
  });

  it('the tab icon is right in all three engines: ico first with sizes, the SVG favicon is the compact cut, no loose PNG links', () => {
    const iconLinks = [...html.matchAll(/<link\b[^>]*\brel=["']([^"']*)["'][^>]*>/g)].filter(m => /\bicon\b/.test(m[1]));
    const tab = iconLinks.filter(m => m[1] === 'icon').map(m => m[0]);
    expect(tab.length).toBe(2);
    expect(tab[0]).toMatch(/href=["']\/favicon\.ico["']/);
    expect(tab[0]).toMatch(/sizes=["']16x16 32x32 48x48["']/);
    expect(tab[1]).toMatch(/type=["']image\/svg\+xml["']/);
    expect(tab[1], 'Firefox takes an SVG favicon regardless of order, so it must be the compact cut').toMatch(/href=["']\/brand\/aeon-mark\/aeon-mark-compact\.svg["']/);
    for (const m of iconLinks) {
      if (m[1] === 'apple-touch-icon') continue;
      expect(m[1], `unexpected icon link: ${m[0]}`).toBe('icon');
      expect(m[0], `an icon link must not point at a raster: ${m[0]}`).not.toMatch(/\.(png|jpe?g|webp|gif)["']/i);
    }
  });

  it('apple-touch-icon and both manifests: maskable slots get the full-bleed cut, every "any" size has an own-size render, the compact 16/32/48 are listed, and the manifests agree', () => {
    expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="\/brand\/aeon-mark\/aeon-icon-maskable-180\.png"/);
    const pub = JSON.parse(read(path.join(ROOT, 'public/manifest.json'))).icons;
    const vite = read(path.join(ROOT, 'vite.config.js'));
    const block = vite.match(/icons:\s*\[([\s\S]*?)\]/)[1];
    const viteIcons = [...block.matchAll(/\{\s*src:\s*'([^']+)',\s*sizes:\s*'([^']+)',\s*type:\s*'([^']+)',\s*purpose:\s*'([^']+)'\s*\}/g)]
      .map(m => ({ src: m[1], sizes: m[2], type: m[3], purpose: m[4] }));
    expect(viteIcons, 'the VitePWA manifest must list exactly what public/manifest.json lists').toEqual(pub);
    for (const i of pub) {
      const size = Number(i.sizes.split('x')[0]);
      if (i.purpose === 'maskable') { expect(i.src).toBe(`/brand/aeon-mark/aeon-icon-maskable-${size}.png`); continue; }
      expect(i.purpose, `${i.src} must not be declared maskable`).toBe('any');
      // Own-size render: the browser never resamples one of ours.
      expect(i.src, `${i.sizes} "any" icon must be the own-size render`).toBe(`/brand/aeon-mark/aeon-icon-${size}.png`);
      expect(SIZES, `${i.sizes} is generated`).toContain(size);
    }
    expect(pub.filter(i => i.purpose === 'maskable').length).toBeGreaterThanOrEqual(2);
    // The installed-PWA surfaces (taskbar, title bar) come from the manifest's
    // "any" icons and never from favicon.ico; without these, Chrome downscales
    // the 192px full mark to 16-48px - the original smudge on one surface.
    for (const size of [...FAVICON_FRAMES, 64, 128, 256]) {
      expect(pub.find(i => i.purpose === 'any' && i.sizes === `${size}x${size}`), `manifest must list a ${size}x${size} "any" icon`).toBeTruthy();
    }
    // And they are precached.
    const include = vite.match(/includeAssets:\s*\[([\s\S]*?)\]/)[1];
    for (const i of pub) expect(include, `${i.src} precached`).toContain(i.src.replace(/^\//, ''));
    expect(include).toContain('brand/aeon-mark/aeon-mark-compact.svg');
    expect(include).toContain('brand/aeon-mark/aeon-icon-maskable-180.png');
  });

  it('the maskable cuts are full-bleed and keep every bright pixel inside the safe circle', async () => {
    for (const size of MASKABLE_SIZES) {
      const { w, h, lum, alpha } = await rasterPng(path.join(MARK, `aeon-icon-maskable-${size}.png`));
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [8, 8]]) {
        expect(alpha(x, y), `${size}: (${x},${y}) alpha`).toBe(255);
      }
      const safe = 0.4 * w, cx = w / 2, cy = h / 2;
      let outside = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum(x, y) > 140 && Math.hypot(x - cx, y - cy) > safe) outside++;
      expect(outside, `${size}: bright pixels outside the 40% safe circle`).toBe(0);
    }
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. legibility, measured the way a browser rasterises', () => {
  const compact = read(path.join(MARK, 'aeon-mark-compact.svg'));
  const full = read(path.join(MARK, 'aeon-mark.svg'));
  const BRIGHT = 140, DARK = 60;

  /**
   * The ring. Light from a ~1px stroke lands in one pixel or is split across
   * two, so the probe sums adjacent pixels: the brightest adjacent pair in a
   * band of columns, over the middle band of rows, must carry >= 150.
   * Measured: the compact ring gives 167 at 16, 213 at 20, 254 at 24. For the
   * full mark the outer 30% band holds the segmented outer ring and a node
   * circle; its inner ring sits at r 118/256 and is probed in its own band.
   * Point-sampled renders gave 173 from a single pixel and zero from its
   * neighbour - both would pass this; a missing ring would not.
   */
  const ringLight = ({ w, h, lum }, from = 0, to = 0.3) => {
    let left = 0, right = 0;
    for (let y = Math.floor(h * 0.4); y <= Math.ceil(h * 0.6) && y < h; y++) {
      for (let x = Math.floor(w * from); x + 1 < w * to; x++) left = Math.max(left, lum(x, y) + lum(x + 1, y));
      for (let x = Math.ceil(w * (1 - to)); x + 1 < w * (1 - from) && x + 1 < w; x++) right = Math.max(right, lum(x, y) + lum(x + 1, y));
    }
    return Math.min(left, right);
  };
  const innerRingLight = (r) => ringLight(r, 0.22, 0.32);
  /**
   * The notch. Sample at 58% of the height, not the centre: the hollow is a V,
   * so its widest usable row is low, and near the inner apex the glow fills it.
   * 58% is also exactly where the rejected A's crossbar sat (y 292 of 512), so
   * a crossbar coming back fails here. The pixel must be dark, and walking up
   * from it the first bright pixel is the cap.
   */
  const hasNotch = ({ w, h, lum }) => {
    const x = Math.floor(w / 2), y0 = Math.floor(h * 0.58);
    if (lum(x, y0) >= DARK) return false;
    let y = y0;
    while (y >= 0 && lum(x, y) < BRIGHT) y--;
    return y >= 0;
  };
  /**
   * Daylight between foot and ring, on EVERY row that carries a chevron pixel
   * in the lower band, on both sides: walking outward from the chevron, a
   * pixel under 30 must come before any pixel >= 60 (the ring). A ring that
   * touches or overlaps the feet has no such valley. Monotonic in the ring
   * radius (probed: r >= 190 clear at every size; 186 fused at 16; 170 fused
   * everywhere), which the first version of this probe was not.
   */
  const feetClearRing = ({ w, h, lum }) => {
    let rows = 0;
    for (let y = Math.floor(h * 0.6); y < h * 0.8; y++) {
      const row = [...Array(w)].map((_, x) => lum(x, y));
      const glyph = row.map((v, x) => (v >= 200 ? x : -1)).filter(x => x >= 0 && x > w * 0.15 && x < w * 0.85);
      if (!glyph.length) continue;
      rows++;
      const side = (from, dir) => {
        let x = from + dir;
        while (x >= 0 && x < w && row[x] >= 30) x += dir;   // through the glyph's antialiased edge
        if (x < 0 || x >= w) return false;                   // ran off the tile: no valley
        for (let q = x + dir; q >= 0 && q < w; q += dir) if (row[q] >= 60) return true;  // then a ring
        return false;
      };
      if (!(side(glyph[0], -1) && side(glyph[glyph.length - 1], +1))) return false;
    }
    return rows > 0;
  };
  /** A coverage rasteriser leaves intermediate levels; a point sampler leaves almost none. */
  const antialiased = ({ w, h, lum }) => {
    let mid = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const l = lum(x, y); if (l > 40 && l < 130) mid++; }
    return mid;
  };

  it('the rasters under test are antialiased (a point-sampled 16px render has no intermediate levels)', async () => {
    expect(antialiased(await rasterSvg(compact, 16))).toBeGreaterThan(20);
  });

  it('the compact cut at every device size the 16, 22 and (at 1x/1.5x) 28 CSS px imgs produce: ring, notch, daylight', async () => {
    for (const size of [16, 20, 22, 24, 28, 32, 33, 42, 44, 48, 66]) {
      const r = await rasterSvg(compact, size);
      expect(ringLight(r), `compact @${size}: ring light`).toBeGreaterThanOrEqual(150);
      expect(hasNotch(r), `compact @${size}: notch`).toBe(true);
      expect(feetClearRing(r), `compact @${size}: feet clear of the ring`).toBe(true);
    }
  }, 30000);

  it('negative control: with the ring at r 170 the feet probe fails, so it is not vacuous', async () => {
    const fused = compact.replace(/<circle\b([^>]*)\br="\d+"/, '<circle$1 r="170"');
    expect(fused).not.toBe(compact);
    for (const size of [16, 20, 24]) expect(feetClearRing(await rasterSvg(fused, size)), `r 170 @${size} must read as fused`).toBe(false);
  });

  it('negative controls: a filled triangle and a crossbar A both fail the notch probe', async () => {
    const triangle = compact.replace(/<path\b[^>]*\bd="[^"]+"/, '<path d="M141 369 L256 155 L371 369 Z"');
    const crossbar = compact.replace('</svg>', '<path d="M176 297 L336 297 L336 317 L176 317 Z" fill="#ffffff"/></svg>');
    for (const size of [16, 32]) {
      expect(hasNotch(await rasterSvg(triangle, size)), `triangle @${size}`).toBe(false);
      expect(hasNotch(await rasterSvg(crossbar, size)), `crossbar @${size}`).toBe(false);
    }
  });

  it('the full mark at every device size a surface can rasterise it (48 and up): outer ring, inner ring, notch', async () => {
    for (const size of [48, 56, 72, 84, 96, 144]) {
      const r = await rasterSvg(full, size);
      expect(ringLight(r), `full @${size}: outer ring light`).toBeGreaterThanOrEqual(150);
      expect(innerRingLight(r), `full @${size}: inner ring light`).toBeGreaterThanOrEqual(150);
      expect(hasNotch(r), `full @${size}: notch`).toBe(true);
    }
  }, 30000);

  it('the shipped favicon frames (16, 32, 48 PNGs) read the same way, from their own bytes', async () => {
    for (const size of FAVICON_FRAMES) {
      const r = await rasterPng(path.join(MARK, `aeon-icon-${size}.png`));
      expect(ringLight(r), `aeon-icon-${size}.png: ring light`).toBeGreaterThanOrEqual(150);
      expect(hasNotch(r), `aeon-icon-${size}.png: notch`).toBe(true);
      expect(feetClearRing(r), `aeon-icon-${size}.png: feet clear`).toBe(true);
      expect(antialiased(r), `aeon-icon-${size}.png: antialiased`).toBeGreaterThan(20);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5. provenance: the SVGs in, nothing from the poster', () => {
  const gen = code(read(path.join(ROOT, 'tools', 'generate-aeon-brand-icons.mjs')));
  const blockGen = code(read(path.join(ROOT, 'tools', 'generate-block-icons.mjs')));

  it('the generator rasterises sized SVG text and nothing else; the sentinels are fixed drawings, not the sources', () => {
    // One import plus one call, inside renderPng, on the sized SVG: an alias
    // like `const li = loadImage` or a second call site shows up here.
    expect((gen.match(/\bloadImage\b/g) || []).length).toBe(2);
    expect(gen).toMatch(/loadImage\(Buffer\.from\(sizedSvg\(svgText, size\)\)\)/);
    expect(gen).toMatch(/import \{ createCanvas, loadImage \} from '@napi-rs\/canvas'/);
    expect(gen).toMatch(/fullSvg = fs\.readFileSync\(FULL_SVG\)/);
    expect(gen).toMatch(/compactSvg = fs\.readFileSync\(COMPACT_SVG\)/);
    expect(gen).toMatch(/maskableSvg = Buffer\.from\(deriveMaskable\(fullSvg/);
    expect(gen).not.toMatch(/readFileSync\([^)]*\.(png|jpe?g|webp|gif)/i);
    expect(gen).not.toMatch(/aeon-primary-logo/);
    // probeHashes takes no arguments: it renders SENTINELS, never the sources.
    expect(gen).toMatch(/export async function probeHashes\(\)/);
    expect(gen).not.toMatch(/probeHashes\([^)]*(full|compact)/);
    // Every rasteriser path the outputs use must have a sentinel: an AA stroke
    // over a gradient, a hairline at 16, a blur, and a blur inside a scaled
    // group at a non-power-of-two size (the maskable-180 path, added after
    // win32 was classed exact and then differed on that file alone).
    expect(Object.keys(SENTINELS)).toEqual(['stroke64', 'hairline16', 'blur128', 'scaledBlur180']);
    expect(SENTINELS.scaledBlur180.size).toBe(180);
    expect(MASKABLE_SIZES).toContain(SENTINELS.scaledBlur180.size);
    for (const { svg } of Object.values(SENTINELS)) expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512">/);
  });

  it('neither generator scales a raster through drawImage - the size goes into the SVG', () => {
    for (const [name, src] of [['brand', gen], ['block-icons', blockGen]]) {
      expect(src, `${name}: no drawImage(image, 0, 0, w, h)`).not.toMatch(/drawImage\([^)]*,\s*0,\s*0,\s*[^)]+,\s*[^)]+\)/);
      expect(src, `${name}: draws 1:1`).toMatch(/drawImage\(image, 0, 0\)/);
      expect(src, `${name}: smoothing off at 1:1`).toMatch(/imageSmoothingEnabled = false/);
    }
  });

  it('it fails loudly on a missing source instead of shipping blank squares', () => {
    expect(gen).toMatch(/missing source/);
    expect(gen).toMatch(/process\.exit\(1\)/);
  });

  // A sweep, not a list of files someone remembered: every text file the app
  // is built from, plus the served HTML and manifests. Paths are captured
  // whether quoted, inside a srcSet list, or relative (vite's includeAssets),
  // from comment-stripped text, so prose cannot trip it.
  it('no served file points at the poster, and every icon path it names exists', () => {
    const roots = ['index.html', 'vite.config.js', 'public/manifest.json', 'src', 'server'];
    const files = roots.flatMap(r => walk(path.join(ROOT, r))).filter(p => /\.(jsx?|cjs|mjs|css|html|json)$/.test(p));
    expect(files.length).toBeGreaterThan(50);

    const poster = [], missing = [];
    for (const f of files) {
      const src = code(markup(read(f)));
      if (/aeon-primary-logo/.test(src)) poster.push(path.relative(ROOT, f));
      for (const m of src.matchAll(/(?:["'`]|\s|,)(\/?(?:brand\/|logo\.png|favicon\.ico)[^"'`\s)?#,]*)/g)) {
        const p = m[1].replace(/\.$/, '');
        if (p.includes('${')) continue;
        if (!fs.existsSync(path.join(ROOT, 'public', p))) missing.push(`${path.relative(ROOT, f)} -> ${p}`);
      }
    }
    expect(poster, 'files using the poster as an icon').toEqual([]);
    expect(missing, `broken icon references:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
