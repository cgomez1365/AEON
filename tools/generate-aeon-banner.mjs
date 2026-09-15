#!/usr/bin/env node
/**
 * AEON README banner.
 *
 *   npm run brand:banner           public/brand/aeon-banner.png   still, 3840x1056
 *   npm run brand:banner:animate   public/brand/aeon-banner.webp  animated, 1200x330
 *
 * The mark IS the A. In the 512 mark the chevron is 136 tall (y 192..328), so
 * the mark is scaled until that chevron matches the cap height of "EON" set in
 * Avenir Next Ultra Light, and the rings fall behind the word. Pale ground,
 * ink lettering, and to the right a field of neon-blue and deep-blue
 * particles streaming in from the edge - a door opened onto the digital
 * world. Deterministic (seeded), so both commands reproduce their file exactly
 * on the same font.
 *
 * Lettering (CEO, 2026-09-14). EON is Ultra Light thickened by a stroke in its
 * own colour, so the word holds its own beside the filled chevron. Where a ring
 * passes behind a letter it stops short in a square-cornered gap cut from the
 * mark's own layer - no halo painted over the ground.
 *
 * Motion (CEO, 2026-09-14), animation only - the still is its first frame:
 *   - the segmented outer ring turns clockwise, 90 degrees per loop (its four
 *     arcs repeat every 90 degrees, so a quarter turn loops seamlessly);
 *   - the three satellites orbit counter-clockwise on their own, one turn per loop;
 *   - the particles drift in from the door, three crossings per loop;
 *   - the inner ring, the chevron and the lettering never move.
 * 228 frames at 18 fps: a 12.67 s loop. Ring and satellites are moved inside the
 * SVG and every frame rasterised from the vector, never a rotated bitmap.
 *
 * The README shows the animation, and the still to readers who ask for reduced
 * motion. Text uses the system's Avenir Next when present (macOS); elsewhere
 * the canvas default sans is used and the output differs, which is why both
 * files are committed rather than generated at build.
 *
 * The animated WebP is encoded by sharp, which is not a dependency - this is the
 * only thing that would use it. Install it for the run:
 *   npm install --no-save sharp && npm run brand:banner:animate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = path.join(ROOT, 'public', 'brand', 'aeon-mark', 'aeon-mark.svg');
const ANIMATE = process.argv.includes('--animate');
const OUT = process.env.AEON_BANNER_OUT || path.join(ROOT, 'public', 'brand', ANIMATE ? 'aeon-banner.webp' : 'aeon-banner.png');

// Fonts. @napi-rs/canvas registers only the FIRST face of a .ttc, and for
// Avenir Next that is Bold - the opposite of the poster's hairline lettering.
// So the collection is split here: a TTC is a 'ttcf' header with offsets to N
// ordinary sfnt table directories; one face is extracted by copying its
// directory and tables into a standalone buffer. Nothing is written to the
// repo - the extracted face lives in the OS temp dir for this run only.
import os from 'node:os';
function extractFace(ttcPath, wantSubfamily) {
  const buf = fs.readFileSync(ttcPath);
  if (buf.toString('ascii', 0, 4) !== 'ttcf') return null;
  const n = buf.readUInt32BE(8);
  for (let i = 0; i < n; i++) {
    const off = buf.readUInt32BE(12 + i * 4);
    const numTables = buf.readUInt16BE(off + 4);
    const tables = [];
    for (let t = 0; t < numTables; t++) {
      const rec = off + 12 + t * 16;
      tables.push({ tag: buf.toString('ascii', rec, rec + 4), checksum: buf.readUInt32BE(rec + 4), offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
    }
    const name = tables.find((t) => t.tag === 'name');
    if (!name) continue;
    const count = buf.readUInt16BE(name.offset + 2), strOff = name.offset + buf.readUInt16BE(name.offset + 4);
    // nameID 2 is the legacy style (only Regular/Bold/Italic); the weight name
    // lives in nameID 17 (typographic subfamily) or nameID 4 (full name).
    const read = (p, so, len) => (p === 1 ? buf.toString('latin1', strOff + so, strOff + so + len) : Buffer.from(buf.subarray(strOff + so, strOff + so + len)).swap16().toString('utf16le'));
    let subfamily = '', full = '';
    for (let r = 0; r < count; r++) {
      const rec = name.offset + 6 + r * 12;
      const platform = buf.readUInt16BE(rec), nameId = buf.readUInt16BE(rec + 6), len = buf.readUInt16BE(rec + 8), so = buf.readUInt16BE(rec + 10);
      if (nameId === 17 && !subfamily) subfamily = read(platform, so, len);
      if (nameId === 4 && !full) full = read(platform, so, len);
    }
    subfamily = subfamily || full;
    if (!wantSubfamily.test(subfamily)) continue;
    // Rebuild: header + directory, then tables 4-byte aligned.
    const dirLen = 12 + numTables * 16;
    let total = dirLen; for (const t of tables) total += (t.length + 3) & ~3;
    const out = Buffer.alloc(total);
    buf.copy(out, 0, off, off + 12);
    let cursor = dirLen;
    tables.forEach((t, idx) => {
      const rec = 12 + idx * 16;
      out.write(t.tag, rec, 'ascii'); out.writeUInt32BE(t.checksum, rec + 4); out.writeUInt32BE(cursor, rec + 8); out.writeUInt32BE(t.length, rec + 12);
      buf.copy(out, cursor, t.offset, t.offset + t.length); cursor += (t.length + 3) & ~3;
    });
    return { subfamily, buffer: out };
  }
  return null;
}

let FAMILY = 'sans-serif', FACE = 'none', FAMILY_MED = 'sans-serif';
for (const f of ['/System/Library/Fonts/Avenir Next.ttc', '/Library/Fonts/Avenir Next.ttc']) {
  if (!fs.existsSync(f)) continue;
  const face = extractFace(f, /Ultra ?Light$/i) || extractFace(f, /(^|\s)Light$/i);
  if (!face) continue;
  const tmp = path.join(os.tmpdir(), `aeon-banner-face-${process.pid}.ttf`);
  fs.writeFileSync(tmp, face.buffer);
  try { GlobalFonts.registerFromPath(tmp, 'AeonBannerFace'); FAMILY = 'AeonBannerFace'; FACE = face.subfamily; } catch {}
  // The tagline in Ultra Light at 28px is a hairline - nearly invisible on the
  // dark ground (CEO, 2026-09-14). It gets the Medium face instead.
  const med = extractFace(f, /^Medium$/i) || extractFace(f, /^Regular$/i);
  if (med) { const t2 = path.join(os.tmpdir(), `aeon-banner-face-med-${process.pid}.ttf`); fs.writeFileSync(t2, med.buffer); try { GlobalFonts.registerFromPath(t2, 'AeonBannerFaceMed'); FAMILY_MED = 'AeonBannerFaceMed'; } catch {} }
  break;
}

// The mark without its rounded ground: keep <defs> (gradient + glow filter) and
// the glow group, drop the <rect>. Everything else is the SVG's own geometry.
const markSvg = fs.readFileSync(MARK, 'utf8').replace(/<rect[^>]*aeonGround[^>]*\/>/, '');

const W = 1600, H = Number(process.env.AEON_BANNER_H) || 440;
const TITLE = Number(process.env.AEON_BANNER_TITLE) || 165;
// Every number below is in 1600x440 layout units and the context is scaled:
// 2.4x for the still (3840x1056, crisp at README width on 2x displays), 0.75x
// for the animation (1200x330 - every frame is stored, so size is the budget).
const SCALE = ANIMATE ? 0.75 : 2.4;
const TAGLINE = 'MODULAR. LOCAL. YOURS.';
const DESC = 'A local-first AI workspace';

// One loop: particles cross CYCLES times, the ring turns SPIN degrees, the
// satellites travel ORBIT degrees (negative = counter-clockwise).
const FRAMES = 228, FPS = 18, CYCLES = 3, SPIN = 90, ORBIT = -360;

// In the 512 mark: chevron outer apex y=192, feet y=328; feet x 183..329.
const CHEV_H = 136 / 512, CHEV_W = 146 / 512, CHEV_CY = (192 + 328) / 2 / 512;
const CAP = 0.72; // Avenir Next Ultra Light cap height, em
// Satellites in the mark: centre (256,256), radius 218, at these angles.
const SAT_ANGLES = [315, 45, 180];
// Letter stroke, and how far a ring stops short of a letter - layout units.
const WEIGHT = 2.2, RING_GAP = 2.5;

// Seeded RNG so every output is byte-stable across runs.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const trackedWidth = (ctx, text, size, spacing, family = FAMILY) => {
  ctx.font = `400 ${size}px ${family}`; let w = 0; for (const ch of text) w += ctx.measureText(ch).width + spacing; return w - spacing;
};
const tracked = (ctx, text, x, y, size, spacing, color, family = FAMILY) => {
  ctx.font = `400 ${size}px ${family}`; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic';
  let cx = x; for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
};

// The wordmark: mark as the A, chevron at cap height, "EON" beside it. `spin`
// turns the segmented ring, `orbit` moves the satellites round theirs.
async function wordmark(ctx, { x, y, size, spacing, color, onLight, ringAlpha, align = 'left', spin = 0, orbit = 0 }) {
  ctx.font = `400 ${size}px ${FAMILY}`;
  const cap = size * CAP, markSize = cap / CHEV_H, chevW = markSize * CHEV_W;
  const letters = [...'EON'], lw = letters.map((ch) => ctx.measureText(ch).width);
  if (align === 'right') x -= chevW + spacing + lw.reduce((a, b) => a + b + spacing, 0) - spacing;
  const chevCx = x + chevW / 2, chevCy = y - cap / 2;
  const markCy = chevCy + (0.5 - CHEV_CY) * markSize;
  const px = Math.round(markSize * SCALE);
  let svg = markSvg.replace(/width="512" height="512"/, `width="${px}" height="${px}"`);
  if (onLight) {
    // Ink, not glow: the bloom filter has nothing dark to bloom against.
    svg = svg.replace(/#bcd8ff|#eaf3ff/g, '#2f6fd6').replace(/#7fb2ff/g, '#5b8fe0').replace(/fill="#ffffff"/, 'fill="#0b1a3a"').replace(/filter="url\(#aeonGlow\)"/, '');
  }
  // The glow filter blurs the chevron's own edge along with its halo. Draw the
  // chevron once more, unfiltered, on top - the bloom stays, the edge is crisp.
  const chev = svg.match(/<path d="[^"]+" fill="[^"]+" stroke="none"\/>/)[0];
  svg = svg.replace('</svg>', `<g>${chev}</g></svg>`);

  // Two layers: the outer ring and satellites, which move, and the inner ring
  // and chevron, which don't. Position is set in the SVG before rasterising.
  let satK = 0;
  const outerSvg = svg
    .replace(/<circle cx="256" cy="256" r="118"[^>]*\/>/, '').replace(/<path d="M183 328[^>]*\/>/g, '')
    .replace(/transform="rotate\(-36 256 256\)"/, `transform="rotate(${-36 + spin} 256 256)"`)
    // \s+: the mark aligns the left node with spaces, cx="38"     cy="256".
    .replace(/<circle cx="(?:410\.15|38)"\s+cy="(?:101\.85|410\.15|256)"/g, () => {
      const a = (SAT_ANGLES[satK++] + orbit) * Math.PI / 180;
      return `<circle cx="${(256 + 218 * Math.cos(a)).toFixed(3)}" cy="${(256 + 218 * Math.sin(a)).toFixed(3)}"`;
    });
  if (satK !== SAT_ANGLES.length) throw new Error(`expected ${SAT_ANGLES.length} satellites in the mark, positioned ${satK}`);
  const innerSvg = svg.replace(/<circle cx="256" cy="256" r="205"[\s\S]*?\/>/, '').replace(/<circle cx="(?:410\.15|38)"[^>]*\/>/g, '');
  const outerImg = await loadImage(Buffer.from(outerSvg)), innerImg = await loadImage(Buffer.from(innerSvg));

  // The gap is cut from the MARK LAYER only: draw the mark on its own canvas,
  // erase the letter shapes (a little wider than the letters) from it, then
  // composite. It exists only where a ring passes behind a letter.
  let cx = x + chevW + spacing; const xs = [];
  const off = createCanvas(W * SCALE, H * SCALE); const o = off.getContext('2d'); o.scale(SCALE, SCALE);
  o.globalAlpha = ringAlpha;
  o.drawImage(outerImg, chevCx - markSize / 2, markCy - markSize / 2, markSize, markSize);
  o.drawImage(innerImg, chevCx - markSize / 2, markCy - markSize / 2, markSize, markSize);
  o.globalAlpha = 1;
  o.globalCompositeOperation = 'destination-out'; o.textBaseline = 'alphabetic'; o.font = `400 ${size}px ${FAMILY}`;
  // Square notch, matching the E's square terminals.
  o.lineJoin = 'miter'; o.miterLimit = 2; o.lineCap = 'butt'; o.strokeStyle = '#000'; o.fillStyle = '#000'; o.lineWidth = WEIGHT + RING_GAP * 2;
  let kx = cx; letters.forEach((ch, i) => { o.fillText(ch, kx, y); o.strokeText(ch, kx, y); kx += lw[i] + spacing; });
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.restore();

  ctx.save(); ctx.textBaseline = 'alphabetic'; ctx.font = `400 ${size}px ${FAMILY}`; ctx.fillStyle = color;
  letters.forEach((ch, i) => {
    xs.push(cx); ctx.fillText(ch, cx, y); ctx.fillText(ch, cx, y);
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = WEIGHT; ctx.lineJoin = 'round'; ctx.strokeText(ch, cx, y); ctx.restore();
    cx += lw[i] + spacing;
  });
  ctx.restore();
  return { oX: xs[1], ringR: markSize * 205 / 512, cx: chevCx, cy: markCy };
}

// Light through an opened door: a soft vertical slit at the right edge and a
// stream of particles pouring in from it, dense at the door, thinning leftward.
// Two glows per particle (wide faint halo, tight bright core), some drawn as
// short horizontal streaks so the field reads as motion, not static noise.
// `t` counts crossings: each particle moves door -> far end at a whole-number
// speed, so at every whole t all of them are back where they started.
function particles(ctx, { seed, doorX, from, colors, count, additive, centerY, spreadK, expo, farAlpha, sizeK, dim, t = 0 }) {
  const r = rng(seed);
  ctx.save();
  // Additive on dark (light adds up); normal on light (ink would wash to white).
  ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
  for (let i = 0; i < count; i++) {
    // distance from the door: most dust sits near the opening
    const r0 = r(), speed = 1 + Math.floor(r() * 2);
    const pd = (r0 + t * speed) % 1;
    const d = Math.pow(pd, expo);
    const x = doorX + d * (from - doorX) + (r() - 0.5) * 30;
    const toward = Math.sign(doorX - from); // streaks point back at the door
    // Full height at the door, not a point source: mostly uniform top to
    // bottom, with a mild pull toward centerY so the field still has a middle.
    const u = 12 + r() * (H - 24);
    const y = u + (centerY - u) * 0.25 * spreadK;
    const near = 1 - d;
    const size = (0.6 + r() * (1.4 + near * 2.6)) * sizeK;
    // `dim` scales everything down: the dust is filler and must never outdo the
    // mark. Each particle fades in past the door and out before the far end.
    const a = (0.25 + r() * 0.75) * (farAlpha + near * (1 - farAlpha)) * dim * Math.max(0, Math.min(1, pd / 0.08, (1 - pd) / 0.15));
    const col = colors[Math.floor(r() * colors.length)];
    const rgba = (alpha) => col.replace('A', alpha.toFixed(3));
    // soft halo
    const hg = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
    hg.addColorStop(0, rgba(a * 0.3)); hg.addColorStop(1, rgba(0));
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(x, y, size * 3, 0, Math.PI * 2); ctx.fill();
    // core, sometimes a streak
    ctx.fillStyle = rgba(a);
    if (r() < 0.22) { const len = size * (5 + r() * 18) * (0.5 + near); ctx.fillRect(x, y - size * 0.3, len * toward, size * 0.6); }
    else { ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

async function render({ onLight, mirror = false, t = 0, spin = 0, orbit = 0 }) {
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  if (onLight) {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#f7f9fe'); g.addColorStop(1, '#e9eef9');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.strokeStyle = 'rgba(31,79,168,0.08)'; ctx.lineWidth = 1 / SCALE;
    for (let x = 0.5; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0.5; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  } else {
    const gx = mirror ? W - 300 : 300;
    const g = ctx.createRadialGradient(gx, H * 0.45, 40, gx, H * 0.45, 1500);
    g.addColorStop(0, '#0b1428'); g.addColorStop(0.45, '#050a16'); g.addColorStop(1, '#01030a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.strokeStyle = 'rgba(127,178,255,0.06)'; ctx.lineWidth = 1 / SCALE;
    for (let x = 0.5; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0.5; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }

  // The dust, before the word so it passes behind the lettering. No door glow:
  // the particles are filler and must not compete with the mark.
  const DUST = { seed: 20260914, doorX: mirror ? 40 : W - 40, from: mirror ? W - 760 : 760, count: 380, centerY: H * 0.42, spreadK: 1.0, expo: 1.3, farAlpha: 0.4, sizeK: 1.25, dim: 0.495, t };
  if (onLight) particles(ctx, { ...DUST, additive: false, colors: ['rgba(0,140,255,A)', 'rgba(0,190,255,A)', 'rgba(31,79,168,A)', 'rgba(11,42,120,A)'] });
  else particles(ctx, { ...DUST, additive: true, colors: ['rgba(255,255,255,A)', 'rgba(220,235,255,A)', 'rgba(170,205,255,A)', 'rgba(127,178,255,A)'] });

  const ink = onLight ? '#0b1a3a' : '#eaf3ff';
  const blue = onLight ? '#2f6fd6' : '#a9ccff';
  const dim = onLight ? '#1f4fa8' : 'rgba(222,236,255,0.95)';
  const ruleCol = onLight ? 'rgba(31,79,168,0.3)' : 'rgba(127,178,255,0.3)';

  // Chevron centred on the banner's mid-height so the whole mark, rings
  // included, sits inside the frame; the text block hangs off the baseline.
  const base = H / 2 + TITLE * CAP / 2;
  // Left margin is measured from the OUTER RING, not the chevron: the ring
  // reaches (markSize - chevW) / 2 further left than the glyph it surrounds.
  const markSize = TITLE * CAP / CHEV_H, ringOverhang = (markSize - markSize * CHEV_W) / 2;
  const left = 36 + ringOverhang;
  const g = await wordmark(ctx, { x: mirror ? W - 120 : left, align: mirror ? 'right' : 'left', y: base, size: TITLE, spacing: Math.round(TITLE * 0.19), color: ink, onLight, ringAlpha: onLight ? 0.85 : 0.8, spin, orbit });

  // Tagline, rule and description: start under the O, clear of the outer ring.
  // Mirrored, the block is right-aligned to the N's edge instead.
  const tagSp = mirror ? 7 : 10;
  const tagW = trackedWidth(ctx, TAGLINE, 26, tagSp, FAMILY_MED);
  const right = W - 120;
  const tx = mirror ? right - tagW : g.oX;
  tracked(ctx, TAGLINE, tx, base + 60, 26, tagSp, blue, FAMILY_MED);
  ctx.strokeStyle = ruleCol; ctx.lineWidth = 1; ctx.beginPath();
  if (mirror) { ctx.moveTo(tx, base + 92.5); ctx.lineTo(right, base + 92.5); } else { ctx.moveTo(tx, base + 92.5); ctx.lineTo(tx + 700, base + 92.5); }
  ctx.stroke();
  // Same weight as the tagline: in Ultra Light this line went grey and vanished (CEO, 2026-09-14).
  ctx.font = `400 23px ${FAMILY_MED}`; ctx.fillStyle = dim; ctx.textAlign = mirror ? 'right' : 'left';
  ctx.fillText(DESC, mirror ? right : tx, base + 130); ctx.textAlign = 'left';

  return canvas;
}

// One banner, the light one - the dark and mirrored variants were tried and
// the operator chose this (CEO, 2026-09-14). `onLight`/`mirror` stay as seams.
if (!ANIMATE) {
  fs.writeFileSync(OUT, (await render({ onLight: true })).toBuffer('image/png'));
  console.log(`[brand:banner] wrote ${path.relative(ROOT, OUT)} ${W * SCALE}x${H * SCALE} (face: ${FACE})`);
} else {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch {
    console.error('[brand:banner] --animate encodes with sharp, which is not installed. Run: npm install --no-save sharp');
    process.exit(1);
  }
  const frameAt = (i) => render({ onLight: true, t: (i * CYCLES) / FRAMES, spin: (i * SPIN) / FRAMES, orbit: (i * ORBIT) / FRAMES });
  const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  // The loop must close: wrapping from the last frame to frame 0 may change no
  // more of the picture than an ordinary step. Frame N is not byte-equal to
  // frame 0 - the ring a quarter turn on antialiases its edges differently.
  const changed = (a, b) => { let n = 0; for (let p = 0; p < a.length; p += 4) if (Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2])) > 8) n++; return n; };
  const [f0, f1, last] = [pixels(await frameAt(0)), pixels(await frameAt(1)), pixels(await frameAt(FRAMES - 1))];
  const step = changed(f0, f1), wrap = changed(last, f0);
  if (wrap > step * 1.5) throw new Error(`loop does not close: wrapping to frame 0 changes ${wrap} px, an ordinary step ${step}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-banner-frames-'));
  try {
    const files = [];
    for (let i = 0; i < FRAMES; i++) {
      files.push(path.join(dir, `${String(i).padStart(4, '0')}.png`));
      fs.writeFileSync(files[i], (await frameAt(i)).toBuffer('image/png'));
    }
    await sharp(files, { join: { animated: true }, limitInputPixels: false })
      .webp({ quality: 82, effort: 5, loop: 0, delay: Array(FRAMES).fill(Math.round(1000 / FPS)) })
      .toFile(OUT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`[brand:banner] wrote ${path.relative(ROOT, OUT)} ${W * SCALE}x${H * SCALE}, seam ${wrap} px vs step ${step}, ${FRAMES} frames at ${FPS} fps, ${(FRAMES / FPS).toFixed(2)} s loop, ${kb} KB (face: ${FACE})`);
}
