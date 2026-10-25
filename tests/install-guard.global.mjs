/**
 * The suite leaves the install exactly as it found it — checked, not hoped.
 *
 * setup-isolation.js redirects every root the kernel resolves (AEON_HOME,
 * secrets, data) before any test module loads. It cannot catch a path that is
 * built from __dirname: a block's fallback root, a fixed tools/ directory, a
 * test that hands a router no data root. Those landed in the install on every
 * `npx vitest run` (2026-10-25, a bare clone after a full run):
 *
 *     data/writer/                    writer.js fallback, no getBlockDataFile
 *     src/blocks/aeon_matrix/data/    second-brain-r09 mounted with no getDataFile
 *     tools/bin/                      cloudflare-tunnel-platform drives the real BIN_DIR
 *     staging/                        boot-proof stages fixtures in the real STAGING_DIR
 *
 * Empty, so `git status` never showed them, and harmless on a developer
 * clone. On an install that holds real data they are the suite provisioning
 * the operator's tree, which tests may observe and never provision.
 *
 * globalSetup runs once in the main process, before the first worker and after
 * the last, so the comparison sees the whole run with no ordering luck. Any
 * path that exists after the run and did not before fails the run, by name.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Not the install's content: dependencies, history, and what `vitest --coverage` writes.
const SKIP = new Set(['node_modules', '.git', 'coverage']);
// boot-proof must stage inside the repo (node_modules resolution, see
// bootProof.cjs environmentError). Its fixtures are removed per test; the
// parent is shared by two files in two workers, so only the main process can
// tell whether this run created it.
const SHARED_STAGING = path.join(INSTALL, 'staging');

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (dir === INSTALL && SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    out.add(path.relative(INSTALL, full));
    if (e.isDirectory() && !e.isSymbolicLink()) walk(full, out);
  }
  return out;
}

export function listInstall() { return walk(INSTALL, new Set()); }

export default function setup() {
  const before = listInstall();
  const stagingExisted = fs.existsSync(SHARED_STAGING);
  return function teardown() {
    if (!stagingExisted) {
      try { fs.rmdirSync(SHARED_STAGING); } catch { /* absent, or not empty — reported below */ }
    }
    const added = [...listInstall()].filter((p) => !before.has(p)).sort();
    if (added.length) {
      // A throw here is printed as "error during close" and vitest still exits
      // 0 (seen on 4.1.11), so the exit code is set explicitly: CI must go red.
      process.exitCode = 1;
      throw new Error(
        `The test run wrote ${added.length} new path(s) into the install (${INSTALL}). `
        + 'A test may observe an install, never provision one — redirect the root '
        + '(setup-isolation.js, deps.getDataFile, a temp app copy) instead:\n  '
        + added.slice(0, 40).join('\n  ') + (added.length > 40 ? '\n  …' : ''),
      );
    }
  };
}
