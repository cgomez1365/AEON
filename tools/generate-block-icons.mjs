import fs from 'node:fs';
import path from 'node:path';
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

const BLOCK_ICONS = [
  '_blank', '_template', 'activity', 'aeon_matrix', 'cookbook',
  'council', 'dashboard', 'deep_research', 'files', 'fleet_control', 'host_os',
  'master', 'memory_core', 'orion_search', 'quick_links', 'resume_grader', 'security', 'settings',
  'writer', 'payroll', 'system', 'finance',
];
const SOURCE_NAMES = Object.fromEntries(BLOCK_ICONS.map((id) => [id, id.replaceAll('_', '-')]));
const SECTION_ICONS = ['finance', 'agent', 'work', 'content', 'tools', 'system'];

const AEON_FALLBACK = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
  '<path fill="none" stroke="currentColor" stroke-width="1.4" d="M4 18 12 3l8 15M7 13h10"/>',
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

function sourceSvg(name, fallback = AEON_FALLBACK) {
  const file = path.join(SOURCE_DIR, `${name}.svg`);
  return fs.existsSync(file) ? themeAware(fs.readFileSync(file, 'utf8')) : fallback;
}

async function writePng(svg, destination) {
  const rasterSvg = Buffer.from(svg.replaceAll('currentColor', '#00e2ff'));
  const image = await loadImage(rasterSvg);
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 64, 64);
  context.drawImage(image, 0, 0, 64, 64);
  fs.writeFileSync(destination, await canvas.encode('png'));
}

fs.mkdirSync(PNG_DIR, { recursive: true });
fs.mkdirSync(SECTION_DIR, { recursive: true });

for (const id of BLOCK_ICONS) {
  const svg = sourceSvg(SOURCE_NAMES[id]);
  fs.writeFileSync(path.join(OUTPUT_DIR, `${id}.svg`), svg);
  await writePng(svg, path.join(PNG_DIR, `${id}.png`));
}

for (const id of SECTION_ICONS) {
  fs.writeFileSync(path.join(SECTION_DIR, `${id}.svg`), sourceSvg(`group-${id}`));
}

console.log(`Generated ${BLOCK_ICONS.length} block SVGs, ${BLOCK_ICONS.length} PNG fallbacks, and ${SECTION_ICONS.length} section SVGs.`);
