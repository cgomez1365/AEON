#!/usr/bin/env node
/**
 * AEON README banners — public/brand/aeon-banner-dark.png and -light.png
 *
 * The mark IS the A. In the 512 mark the chevron is 136 tall (y 192..328), so
 * the mark is scaled until that chevron matches the cap height of "EON" set in
 * Avenir Next Ultra Light, and the rings fall behind the word. The README
 * serves the dark one on GitHub's dark theme and the light one on light, via
 * <picture> + prefers-color-scheme. To the right, a field of light particles
 * streams in from the edge - a door opened onto the digital world. Dark:
 * white-blue dust. Light: neon blue and deep blue. Deterministic (seeded), so
 * `npm run brand:banner` reproduces both files exactly on the same font.
 *
 * 1600x400 — GitHub renders a README image at content width (~900px) so this
 * stays crisp on 2x displays. Text uses the system's Avenir Next when present
 * (macOS); elsewhere the canvas default sans is used and the output differs,
 * which is why the PNG is committed rather than generated at build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = path.join(ROOT, 'public', 'brand', 'aeon-mark', 'aeon-mark.svg');
const OUT_DARK = path.join(ROOT, 'public', 'brand', 'aeon-banner-dark.png');
const OUT_LIGHT = path.join(ROOT, 'public', 'brand', 'aeon-banner-light.png');

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

const W = 1600, H = 400;
// Output is 3840x960 (2.4x): every number below is in 1600x400 layout units
// and the context is scaled, so text, mark and dust all render at full res.
const SCALE = 2.4;
const TAGLINE = 'MODULAR. LOCAL. YOURS.';
const DESC = 'A local-first AI workspace';

// In the 512 mark: chevron outer apex y=192, feet y=328; feet x 183..329.
const CHEV_H = 136 / 512, CHEV_W = 146 / 512, CHEV_CY = (192 + 328) / 2 / 512;
const CAP = 0.72; // Avenir Next Ultra Light cap height, em

// Seeded RNG so both banners are byte-stable across runs.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const tracked = (ctx, text, x, y, size, spacing, color, family = FAMILY) => {
  ctx.font = `400 ${size}px ${family}`; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic';
  let cx = x; for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
};

// The wordmark: mark as the A, chevron at cap height, "EON" drawn last with a
// halo in the ground colour so the rings behind stay readable.
async function wordmark(ctx, { x, y, size, spacing, color, onLight, ringAlpha, halo }) {
  ctx.font = `400 ${size}px ${FAMILY}`;
  const cap = size * CAP, markSize = cap / CHEV_H, chevW = markSize * CHEV_W;
  const letters = [...'EON'], lw = letters.map((ch) => ctx.measureText(ch).width);
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
  const img = await loadImage(Buffer.from(svg));
  ctx.save(); ctx.globalAlpha = ringAlpha; ctx.drawImage(img, chevCx - markSize / 2, markCy - markSize / 2, markSize, markSize); ctx.restore();
  let cx = x + chevW + spacing; const xs = [];
  ctx.save(); ctx.textBaseline = 'alphabetic'; ctx.font = `400 ${size}px ${FAMILY}`;
  ctx.shadowColor = halo; ctx.shadowBlur = 14; ctx.fillStyle = color;
  letters.forEach((ch, i) => { xs.push(cx); ctx.fillText(ch, cx, y); ctx.fillText(ch, cx, y); cx += lw[i] + spacing; });
  ctx.restore();
  return { oX: xs[1], ringR: markSize * 205 / 512, cx: chevCx, cy: markCy };
}

// Light through an opened door: a soft vertical slit at the right edge and a
// stream of particles pouring in from it, dense at the door, thinning leftward.
// Two glows per particle (wide faint halo, tight bright core), some drawn as
// short horizontal streaks so the field reads as motion, not static noise.
function particles(ctx, { seed, doorX, from, colors, count, additive, centerY, spreadK, expo, farAlpha, sizeK, dim }) {
  const r = rng(seed);
  ctx.save();
  // Additive on dark (light adds up); normal on light (ink would wash to white).
  ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
  for (let i = 0; i < count; i++) {
    // distance from the door: most dust sits near the opening
    const d = Math.pow(r(), expo);
    const x = doorX - d * (doorX - from) + (r() - 0.5) * 30;
    // Full height at the door, not a point source: mostly uniform top to
    // bottom, with a mild pull toward centerY so the field still has a middle.
    const u = 12 + r() * (H - 24);
    const y = u + (centerY - u) * 0.25 * spreadK;
    const near = 1 - d;
    const size = (0.6 + r() * (1.4 + near * 2.6)) * sizeK;
    // `dim` scales everything down: the dust is filler and must never outdo the mark.
    const a = (0.25 + r() * 0.75) * (farAlpha + near * (1 - farAlpha)) * dim;
    const col = colors[Math.floor(r() * colors.length)];
    const rgba = (alpha) => col.replace('A', alpha.toFixed(3));
    // soft halo
    const hg = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
    hg.addColorStop(0, rgba(a * 0.3)); hg.addColorStop(1, rgba(0));
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(x, y, size * 3, 0, Math.PI * 2); ctx.fill();
    // core, sometimes a streak
    ctx.fillStyle = rgba(a);
    if (r() < 0.22) { const len = size * (5 + r() * 18) * (0.5 + near); ctx.fillRect(x, y - size * 0.3, len, size * 0.6); }
    else { ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

async function render({ onLight, out }) {
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
    const g = ctx.createRadialGradient(300, H * 0.45, 40, 300, H * 0.45, 1500);
    g.addColorStop(0, '#0b1428'); g.addColorStop(0.45, '#050a16'); g.addColorStop(1, '#01030a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.strokeStyle = 'rgba(127,178,255,0.06)'; ctx.lineWidth = 1 / SCALE;
    for (let x = 0.5; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0.5; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }

  // The dust, before the word so it passes behind EON's halo. No door glow: the
  // particles are filler and must not compete with the mark.
  const DUST = { seed: 20260914, doorX: W - 40, from: 760, count: 380, centerY: H * 0.42, spreadK: 1.0, expo: 1.3, farAlpha: 0.4, sizeK: 1.25, dim: 0.495 };
  if (onLight) particles(ctx, { ...DUST, additive: false, colors: ['rgba(0,140,255,A)', 'rgba(0,190,255,A)', 'rgba(31,79,168,A)', 'rgba(11,42,120,A)'] });
  else particles(ctx, { ...DUST, additive: true, colors: ['rgba(255,255,255,A)', 'rgba(220,235,255,A)', 'rgba(170,205,255,A)', 'rgba(127,178,255,A)'] });

  const ink = onLight ? '#0b1a3a' : '#eaf3ff';
  const blue = onLight ? '#2f6fd6' : '#a9ccff';
  const dim = onLight ? 'rgba(11,26,58,0.88)' : 'rgba(222,236,255,0.95)';
  const ruleCol = onLight ? 'rgba(31,79,168,0.3)' : 'rgba(127,178,255,0.3)';
  const halo = onLight ? 'rgba(247,249,254,0.95)' : 'rgba(1,3,10,0.95)';

  const g = await wordmark(ctx, { x: 120, y: 212, size: 190, spacing: 36, color: ink, onLight, ringAlpha: onLight ? 0.85 : 0.8, halo });

  // Tagline, rule and description start under the O - clear of the outer ring.
  const tx = g.oX;
  tracked(ctx, TAGLINE, tx, 272, 26, 10, blue, FAMILY_MED);
  ctx.strokeStyle = ruleCol; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tx, 304.5); ctx.lineTo(tx + 700, 304.5); ctx.stroke();
  ctx.font = `400 24px ${FAMILY}`; ctx.fillStyle = dim; ctx.fillText(DESC, tx, 342);

  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`[brand:banner] wrote ${path.relative(ROOT, out)} ${W * SCALE}x${H * SCALE} (face: ${FACE})`);
}

await render({ onLight: false, out: OUT_DARK });
await render({ onLight: true, out: OUT_LIGHT });
