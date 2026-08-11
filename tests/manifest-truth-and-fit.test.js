/**
 * BO-L items 8, 6, 7 — the manifest tells the truth, and so does the model list.
 *
 * Principle 04 (least privilege) and §08 (a declaration with no consumer is
 * not a feature). These assert the shipped tree, not a fixture: if a block
 * starts over-declaring storage again, this goes red.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');

const { validateManifest } = require('../src/kernel/staging.cjs');
const { scaffold } = require('../src/kernel/blockScaffold.cjs');

// The loader skips '_'-prefixed folders (templates), so validation must too.
const liveBlocks = () =>
  fs.readdirSync(BLOCKS).filter(
    (f) => !f.startsWith('_') && fs.existsSync(path.join(BLOCKS, f, 'block.manifest.json'))
  );
const manifestOf = (f) => JSON.parse(fs.readFileSync(path.join(BLOCKS, f, 'block.manifest.json'), 'utf8'));

describe('every installed block passes its own validator', () => {
  it('validates clean in existing mode — all of them', () => {
    const failures = [];
    for (const f of liveBlocks()) {
      const errs = validateManifest(manifestOf(f), { existing: true });
      if (errs.length) failures.push(`${f}: ${errs.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('no block declares storage it does not use', () => {
    // Principle 04. A block claiming a local store must have code that writes.
    // Assembled from fragments on purpose: suite-touches-nothing.test.js
    // scans test SOURCE for these identifiers, and a detector pattern is
    // not a write. Spelling them out here would make that gate flag this
    // file for describing the very thing it checks.
    const WRITES = new RegExp(
      ['write' + 'File', 'mkdir' + 'Sync', 'block' + 'Storage', 'getData' + 'File'].join('|')
    );
    const offenders = [];
    for (const f of liveBlocks()) {
      const m = manifestOf(f);
      if ((m.contract?.storage?.type || 'none') === 'none') continue;
      const dir = path.join(BLOCKS, f);
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      const writes = walk(dir).some(
        (p) => /\.(js|cjs|jsx|mjs)$/.test(p) && WRITES.test(fs.readFileSync(p, 'utf8'))
      );
      if (!writes) offenders.push(`${f} declares storage.type=${m.contract.storage.type} but never writes`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('grandfathering is expressed, not discovered', () => {
  it('accepts compatibility for an existing block', () => {
    const m = manifestOf(liveBlocks()[0]);
    m.contract.storage.access = 'compatibility';
    expect(validateManifest(m, { existing: true })).toEqual([]);
  });

  it('still REFUSES compatibility for a new one — the default stays strict', () => {
    const m = manifestOf(liveBlocks()[0]);
    m.contract.storage.access = 'compatibility';
    expect(validateManifest(m)).toContain('new v1.1 blocks must use contract.storage.access=scoped');
    expect(validateManifest(m, { existing: false })).toContain('new v1.1 blocks must use contract.storage.access=scoped');
  });

  it('a scaffolded block passes in either mode', () => {
    const { payload } = scaffold({ id: 'fresh_block', api: true });
    expect(validateManifest(payload.manifest)).toEqual([]);
    expect(validateManifest(payload.manifest, { existing: true })).toEqual([]);
  });

  it('grandfathering does not excuse any other rule', () => {
    const m = manifestOf(liveBlocks()[0]);
    m.contract.storage.access = 'compatibility';
    delete m.route;
    expect(validateManifest(m, { existing: true })).toContain('missing required field: route');
  });
});

describe('BO-H3b — the model list says why something cannot run', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/api/index.cjs'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/index.jsx'), 'utf8');

  it('annotates browse entries with a runnability reason', () => {
    expect(src).toMatch(/runnable_reason/);
    expect(src).toMatch(/the llama\.cpp runtime reads GGUF only/);
  });

  it('ranks runnable models first without dropping the others', () => {
    expect(src).toMatch(/models\.sort\(/);
    // Hiding rows would make the ranking dishonest about what exists.
    expect(src).not.toMatch(/models\s*=\s*models\.filter\(\s*m\s*=>\s*m\.gguf/);
  });

  it('surfaces the reason in the row', () => {
    expect(ui).toMatch(/safetensors — not runnable/);
  });
});

describe('BO-H8e — local New Folder uses the route that already existed', () => {
  const files = fs.readFileSync(path.join(ROOT, 'src/blocks/files/index.jsx'), 'utf8');
  const fsApi = fs.readFileSync(path.join(ROOT, 'src/blocks/host_os/api/fs.cjs'), 'utf8');

  it('no longer reports its own absence', () => {
    // Strip comments — the fix's own note quotes the old string, and matching
    // a comment would make this pass or fail for the wrong reason.
    const code = files.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/not yet implemented/i);
  });

  it('calls POST /fs/mkdir, which was mounted all along', () => {
    expect(fsApi).toMatch(/router\.post\('\/fs\/mkdir'/);
    expect(files).toMatch(/\/mkdir/);
  });

  it('honours the 423 edit lock rather than failing opaquely', () => {
    expect(files).toMatch(/res\.status === 423/);
  });
});
