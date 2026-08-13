#!/usr/bin/env node
/**
 * The block filesystem surface, as a ratchet.
 *
 * BO-SHIP P2.2 discovery, 2026-08-12.
 *
 * The block sandbox in server/block-loader.js scopes a block by DELETING
 * injected dependencies — DATA_ROOT, VAULT_ROOT, getDataFile, getVaultFile —
 * when its manifest declares storage.access === 'scoped'.
 *
 * That mechanism can only constrain capability it HANDS OUT. A block that does
 * `require('fs')` and builds its own paths is not scoped by it at all. At
 * 0aba060, 14 of 19 blocks require fs directly, and aeon_matrix computes
 * `DATA_ROOT = path.join(__dirname, ...)` — ignoring the injected dep entirely.
 *
 * So migrating every manifest to `scoped` closes ONE path to a sibling's
 * namespace and leaves the other open. Audit P1-14 already recorded a single
 * instance of this: master declares filesystem:"none", imports fs, and
 * enumerates its sibling block directories. It is not an instance. It is the
 * general case.
 *
 * Closing it properly is an architecture decision (module-level isolation, or
 * making direct fs a build-time violation and porting 14 blocks to
 * blockStorage). Until that decision is made, this scanner does what §19's
 * ratchet principle prescribes for a surface that should only ever shrink:
 * record a baseline and fail the build if the number rises.
 *
 *   node tools/scan/block-fs-surface.cjs          check against the baseline
 *   node tools/scan/block-fs-surface.cjs --write  lower the baseline (deliberate)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BLOCKS_DIR = process.env.AEON_BLOCKS_DIR || path.join(ROOT, 'src', 'blocks');
const BASELINE_FILE = path.join(__dirname, 'block-fs-surface.baseline.json');

const FS_REQUIRE = /require\(\s*['"](?:fs|node:fs|fs\/promises|node:fs\/promises)['"]\s*\)/;

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

function scan() {
  const blocks = fs.readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const perBlock = {};
  let total = 0;

  for (const block of blocks) {
    const hits = [];
    for (const file of sourceFiles(path.join(BLOCKS_DIR, block))) {
      const src = fs.readFileSync(file, 'utf8');
      if (FS_REQUIRE.test(src)) {
        hits.push(path.relative(BLOCKS_DIR, file).split(path.sep).join('/'));
      }
    }
    if (hits.length) {
      perBlock[block] = hits.sort();
      total += hits.length;
    }
  }

  return { total, blocks: Object.keys(perBlock).length, perBlock };
}

function readBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; }
}

function main() {
  const result = scan();
  const write = process.argv.includes('--write');
  const baseline = readBaseline();

  if (write || !baseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      note: 'Direct fs requires inside blocks. This surface may only shrink — see tools/scan/block-fs-surface.cjs.',
      measuredAt: new Date().toISOString().slice(0, 10),
      total: result.total,
      blocks: result.blocks,
      perBlock: result.perBlock,
    }, null, 2) + '\n');
    console.log(`[block-fs-surface] baseline written — ${result.total} direct fs requires across ${result.blocks} blocks.`);
    return 0;
  }

  if (result.total > baseline.total) {
    const added = [];
    for (const [block, files] of Object.entries(result.perBlock)) {
      const before = new Set(baseline.perBlock?.[block] || []);
      for (const f of files) if (!before.has(f)) added.push(f);
    }
    console.error('[block-fs-surface] RATCHET BROKEN');
    console.error(`  direct fs requires inside blocks rose ${baseline.total} → ${result.total}. It may only fall.`);
    if (added.length) {
      console.error('\n  new:');
      for (const f of added) console.error(`    ${f}`);
    }
    console.error('\n  A block reaching the filesystem directly is not constrained by the');
    console.error('  manifest sandbox — the sandbox can only withhold what it injects.');
    console.error('  Use the blockStorage surface, or lower the baseline deliberately:');
    console.error('    node tools/scan/block-fs-surface.cjs --write\n');
    return 1;
  }

  if (result.total < baseline.total) {
    console.log(`[block-fs-surface] IMPROVED — ${baseline.total} → ${result.total}. Lower the baseline:`);
    console.log('  node tools/scan/block-fs-surface.cjs --write');
    return 0;
  }

  console.log(`[block-fs-surface] HELD — ${result.total} direct fs requires across ${result.blocks} blocks (baseline ${baseline.total}).`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { scan };
