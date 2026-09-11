/**
 * The Master block leaves no block-authoring instruction out.
 *
 * CEO, 2026-09-07, after a block scaffolded on Windows never appeared: "expand
 * to leave no instructions out — directory paths, 'you can find icons in …'".
 * Every path the page names must exist in the tree, and the page must state
 * the three facts the post-mortem missed: a new block needs a Vite rebuild,
 * the kernel overwrites manifest.nav, and icons are a drop-in file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'src/blocks/master/index.jsx'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'src/blocks/_template/README.md'), 'utf8');

const PATHS = [
  'src/blocks/_template',
  'public/brand/block-icons',
  'public/brand/block-icons/png',
  'public/brand/block-icons/sections',
  'src/kernel/blockStandard.cjs',
  'src/kernel/blockRegistry.js',
  'src/kernel/schema.json',
  'src/kernel/staging.cjs',
  'server/block-loader.js',
  'tools/aeon-cli.cjs',
  'docs/BLOCKS.md',
];

describe('Master — the block standard, complete', () => {
  it('names every directory an author needs, and each one exists', () => {
    for (const p of PATHS) {
      expect(page, `page should name ${p}`).toContain(p);
      expect(fs.existsSync(path.join(ROOT, p)), `${p} should exist`).toBe(true);
    }
  });

  it('says where icons go — the drop-in file, by full path', () => {
    expect(page).toMatch(/public\/brand\/block-icons\/<id>\.svg/);
    expect(page).toMatch(/public\/brand\/block-icons\/png\/<id>\.png/);
  });

  it('states the three facts the ace_step post-mortem missed', () => {
    expect(page).toMatch(/npm run build/);                 // compile-time discovery
    expect(page).toMatch(/import\.meta\.glob/);
    expect(page).toMatch(/overwrit/i);                     // kernel owns manifest.nav
    expect(page).toMatch(/starting with .?_/);             // _ prefix never registers
  });

  it('the AI prompt matches the live manifest shape, not a stale one', () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocks/_template/block.manifest.json'), 'utf8'));
    expect(page).toContain(`"manifestVersion": "${tpl.manifestVersion}"`);
    expect(page).toContain('"contract"');
    expect(page).toContain('"permissions"');
    expect(page).not.toMatch(/"category": "tools",\n\s+"nav": \{ "icon": "Puzzle"/); // the old top-level-permissions shape
    expect(page).toContain('npm run aeon lint');
  });

  it('the template README carries the same paths, so a copied folder is self-explaining', () => {
    expect(readme).toContain('public/brand/block-icons');
    expect(readme).toMatch(/npm run build|npm run dev/);
    expect(readme).toMatch(/overwrit/i);
  });
});
