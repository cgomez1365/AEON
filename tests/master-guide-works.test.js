/**
 * Master's instructions produce a block that passes AEON's own airlock and
 * answers at the path its own screen fetches.
 *
 * Measured 2026-09-23 (agent C4) by following the Master page literally in a
 * scratch clone (`aeon new c4probe`, the page's four files, lint, promote,
 * build, rescan, curl):
 *  - The prompt's index.jsx imports `../../components/aurora`. `aeon lint`
 *    scores that HIGH (path-traversal) and `aeon promote` refused:
 *    "lint failed — block stays in staging/". The guide's block could not
 *    enter AEON.
 *  - The prompt's api registers `router.get('/status')` and `'/widget'`.
 *    Router modules mount at /api, so those became /api/status and
 *    /api/widget — shared names any second block would collide on — while the
 *    prompt's own screen fetched /api/my_block/status: 404.
 *  - "routes: leave []. npm run build fills it" — `npm run build` starts with
 *    `gen-block-routes --check`, which FAILS on a new block ("STALE — c4probe
 *    (0 declared, 2 real)"). Only `node scripts/gen-block-routes.cjs` writes it.
 *  - "Restart the server" was the only way named to mount a promoted block;
 *    POST /api/build/rescan mounts it live (measured: generation 2, 18 blocks).
 *  - The lifecycle commands the kernel now has (aeon block stop|start|remove|
 *    restore, POST /api/build/blocks/:id/…) were named nowhere on the page.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSrc = fs.readFileSync(path.join(ROOT, 'src/blocks/master/index.jsx'), 'utf8');
const builder = fs.readFileSync(path.join(ROOT, 'src/blocks/master/AEON_BLOCK_BUILDER.md'), 'utf8');
const cli = fs.readFileSync(path.join(ROOT, 'tools/aeon-cli.cjs'), 'utf8');

// The prompt exactly as "Copy prompt" hands it over.
const prompt = (() => {
  const start = pageSrc.indexOf('const PROMPT_TEMPLATE = `') + 'const PROMPT_TEMPLATE = `'.length;
  const end = pageSrc.indexOf('`;', start);
  return pageSrc.slice(start, end).replace(/\\`/g, '`').replace(/\\\$/g, '$');
})();
const between = (a, b) => {
  const i = prompt.indexOf(a);
  const j = prompt.indexOf(b, i + a.length);
  expect(i, `prompt section "${a}"`).toBeGreaterThan(-1);
  expect(j, `prompt section "${b}"`).toBeGreaterThan(i);
  return prompt.slice(i + a.length, j);
};
const manifestText = (() => {
  const s = between('### 1. block.manifest.json', 'Notes on the manifest');
  return s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
})();
const indexJsx = between('### 2. index.jsx', '### 3.').replace(/^[^\n]*\n/, '');
const apiCjs = between('### 3. api/my_block.cjs', '### 4.').replace(/^[^\n]*\n/, '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-master-guide-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the Master prompt, followed literally', () => {
  it('writes a block that `aeon lint` passes with no HIGH finding (so promote accepts it)', () => {
    const { lintBlock } = require('../src/kernel/staging.cjs');
    const dir = path.join(tmp, 'my_block');
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'block.manifest.json'), manifestText);
    fs.writeFileSync(path.join(dir, 'index.jsx'), indexJsx);
    fs.writeFileSync(path.join(dir, 'api', 'my_block.cjs'), apiCjs);
    fs.writeFileSync(path.join(dir, 'README.md'), 'Owns nothing yet.');
    const r = lintBlock(dir);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.findings.filter((f) => f.sev === 'HIGH'), JSON.stringify(r.findings)).toEqual([]);
  });

  it("serves every path its own screen fetches (router modules mount at /api, so routes carry the id)", () => {
    const routes = [...apiCjs.matchAll(/router\.(?:get|post|put|delete|patch)\(\s*'([^']+)'/g)].map((m) => `/api${m[1]}`);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r, 'every route is namespaced by the block id').toMatch(/^\/api\/my_block\//);
    const fetched = [...indexJsx.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(fetched.length).toBeGreaterThan(0);
    for (const f of fetched) expect(routes, `${f} is fetched but not served`).toContain(f);
  });

  it('names the step that writes routes, since the build only checks them', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(/gen-block-routes\.cjs --check/); // the fact the guide relies on
    for (const doc of [prompt, pageSrc, builder]) {
      expect(doc).toContain('node scripts/gen-block-routes.cjs');
      expect(doc).not.toMatch(/build fills it/i);
    }
  });

  it('mounts without a restart, and says how', () => {
    for (const doc of [pageSrc, builder]) expect(doc).toContain('/api/build/rescan');
  });
});

describe('the lifecycle is on the page, and every CLI verb it names exists', () => {
  it('names stop / start / remove / restore, by CLI and by route', () => {
    for (const doc of [pageSrc, builder]) {
      for (const verb of ['stop', 'start', 'remove', 'restore']) expect(doc).toContain(`aeon block ${verb}`);
      expect(doc).toMatch(/\/api\/build\/blocks\/:id\/\{?stop/);
    }
  });

  it('every `npm run aeon <verb>` / `aeon <verb>` the guide names is a real CLI command', () => {
    const verbs = new Set();
    for (const doc of [pageSrc, builder]) {
      for (const m of doc.matchAll(/(?:npm run aeon|node tools\/aeon-cli\.cjs|\baeon) (new|lint|dev|pack|promote|block|install|blocks|login|status|run)\b/g)) verbs.add(m[1]);
    }
    expect(verbs.size).toBeGreaterThan(4);
    for (const v of verbs) expect(cli, `aeon ${v} is not a CLI command`).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it('does not claim every unlisted block lands in SYSTEM (the kernel honours a real nav.group now)', () => {
    const std = fs.readFileSync(path.join(ROOT, 'src/kernel/blockStandard.cjs'), 'utf8');
    expect(std).toMatch(/GROUP_META\[m\.nav\?\.group\] \? m\.nav\.group : 'system'/); // the fact
    for (const doc of [pageSrc, builder]) {
      expect(doc).not.toMatch(/unlisted blocks land in SYSTEM at order 99/i);
      expect(doc).not.toMatch(/lands in the SYSTEM group at order 99/i);
    }
  });
});
