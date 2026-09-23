/**
 * AEON — carry THIS install and its home onto a drive (build-usb --carry-home).
 *
 *   node scripts/build-usb.js --target /Volumes/AEON --carry-home [--replace-data]
 *
 * The stock bundle (scripts/build-usb.js) builds a BLANK AEON for someone else:
 * no keys, no data, AEON_PORTABLE=true (local AI only). This builds the
 * opposite — the operator's own working AEON, their Vault, settings and key
 * vault, onto a drive they carry between their own machines:
 *
 *     <drive>/AEON              the install: tracked source + dist + node_modules
 *     <drive>/AEON-Data         the home, with a home.json marker
 *                               { layout: "carried", appFolder: "AEON" }
 *     <drive>/runtime/node/     Node for macOS (Intel + Apple Silicon), Windows
 *                               and Linux; runtime/npm is the one pure-JS npm
 *     <drive>/launch.command    macOS  ─┐ each picks the drive's Node, a free
 *     <drive>/LAUNCH.bat        Windows │ port (another AEON may own 3001), and
 *     <drive>/launch.sh         Linux  ─┘ starts AEON; AEON finds AEON-Data itself
 *
 * AEON recognises the layout on its own (src/kernel/aeonHome.cjs rule 5), so
 * the drive is one app however it is started. AEON_PORTABLE is NOT set: that
 * flag forbids cloud AI, and this drive carries the operator's cloud keys on
 * purpose. Treat the drive like a key.
 *
 * Built for exFAT — the one filesystem macOS, Windows and Linux all write:
 *   - files are copied DATA ONLY: a metadata-preserving copy made macOS write
 *     an AppleDouble "._" sidecar for every file (50,806 of them, 2026-09-22);
 *   - symlinks are MATERIALIZED as real files: exFAT has none, macOS only
 *     emulates them, and Windows/Linux see junk. node_modules/.bin (npm script
 *     shims, useless on a drive) is skipped;
 *   - mtimes are preserved, so the Second Brain does not re-index the Vault.
 *
 * Data safety: an existing AEON-Data is NEVER overwritten by default — once
 * the drive has been used elsewhere, it holds the newer copy. Re-running this
 * refreshes the app code only. --replace-data moves the old AEON-Data aside
 * (AEON-Data.replaced-<time>); it is never deleted.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { isOsJunk } = require('../src/kernel/osJunk.cjs');
const aeonHome = require('../src/kernel/aeonHome.cjs');

const APP_FOLDER = 'AEON';
const DATA_FOLDER = aeonHome.CARRIED_DIR_NAME; // 'AEON-Data'

// Never copied from the source home: they describe the host, not the operator.
const HOME_HOST_ONLY = new Set(['data/desktop-shortcut.json', 'home.json']);

// ── copying ──────────────────────────────────────────────────────────────────

/** Copy file contents only (no extended attributes), keeping mode and mtime. */
function copyFileData(src, dst, st = fs.statSync(src)) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const fin = fs.openSync(src, 'r');
  let fout;
  try {
    fout = fs.openSync(dst, 'w');
    const buf = Buffer.allocUnsafe(4 << 20);
    let n;
    while ((n = fs.readSync(fin, buf, 0, buf.length, null)) > 0) fs.writeSync(fout, buf, 0, n);
  } finally {
    fs.closeSync(fin);
    if (fout !== undefined) fs.closeSync(fout);
  }
  try { fs.chmodSync(dst, st.mode & 0o777); } catch { /* exFAT: no modes */ }
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* best effort */ }
  return st.size;
}

/**
 * Copy a tree for an exFAT drive: OS junk skipped, symlinks replaced by what
 * they point at (a cycle is cut, a broken link counted), data-only files.
 * @param {(rel: string) => boolean} [filter]  rel is POSIX, relative to src
 */
