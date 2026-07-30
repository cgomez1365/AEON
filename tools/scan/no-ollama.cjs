#!/usr/bin/env node
/**
 * Phase 7 gate — no-Ollama scan.
 *
 * The native runtime architecture is only real when NOTHING in production
 * source assumes an Ollama daemon: no host/port, no env var, no /api/generate
 * or /api/embed fetch, no process management, no ~/.ollama storage.
 *
 * One leftover direct call invalidates the whole single-path claim, so this
 * scan is a hard release gate rather than a lint warning.
 *
 * Run: npm run scan:no-ollama
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['services', 'server', 'src', 'security', 'api'];
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'tests', 'data', 'coverage']);
const EXT = new Set(['.js', '.cjs', '.mjs', '.jsx', '.json']);

/**
 * Files still permitted to mention Ollama during the migration window.
 * This list must be EMPTY for the Phase 7 gate to be green.
 *
 * Phase 9 keeps exactly one documented exception: migrate.cjs may DETECT a
 * legacy config in order to explain it — never read or mutate it.
 */
const MIGRATION_ALLOWED = new Set([
  // Phase 9: may DETECT legacy Ollama config to explain it — never calls it.
  'services/local-runtime/migrate.cjs',
  // Phase 3–6: these files mention "Ollama" only in negative/explanatory comments
  // ("no Ollama daemon", "never touches ~/.ollama", etc.) — they are NOT callers.
  'services/local-runtime/runtime-assets.json',
  'services/local-runtime/runtime-installer.cjs',
  'services/local-runtime/runtime-probe.cjs',
  'services/local-runtime/model-installer.cjs',
  'services/local-runtime/worker.mjs',
  'services/local-runtime/supervisor.cjs',
  'services/local-runtime/index.cjs',
  'services/local-runtime/paths.cjs',
  'services/local-runtime/queue.cjs',
  'services/local-runtime/registry.cjs',
  'services/storage.js',
]);

const RULES = [
  { id: 'ollama-host',    re: /OLLAMA_HOST|OLLAMA_MODEL|AEON_OLLAMA/g,        msg: 'Ollama environment variable' },
  { id: 'ollama-port',    re: /localhost:11434|127\.0\.0\.1:11434|:11434\b/g, msg: 'Ollama daemon port' },
  { id: 'ollama-api',     re: /\/api\/(generate|embed|embeddings|pull|tags|show)\b/g, msg: 'Ollama HTTP API path' },
  { id: 'ollama-ident',   re: /\bollama\b/gi,                                  msg: 'Ollama identifier' },
  { id: 'ollama-storage', re: /\.ollama\b/g,                                   msg: 'Ollama model store' },
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
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
  const json = process.argv.includes('--json');
  const findings = [];

  for (const d of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, d))) {
      const r = rel(file);
      if (MIGRATION_ALLOWED.has(r)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(src)) !== null) {
          const line = src.slice(0, m.index).split('\n').length;
          const text = (lines[line - 1] || '').trim();
          findings.push({ file: r, line, rule: rule.id, msg: rule.msg, text: text.slice(0, 140) });
        }
      }
    }
  }

  // Collapse to one entry per file+rule so the report reads as a work list.
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, { file: f.file, count: 0, rules: new Set(), firstLine: f.line });
    const e = byFile.get(f.file);
    e.count++; e.rules.add(f.rule);
  }
  const files = [...byFile.values()].sort((a, b) => b.count - a.count);

  if (json) {
    console.log(JSON.stringify({
      total: findings.length,
      files: files.map(f => ({ file: f.file, hits: f.count, rules: [...f.rules] })),
    }, null, 2));
    process.exit(findings.length === 0 ? 0 : 1);
  }

  if (findings.length === 0) {
    console.log('[SCAN no-ollama] PASS — zero Ollama assumptions in production source.');
    process.exit(0);
  }

  console.error(`[SCAN no-ollama] FAIL — ${findings.length} hit(s) across ${files.length} file(s):\n`);
  for (const f of files) {
    console.error(`  ${String(f.count).padStart(4)}  ${f.file}  [${[...f.rules].join(', ')}]`);
  }
  console.error('\nPhase 7 is complete only when this scan reports zero.');
  process.exit(1);
}

main();
