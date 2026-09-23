/**
 * The scaffolds are skipped by ONE rule: a block folder starting with '_'.
 *
 * This gate used to say two mechanisms keyed off different fields — the
 * runtime by folder prefix, the build (scripts/gen-block-routes.cjs and
 * block-manifest-routes.test.js) by manifest ID in SKIP {__BLANK__, _template}
 * — and that they agreed only because `_blank`'s id is `__BLANK__`. The second
 * half was never true. Both build sites iterate `fs.readdirSync(blocksDir)`, so
 * they compared FOLDER names against a set holding a manifest id: `_template`
 * matched, `_blank` never did, and the route generator validated (and in write
 * mode rewrote) the `_blank` scaffold like a real block. The gate passed
 * because it mapped each folder to its manifest id before checking SKIP —
 * testing the code it described, not the code that ran (found 2026-09-23 by the
 * removability run; §08).
 *
 * Now every site, runtime and build, keys off the folder prefix. This gate pins
 * that, and still states the counts out loud (§08): 19 folders on disk, 17 that
 * mount.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');

const folders = fs.readdirSync(BLOCKS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const manifestId = (folder) => {
  const p = path.join(BLOCKS, folder, 'block.manifest.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')).id;
};

describe('the scaffold skip rule is one rule', () => {
  // Each site with the pattern that proves it applies the prefix to the FOLDER
  // it iterates. A bare startsWith('_') anywhere in a file proves nothing: the
  // old generator had one for underscore-prefixed API files and still processed
  // the `_blank` folder.
  const PREFIX = String.raw`startsWith\(['"]_['"]\)`;
  const SITES = [
    [['src', 'kernel', 'blockHost.cjs'], new RegExp(PREFIX)],
    [['src', 'kernel', 'blockRegistry.js'], new RegExp(PREFIX)],
    [['src', 'kernel', 'blockStandard.cjs'], new RegExp(PREFIX)],
    [['scripts', 'gen-block-routes.cjs'], /const isScaffold = \(name\) => name\.startsWith\('_'\)[\s\S]*if \(isScaffold\(id\)\) continue;/],
    [['tests', 'block-manifest-routes.test.js'], /\.filter\(id => !id\.startsWith\('_'\)/],
  ];

  it('every skip site, runtime and build, keys off the folder prefix', () => {
    for (const [rel, re] of SITES) {
      const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
      expect(re.test(src), `${rel.join('/')} no longer skips scaffold folders by prefix`).toBe(true);
    }
  });

  it('no site keeps an id-keyed skip set that could drift from the folders', () => {
    for (const [rel] of SITES) {
      const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
      expect(/const SKIP = new Set\(/.test(src), `${rel.join('/')} declares a SKIP set again`).toBe(false);
    }
  });
});

describe('the counts, stated so nobody has to guess again', () => {
  it('19 folders on disk, 2 scaffolds, 17 that mount', () => {
    // Both numbers are true and they answer different questions. A report
    // citing one without its basis reads as drift (§08). If you add a block,
    // update this line deliberately — that is the point of it being here.
    expect(folders.length).toBe(19);
    expect(folders.filter((f) => f.startsWith('_')).sort()).toEqual(['_blank', '_template']);
    expect(folders.filter((f) => !f.startsWith('_')).length).toBe(17);
  });

  it('every non-scaffold folder actually carries a manifest', () => {
    const missing = folders.filter((f) => !f.startsWith('_') && manifestId(f) === null);
    expect(missing, `folders under src/blocks with no manifest: ${missing.join(', ')}`).toEqual([]);
  });
});