function copyTreeMaterialized(src, dst, { filter = () => true, onProgress } = {}) {
  const stats = { files: 0, bytes: 0, links: 0, broken: 0, cycles: 0 };
  const ancestors = new Set();
  (function walk(s, d, rel) {
    const real = fs.realpathSync(s);
    if (ancestors.has(real)) { stats.cycles++; return; }
    ancestors.add(real);
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (isOsJunk(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!filter(r)) continue;
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      let st;
      if (e.isSymbolicLink()) {
        try { st = fs.statSync(sp); } catch { stats.broken++; continue; }
        stats.links++;
      } else {
        st = fs.lstatSync(sp);
      }
      if (st.isDirectory()) { walk(sp, dp, r); continue; }
      if (!st.isFile()) continue;
      stats.bytes += copyFileData(sp, dp, st);
      stats.files++;
      if (onProgress && stats.files % 2000 === 0) onProgress(stats);
    }
    ancestors.delete(real);
  })(src, dst, '');
  return stats;
}

/** Remove OS junk ("._x", ".DS_Store", ...) under root. Returns how many. */
function sweepOsJunk(root) {
  let removed = 0;
  if (!fs.existsSync(root)) return 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (isOsJunk(e.name)) {
        try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch { /* in use: leave it */ }
        continue;
      }
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  })(root);
  return removed;
}

// ── what travels ─────────────────────────────────────────────────────────────

/**
 * The install's files: what git tracks (so nothing personal and untracked —
 * .aeon-home, local notes, caches — rides along), minus what build-usb's
 * EXCLUDE says never travels. dist/ and node_modules are added by the caller.
 */
function installFileList(root = ROOT, exclude) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0').filter(Boolean);
  } catch {
    files = null; // not a git checkout (a release zip): fall back to a walk
  }
  if (!files) {
    files = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isOsJunk(e.name) || e.name === 'node_modules' || e.name === 'dist') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile()) files.push(r);
      }
    })(root, '');
  }
  // Tracked seeds the stock bundle's "no db/*.json" rule also catches. Tracked
  // files are never personal runtime state, so these travel like a normal install.
  const allow = new Set(['db/retrieval/_scopes.json']);
  const skip = (rel) => !allow.has(rel) && (exclude.some((re) => re.test(rel)))
    || rel === '.aeon-home'
    || rel.startsWith('src/blocks/aeon_matrix/data/')     // a legacy in-install Vault
    || rel === 'src/aeon-settings.json'                    // legacy in-install settings
    || rel.split('/').some(isOsJunk);
  return files.filter((f) => !skip(f) && fs.existsSync(path.join(root, f)));
}

/** home.json for the drive: the marker AEON reads (aeonHome.cjs rule 5). */
function writeCarriedMarker(dataDir, { appFolder = APP_FOLDER } = {}) {
  return aeonHome.updateManifest(dataDir, {
    layout: aeonHome.CARRIED_LAYOUT,
    appFolder,
    note: 'AEON carried on a drive. The app beside this folder uses it as its home. '
      + 'Written by scripts/build-usb.js --carry-home; do not delete.',
  });
}

/**
 * Copy every root of the source home onto the matching root of the drive's
 * home. Both sides come from src/kernel/aeonHome.cjs — this never works out
 * where a root (least of all .env) lives by itself.
 * @param {ReturnType<typeof aeonHome.roots>} src
 * @param {ReturnType<typeof aeonHome.roots>} dst
 */
function copyHome(src, dst, { onProgress } = {}) {
  const out = {};
  for (const key of ['vault', 'data', 'db', 'secrets']) {
    if (!src[key] || !fs.existsSync(src[key])) { out[key] = 'absent'; continue; }
    const top = path.basename(dst[key]);
    out[key] = copyTreeMaterialized(src[key], dst[key], {
      filter: (rel) => !HOME_HOST_ONLY.has(`${top}/${rel}`),
      onProgress,
    });
  }
  for (const key of ['envFile', 'settings']) {
    if (src[key] && fs.existsSync(src[key])) { copyFileData(src[key], dst[key]); out[key] = 'copied'; }
    else out[key] = 'absent';
  }
  try { fs.chmodSync(dst.secrets, 0o700); } catch { /* exFAT */ }
  return out;
}

