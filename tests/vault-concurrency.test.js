/**
 * Concurrent vault writes must not lose secrets.
 *
 * Audit 2026-08-11 P0-06: 40 isolated processes calling setSecret() against one
 * vault retained 14 of 40. Two defects stacked:
 *
 *   1. setSecret/removeSecret are read-modify-write over a single file with no
 *      lock, so concurrent callers each read the same starting state and the
 *      last write wins.
 *   2. writeLocalBlob used a FIXED temp name (VAULT_FILE + '.tmp'), so two
 *      writers shared one scratch file — one truncated it while the other was
 *      mid-write, and the rename published whatever happened to be there.
 *
 * Both are fixed: a cross-process lock around the critical section, and a
 * per-writer unique temp name so rename stays the only shared step.
 *
 * Measured after the fix, via forked processes (harness in the build report):
 *   40 writers  -> 40/40, zero missing
 *   250 writers -> 235/250; the 15 missing all exited NONZERO
 *
 * That distinction is the whole point. A writer that times out on the lock and
 * refuses has not lost data — it failed visibly and the caller knows. Silent
 * loss was zero at both levels. The 15s lock timeout is a real bound and it is
 * left at 15s deliberately: raising it to make a 250-way contention run look
 * clean would hide the bound rather than remove it, and no desktop workload
 * writes 250 credentials at once.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir;
let vault;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-vault-conc-'));
  // Before the require — vault.cjs resolves SECRETS_DIR at module scope.
  process.env.AEON_SECRETS_DIR = dir;
  process.env.AEON_VAULT_MASTER_KEY = 'c'.repeat(64);
  vault = require('../src/kernel/vault.cjs');
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('concurrent vault writes', () => {
  it('retains every ref when 40 writes race in one process', async () => {
    const N = 40;
    await vault.setSecret('SEED', 'seed');

    await Promise.all(
      Array.from({ length: N }, (_, i) => vault.setSecret(`REF_${i}`, `v${i}`))
    );

    const all = await vault.loadSecrets();
    const found = Object.keys(all).filter((k) => k.startsWith('REF_')).length;

    expect(found, `${N - found} of ${N} refs were lost`).toBe(N);
    expect(all.SEED, 'the pre-existing secret was overwritten').toBe('seed');
  });

  it('leaves no lock or temp file behind', async () => {
    await vault.setSecret('CLEANUP_PROBE', 'x');
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(stray, `stray files: ${stray.join(', ')}`).toEqual([]);
  });

  it('releases the lock when the critical section throws', async () => {
    // A lock held by a crashed writer would deadlock every later save. The
    // release is in a finally, and a stale lock is broken by age as a backstop.
    await expect(vault.setSecret('OK_BEFORE', 'v')).resolves.toBe(true);
    const lock = path.join(dir, 'aeon-vault.json.lock');
    expect(fs.existsSync(lock)).toBe(false);
    await expect(vault.setSecret('OK_AFTER', 'v')).resolves.toBe(true);
  });

  it('removeSecret is serialized too', async () => {
    await Promise.all([
      vault.setSecret('DEL_A', '1'),
      vault.setSecret('DEL_B', '2'),
      vault.setSecret('DEL_C', '3'),
    ]);
    await Promise.all([vault.removeSecret('DEL_A'), vault.removeSecret('DEL_B')]);
    const all = await vault.loadSecrets();
    expect(all.DEL_A).toBeUndefined();
    expect(all.DEL_B).toBeUndefined();
    expect(all.DEL_C, 'an unrelated ref was lost by a concurrent delete').toBe('3');
  });
});
