#!/usr/bin/env node
/**
 * The block filesystem surface — declared capability vs unreviewed use.
 *
 * BO-SHIP P2.2 / P12.
 *
 * The block sandbox in server/block-loader.js scopes a block by DELETING
 * injected dependencies — DATA_ROOT, VAULT_ROOT, getDataFile, getVaultFile —
 * when its manifest declares storage.access === 'scoped'. That mechanism can
 * only constrain capability it HANDS OUT. A block that calls `require('fs')`
 * and builds its own paths is not scoped by it at all.
 *
 * The first version of this scanner counted every such require and ratcheted
 * the total downward, on the assumption that all of them were defects to be
 * ported to blockStorage. Inventorying all twelve proved that wrong. Five
 * blocks touch the filesystem because the filesystem IS their job:
 *
 *   host_os/api/fs.cjs      the File Manager
 *   security/api/guardian   an integrity scan over the install
 *   activity/api/analytics  scans the install for activity
 *   master/api/master.cjs   enumerates sibling blocks — its entire purpose
 *   cookbook/api/index.cjs  scans and prunes the HuggingFace model cache
 *
 * A ratchet that treats those identically to an unreviewed `require('fs')` is
 * measuring the wrong thing, and it can never reach zero — so it would sit at
 * a permanent non-zero number that nobody can act on, which is how a gate
 * stops being read.
 *
 * ── The declaration ──────────────────────────────────────────────────────
 *
 * A block states, in its own manifest, the filesystem access it genuinely
 * requires beyond its namespace, and why:
 *
 *   "contract": {
 *     "filesystem": {
 *       "beyondNamespace": [
 *         { "file": "api/guardian.cjs",
 *           "scope": "install",
 *           "reason": "Integrity scan: compares shipped files against hashes." }
 *       ]
 *     }
 *   }
 *
 * Declared access is AUDITED access: it is visible in the manifest a buyer can
 * read, it names the file and the reason, and this scanner refuses to let it
 * rot. Undeclared access is unreviewed, counts toward the ratchet, and may
 * only fall.
 *
 * The declaration is deliberately not a permission — it grants nothing. Node
 * hands a block `fs` whatever the manifest says. It is a STATEMENT, checked
 * against reality, so that "which blocks touch the filesystem, and why" has a
 * truthful answer that does not require reading twelve blocks' source.
 *
 *   node tools/scan/block-fs-surface.cjs          check
 *   node tools/scan/block-fs-surface.cjs --write  lower the baseline (deliberate)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BLOCKS_DIR = process.env.AEON_BLOCKS_DIR || path.join(ROOT, 'src', 'blocks');
const BASELINE_FILE = path.join(__dirname, 'block-fs-surface.baseline.json');

const FS_REQUIRE = /require\(\s*['"](?:fs|node:fs|fs\/promises|node:fs\/promises)['"]\s*\)/;

/** Where a block may legitimately reach. Anything else is a declaration error. */
const SCOPES = {
  install: 'the AEON install itself (integrity scans, block enumeration)',
  workspace: "the operator's workspace (the File Manager's whole purpose)",
  vault: 'shared Vault areas outside the block namespace',
  'external-cache': 'a cache owned by a third-party tool (HuggingFace, llama.cpp)',
};

/**
 * A rule described in prose is not a rule being broken.
 *
 * The scaffold's own comment says "Do not require('fs') in a block" and that
 * kept _blank counted after it had been ported. Line comments are stripped
 * FIRST: a `//` containing something block-comment-shaped otherwise swallows
 * real code beneath it, which is how a sibling gate produced a false positive
 * on DesktopLayout.jsx on 2026-08-11.
 */
