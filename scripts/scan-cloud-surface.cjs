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

/**
 * Blank every comment and the CONTENTS of every string, template and regex
 * literal, in one left-to-right pass that knows where literals are. Newlines
 * are kept so line numbers still mean something.
 *
 * The regex this replaces could not tell "/*" in code from "/*" in a string.
 * server/server.js logs '.../api/token-analytics/*'; the stripper opened a
 * comment there and discarded 135 lines of code — four isVercel branches —
 * until an unrelated "*\/" closed it (found 2026-09-22, when deleting that
 * comment made the count "rise" with no branch written). Template ${…} stays
 * code. A "/" starts a regex only where a value cannot end — the usual rule.
 */
function stripNonCode(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  const tplDepth = [];   // brace depth at each open ${ — its matching } returns to the template
  let depth = 0;
  // The last few characters of CODE (a literal counts as one value "v", a run
  // of whitespace or a comment as one space) — enough to decide whether a "/"
  // opens a regex, without re-reading the output (that made this quadratic).
  let tail = '';
  const note = (ch) => { tail = (tail + ch).slice(-24); };

  const regexCanStart = () => {
    const code = tail.replace(/\s+$/, '');
    if (!code) return true;
    const last = code[code.length - 1];
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
    return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(code);
  };

  // Scan a template from just after an opening backtick (or a closing "}" of
  // ${…}) up to its end or its next ${. Returns false when it hit ${.
  const readTemplate = () => {
    let j = i;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { out += blank(src.slice(i, j)) + '`'; i = j + 1; return true; }
      if (src[j] === '$' && src[j + 1] === '{') {
        out += blank(src.slice(i, j)) + '${'; i = j + 2;
        tplDepth.push(depth); depth++;
        return false;
      }
      j++;
    }
    out += blank(src.slice(i)); i = n; return true;
  };

  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j)); i = j; note(' '); continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(src.slice(i, stop)); i = stop; note(' '); continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : '');
      i = src[j] === c ? j + 1 : j; note('v'); continue;
    }
    if (c === '`') { out += '`'; i++; if (readTemplate()) note('v'); else note('{'); continue; }
    if (c === '/' && regexCanStart()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') {
        j++; while (j < n && /[a-z]/i.test(src[j])) j++;
        out += '/' + blank(src.slice(i + 1, j - 1)) + '/';
        i = j; note('v'); continue;
      }
      // not a regex after all (an unterminated line) — treat the "/" as code
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (tplDepth.length && tplDepth[tplDepth.length - 1] === depth) {
        tplDepth.pop(); out += '}'; i++; if (readTemplate()) note('v'); else note('{'); continue;
      }
    }
    out += c; i++;
    note(/\s/.test(c) ? ' ' : c);
  }
  return out;
}

/** Counted uses in one file's source. */
function countIn(source) {
  const code = stripNonCode(source);
  return { envReads: (code.match(READ_RE) || []).length, flagUses: (code.match(FLAG_RE) || []).length };
}

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

    // Literal-aware (see stripNonCode). Two regex strippers before it each
    // hid real branches: stripping block comments first let a `/*` inside a
    // line comment swallow 200 lines; stripping both in one alternation still
    // let a `/*` inside a STRING swallow 135.
    const { envReads: e, flagUses: f } = countIn(fs.readFileSync(file, 'utf8'));
    if (e + f === 0) continue;

    envReads += e;
    flagUses += f;
    perFile[rel.replace(/\\/g, '/')] = { envReads: e, flagUses: f };
  }

  return { envReads, flagUses, total: envReads + flagUses, files: Object.keys(perFile).length, perFile };
}

module.exports = { scan, stripNonCode, countIn };

if (require.main === module) {
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
}