/** The drive home's roots, as AEON on the drive will resolve them. */
function driveRoots(app, data) {
  return aeonHome.roots({ appRoot: app, env: { AEON_HOME: data } });
}

/** Every .json under dataDir that no longer parses — a torn copy of a file mid-write. */
function unparseableJson(dataDir) {
  const bad = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.json')) continue;
      try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { bad.push(path.relative(dataDir, p)); }
    }
  })(dataDir);
  return bad;
}

/**
 * What to do with the target: the app is always replaced, the data only on
 * request. Installed store blocks inside the old app are kept.
 */
function planCarry(target, { replaceData = false } = {}) {
  const app = path.join(target, APP_FOLDER);
  const data = path.join(target, DATA_FOLDER);
  const dataExists = fs.existsSync(data);
  const extraBlocks = [];
  const blocksDir = path.join(app, 'src', 'blocks');
  if (fs.existsSync(blocksDir)) {
    for (const b of fs.readdirSync(blocksDir, { withFileTypes: true })) {
      if (!b.isDirectory() || isOsJunk(b.name)) continue;
      if (!fs.existsSync(path.join(ROOT, 'src', 'blocks', b.name))) extraBlocks.push(b.name);
    }
  }
  return {
    app, data,
    dataAction: !dataExists ? 'create' : replaceData ? 'replace' : 'keep',
    extraBlocks,
  };
}

// ── Node runtimes ────────────────────────────────────────────────────────────

/** A Mach-O universal ("fat") binary runs natively on Intel and Apple Silicon. */
function isUniversalMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    const magic = b.readUInt32BE(0);
    return magic === 0xcafebabe || magic === 0xcafebabf;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** "sha  file" lines → Map(file → sha). */