function stripComments(src) {
  return src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'db' || e.name === 'data') continue;
        walk(p);
      } else if (/\.(cjs|js|jsx|mjs)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** The block's declared beyond-namespace filesystem access, keyed by file. */
function declarationsFor(block) {
  const file = path.join(BLOCKS_DIR, block, 'block.manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { map: new Map(), errors: [] }; }

  const list = manifest?.contract?.filesystem?.beyondNamespace;
  const map = new Map();
  const errors = [];
  if (!Array.isArray(list)) return { map, errors };

  for (const d of list) {
    if (!d || typeof d.file !== 'string' || !d.file) {
      errors.push(`${block}: a filesystem declaration has no "file"`);
      continue;
    }
    if (!SCOPES[d.scope]) {
      errors.push(`${block}/${d.file}: scope "${d.scope}" is not one of ${Object.keys(SCOPES).join(', ')}`);
    }
    if (typeof d.reason !== 'string' || d.reason.trim().length < 20) {
      // A one-word reason is not a reason. The point of the declaration is
      // that someone reading the manifest learns why.
      errors.push(`${block}/${d.file}: "reason" must be a sentence explaining why (20+ chars)`);
    }
    map.set(d.file.split(path.sep).join('/'), d);
  }
  return { map, errors };
}

function scan() {
  const blocks = fs.readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const undeclared = {};   // block -> [file]   counts toward the ratchet
  const declared = {};     // block -> [{file, scope}]
  const errors = [];
  let total = 0;
  let declaredTotal = 0;

  for (const block of blocks) {
    const { map, errors: declErrors } = declarationsFor(block);
    errors.push(...declErrors);

    const hits = [];
    const declaredHere = [];
    const seenFiles = new Set();

    for (const file of sourceFiles(path.join(BLOCKS_DIR, block))) {
      const rel = path.relative(path.join(BLOCKS_DIR, block), file).split(path.sep).join('/');
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      if (!FS_REQUIRE.test(src)) continue;
      seenFiles.add(rel);

      const d = map.get(rel);
      if (d) { declaredHere.push({ file: rel, scope: d.scope }); declaredTotal++; }
      else hits.push(`${block}/${rel}`);
    }

    // A declaration for a file that no longer touches the filesystem is a
    // claim about the product that has stopped being true. §08.
    for (const [rel] of map) {
      if (!seenFiles.has(rel)) {
        const exists = fs.existsSync(path.join(BLOCKS_DIR, block, rel));
        errors.push(
          `${block}/${rel}: declared beyond-namespace filesystem access, but the file `
          + (exists ? 'no longer requires fs' : 'does not exist') + ' — remove the declaration'
        );
      }
    }

    if (hits.length) { undeclared[block] = hits.sort(); total += hits.length; }
    if (declaredHere.length) declared[block] = declaredHere.sort((a, b) => a.file.localeCompare(b.file));
  }

  return { total, blocks: Object.keys(undeclared).length, perBlock: undeclared, declared, declaredTotal, errors };
}

function readBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; }
}

function main() {
  const result = scan();
  const write = process.argv.includes('--write');
  const baseline = readBaseline();

  // Declaration errors are always fatal. A stale or malformed declaration is
  // worse than none: it asserts something untrue in the manifest a buyer reads.
  if (result.errors.length) {
    console.error('[block-fs-surface] DECLARATION ERRORS');
    for (const e of result.errors) console.error(`    ${e}`);
    console.error('');
    return 1;
  }

  if (write || !baseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      note: 'UNDECLARED direct fs requires inside blocks. This surface may only shrink. '
          + 'Declared beyond-namespace access lives in each block manifest under '
          + 'contract.filesystem.beyondNamespace and is audited, not counted.',
      measuredAt: new Date().toISOString().slice(0, 10),
      total: result.total,
      blocks: result.blocks,
      declaredTotal: result.declaredTotal,
      perBlock: result.perBlock,
    }, null, 2) + '\n');
    console.log(`[block-fs-surface] baseline written — ${result.total} undeclared across ${result.blocks} blocks; ${result.declaredTotal} declared and audited.`);
    return 0;
  }

  if (result.total > baseline.total) {
    const added = [];
    for (const [block, files] of Object.entries(result.perBlock)) {
      const before = new Set(baseline.perBlock?.[block] || []);
      for (const f of files) if (!before.has(f)) added.push(f);
    }
    console.error('[block-fs-surface] RATCHET BROKEN');
    console.error(`  undeclared fs requires inside blocks rose ${baseline.total} → ${result.total}. It may only fall.`);
    if (added.length) {
      console.error('\n  new:');
      for (const f of added) console.error(`    ${f}`);
    }
    console.error('\n  A block reaching the filesystem directly is not constrained by the');
    console.error('  manifest sandbox — the sandbox can only withhold what it injects.');
    console.error('  Either use the blockStorage surface, or DECLARE the access in the');
    console.error('  block manifest if the filesystem is genuinely the job:');
    console.error('');
    console.error('    "contract": { "filesystem": { "beyondNamespace": [');
    console.error('      { "file": "api/thing.cjs", "scope": "install",');
    console.error('        "reason": "why this block must reach outside its namespace" } ] } }');
    console.error('');
    console.error(`  scopes: ${Object.keys(SCOPES).join(', ')}`);
    console.error('  Or lower the baseline deliberately:');
    console.error('    node tools/scan/block-fs-surface.cjs --write\n');
    return 1;
  }

  if (result.total < baseline.total) {
    console.log(`[block-fs-surface] IMPROVED — ${baseline.total} → ${result.total} undeclared. Lower the baseline:`);
    console.log('  node tools/scan/block-fs-surface.cjs --write');
    return 0;
  }

  console.log(`[block-fs-surface] HELD — ${result.total} undeclared across ${result.blocks} blocks (baseline ${baseline.total}); ${result.declaredTotal} declared and audited.`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { scan, SCOPES };
