/**
 * The block filesystem surface may only shrink.
 *
 * BO-SHIP P2.2 discovery. The block sandbox scopes a block by DELETING the
 * dependencies it injects — DATA_ROOT, VAULT_ROOT, getDataFile, getVaultFile.
 * That can only constrain capability it hands out. A block that calls
 * `require('fs')` and builds its own paths is not scoped by it at all.
 *
 * Audit P1-14 recorded one instance: master declares filesystem:"none",
 * imports fs, and enumerates its sibling block directories. Measured at
 * 0aba060, it is not an instance — 27 direct fs requires across 14 blocks, and
 * aeon_matrix computes DATA_ROOT from __dirname, ignoring the injected dep.
 *
 * Note `_blank` is on that list. It is the scaffold every new block is cloned
 * from, so the pattern propagates by default rather than by choice.
 *
 * Closing this properly is an architecture decision, not a patch — see the
 * build order. Until it is made, §19's ratchet principle applies: record the
 * baseline, fail the build if it rises.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = path.join(__dirname, '..');
const SCANNER = path.join(ROOT, 'tools', 'scan', 'block-fs-surface.cjs');
const BASELINE = path.join(ROOT, 'tools', 'scan', 'block-fs-surface.baseline.json');

function runScanner(blocksDir) {
  const env = { ...process.env };
  if (blocksDir) env.AEON_BLOCKS_DIR = blocksDir;
  try {
    const stdout = execFileSync(process.execPath, [SCANNER], { cwd: ROOT, encoding: 'utf8', env });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// CEO decision, 2026-08-12: direct fs is a build-time violation and blocks
// port to blockStorage. The 13 blocks still holding fs are grandfathered under
// the ratchet above and come down one at a time. The scaffolds are NOT
// grandfathered — they are what every new block is copied from, so a violation
// there is a violation in every block written from today onward.
describe('the scaffolds teach the sanctioned pattern', () => {
  const FS_REQUIRE = /require\(\s*['"](?:fs|node:fs|fs\/promises|node:fs\/promises)['"]\s*\)/;

  const stripComments = (src) => src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  function sourcesOf(block) {
    const dir = path.join(ROOT, 'src', 'blocks', block);
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'data' && e.name !== 'db') walk(p); }
        else if (/\.(cjs|js|jsx|mjs)$/.test(e.name)) out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  it.each(['_blank', '_template'])('%s requires no filesystem module', (block) => {
    const offenders = sourcesOf(block)
      .filter((f) => FS_REQUIRE.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f));

    expect(
      offenders,
      `${block} is the scaffold every new block is cloned from — a direct fs `
      + `require here propagates to every block written from now on`,
    ).toEqual([]);
  });

  it('_blank persists through blockStorage', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', '_blank', 'api', 'blank.cjs'), 'utf8');
    expect(src).toMatch(/blockStorage/);
    // And it must not teach writing into the block's own source folder.
    expect(stripComments(src)).not.toMatch(/__dirname\s*,\s*['"]\.\.['"]\s*,\s*['"]data['"]/);
  });
});

describe('block fs surface ratchet', () => {
  it('holds at the recorded baseline', () => {
    const r = runScanner();
    expect(r.stdout).toMatch(/HELD|IMPROVED/);
    expect(r.code, r.stdout).toBe(0);
  });

  it('has a baseline that matches a real measurement', () => {
    const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    expect(b.total).toBeGreaterThan(0);
    expect(Object.keys(b.perBlock).length).toBe(b.blocks);
    // Every listed file must still exist, or the baseline is describing a tree
    // that no longer exists and the number means nothing.
    for (const files of Object.values(b.perBlock)) {
      for (const f of files) {
        expect(fs.existsSync(path.join(ROOT, 'src', 'blocks', f)), `${f} is in the baseline but missing`).toBe(true);
      }
    }
  });

  // A ratchet that cannot report a rise is decoration. Proven by injection
  // rather than asserted, because the doubled-backslash gate of 2026-08-11
  // reported 0 dead while two routes were unmounted.
  //
  // The probe tree is synthetic and lives in the OS temp dir, driven through
  // AEON_BLOCKS_DIR. An earlier draft wrote the probe into src/blocks and the
  // clean-room gate caught it — correctly. A test that mutates the checkout to
  // prove a point is the exact defect BO-J was written about.
  it('reports a rise, naming the file', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-fs-ratchet-'));
    try {
      // One more direct-fs file than the baseline records.
      for (let i = 0; i <= baseline.total; i++) {
        const dir = path.join(tmp, `probe_block_${i}`, 'api');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'handler.cjs'), "const fs = require('fs');\nmodule.exports = () => {};\n");
      }

      const r = runScanner(tmp);
      expect(r.code, 'the ratchet did not fail on a risen surface').toBe(1);
      expect(r.stdout).toMatch(/RATCHET BROKEN/);
      expect(r.stdout).toMatch(/handler\.cjs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // And it must recover — a gate stuck red gets skipped, and §19 is explicit
    // that a gate skipped once stops being a gate.
    expect(runScanner().code).toBe(0);
  });
});
