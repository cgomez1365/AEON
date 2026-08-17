/**
 * The scaffolds are skipped by TWO mechanisms that key off DIFFERENT fields.
 *
 *   runtime  — blockHost.cjs, blockRegistry.js, blockStandard.cjs all skip a
 *              block whose FOLDER starts with '_' (K2).
 *   build    — scripts/gen-block-routes.cjs and block-manifest-routes.test.js
 *              skip a block whose manifest ID is in SKIP: {__BLANK__, _template}.
 *
 * Both are correct today only because `_blank`'s id happens to be `__BLANK__`.
 * Rename that id and the folder still never mounts, while the route generator
 * silently starts emitting scaffold routes into the declared surface — a
 * divergence with no symptom until someone counts routes and gets a number
 * nobody can explain. That is the origin of the recurring "19 folders vs 17
 * blocks" question.
 *
 * This gate pins the invariant: the two mechanisms must select the SAME set.
 *
 * It also states the counts out loud, because both are true and they answer
 * different questions (§08): 19 folders on disk, 17 that mount.
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

/** The build-time SKIP set, read from the generator itself rather than copied. */
function generatorSkipSet() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-block-routes.cjs'), 'utf8');
  const m = src.match(/const SKIP = new Set\(\[([^\]]*)\]\)/);
  expect(m, 'gen-block-routes.cjs no longer declares SKIP as a literal Set — update this gate').not.toBeNull();
  return new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
}

describe('the scaffold skip rule is one rule, not two that happen to agree', () => {
  const scaffoldFolders = folders.filter((f) => f.startsWith('_'));
  const realFolders = folders.filter((f) => !f.startsWith('_'));

  it('every scaffold folder has an id the route generator also skips', () => {
    const SKIP = generatorSkipSet();
    const leaking = scaffoldFolders
      .map((f) => ({ folder: f, id: manifestId(f) }))
      .filter((x) => x.id !== null && !SKIP.has(x.id));

    expect(leaking,
      `these folders never mount but their routes WOULD be generated: ` +
      leaking.map((x) => `${x.folder} (id ${x.id})`).join(', ')).toEqual([]);
  });

  it('the generator skips nothing that actually mounts', () => {
    // The inverse. An over-broad SKIP would silently drop a real block's
    // routes from the declared surface, which is the same defect pointed the
    // other way.
    const SKIP = generatorSkipSet();
    const dropped = realFolders
      .map((f) => ({ folder: f, id: manifestId(f) }))
      .filter((x) => x.id !== null && SKIP.has(x.id));

    expect(dropped,
      `these blocks mount but their routes would be skipped: ` +
      dropped.map((x) => x.folder).join(', ')).toEqual([]);
  });

  it('all three runtime skip sites still key off the folder prefix', () => {
    // If one of these is rewritten to match on id, or on a hardcoded list, the
    // invariant above stops being enforceable.
    for (const rel of [
      ['src', 'kernel', 'blockHost.cjs'],
      ['src', 'kernel', 'blockRegistry.js'],
      ['src', 'kernel', 'blockStandard.cjs'],
    ]) {
      const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
      expect(/startsWith\(['"]_['"]\)/.test(src),
        `${rel.join('/')} no longer skips scaffolds by folder prefix`).toBe(true);
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
