#!/usr/bin/env node
/**
 * Dead-endpoint harness — the gate this repo was missing (BO-E3).
 *
 * Parses every fetch() call site in src/ for its URL AND its method, then
 * issues that exact method against a live AEON instance.
 *
 * The discriminator that makes this trustworthy: Express answers an UNMOUNTED
 * route with an HTML `Cannot <METHOD> <path>` body, while a mounted handler
 * answers 404 with JSON. Without that distinction a "record not found" reads
 * identically to a missing route, which is why a GET-only sweep produces mostly
 * false positives.
 *
 * On 2026-07-31 this found 9 endpoints the UI called that nothing served —
 * at 392/392 tests with both scanners passing.
 *
 * Usage:  node tools/stress/dead-endpoints.mjs [baseUrl] [aeonRoot] [outJson]
 *
 * Not part of `scan:release-gate`: it needs a booted instance. Run it against
 * a fresh install before shipping.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3099';
const AEON = process.argv[3] || path.resolve(import.meta.dirname, '..', '..');
const OUT  = process.argv[4] || path.join(AEON, 'data', 'dead-endpoints.json');

const DANGEROUS = [
  '/restart', '/os/shell', '/api/exec', '/kill-pid', '/delete-cache',
  '/install-runtime', '/model/download', '/model/serve', '/flush', '/lock',
  '/autopilot/', '/transcribe', '/api/build/', '/store/install', '/store/publish',
  '/god/file-drop', '/god/file-save', '/god/model-swap', '/commands/dispatch',
  '/vault-push', '/ingest/', '/scan-all', '/system/scan', '/settings/secrets',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const sites = [];
for (const file of walk(path.join(AEON, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  // fetch( <url> [, { ... method: 'X' ... }] )
  const re = /fetch\(\s*([`'"])([^`'"]+)\1\s*(?:,\s*(\{[\s\S]{0,400}?\}))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const url = m[2];
    if (!url.startsWith('/')) continue;
    const opts = m[3] || '';
    const mm = opts.match(/method\s*:\s*['"`](\w+)['"`]/);
    sites.push({
      file: path.relative(AEON, file).split(path.sep).join('/'),
      line: src.slice(0, m.index).split('\n').length,
      url,
      method: (mm ? mm[1] : 'GET').toUpperCase(),
    });
  }
}

// Collapse to unique (method, path)
const uniq = new Map();
for (const s of sites) {
  const p = s.url.split('?')[0].replace(/\$\{[^}]*\}/g, 'probe');
  if (p.includes('__BLANK__')) continue;
  const k = s.method + ' ' + p;
  if (!uniq.has(k)) uniq.set(k, { method: s.method, path: p, sites: [] });
  uniq.get(k).sites.push(`${s.file}:${s.line}`);
}

const results = [];
for (const e of uniq.values()) {
  if (DANGEROUS.some(d => e.path.includes(d))) {
    results.push({ ...e, status: 'SKIPPED-DESTRUCTIVE' });
    continue;
  }
  try {
    const init = { method: e.method, redirect: 'manual', signal: AbortSignal.timeout(4000) };
    if (e.method !== 'GET' && e.method !== 'HEAD') {
      init.headers = { 'content-type': 'application/json' };
      init.body = '{}';
    }
    const r = await fetch(BASE + e.path, init);
    const ct = r.headers.get('content-type') || '';
    results.push({ ...e, status: r.status, html: r.status === 200 && ct.includes('text/html') });
  } catch (err) {
    results.push({ ...e, status: 'TIMEOUT/ERR', err: err.message.slice(0, 50) });
  }
}

const dead = results.filter(r => r.status === 404 || r.html === true);
const skipped = results.filter(r => r.status === 'SKIPPED-DESTRUCTIVE');
const errs = results.filter(r => r.status === 'TIMEOUT/ERR');
const alive = results.filter(r => !dead.includes(r) && !skipped.includes(r) && !errs.includes(r));

console.log(`\n=== ${results.length} unique (method,path) call sites vs ${BASE} ===`);
console.log(`ALIVE ${alive.length}  ·  DEAD ${dead.length}  ·  SKIPPED ${skipped.length}  ·  ERR ${errs.length}\n`);
console.log('--- DEAD (UI calls a route the server does not mount) ---');
for (const d of dead.sort((a,b)=>a.path.localeCompare(b.path)))
  console.log(`  ${d.method.padEnd(6)} ${d.path.padEnd(46)} ${d.sites[0]}`);
console.log('\n--- TIMEOUT/ERR ---');
for (const d of errs) console.log(`  ${d.method.padEnd(6)} ${d.path}  ${d.err}`);
console.log('\n--- ALIVE by status ---');
const by = {};
for (const a of alive) (by[a.status] ||= []).push(`${a.method} ${a.path}`);
for (const s of Object.keys(by).sort()) console.log(`  [${s}] ${by[s].length}`);
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
