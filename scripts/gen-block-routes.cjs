#!/usr/bin/env node
// Writes each block's real HTTP routes into its block.manifest.json.
// Run: node scripts/gen-block-routes.cjs        (part of `npm run build`)
//      node scripts/gen-block-routes.cjs --check (CI / test: fail if stale)
//
// 15 of 17 manifests carried `[{ method: 'ALL', path: '/<id>/*', auth: true }]`
// — a placeholder `aeon-cli.cjs` stamped at scaffold time and nobody ever
// replaced. It was wrong three ways at once: the prefix did not match the real
// mount point (router blocks answer under /api, not /<id>), it under-declared
// blocks owning more than one prefix (fleet_control also serves /hwfit/* and
// /api/local-status), and `auth: true` was stamped on routes that are
// deliberately pre-auth.
//
// Nothing routed traffic by it and nothing made an auth decision from it, so
// the placeholder was inert rather than dangerous. But a manifest is supposed
// to be the block's declaration of itself, and this one was fiction. Generating
// beats validating: a generated declaration cannot go stale.
//
// THE PREFIX RULE mirrors blockHost.cjs mount shapes exactly:
//   - a module exporting/returning a ROUTER is mounted twice, at `/api` and at
//     `/block/<folder>`. Its declared paths are relative, so the public path is
//     `/api` + declared.
//   - a PLUGIN registers verbs on the router it is handed, with no prefix, so
//     its declared paths are already absolute and are emitted verbatim.
// If those two ever diverge, the manifest starts lying again — which is the
// whole reason this file exists.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const blocksDir = path.join(ROOT, 'src', 'blocks');
const SKIP = new Set(['__BLANK__', '_template']);

const { PRE_AUTH_ROUTES } = require(
  path.join(ROOT, 'src', 'kernel', 'server-utils', 'sessionValidator.cjs')
);

function apiFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      // `_`-prefixed files are helpers, not routers — blockHost skips them too.
      else if (/\.(js|cjs)$/.test(e.name) && !e.name.startsWith('_')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Deliberately a regex over source rather than a require(): loading a block's
// api module runs its factory, which touches the filesystem and the vault. A
// build step must not boot the product to describe it.
const ROUTE_RE = /\b(?:router|app|sub)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)/g;

// Computed registration: resume_grader does
//   ['get','post','options'].forEach(m => app[m]('/api/resume-grader/grade', h))
// The verb list is a runtime value, so the method cannot be known statically.
// Emitting ALL is the honest answer — better than omitting a route that exists,
// which is what the dotted regex alone did.
const ROUTE_COMPUTED_RE = /\b(?:router|app|sub)\[\s*[\w$]+\s*\]\(\s*['"`]([^'"`]+)/g;

// blockHost decides the mount by the module's ARITY, never by what the
// parameter is called:
//   arity >= 2  -> plugin. Registers on the router it is handed, mounted with
//                  NO prefix, so its paths are already absolute.
//   arity <= 1  -> factory returning a router (or a bare router), mounted at
//                  `/api`, so its paths are relative.
//
// Reading the parameter NAME instead is the trap this comment exists to stop:
// fleet_control/local-status.js is `(router, _deps) => router.get('/api/...')`
// — arity 2, a plugin, whose parameter merely happens to be called `router`.
// Prefixing that produced `/api/api/local-status`, a path nothing serves.
const EXPORT_RE = /module\.exports\s*=\s*(?:async\s*)?(?:function\s*[\w$]*\s*)?\(([^)]*)\)|module\.exports\s*=\s*(?:async\s*)?([\w$]+)\s*=>/;

// Count parameters at nesting depth 0 only. A destructured single parameter is
// full of commas — dashboard/chat-stream.cjs is
//   module.exports = function ({ getLocalFile, GEMINI_KEY_POOL, _trackLLM, … })
// which is ARITY 1, a factory returning a router, mounted at /api. Splitting on
// every comma counted five parameters, misfiled it as a plugin, and stripped
// the prefix off /api/chat/stream — a route the dashboard actually calls.
function countParams(params) {
  let depth = 0, n = params.trim() ? 1 : 0;
  for (const ch of params) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) n++;
  }
  return n;
}

function isPlugin(src) {
  const m = EXPORT_RE.exec(src);
  if (!m) return false;
  if (m[2] !== undefined) return false; // single bare identifier => arity 1
  return countParams(m[1] || '') >= 2;
}

function collect(blockDir) {
  const found = new Map();
  for (const file of apiFiles(path.join(blockDir, 'api'))) {
    const src = fs.readFileSync(file, 'utf8');
    const prefix = isPlugin(src) ? '' : '/api';
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) {
      const [, verb, declared] = m;
      const publicPath = `${prefix}${declared}`;
      const method = verb.toUpperCase();
      found.set(`${method} ${publicPath}`, { method, path: publicPath });
    }
    ROUTE_COMPUTED_RE.lastIndex = 0;
    while ((m = ROUTE_COMPUTED_RE.exec(src))) {
      const publicPath = `${prefix}${m[1]}`;
      found.set(`ALL ${publicPath}`, { method: 'ALL', path: publicPath });
    }
  }
  return [...found.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
}

const routesFor = (blockDir) =>
  collect(blockDir).map(r => ({
    ...r,
    // Truthful, not stamped. The gate's own frozen list is the authority.
    auth: !PRE_AUTH_ROUTES.some(rx => rx.test(r.path)),
  }));

const check = process.argv.includes('--check');
const stale = [];
let changed = 0;

for (const id of fs.readdirSync(blocksDir)) {
  if (SKIP.has(id)) continue;
  const mPath = path.join(blocksDir, id, 'block.manifest.json');
  if (!fs.existsSync(mPath)) continue;

  const raw = fs.readFileSync(mPath, 'utf8');
  const manifest = JSON.parse(raw);
  const next = routesFor(path.join(blocksDir, id));

  if (JSON.stringify(manifest.routes || []) === JSON.stringify(next)) continue;

  if (check) { stale.push(`${id} (${(manifest.routes || []).length} declared, ${next.length} real)`); continue; }

  manifest.routes = next;
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + trailingNewline);
  changed++;
}

if (check) {
  if (stale.length) {
    console.error(`[GEN routes] STALE — ${stale.length} manifest(s) do not match the code:`);
    for (const s of stale) console.error(`  ${s}`);
    console.error('Run: node scripts/gen-block-routes.cjs');
    process.exit(1);
  }
  console.log('[GEN routes] PASS — every manifest matches its real routes.');
} else {
  console.log(`[GEN routes] wrote ${changed} manifest(s).`);
}
