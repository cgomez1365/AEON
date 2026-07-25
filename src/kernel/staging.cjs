/**
 * K5 + DX1 — staging airlock, deterministic lint, pack.
 * The lint is string/AST-lite checks, NEVER an LLM call (Ship Plan B2 rule:
 * asking a model if code is risky makes the gate exploitable).
 *
 * Used by tools/aeon-cli.cjs (aeon lint / pack / promote) and later by the
 * Track B auto-build pipeline. staging/ lives at repo root; a block that
 * fails lint never reaches src/blocks/ (Non-Negotiable II).
 */
const path = require('path');
const fs   = require('fs');

const ROOT        = path.join(__dirname, '..', '..');
const BLOCKS_DIR  = path.join(ROOT, 'src', 'blocks');
const STAGING_DIR = path.join(ROOT, 'staging');
const SCHEMA      = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));

// ── Minimal schema validation (required fields + enums + types we care about) ──
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  for (const f of SCHEMA.required) if (m[f] === undefined) errors.push(`missing required field: ${f}`);
  if (m.id && !/^[a-z0-9_]+$/.test(m.id)) errors.push(`id "${m.id}" must be lowercase [a-z0-9_]`);
  if (m.route && !String(m.route).startsWith('/')) errors.push('route must start with /');
  const perms = m.contract?.permissions;
  if (perms) {
    if (perms.filesystem && !['none', 'read', 'write'].includes(perms.filesystem)) errors.push(`invalid permissions.filesystem: ${perms.filesystem}`);
    if (perms.network && !['none', 'internal', 'external'].includes(perms.network)) errors.push(`invalid permissions.network: ${perms.network}`);
  }
  const [major, minor] = String(m.manifestVersion || '1.0.0').split('.').map(Number);
  if (major > 1 || (major === 1 && minor >= 1)) {
    const storage = m.contract?.storage;
    const memory = m.contract?.memory;
    if (!storage?.local || storage.local.indexed !== false) errors.push('v1.1 requires contract.storage.local.indexed=false');
    if (!['operational', 'ephemeral'].includes(storage?.local?.retention)) errors.push('v1.1 requires operational or ephemeral local retention');
    if (storage?.access !== 'scoped') errors.push('new v1.1 blocks must use contract.storage.access=scoped');
    if (!memory || !['none', 'summary', 'document'].includes(memory.mode)) errors.push('v1.1 requires contract.memory.mode');
    if (memory && memory.indexed !== (memory.mode !== 'none')) errors.push('contract.memory.indexed must match whether memory.mode is enabled');
    if ((storage?.type !== 'none' || memory?.mode !== 'none') && perms?.filesystem !== 'write') {
      errors.push('declared storage or memory requires permissions.filesystem=write');
    }
  }
  return errors;
}

