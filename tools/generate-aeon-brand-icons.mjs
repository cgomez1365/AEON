import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public', 'brand', 'aeon-primary-logo.png');
const OUTPUT_DIR = path.join(ROOT, 'public', 'brand', 'aeon-mark');
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
const sourcePng = fs.readFileSync(SOURCE);
const image = await loadImage(sourcePng);
const frames = [];

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, size, size);
  const png = await canvas.encode('png');
  fs.writeFileSync(path.join(OUTPUT_DIR, `aeon-icon-${size}.png`), png);
  frames.push({ size, png });
}

const svgWrapper = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 1280" role="img" aria-labelledby="aeon-logo-title"><title id="aeon-logo-title">AEON primary logo</title><image href="/brand/aeon-primary-logo.png" width="1280" height="1280" preserveAspectRatio="xMidYMid meet"/></svg>\n`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'aeon-mark.svg'), svgWrapper);
fs.writeFileSync(path.join(ROOT, 'public', 'brand', 'aeon-icon.svg'), svgWrapper);
for (const size of [32, 64, 192, 256, 512, 1024]) {
  const frame = frames.find((item) => item.size === size);
  fs.writeFileSync(path.join(ROOT, 'public', 'brand', `aeon-icon-${size}.png`), frame.png);
}

const icon = createIco(frames.filter(({ size }) => [16, 32, 48, 256].includes(size)));
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'AEON.ico'), icon);
fs.writeFileSync(path.join(ROOT, 'public', 'logo.png'), frames.find(({ size }) => size === 512).png);

console.log(`Generated AEON primary logo assets at ${SIZES.join(', ')}px plus favicon.ico`);
