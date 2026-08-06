/**
 * The shell contract — a block may reach into the kernel, never into services/.
 *
 * WHAT THIS COST (2026-08-05, found building BO-D2a): shared memory policy
 * was placed in services/memory-policy.cjs and required from memory_core.
 * Every unit test passed. The block then 404'd in the empty-shell test,
 * because that test copies the block folder into a bare shell and
 * `../../../../services/` resolves outside it — the require threw, the mount
 * failed, and "installed" stopped meaning "served".
 *
 * The empty-shell test states the contract in its own header:
 *
 *     THE SHELL IS kernel + node_modules. BLOCKS ARE ONLY the folders.
 *
 * That is principle 02 and §03 composability together: "Drop a block folder"
 * only works if the folder is genuinely droppable. A block that reaches
 * sideways into services/ is not a cartridge, it is a dependency with a
 * folder around it.
 *
 * WHY THIS IS A RATCHET, NOT A FLAT BAN
 * Five block files already do this, and they predate the rule. Failing the
 * build on all of them today would block work that has nothing to do with
 * them. So this records the baseline and fails when the number RISES —
 * the same shape as the cloud-surface scanner (§19). Lowering the baseline
 * is a deliberate, visible commit.
 *
 * Empty-shell catches this only for the blocks it installs (settings and
 * memory_core — 2 of 19). This reads all of them, statically, with no boot.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');

/**
 * Known violations as of 2026-08-05. Each entry is a block FILE that
 * top-level-requires something under services/.
 *
 * To remove an entry: move what it needs into src/kernel/ (as
 * tokens.cjs and memory-policy.cjs were), then delete the line.
 * Never add one.
 */
const BASELINE = new Set([
  'aeon_matrix/api/_lib.cjs',
  'council/api/index.cjs',
  'dashboard/api/chat-stream.cjs',
  'dashboard/api/chat.cjs',
  'fleet_control/api/local-status.js',
]);

/** require('...services/...') anywhere in the file. */
const SERVICES_REQUIRE = /require\((['"])([^'"]*services\/[^'"]*)\1\)/g;

function blockFilesRequiringServices() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(cjs|js|jsx)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (SERVICES_REQUIRE.test(src)) {
        out.push(path.relative(BLOCKS, p).split(path.sep).join('/'));
      }
      SERVICES_REQUIRE.lastIndex = 0;
    }
  };
  walk(BLOCKS);
  return out.sort();
}

describe('block shell contract', () => {
  it('no NEW block file reaches into services/', () => {
    const found = blockFilesRequiringServices();
    const added = found.filter(f => !BASELINE.has(f));
    // If this fails: move the shared code into src/kernel/ instead. A block
    // that requires services/ mounts and then 404s in a bare shell, which is
    // the worst shape of failure — it reports success and serves nothing.
    expect(added).toEqual([]);
  });

  it('the baseline only ever shrinks', () => {
    const found = new Set(blockFilesRequiringServices());
    const fixed = [...BASELINE].filter(f => !found.has(f));
    // Not a failure — a prompt. Delete these lines from BASELINE.
    if (fixed.length) {
      throw new Error(
        `These no longer reach into services/. Remove them from BASELINE:\n  ${fixed.join('\n  ')}`
      );
    }
    expect(found.size).toBeLessThanOrEqual(BASELINE.size);
  });

  it('what BO-D2a added is on the right side of the line', () => {
    // The two modules this rule was learned on must be kernel-resident, and
    // must not themselves reach back into services/.
    for (const f of ['tokens.cjs', 'memory-policy.cjs']) {
      const p = path.join(ROOT, 'src', 'kernel', f);
      expect(fs.existsSync(p), `${f} must live in src/kernel/`).toBe(true);
      expect(fs.readFileSync(p, 'utf8')).not.toMatch(/require\(['"][^'"]*services\//);
    }
  });
});
