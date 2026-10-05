'use strict';
/**
 * Kernel-run, on-demand engine installer (BO-TIER15).
 *
 * A block can declare an "engine": npm packages it needs installed on demand
 * into its own data folder (not in AEON core, so core stays small). The problem
 * that used to force such a block to Tier 3: it had to `require('child_process')`
 * and spawn npm itself, which the scanner flags as shell execution.
 *
 * This moves that spawn into the KERNEL. The block declares the exact packages
 * in its manifest (reviewed at install time); the kernel installs ONLY those,
 * into `<blockData>/<dir>/node_modules`, and hands the block a function to
 * trigger it. The block never touches child_process, so it stays Tier 1.5.
 *
 * Security: only the packages named in the manifest are installed — this is not
 * an arbitrary-exec surface. npm runs with --ignore-scripts, so no package
 * postinstall can run. The install writes only inside the block's own data dir.
 */
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');

/**
 * npm found next to the Node that runs AEON (regular install, Windows, and the
 * carried drive's runtime/ layout), else `npm` on PATH. (Ported from the old
 * block-local resolver so behaviour is unchanged — only the caller moved.)
 */
function findNpm({ execPath = process.execPath, env = process.env, platform = process.platform, exists } = {}) {
  const isFile = exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const dir = path.dirname(execPath);
  const tail = ['npm', 'bin', 'npm-cli.js'];
  const candidates = [];
  if (env.AEON_NPM_CLI) candidates.push(env.AEON_NPM_CLI);
  candidates.push(path.join(dir, '..', 'lib', 'node_modules', ...tail));
  candidates.push(path.join(dir, 'node_modules', ...tail));
  for (let up = 1; up <= 3; up++) candidates.push(path.join(dir, ...Array(up).fill('..'), ...tail));
  for (const c of candidates) if (isFile(c)) return { command: execPath, args: [c], via: c };
  if (platform === 'win32') return null;
  return { command: 'npm', args: [], via: 'npm on PATH' };
}

function folderBytes(root, limit = 60000) {
  let bytes = 0; let seen = 0;
  const walk = (r) => {
    let entries;
    try { entries = fs.readdirSync(r, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > limit) return;
      const child = path.join(r, e.name);
      if (e.isDirectory()) walk(child);
      else { try { bytes += fs.statSync(child).size; } catch { /* vanished */ } }
    }
  };
  walk(root);
  return bytes;
}

const PKG_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PKG_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;      // an exact version — never a range, tag, URL, git ref or file path
const ENGINE_DIR = /^[a-z0-9_-]{1,40}$/;
const WORKER_REL = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const MAX_ENGINE_PACKAGES = 16;

/**
 * Check a manifest's contract.engine declaration. Returns a list of problems
 * (empty = fine). Used by the complexity gate (so a malformed or sneaky
 * declaration is refused before it is ever approved) and again by forBlock at
 * install time (so nothing the gate never saw can be installed): packages must
 * be plain registry names at EXACT versions — no ranges, dist-tags, URLs, git
 * or file specifiers — and the worker must be a file inside the block.
 */
function validateEngine(e) {
  const problems = [];
  if (!e || typeof e !== 'object') return ['contract.engine must be an object'];
  const names = Object.keys(e.packages || {});
  if (!names.length) problems.push('contract.engine.packages must name at least one package');
  if (names.length > MAX_ENGINE_PACKAGES) problems.push(`contract.engine.packages lists ${names.length} packages (limit ${MAX_ENGINE_PACKAGES})`);
  for (const n of names) {
    if (!PKG_NAME.test(n)) problems.push(`engine package name "${n}" is not a plain registry name`);
    if (typeof e.packages[n] !== 'string' || !PKG_VERSION.test(e.packages[n])) problems.push(`engine package "${n}" must pin an exact version (got "${e.packages[n]}")`);
  }
  if (e.dir != null && !ENGINE_DIR.test(String(e.dir))) problems.push('contract.engine.dir must be a simple folder name');
  if (e.worker != null) {
    const w = String(e.worker);
    if (!WORKER_REL.test(w) || w.split('/').includes('..') || w.endsWith('/')) problems.push('contract.engine.worker must be a relative file path inside the block');
  }
  return problems;
}

