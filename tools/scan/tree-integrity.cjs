#!/usr/bin/env node
/**
 * BO-J2 — a test run must not modify committed source.
 *
 *   node tools/scan/tree-integrity.cjs --snapshot   BEFORE npm test
 *   node tools/scan/tree-integrity.cjs              AFTER  npm test
 *
 * It compares the tree against the snapshot, not against HEAD. Comparing
 * against HEAD would fail any developer who runs it with uncommitted work,
 * which turns a real gate into one people learn to skip — and §19 is explicit
 * that a gate skipped once stops being a gate. The delta across the run is the
 * thing being asserted: whatever you had dirty going in, the tests must not
 * have changed it.
 *
 * Why this exists:
 *
 * tests/block-customize.test.js drove the real customize router against the
 * real src/blocks/, mutating council's and writer's committed manifests and
 * restoring them in afterAll. On a clean run the tree ended clean and nothing
 * looked wrong. On 2026-08-10 the race was caught failing two different
 * readers mid-write — block-manifest-routes reading placeholder values, and
 * vercel-mount-parity hitting JSON.parse on a half-written file — about one
 * run in three. A killed run left the damage on disk.
 *
 * BO-J1 fixed that test with an AEON_BLOCKS_DIR override. This gate is the
 * part that survives the fix: the NEXT test to reach for the live install will
 * not carry a warning comment, and this catches it on the first CI run rather
 * than the first corrupted commit.
 *
 * No allowlist by design. If a test needs to write, it writes to a temp fixture.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAPSHOT = path.join(os.tmpdir(), 'aeon-tree-integrity.snapshot');

function treeState() {
  // Tracked files only. Untracked build output and scratch files are not
  // "committed source" and are none of this gate's business.
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let state;
try {
  state = treeState();
} catch {
  // Not a git checkout (tarball install, vendored copy). Nothing to compare
  // against — say so and pass, rather than failing a build over a missing .git.
  console.log('[SCAN tree] SKIP — not a git working tree');
  process.exit(0);
}

if (process.argv.includes('--snapshot')) {
  fs.writeFileSync(SNAPSHOT, state, 'utf8');
  console.log('[SCAN tree] snapshot taken — run again after the suite to compare.');
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT)) {
  // Fail rather than silently pass. A check that quietly does nothing when
  // mis-wired is the "check that cannot fail" this codebase has paid for twice.
  console.error('[SCAN tree] FAIL — no snapshot found.');
  console.error('Run `node tools/scan/tree-integrity.cjs --snapshot` before the suite.');
  process.exit(1);
}

const before = fs.readFileSync(SNAPSHOT, 'utf8');
if (before === state) {
  console.log('[SCAN tree] PASS — the test run modified no committed source.');
  process.exit(0);
}

const parse = (s) => new Map(
  s.split('\n').filter(Boolean).map((l) => [l.slice(3).trim(), l.slice(0, 2)])
);
const b = parse(before);
const a = parse(state);
const touched = [];
for (const [file, code] of a) if (b.get(file) !== code) touched.push(`${code.trim()} ${file}`);
for (const [file] of b) if (!a.has(file)) touched.push(`restored-or-reverted ${file}`);

console.error('[SCAN tree] FAIL — the test run modified committed source:\n');
for (const t of touched) console.error(`  ${t}`);
console.error(`
A test wrote to the live checkout. Point it at a temp copy instead:

  const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-blocks-'));
  fs.cpSync(<real dir>, FIXTURE, { recursive: true });
  process.env.AEON_BLOCKS_DIR = FIXTURE;   // BEFORE requiring the kernel

See tests/block-customize.test.js for the working pattern, and
src/kernel/blocksDir.cjs for why the override resolves once at module load.

Inspect with:  git diff
`);
process.exit(1);