// ── Deterministic code checks ────────────────────────────────────────────────
const CODE_CHECKS = [
  { id: 'path-traversal',   sev: 'HIGH',   re: /\.\.[\/\\]\.\.[\/\\]|(['"`]\.\.['"`]\s*,\s*){2,}/,
    why: 'references paths outside own block (sandbox escape attempt)' },
  { id: 'secret-file-read', sev: 'HIGH',   re: /['"`][^'"`]*\.env(\.[a-z]+)?['"`]|[\/\\]secrets[\/\\]/i,
    why: 'touches .env or secrets/ — credentials never leave the vault' },
  { id: 'child-process',    sev: 'HIGH',   re: /require\(['"`]child_process['"`]\)|\bexecSync\b|\bspawnSync\b/,
    why: 'shell execution — requires permissions.shell=true + Tier 3 review' },
  { id: 'eval',             sev: 'HIGH',   re: /\beval\s*\(|new\s+Function\s*\(/,
    why: 'dynamic code evaluation' },
  { id: 'hardcoded-secret', sev: 'HIGH',   re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"`][A-Za-z0-9_\-]{20,}['"`]/i,
    why: 'hardcoded credential — use the vault' },
  { id: 'env-write',        sev: 'MEDIUM', re: /process\.env\[[^\]]+\]\s*=|process\.env\.\w+\s*=/,
    why: 'mutates process.env at runtime' },
  { id: 'global-mutation',  sev: 'MEDIUM', re: /\bglobal\.\w+\s*=/,
    why: 'writes to global scope' },
];

/**
 * Scan in-memory sources [{path, content}] against CODE_CHECKS.
 * Shared by lintBlock (on-disk) and the complexity gate (envelope files).
 */
function scanSources(sources, { declaredShell = false } = {}) {
  const findings = [];
  for (const { path: rel, content } of sources) {
    // Importing kernel modules is the sanctioned block API — don't count those
    // relative paths as traversal. Everything else with ../.. still flags.
    const src = content.replace(/require\(\s*['"`][./\\]+kernel\/[^'"`]+['"`]\s*\)/g, 'require("aeon-kernel")');
    for (const check of CODE_CHECKS) {
      if (check.re.test(src)) {
        const excused = check.id === 'child-process' && declaredShell;
        findings.push({ check: check.id, sev: excused ? 'DECLARED' : check.sev, file: rel, why: check.why });
      }
    }
  }
  return findings;
}

/**
 * B6 failure mode #5 — circular imports crash the loader mid-remount.
 * Deterministic graph walk over block-LOCAL relative requires/imports.
 * Kernel imports and node_modules are out of scope (not part of the block's
 * own cycle surface). Returns array of cycle strings, e.g. "a.cjs → b.cjs → a.cjs".
 */
function detectCircularImports(sources) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const byPath = new Map(sources.map(s => [norm(s.path), s]));
  const resolve = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null; // node_modules / kernel — not block-local
    const baseDir = norm(fromFile).split('/').slice(0, -1).join('/');
    const joined = norm((baseDir ? baseDir + '/' : '') + spec)
      .split('/').reduce((acc, seg) => {
        if (seg === '..') acc.pop(); else if (seg !== '.') acc.push(seg);
        return acc;
      }, []).join('/');
    for (const cand of [joined, `${joined}.cjs`, `${joined}.js`, `${joined}.jsx`, `${joined}.mjs`,
                        `${joined}/index.cjs`, `${joined}/index.js`, `${joined}/index.jsx`]) {
      if (byPath.has(cand)) return cand;
    }
    return null;
  };

  const edges = new Map();
  const IMPORT_RE = /(?:require\(\s*|from\s+|import\s*\(\s*)['"`](\.[^'"`]+)['"`]/g;
  for (const s of sources) {
    const deps = [];
    for (const m of s.content.matchAll(IMPORT_RE)) {
      const target = resolve(s.path, m[1]);
      if (target && target !== norm(s.path)) deps.push(target);
    }
    edges.set(norm(s.path), deps);
  }

  const cycles = [];
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  function dfs(node, stack) {
    state.set(node, 1); stack.push(node);
    for (const dep of edges.get(node) || []) {
      if (state.get(dep) === 1) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' → '));
      } else if (!state.get(dep)) dfs(dep, stack);
    }
    stack.pop(); state.set(node, 2);
  }
  for (const node of edges.keys()) if (!state.get(node)) dfs(node, []);
  return cycles;
}

function walkFiles(dir, exts = /\.(cjs|js|jsx|mjs)$/) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'data') continue;
      out.push(...walkFiles(full, exts));
    } else if (exts.test(name)) out.push(full);
  }
  return out;
}

/**
 * Lint a block folder (staging/<id> or src/blocks/<id>).
 * Returns { score: 'LOW'|'MEDIUM'|'HIGH', errors[], findings[] }.
 * errors = schema/structure failures (always block promotion).
 * findings = code check hits; HIGH findings that aren't declared in the
 * manifest's permissions also block promotion.
 */
function lintBlock(blockDir) {
  const errors = [];
  const findings = [];

  const manifestPath = path.join(blockDir, 'block.manifest.json');
  if (!fs.existsSync(manifestPath)) return { score: 'HIGH', errors: ['no block.manifest.json'], findings };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { score: 'HIGH', errors: [`manifest is not valid JSON: ${e.message}`], findings }; }

  errors.push(...validateManifest(manifest));
  const folderName = path.basename(blockDir);
  if (manifest.id && manifest.id !== folderName) errors.push(`manifest id "${manifest.id}" != folder name "${folderName}"`);
  if (!fs.existsSync(path.join(blockDir, 'index.jsx'))) errors.push('missing index.jsx');

  const declaredShell = manifest.contract?.permissions?.shell === true;
  const sources = walkFiles(blockDir).map(f => ({ path: path.relative(blockDir, f), content: fs.readFileSync(f, 'utf8') }));
  findings.push(...scanSources(sources, { declaredShell }));

  // B6 #5 — circular imports crash the loader on remount; block before promote.
  for (const cycle of detectCircularImports(sources)) {
    findings.push({ check: 'circular-import', sev: 'HIGH', file: cycle.split(' → ')[0], why: `circular import: ${cycle}` });
  }

  const hasHigh = findings.some(f => f.sev === 'HIGH');
  const hasMed  = findings.some(f => f.sev === 'MEDIUM');
  const score = errors.length || hasHigh ? 'HIGH' : hasMed ? 'MEDIUM' : 'LOW';
  return { score, errors, findings, manifest };
}

/**
 * Promote staging/<id> → src/blocks/<id>. Fails closed: any lint error or
 * undeclared HIGH finding rolls back (staging copy left in place for fixing).
 */
function promoteBlock(id) {
  const src = path.join(STAGING_DIR, id);
  const dst = path.join(BLOCKS_DIR, id);
  if (!fs.existsSync(src)) return { ok: false, error: `staging/${id} not found` };
  if (fs.existsSync(dst)) return { ok: false, error: `src/blocks/${id} already exists — bump version and use update flow, or remove the old block first` };

  const lint = lintBlock(src);
  if (lint.errors.length || lint.findings.some(f => f.sev === 'HIGH')) {
    return { ok: false, error: 'lint failed — block stays in staging/', lint };
  }

  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
  return { ok: true, promoted: id, score: lint.score, note: 'restart or rescan the kernel to mount' };
}

function ensureStagingDir() { fs.mkdirSync(STAGING_DIR, { recursive: true }); return STAGING_DIR; }

module.exports = { lintBlock, promoteBlock, ensureStagingDir, validateManifest, scanSources, detectCircularImports, CODE_CHECKS, BLOCKS_DIR, STAGING_DIR };
