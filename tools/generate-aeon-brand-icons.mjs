import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public', 'brand', 'aeon-mark', 'aeon-mark.svg');
const OUTPUT_DIR = path.dirname(SOURCE);
const SIZES = [16, 32, 48, 64, 128, 192, 256, 512, 1024];

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

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const sourceSvg = fs.readFileSync(SOURCE);
const rasterSvg = Buffer.from(
  sourceSvg.toString('utf8')
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/class="grid"/g, 'fill="none" stroke="#167eb1" stroke-width="1" opacity=".17"')
    .replace(/class="construction"/g, 'fill="none" stroke="#43c8ff" stroke-width="2" opacity=".38"')
    .replace(/class="ink"/g, 'fill="none" stroke="#b9edff" stroke-width="13" stroke-linecap="square" stroke-linejoin="miter"')
    .replace(/class="fine"/g, 'fill="none" stroke="#43c8ff" stroke-width="3" opacity=".8"')
    .replace(/\sfilter="url\(#(?:glow|softGlow)\)"/g, ''),
);
const image = await loadImage(rasterSvg);
const frames = [];

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, size, size);
  const png = await canvas.encode('png');
  fs.writeFileSync(path.join(OUTPUT_DIR, `aeon-icon-${size}.png`), png);
  frames.push({ size, png });
}

const sourceText = sourceSvg.toString('utf8');
fs.writeFileSync(path.join(ROOT, 'public', 'brand', 'aeon-icon.svg'), sourceText);
for (const size of [32, 64, 192, 256, 512, 1024]) {
  const frame = frames.find((item) => item.size === size);
  fs.writeFileSync(path.join(ROOT, 'public', 'brand', `aeon-icon-${size}.png`), frame.png);
}

const icon = createIco(frames.filter(({ size }) => [16, 32, 48, 256].includes(size)));
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'AEON.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'public', 'logo.png'), frames.find(({ size }) => size === 512).png);

console.log(`Generated AEON mark assets at ${SIZES.join(', ')}px plus favicon.ico`);
