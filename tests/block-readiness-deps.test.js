/**
 * A block whose declared dependency is not installed says so.
 *
 * `requires.blocks` was normalized into every manifest and then never read:
 * with fleet_control removed, cookbook (which declares it) still counted as
 * ready while its /api/hwfit calls answered 404 (measured 2026-09-23, one block
 * removed at a time). Blocks are meant to be added and removed one by one
 * (Bible §03, "Composable"), so a missing dependency must be visible.
 *
 * It degrades rather than un-readies, on purpose — the same line readiness
 * already draws for AI roles: Writer drafts without memory_core; only its
 * "push to memory" needs it.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkReadiness } = require('../src/kernel/blockStandard.cjs');

const manifest = (blocks) => ({ id: 'cookbook', requires: { apis: [], env: [], local: [], blocks } });

describe('requires.blocks is checked', () => {
  it('names a missing dependency and marks the block degraded, not unready', () => {
    const r = checkReadiness(manifest(['fleet_control']), {}, new Set(['cookbook', 'settings']));
    expect(r.missingBlocks).toEqual(['fleet_control']);
    expect(r.degraded).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('an installed dependency is not reported', () => {
    const r = checkReadiness(manifest(['fleet_control']), {}, new Set(['cookbook', 'fleet_control']));
    expect(r.missingBlocks).toEqual([]);
    expect(r.degraded).toBe(false);
  });

  it('with no set given, it reads the installed blocks itself', () => {
    // fleet_control ships in src/blocks, so the real tree satisfies cookbook.
    const r = checkReadiness(manifest(['fleet_control']), {});
    expect(r.missingBlocks).toEqual([]);
    const r2 = checkReadiness(manifest(['no_such_block']), {});
    expect(r2.missingBlocks).toEqual(['no_such_block']);
  });
});

describe('the dependencies field mirrors requires.blocks', () => {
  it('an empty dependencies list no longer hides a declared requires.blocks', () => {
    // `m.dependencies || m.requires.blocks` let an empty [] win, so cookbook's
    // declared need for fleet_control never showed in its own manifest
    // (found 2026-09-23). The field is the union, as the Master README says.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-deps-'));
    const saved = process.env.AEON_BLOCKS_DIR;
    process.env.AEON_BLOCKS_DIR = dir;
    for (const m of ['../src/kernel/blocksDir.cjs', '../src/kernel/blockStandard.cjs']) delete require.cache[require.resolve(m)];
    try {
      fs.mkdirSync(path.join(dir, 'cookbook'));
      fs.writeFileSync(path.join(dir, 'cookbook', 'block.manifest.json'), JSON.stringify({
        id: 'cookbook', name: 'cookbook', version: '1.0.0', route: '/cookbook',
        dependencies: [], requires: { blocks: ['fleet_control'] },
      }));
      const std = require('../src/kernel/blockStandard.cjs');
      expect(std.normalizeManifest('cookbook').dependencies).toEqual(['fleet_control']);
    } finally {
      if (saved === undefined) delete process.env.AEON_BLOCKS_DIR; else process.env.AEON_BLOCKS_DIR = saved;
      for (const m of ['../src/kernel/blocksDir.cjs', '../src/kernel/blockStandard.cjs']) delete require.cache[require.resolve(m)];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
