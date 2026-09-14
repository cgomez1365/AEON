#!/usr/bin/env node
/**
 * AEON README banner — public/brand/aeon-banner.png
 *
 * Derived from the same source as every icon: the mark's glow group in
 * public/brand/aeon-mark/aeon-mark.svg is rasterised as-is (no rounded ground,
 * the banner carries its own), then the wordmark and tagline are set beside it
 * in canvas text. Same ground gradient and the same three blues as the mark,
 * so the banner and the icons read as one object. Run: `npm run brand:banner`.
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
const OUT = path.join(ROOT, 'public', 'brand', 'aeon-banner.png');

const W = 1600, H = 400;
const TAGLINE = 'MODULAR. LOCAL. YOURS.';

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

let FAMILY = 'sans-serif', FACE = 'none';
for (const f of ['/System/Library/Fonts/Avenir Next.ttc', '/Library/Fonts/Avenir Next.ttc']) {
  if (!fs.existsSync(f)) continue;
  const face = extractFace(f, /Ultra ?Light$/i) || extractFace(f, /(^|\s)Light$/i);
  if (!face) continue;
  const tmp = path.join(os.tmpdir(), `aeon-banner-face-${process.pid}.ttf`);
  fs.writeFileSync(tmp, face.buffer);
  try { GlobalFonts.registerFromPath(tmp, 'AeonBannerFace'); FAMILY = 'AeonBannerFace'; FACE = face.subfamily; } catch {}
  break;
}

// The mark without its rounded ground: keep <defs> (gradient + glow filter) and
// the glow group, drop the <rect>. Everything else is the SVG's own geometry.
const markSvg = fs.readFileSync(MARK, 'utf8').replace(/<rect[^>]*aeonGround[^>]*\/>/, '');

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Ground: the icon's radial gradient, centred on the mark, stretched wide.
const g = ctx.createRadialGradient(330, H * 0.42, 40, 330, H * 0.42, 1500);
g.addColorStop(0, '#0b1428'); g.addColorStop(0.45, '#050a16'); g.addColorStop(1, '#01030a');
ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

// The poster's faint grid, receding to the right.
ctx.save();
ctx.strokeStyle = 'rgba(127,178,255,0.07)'; ctx.lineWidth = 1;
for (let x = 0.5; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
for (let y = 0.5; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
const fade = ctx.createLinearGradient(0, 0, W, 0);
fade.addColorStop(0, 'rgba(1,3,10,0)'); fade.addColorStop(0.55, 'rgba(1,3,10,0)'); fade.addColorStop(1, 'rgba(1,3,10,0.85)');
ctx.fillStyle = fade; ctx.fillRect(0, 0, W, H);
ctx.restore();

// A thin horizontal HUD line through the mark's centre, as on the poster.
ctx.save();
ctx.strokeStyle = 'rgba(127,178,255,0.35)'; ctx.lineWidth = 1.5;
ctx.beginPath(); ctx.moveTo(60, H / 2 + 0.5); ctx.lineTo(520, H / 2 + 0.5); ctx.stroke();
ctx.restore();

// The mark, 320px, vertically centred, left.
const markSize = 320;
const mark = await loadImage(Buffer.from(markSvg.replace(/width="512" height="512"/, `width="${markSize}" height="${markSize}"`)));
ctx.drawImage(mark, 330 - markSize / 2, H / 2 - markSize / 2, markSize, markSize);

// Wordmark. Light weight, wide tracking - the poster sets "AEON" the same way.
const tracked = (text, x, y, size, weight, spacing, color) => {
  ctx.font = `${weight} ${size}px ${FAMILY}`; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic';
  let cx = x;
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
  return cx - spacing;
};
const textX = 560;
ctx.save();
ctx.shadowColor = 'rgba(127,178,255,0.55)'; ctx.shadowBlur = 28;
tracked('AEON', textX, 196, 136, '400', 26, '#eaf3ff');
ctx.restore();
tracked(TAGLINE, textX + 4, 258, 30, '400', 9, '#7fb2ff');

// Rule and the one-line description, in the README's words.
ctx.strokeStyle = 'rgba(127,178,255,0.3)'; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(textX + 2, 292.5); ctx.lineTo(textX + 690, 292.5); ctx.stroke();
ctx.font = `400 22px ${FAMILY}`; ctx.fillStyle = 'rgba(188,216,255,0.72)';
ctx.fillText('A local-first AI workspace built from governed blocks.', textX + 2, 330);

fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
console.log(`[brand:banner] wrote ${path.relative(ROOT, OUT)} ${W}x${H} (face: ${FACE})`);