/**
 * Build the engine installer bound to one block.
 * @param {object} o
 * @param {string} o.blockId
 * @param {object} o.declaredEngine  manifest.contract.engine: { dir?, packages: {name: version}, approxBytes? }
 * @param {function} o.getBlockDataFile  (blockId) -> absolute data dir for that block
 * @param {string} [o.blockDir]  the block's own folder; the declared worker must live inside it
 */
function forBlock({ blockId, declaredEngine, getBlockDataFile, blockDir }) {
  const invalid = validateEngine(declaredEngine);
  if (invalid.length) throw new Error(`The engine this block declares is not allowed: ${invalid.join('; ')}.`);
  const dir = (declaredEngine && declaredEngine.dir) || 'engine';
  const packages = { ...((declaredEngine && declaredEngine.packages) || {}) };
  const approxBytes = (declaredEngine && declaredEngine.approxBytes) || 0;
  const pkgNames = Object.keys(packages);
  const engineRoot = () => path.join(getBlockDataFile(blockId), dir);

  const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  // Installed = every declared package is present in the engine's node_modules.
  function installed() {
    if (!pkgNames.length) return false;
    const nm = path.join(engineRoot(), 'node_modules');
    return pkgNames.every((p) => has(path.join(nm, p, 'package.json')));
  }

  async function install({ onProgress = () => {}, signal = {} } = {}) {
    const root = engineRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: `aeon-engine-${blockId}`, private: true, dependencies: packages,
    }, null, 2));

    const npm = findNpm();
    if (!npm) {
      throw new Error('npm was not found next to the Node.js that runs AEON. Reinstall Node.js from nodejs.org (it includes npm), or set AEON_NPM_CLI to npm-cli.js.');
    }
    const cacheDir = path.join(root, '.npm-cache');
    const args = [...npm.args, 'install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', '--loglevel=error', '--cache', cacheDir];

    await new Promise((resolve, reject) => {
      let err = '';
      let child;
      try {
        child = spawn(npm.command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { reject(new Error(`npm could not start (${npm.via}): ${e.message}`)); return; }
      signal.kill = () => { try { child.kill(); } catch { /* gone */ } };
      const tick = setInterval(() => {
        try { onProgress({ bytes: folderBytes(path.join(root, 'node_modules')), approxBytes }); } catch { /* advisory */ }
      }, 1500);
      if (tick.unref) tick.unref();
      if (child.stdout) child.stdout.on('data', () => {});
      if (child.stderr) child.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
      child.on('error', (e) => { clearInterval(tick); reject(new Error(`npm could not start (${npm.via}): ${e.message}`)); });
      child.on('close', (code) => {
        clearInterval(tick);
        signal.kill = null;
        if (signal.cancelled) { reject(new Error('Install cancelled. Nothing half-installed is used: start again.')); return; }
        if (code === 0) resolve();
        else reject(new Error(`npm could not install the engine (exit ${code}). ${(err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '').slice(0, 300)}`));
      });
    });
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* cache only */ }
    if (!installed()) throw new Error('npm finished but the declared engine packages are not present. Try again.');
    return { ok: true, dir: root };
  }

  // The block's own worker process (e.g. the speech engine's renderer), started
  // by the KERNEL so the block never needs child_process. Only the one file the
  // manifest declares (contract.engine.worker, inside the block's folder) can be
  // started; the caller supplies no path, arguments or environment. The worker
  // gets a minimal environment — no provider keys, no vault secrets.
  const workerRel = (declaredEngine && declaredEngine.worker) || null;
  function workerPath() {
    if (!workerRel || !blockDir) throw new Error('This block declares no engine worker.');
    const abs = path.resolve(blockDir, workerRel);
    if (!abs.startsWith(path.resolve(blockDir) + path.sep)) throw new Error('The declared engine worker is outside the block folder.');
    if (!has(abs)) throw new Error(`The declared engine worker is missing: ${workerRel}`);
    return abs;
  }
  const WORKER_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  function forkWorker() {
    const env = {};
    for (const k of WORKER_ENV_KEYS) if (process.env[k] != null) env[k] = process.env[k];
    return fork(workerPath(), [], {
      cwd: engineRoot(),
      env,
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
  }

  return {
    install,
    installed,
    fork: forkWorker,
    dir: engineRoot,
    packages: () => ({ ...packages }),
  };
}

module.exports = { forBlock, findNpm, folderBytes, validateEngine };
