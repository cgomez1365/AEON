#!/usr/bin/env node
/**
 * Phase 1 gate — path authority scan.
 *
 * Fails CI when production source reaches for a machine root outside the one
 * module allowed to do it. Drive-letter literals and home-directory access
 * are how a "works on my machine" path silently ships.
 *
 * Run: npm run scan:paths
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Production trees only — tests legitimately construct fixture paths. */
const SCAN_DIRS = ['services', 'server', 'src', 'security'];

const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'tests', 'data', 'coverage']);
const EXT = new Set(['.js', '.cjs', '.mjs', '.jsx']);

/**
 * Files permitted to resolve machine roots. Keep this list SHORT and justified;
 * every entry is a place a path bug can hide.
 */
const ALLOWED = new Set([
  // The single path authority for the native local runtime (Phase 1).
  'services/local-runtime/paths.cjs',
  // Pre-existing AEON storage seam — owns VAULT_ROOT/DATA_ROOT.
  'services/storage.js',
]);

const RULES = [
  {
    id: 'drive-letter-literal',
    // C:\ or C:/ inside a string literal. Catches "C:\\Users\\cgome\\..."
    re: /['"`][A-Za-z]:[\\/]{1,2}[^'"`\n]{2,}['"`]/g,
    msg: 'hardcoded drive-letter path literal',
    allowAll: false,
  },
  {
    id: 'home-root',
    re: /\b(os\.homedir\s*\(|process\.env\.(USERPROFILE|HOMEPATH)\b|process\.env\.HOME\b)/g,
    msg: 'home-directory root access outside the path authority',
    allowAll: false,
  },
  {
    id: 'legacy-model-root',
    re: /\.ollama\b|[\\/]models[\\/]blobs\b/g,
    msg: 'legacy external model root reference',
    allowAll: false,
  },
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(full, out);
    } else if (EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function main() {
  const findings = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, d))) {
      const r = rel(file);
      if (ALLOWED.has(r)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(src)) !== null) {
          const line = src.slice(0, m.index).split('\n').length;
          const text = (lines[line - 1] || '').trim();
          // An eslint-style opt-out keeps a genuine migration adapter legal,
          // but forces it to be explicit and greppable.
          if (/aeon-path-authority-allow/.test(text)) continue;
          findings.push({ file: r, line, rule: rule.id, msg: rule.msg, text: text.slice(0, 140) });
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log('[SCAN paths] PASS — no unauthorized machine-root access in production source.');
    process.exit(0);
  }

  console.error(`[SCAN paths] FAIL — ${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.msg}`);
    console.error(`      ${f.text}`);
  }
  console.error('\nFix: route the path through services/local-runtime/paths.cjs,');
  console.error('or annotate a justified migration adapter with: // aeon-path-authority-allow');
  process.exit(1);
}

main();
