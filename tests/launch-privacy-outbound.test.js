/**
 * Loading the UI contacts nothing but this AEON server (audit A007/A018/A070).
 *
 * README says "No telemetry, no phone-home ... Outbound traffic goes only to
 * services you configure or trigger". Two things broke it on every load:
 *   - src/aurora.css @imported Google Fonts, so each launch sent the
 *     operator's IP to fonts.googleapis.com / fonts.gstatic.com;
 *   - Quick Links drew each saved link's icon from google.com/s2/favicons,
 *     sending every bookmarked domain to Google whenever the page rendered.
 * The fonts are now self-hosted under public/fonts (each with its OFL
 * licence) and Quick Links draws a letter. This gate keeps any frontend
 * source from fetching a resource from another host by itself: an absolute
 * http(s) URL in a CSS @import / url(), or in an element's src.
 * A link the operator clicks (<a href>) is theirs to trigger and is not
 * checked.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Comments say WHY a URL is gone and may name it; only code is checked.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// What the browser loads: index.html and everything under src/ that the
// bundle can include. Server code (block api/ folders, .cjs) is not shipped.
function frontendFiles() {
  const out = ['index.html'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'api' && e.name !== 'node_modules') walk(rel); continue; }
      if (/\.(jsx|js|css|html)$/.test(e.name)) out.push(rel);
    }
  };
  walk('src');
  return out;
}

const SELF_FETCH = [
  /@import\s+(?:url\(\s*)?['"]?https?:\/\//i,
  /url\(\s*['"]?https?:\/\//i,
  /\bsrc\s*=\s*\{?\s*[`'"]https?:\/\//i,
];

describe('nothing on the page is fetched from another host', () => {
  it('no frontend source loads a resource from an absolute http(s) URL', () => {
    const hits = [];
    for (const rel of frontendFiles()) {
      const code = stripComments(read(rel));
      for (const re of SELF_FETCH) {
        const m = re.exec(code);
        if (m) hits.push(`${rel}: ${code.slice(m.index, m.index + 80).split('\n')[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no Google Fonts or Google favicon address remains in the frontend', () => {
    const hits = frontendFiles().filter((rel) =>
      /fonts\.googleapis\.com|fonts\.gstatic\.com|google\.com\/s2\/favicons/.test(stripComments(read(rel))));
    expect(hits).toEqual([]);
  });
});

describe('the three typefaces are served from this install', () => {
  const css = stripComments(read('src/aurora.css'));
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const family = (body) => /font-family:\s*['"]([^'"]+)['"]/.exec(body)?.[1];

  it.each(['Space Grotesk', 'JetBrains Mono', 'Inter'])('%s has a local @font-face', (name) => {
    const face = faces.find((b) => family(b) === name);
    expect(face, `${name} has no @font-face`).toBeTruthy();
    expect(face).toMatch(/font-display:\s*swap/);
    const url = /src:\s*url\(\s*['"]?(\/fonts\/[^'")]+)['"]?\s*\)/.exec(face)?.[1];
    expect(url, `${name} must load from /fonts/`).toBeTruthy();
    const file = path.join(ROOT, 'public', url);
    expect(fs.existsSync(file), `${url} is missing from public/`).toBe(true);
    expect(fs.readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
    const licence = path.join(path.dirname(file), 'OFL.txt');
    expect(fs.existsSync(licence), `${url} ships without its OFL.txt`).toBe(true);
    expect(fs.readFileSync(licence, 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });
});

describe('Quick Links draws its icons', () => {
  it('no <img> in the block; each link gets a letter badge', () => {
    const code = stripComments(read('src/blocks/quick_links/index.jsx'));
    expect(code).not.toMatch(/<img\b/);
    expect(code).toMatch(/badgeLetter\(href, label\)/);
  });
});

describe('the exported research report', () => {
  // deep_research's buildReportHTML writes a standalone HTML file the operator
  // opens later; it @imported Google Fonts, so opening a report reached Google.
  it('loads no Google font', () => {
    const code = stripComments(read('src/blocks/deep_research/api/index.cjs'));
    expect(code).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });
});
