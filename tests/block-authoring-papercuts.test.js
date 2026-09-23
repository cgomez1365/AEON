/**
 * Three authoring defects the removability run hit on 2026-09-23, each of
 * which made a correct new block land wrong:
 *
 *   1. A block absent from the kernel's NAV map was forced into SYSTEM,
 *      order 99, whatever its manifest asked for — `aeon new night_probe`
 *      with nav.group "tools" was rewritten to "system".
 *   2. `aeon new` copied the template's `api_routes: true` while the template
 *      ships only api/README.md, so every UI-only block failed its boot proof:
 *      "api_routes is declared but no API module mounted".
 *   3. The route generator skipped a folder named '__BLANK__'; the scaffold is
 *      `_blank`, so it was validated like a real block. The kernel's rule is
 *      simpler — any folder starting with '_' never registers.
 * And the Master README said "Restart the server" is what makes a block
 * appear; the screen needs `npm run build` (the in-app guide already says so).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function withBlocksDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-nav-'));
  const saved = process.env.AEON_BLOCKS_DIR;
  process.env.AEON_BLOCKS_DIR = dir;
  for (const m of ['../src/kernel/blocksDir.cjs', '../src/kernel/blockStandard.cjs']) delete require.cache[require.resolve(m)];
  try { return fn(dir, require('../src/kernel/blockStandard.cjs')); }
  finally {
    if (saved === undefined) delete process.env.AEON_BLOCKS_DIR; else process.env.AEON_BLOCKS_DIR = saved;
    for (const m of ['../src/kernel/blocksDir.cjs', '../src/kernel/blockStandard.cjs']) delete require.cache[require.resolve(m)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const writeBlock = (dir, id, nav) => {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'block.manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', route: `/${id}`, nav }));
  fs.writeFileSync(path.join(dir, id, 'index.jsx'), 'export default () => null;\n');
};

describe('a block the kernel does not know keeps its own nav placement', () => {
  it('a valid group and order from the manifest are kept', () => withBlocksDir((dir, std) => {
    writeBlock(dir, 'night_probe', { group: 'tools', order: 7 });
    const m = std.normalizeManifest('night_probe');
    expect(m.nav.group).toBe('tools');
    expect(m.nav.order).toBe(7);
  }));

  it('an unknown group still falls back to SYSTEM', () => withBlocksDir((dir, std) => {
    writeBlock(dir, 'night_probe', { group: 'creative', order: 7 });
    const m = std.normalizeManifest('night_probe');
    expect(m.nav.group).toBe('system');
  }));
});

describe('aeon new', () => {
  const id = `zz_papercut_${process.pid}`;
  const staged = path.join(ROOT, 'staging', id);
  afterEach(() => fs.rmSync(staged, { recursive: true, force: true }));

  it('a scaffold with no API module does not claim api_routes', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'new', id], { encoding: 'utf8', timeout: 20000 });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'block.manifest.json'), 'utf8'));
    expect(m.api_routes).toBe(false);
  });
});

describe('the route generator skips scaffolds the way the kernel does', () => {
  it('any folder starting with "_" is skipped', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-block-routes.cjs'), 'utf8');
    expect(src).not.toMatch(/'__BLANK__'/);
    expect(src).toMatch(/startsWith\('_'\)/);
  });
});

describe('the Master README names the step that makes a block appear', () => {
  it('npm run build, not just a restart', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'master', 'README.md'), 'utf8');
    // Any numbered step, not "step 5": the loop gained lint/promote and the
    // routes step ahead of the build (agent C4, 2026-09-23), which moved it to 7.
    const steps = readme.split('\n').filter((l) => /^\d+\. /.test(l));
    const build = steps.find((l) => /npm run build/.test(l)) || '';
    expect(build).toMatch(/npm run build/);
    // …and the build comes before the step that mounts the block.
    const buildAt = readme.indexOf(build);
    expect(buildAt).toBeGreaterThan(-1);
    expect(readme.indexOf('POST /api/build/rescan', buildAt)).toBeGreaterThan(buildAt);
  });
});