function parseShasums(text) {
  const m = new Map();
  for (const line of String(text).split('\n')) {
    const x = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (x) m.set(x[2], x[1]);
  }
  return m;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * Stage Node for every platform, verified against nodejs.org's SHASUMS256.
 * macOS: this machine's own Node when it is universal and the same version,
 * else the Intel and Apple Silicon builds side by side.
 */
async function stageRuntimes(target, { version = process.version, download, log = () => {} }) {
  const base = `https://nodejs.org/dist/${version}`;
  const cache = path.join(os.tmpdir(), 'aeon-usb-cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const rt = path.join(target, 'runtime');
  const res = { mac: null, win: null, linux: null, npm: null };

  const sumsFile = path.join(cache, 'SHASUMS256.txt');
  if (!fs.existsSync(sumsFile)) await download(`${base}/SHASUMS256.txt`, sumsFile);
  const sums = parseShasums(fs.readFileSync(sumsFile, 'utf8'));
  const fetchVerified = async (name) => {
    const f = path.join(cache, name);
    if (!fs.existsSync(f)) await download(`${base}/${name}`, f);
    const want = sums.get(name);
    const got = sha256File(f);
    if (!want || want !== got) { fs.rmSync(f, { force: true }); throw new Error(`${name}: SHA-256 does not match nodejs.org (${got})`); }
    return f;
  };
  const untar = (arc, member, dest) => {
    const tmp = fs.mkdtempSync(path.join(cache, 'x-'));
    try {
      execFileSync('tar', ['-xf', arc, '-C', tmp, member]);
      copyFileData(path.join(tmp, member), dest);
      try { fs.chmodSync(dest, 0o755); } catch { /* exFAT */ }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };

  // macOS
  const macDir = path.join(rt, 'node', 'mac');
  fs.rmSync(macDir, { recursive: true, force: true });
  if (process.platform === 'darwin' && process.version === version && isUniversalMachO(process.execPath)) {
    copyFileData(process.execPath, path.join(macDir, 'node'));
    res.mac = 'universal (this Mac\'s own Node)';
  } else {
    for (const arch of ['x64', 'arm64']) {
      const name = `node-${version}-darwin-${arch}.tar.gz`;
      untar(await fetchVerified(name), `node-${version}-darwin-${arch}/bin/node`, path.join(macDir, arch, 'node'));
    }
    res.mac = 'x64 + arm64';
  }
  log(`  ✓ macOS Node: ${res.mac}`);

  // Windows (+ npm, which is pure JS and the same everywhere)
  const AdmZip = require('adm-zip');
  const winName = `node-${version}-win-x64.zip`;
  const zip = new AdmZip(await fetchVerified(winName));
  const prefix = `node-${version}-win-x64/`;
  const winDir = path.join(rt, 'node', 'win');
  const npmDir = path.join(rt, 'npm');
  fs.rmSync(winDir, { recursive: true, force: true });
  fs.rmSync(npmDir, { recursive: true, force: true });
  let npmFiles = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const n = e.entryName.replace(/\\/g, '/');
    if (n === `${prefix}node.exe`) {
      fs.mkdirSync(winDir, { recursive: true });
      fs.writeFileSync(path.join(winDir, 'node.exe'), e.getData());
    } else if (n.startsWith(`${prefix}node_modules/npm/`)) {
      const rel = n.slice(`${prefix}node_modules/npm/`.length);
      if (!rel || rel.split('/').some((p) => p === '..' || isOsJunk(p))) continue;
      const dest = path.join(npmDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
      npmFiles++;
    }
  }
  if (!fs.existsSync(path.join(winDir, 'node.exe'))) throw new Error(`${winName}: node.exe not found in the archive`);
  if (!fs.existsSync(path.join(npmDir, 'bin', 'npm-cli.js'))) throw new Error(`${winName}: npm not found in the archive`);
  res.win = 'x64';
  res.npm = `${npmFiles} files`;
  log(`  ✓ Windows Node: x64 · npm: ${npmFiles} files`);

  // Linux
  const linName = `node-${version}-linux-x64.tar.xz`;
  const linDir = path.join(rt, 'node', 'linux');
  fs.rmSync(linDir, { recursive: true, force: true });
  untar(await fetchVerified(linName), `node-${version}-linux-x64/bin/node`, path.join(linDir, 'node'));
  res.linux = 'x64';
  log('  ✓ Linux Node: x64');

  return res;
}

// ── launchers ────────────────────────────────────────────────────────────────

const HEADER = 'AEON — carried on this drive. Generated by scripts/build-usb.js --carry-home.';

function macLauncher() {
  return `#!/usr/bin/env bash
# ${HEADER}
# Your data is in AEON-Data beside the app; nothing is written to this Mac
# except what any browser keeps. AEON finds AEON-Data on its own
# (src/kernel/aeonHome.cjs rule 5); AEON_HOME below only makes that explicit.
set -uo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/AEON"

case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
NODE=""
for c in "$ROOT/runtime/node/mac/node" "$ROOT/runtime/node/mac/$ARCH/node"; do
  if [ -f "$c" ]; then NODE="$c"; break; fi
done
if [ -n "$NODE" ]; then
  chmod +x "$NODE" 2>/dev/null || true
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "  [X] No Node.js for this Mac on the drive, and none installed."
  exit 1
fi

export AEON_HOME="$ROOT/AEON-Data"
export AEON_NO_DESKTOP_ICON=1
export npm_config_cache="$ROOT/.npm-cache"

# Another AEON may already own 3001 on this machine. Take the first free port.
PORT="$("$NODE" "$APP/tools/free-port.cjs" 3001 3020)" || { echo "  [X] Ports 3001-3020 are all in use."; exit 1; }
export PORT

cd "$APP"
if ! "$NODE" -e "require('express')" >/dev/null 2>&1; then
  echo "  [!] The app's libraries do not load on this machine. Reinstalling them once (needs internet)..."
  "$NODE" "$ROOT/runtime/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund || { echo "  [X] Reinstall failed."; exit 1; }
fi

echo
echo "  AEON (carried)  http://localhost:$PORT"
echo "  data            $AEON_HOME"
echo "  Close this window to stop AEON. Eject the drive before unplugging it."
echo
( sleep 3; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
exec "$NODE" server.cjs
`;
}

function linuxLauncher() {
  return `#!/usr/bin/env bash
# ${HEADER}
set -uo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/AEON"

NODE="$ROOT/runtime/node/linux/node"
if [ -f "$NODE" ] && [ "$(uname -m)" = "x86_64" ]; then
  chmod +x "$NODE" 2>/dev/null || true
  if ! "$NODE" --version >/dev/null 2>&1; then
    # exFAT mounted without exec permission: run a copy from this machine's temp folder.
    TMPN="\${TMPDIR:-/tmp}/aeon-node-$(id -u)"
    cp "$NODE" "$TMPN" && chmod +x "$TMPN" && NODE="$TMPN"
  fi
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "  [X] No Node.js for this machine on the drive, and none installed."
  exit 1
fi

export AEON_HOME="$ROOT/AEON-Data"
export AEON_NO_DESKTOP_ICON=1
export npm_config_cache="$ROOT/.npm-cache"

PORT="$("$NODE" "$APP/tools/free-port.cjs" 3001 3020)" || { echo "  [X] Ports 3001-3020 are all in use."; exit 1; }
export PORT

cd "$APP"
if ! "$NODE" -e "require('express')" >/dev/null 2>&1; then
  echo "  [!] The app's libraries do not load on this machine. Reinstalling them once (needs internet)..."
  "$NODE" "$ROOT/runtime/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund || { echo "  [X] Reinstall failed."; exit 1; }
fi

echo
echo "  AEON (carried)  http://localhost:$PORT"
echo "  data            $AEON_HOME"
echo
( sleep 3; xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true ) &
exec "$NODE" server.cjs
`;
}

function windowsLauncher() {
  // CRLF, or cmd.exe mis-parses the file. The "for /f" line uses the doubled
  // outer quotes cmd needs when the command itself starts and ends with one.
  return `@echo off
setlocal
title AEON (carried)
rem ${HEADER}
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"
set "APP=%ROOT%\\AEON"

set "NODE=%ROOT%\\runtime\\node\\win\\node.exe"
if not exist "%NODE%" (
  where node >nul 2>&1 || (echo   [X] No Node.js on the drive and none installed on this PC. & pause & exit /b 1)
  set "NODE=node"
)

set "AEON_HOME=%ROOT%\\AEON-Data"
set "AEON_NO_DESKTOP_ICON=1"
set "npm_config_cache=%ROOT%\\.npm-cache"

rem Another AEON may already own 3001 on this PC. Take the first free port.
set "PORT="
for /f "usebackq delims=" %%P in (\`""%NODE%" "%APP%\\tools\\free-port.cjs" 3001 3020"\`) do set "PORT=%%P"
if not defined PORT (echo   [X] Ports 3001-3020 are all in use. & pause & exit /b 1)

cd /d "%APP%"
"%NODE%" -e "require('express')" >nul 2>&1
if errorlevel 1 (
  echo   [!] The app's libraries do not load on this PC. Reinstalling them once ^(needs internet^)...
  "%NODE%" "%ROOT%\\runtime\\npm\\bin\\npm-cli.js" ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (echo   [X] Reinstall failed. & pause & exit /b 1)
)

echo.
echo   AEON (carried)  http://localhost:%PORT%
echo   data            %AEON_HOME%
echo   Close this window to stop AEON. Eject the drive before unplugging it.
echo.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://localhost:%PORT%"
"%NODE%" server.cjs
echo.
pause
endlocal
`.replace(/\r?\n/g, '\r\n');
}

function writeCarriedLaunchers(target) {
  fs.writeFileSync(path.join(target, 'launch.command'), macLauncher());
  fs.writeFileSync(path.join(target, 'launch.sh'), linuxLauncher());
  fs.writeFileSync(path.join(target, 'LAUNCH.bat'), windowsLauncher());
  for (const f of ['launch.command', 'launch.sh']) {
    try { fs.chmodSync(path.join(target, f), 0o755); } catch { /* exFAT: every file already runs */ }
  }
}

function writeDriveReadme(target, { built, runtimes }) {
  fs.writeFileSync(path.join(target, 'README_DRIVE.txt'), `AEON — CARRIED ON THIS DRIVE
=====================================================================
Your own AEON: the app, your Vault, settings and key vault. Built
${built} by scripts/build-usb.js --carry-home.

START IT
---------------------------------------------------------------------
  macOS     double-click  launch.command
  Windows   double-click  LAUNCH.bat
  Linux     ./launch.sh

It opens in your browser (http://localhost:3001, or the next free port
if this machine already runs an AEON). Sign in as usual — AEON asks for
your password on every launch.

EJECT BEFORE UNPLUGGING. This drive is exFAT so every OS can use it;
exFAT has no journal, so pulling it mid-write can corrupt a file.

WHAT'S HERE
---------------------------------------------------------------------
  AEON/          the app (source, built interface, libraries)
  AEON-Data/     YOUR data: Vault, settings, the key vault, .env with
                 the master key and cloud keys. Anyone holding this drive
                 holds your keys — treat it like a key.
  runtime/       Node.js for macOS (${runtimes.mac}), Windows (${runtimes.win}),
                 Linux (${runtimes.linux}), and npm.

WHAT WORKS WHERE
---------------------------------------------------------------------
  Cloud AI (your keys)      every machine
  Local AI (offline models  the machines the installed local runtime was
  and document embeddings)  built for — see Cookbook. Elsewhere, new
                            documents are indexed and get their vectors
                            the next time the drive runs where it works.
  Your data                 always on the drive; nothing is copied to
                            the host except what any browser keeps.

UPDATING THE APP
---------------------------------------------------------------------
Re-run the builder from an updated AEON. It refreshes AEON/ and runtime/
and never touches AEON-Data unless you pass --replace-data (which moves
the old copy aside rather than deleting it).
`);
}

// ── orchestration ────────────────────────────────────────────────────────────

async function buildCarried(args, { download, log = console.log } = {}) {
  const buildUsb = require('./build-usb.js');
  const target = path.resolve(args.target);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const plan = planCarry(target, { replaceData: !!args.replaceData });
  const t0 = Date.now();

  log(`\nAEON — carry this install and its home`);
  log(`  target      ${target}`);
  log(`  app         ${plan.app}  (replaced)`);
  log(`  data        ${plan.data}  (${plan.dataAction === 'keep' ? 'KEPT — already on the drive; pass --replace-data to overwrite' : plan.dataAction})`);
  if (plan.extraBlocks.length) log(`  keeping installed blocks: ${plan.extraBlocks.join(', ')}`);

  try {
    const ping = await fetch('http://127.0.0.1:3001/api/ping', { signal: AbortSignal.timeout(1500) });
    if (ping.status) log('  ! an AEON is running on this machine — its files are copied as they are now; close it first for a quiet snapshot');
  } catch { /* none running */ }

  const files = installFileList(ROOT, buildUsb.EXCLUDE);
  if (args.dryRun) {
    const src = aeonHome.roots({ appRoot: ROOT, env: process.env });
    log(`\n  DRY RUN — nothing written. Would copy ${files.length} tracked files, dist/, node_modules,`);
    log(`  and${plan.dataAction === 'keep' ? ' NOT' : ''} the home at ${src.home}; then stage Node for macOS, Windows and Linux.\n`);
    return { plan, dryRun: true, files: files.length };
  }

  // 1. app
  const staging = `${plan.app}.incoming`;
  fs.rmSync(staging, { recursive: true, force: true });
  let appBytes = 0;
  for (const rel of files) appBytes += copyFileData(path.join(ROOT, rel), path.join(staging, rel));
  log(`  ✓ source: ${files.length} tracked files`);
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist/ is missing — run npm run build first');
  const dist = copyTreeMaterialized(path.join(ROOT, 'dist'), path.join(staging, 'dist'));
  log(`  ✓ interface: ${dist.files} files`);
  const mods = copyTreeMaterialized(path.join(ROOT, 'node_modules'), path.join(staging, 'node_modules'), {
    filter: (rel) => !/(^|\/)\.bin$/.test(rel) && !/^\.(cache|vite)(\/|$)/.test(rel),
    onProgress: (s) => process.stdout.write(`\r      libraries: ${s.files} files   `),
  });
  process.stdout.write('\r');
  log(`  ✓ libraries: ${mods.files} files, ${buildUsb.human(mods.bytes)} (${mods.links} links materialized${mods.broken ? `, ${mods.broken} broken skipped` : ''})`);
  for (const b of plan.extraBlocks) {
    copyTreeMaterialized(path.join(plan.app, 'src', 'blocks', b), path.join(staging, 'src', 'blocks', b));
  }
  if (fs.existsSync(plan.app)) fs.rmSync(plan.app, { recursive: true, force: true });
  fs.renameSync(staging, plan.app);

  // 2. data
  if (plan.dataAction !== 'keep') {
    if (plan.dataAction === 'replace') {
      const aside = `${plan.data}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(plan.data, aside);
      log(`  ✓ previous AEON-Data moved aside → ${path.basename(aside)} (not deleted)`);
    }
    const src = aeonHome.roots({ appRoot: ROOT, env: process.env });
    const copied = copyHome(src, driveRoots(plan.app, plan.data));
    writeCarriedMarker(plan.data);
    log(`  ✓ home copied from ${src.home}: ${Object.entries(copied).map(([k, v]) => `${k} ${typeof v === 'object' ? v.files : v}`).join(' · ')}`);
    const bad = unparseableJson(plan.data);
    if (bad.length) log(`  ! ${bad.length} JSON file(s) did not copy cleanly (written to mid-copy?): ${bad.slice(0, 5).join(', ')} — re-run with AEON closed`);
  }

  // 3. runtimes, launchers, readme
  const runtimes = args.skipRuntime
    ? { mac: 'not staged', win: 'not staged', linux: 'not staged' }
    : await stageRuntimes(target, { version: process.version, download, log });
  writeCarriedLaunchers(target);
  writeDriveReadme(target, { built: new Date().toISOString().slice(0, 10), runtimes });
  const swept = sweepOsJunk(plan.app) + sweepOsJunk(plan.data) + sweepOsJunk(path.join(target, 'runtime'));
  log(`  ✓ launchers (macOS, Windows, Linux) and README_DRIVE.txt · ${swept} OS junk file(s) swept`);
  log(`\n  done in ${Math.round((Date.now() - t0) / 1000)}s.  Verify: node scripts/verify-usb.js --target ${target} --carry-home\n`);
  return { plan, runtimes };
}

module.exports = {
  buildCarried, planCarry, copyFileData, copyTreeMaterialized, sweepOsJunk, installFileList,
  copyHome, driveRoots, writeCarriedMarker, unparseableJson, isUniversalMachO, parseShasums, stageRuntimes,
  writeCarriedLaunchers, macLauncher, linuxLauncher, windowsLauncher, APP_FOLDER, DATA_FOLDER,
};
