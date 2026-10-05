'use strict';
// Is the built interface (dist/) still the interface the source describes?
//
// A block's backend routes mount while AEON runs, but its screen is compiled
// into the Vite bundle, so a block installed since the last build has no
// screen until `npm run build` runs. The launcher built only when dist/ was
// missing, so closing and reopening AEON — or Settings → Restart — kept the
// old bundle and a new block stayed invisible.
//
// `npm run build` ends by writing a stamp: a hash of everything the bundle is
// made from. The launcher compares it on every start and on every Restart and
// rebuilds when it differs. No stamp (a build from before this existed, or a
// hand-copied dist/) counts as stale once; the rebuild writes one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAMP_FILE = '.aeon-build-stamp';
// Everything the bundle is built from. Server code, data and docs are not
// here: changing them never changes what the browser loads.
const FILES = ['index.html', 'vite.config.js', 'package.json', 'package-lock.json'];
const TREES = ['src', 'public'];
// `.aeon.*` is what AEON writes about a running block (`.aeon.runtime.json`
// carries a boot timestamp), so counting it would make every launch rebuild.
const SKIP = (name) => name === '.DS_Store' || name.startsWith('._') || name.startsWith('.aeon.') || name === 'node_modules';

function walk(dir, rel, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (SKIP(e.name)) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else if (e.isFile()) out.push(r);
  }
}

/** Hash of the bundle's inputs: file names and contents, in a fixed order. */
function sourceHash(root) {
  const files = FILES.filter((f) => fs.existsSync(path.join(root, f)));
  for (const t of TREES) walk(path.join(root, t), t, files);
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f); h.update('\0');
    try { h.update(fs.readFileSync(path.join(root, f))); } catch { h.update('unreadable'); }
    h.update('\0');
  }
  return h.digest('hex');
}

function stampPath(root) { return path.join(root, 'dist', STAMP_FILE); }

function writeStamp(root) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const hash = sourceHash(root);
  fs.writeFileSync(stampPath(root), `${hash}\n`);
  return hash;
}

/** @returns {{stale: boolean, reason: 'missing'|'unstamped'|'changed'|null}} */
function buildState(root) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) return { stale: true, reason: 'missing' };
  let stamped;
  try { stamped = fs.readFileSync(stampPath(root), 'utf8').trim(); } catch { return { stale: true, reason: 'unstamped' }; }
  return sourceHash(root) === stamped ? { stale: false, reason: null } : { stale: true, reason: 'changed' };
}

module.exports = { STAMP_FILE, sourceHash, writeStamp, buildState };

if (require.main === module) {
  if (process.argv.includes('--write')) console.log(`build stamp ${writeStamp(path.resolve(__dirname, '..')).slice(0, 12)}`);
  else { const s = buildState(path.resolve(__dirname, '..')); console.log(s.stale ? `stale (${s.reason})` : 'current'); process.exit(s.stale ? 1 : 0); }
}
