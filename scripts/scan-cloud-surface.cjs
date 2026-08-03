#!/usr/bin/env node
/**
 * BO-A3a stage 2 — count the cloud-conditional surface, and ratchet it down.
 *
 * Vercel mode largely turns AEON OFF: the conditionals are overwhelmingly
 * subtractive, of the form
 *
 *   if (isVercel) return res.json({ success: false, reason: 'cloud env — …' })
 *
 * Deleting all of them days before a release is a large diff across many files
 * to remove code that is currently inert. Stage 3 does that, after ship. What
 * stages 1 and 2 buy is that stage 3 becomes an afternoon rather than a gamble:
 * every runtime read goes through src/kernel/runtime.cjs, the surface is
 * countable, and this scanner asserts the count ONLY EVER FALLS.
 *
 * The baseline lives in scripts/cloud-surface-baseline.json. A change that adds
 * cloud branching fails the gate and has to either not do that or lower the
 * baseline deliberately, in its own commit, where a reviewer can see it.
 *
 * Usage:
 *   node scripts/scan-cloud-surface.cjs           # report + enforce the ratchet
 *   node scripts/scan-cloud-surface.cjs --write   # accept the current count
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'cloud-surface-baseline.json');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'data', 'coverage',
  '.aeon-empty-shell-test', 'secrets',
]);

// Tests legitimately manipulate process.env.VERCEL to exercise both runtimes.
// Counting them would punish coverage, which is the opposite of the point.
// The `(^|sep)` anchor matters: paths are relative to the repo root, so the
// top-level suite is `tests\foo.test.js` with NO leading separator. Requiring
// one skipped nothing and quietly put the whole suite into the count.
const SKIP_PATH_RE = /(^|[\\/])(tests|__tests__)[\\/]/;

// The shim itself is the one place allowed to read the raw environment. That
// is its entire job.
const SHIM_REL = path.join('src', 'kernel', 'runtime.cjs');

// This scanner names the patterns it hunts for, in its own regexes and error
// strings. Counting itself would put a permanent floor under the ratchet.
const SELF_REL = path.join('scripts', 'scan-cloud-surface.cjs');

const READ_RE = /process\.env\.VERCEL\w*/g;
const FLAG_RE = /\bisVercel\b/g;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|cjs|mjs|jsx)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

function scan() {
  const perFile = {};
  let envReads = 0;
  let flagUses = 0;

  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (SKIP_PATH_RE.test(rel)) continue;
    if (rel === SHIM_REL || rel === SELF_REL) continue;

    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const e = (src.match(READ_RE) || []).length;
    const f = (src.match(FLAG_RE) || []).length;
    if (e + f === 0) continue;

    envReads += e;
    flagUses += f;
    perFile[rel.replace(/\\/g, '/')] = { envReads: e, flagUses: f };
  }

  return { envReads, flagUses, total: envReads + flagUses, files: Object.keys(perFile).length, perFile };
}

const write = process.argv.includes('--write');
const now = scan();

if (write) {
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: 'BO-A3a ratchet. These numbers may FALL, never rise. Lower them in the same commit that deletes the branches.',
    envReads: now.envReads,
    flagUses: now.flagUses,
    total: now.total,
    files: now.files,
  }, null, 2) + '\n');
  console.log(`[cloud-surface] baseline written: ${now.total} (${now.envReads} env reads + ${now.flagUses} flag uses) across ${now.files} files.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('[cloud-surface] no baseline. Run: node scripts/scan-cloud-surface.cjs --write');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const failures = [];

if (now.envReads > base.envReads) {
  failures.push(`raw process.env.VERCEL reads rose ${base.envReads} → ${now.envReads}. Use src/kernel/runtime.cjs isCloud() instead.`);
}
if (now.total > base.total) {
  failures.push(`cloud-conditional surface rose ${base.total} → ${now.total}. It may only fall.`);
}

if (failures.length) {
  console.error('[cloud-surface] RATCHET BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  console.error('\n  If a branch was genuinely removed, lower the baseline:');
  console.error('    node scripts/scan-cloud-surface.cjs --write');
  process.exit(1);
}

const delta = base.total - now.total;
console.log(
  `[cloud-surface] PASS — ${now.total} conditionals across ${now.files} files ` +
  `(${now.envReads} raw env reads, ${now.flagUses} flag uses)` +
  (delta > 0 ? `; ${delta} fewer than baseline — run --write to lock it in.` : '.')
);
