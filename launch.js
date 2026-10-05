#!/usr/bin/env node
'use strict';
/**
 * AEON — Universal Launcher
 * One file, every platform. Detects the environment, walks a non-technical
 * user through first-run setup, and boots the console.
 *
 *   1. Environment scan   — Node, npm, RAM, GPU, local runtime
 *   2. .env onboarding    — paste keys now, or skip and finish in Settings
 *   3. Vault bootstrap    — master key auto-generated, never asked for
 *   4. Dependencies       — npm install on first run
 *   5. Frontend build     — one-time vite build (then cached)
 *   6. Boot               — kernel on :3001 (or the next free port), browser
 *                           opens itself once AEON answers there
 *
 * Design rule: the user should never NEED to type anything. Every prompt
 * has a safe default reachable by pressing Enter.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const { envFilePath } = require('./src/kernel/envFile.cjs');

const ROOT = __dirname;
// Same authority the server uses, so the launcher wizard and the first-run
// vault guard can never disagree about where the master key lives. Since
// 2026-09-14 that is <AEON home>/.env (src/kernel/aeonHome.cjs), and an older
// install's .env is moved there by main() before this path is ever tested.
const ENV_PATH = envFilePath({ appRoot: ROOT });
// The template ships WITH the install and is read-only — it stays put.
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
// The port is chosen in main() (choosePort below), not here: 3001 may belong
// to another program.

// ── .env is owner-only ──────────────────────────────────────────────────────
// It holds AEON_VAULT_MASTER_KEY, half of what unlocks every stored API key.
// It used to be created by copyFileSync from .env.example (0644, and the copy
// keeps the mode) and rewritten with a bare writeFileSync — readable by every
// local account on macOS/Linux (measured 2026-09-23). A mode passed to
// writeFileSync only applies when the file is CREATED, so an existing file is
// chmod-ed explicitly. Windows has no POSIX modes; chmod there is a no-op.
const ENV_MODE = 0o600;
function secureEnvFile(file) {
  try {
    const from = fs.statSync(file).mode & 0o777;
    if (os.platform() === 'win32' || from === ENV_MODE) return { changed: false };
    fs.chmodSync(file, ENV_MODE);
    return { changed: true, from: from.toString(8) };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}
function writeEnvFile(file, content) {
  fs.writeFileSync(file, content, { mode: ENV_MODE });
  return secureEnvFile(file);
}

// ── Keys that live in the vault, not in .env ────────────────────────────────
// The server moves provider secrets — AEON_MOBILE_SECRET among them — into the
// encrypted vault and leaves "# KEY moved to the encrypted vault …" in .env
// (services/settings.js migrateEnvKeysToVault). ensure() and rotateCompromised()
// read only `KEY=` lines, so from then on each launch appended a fresh secret
// that the server could not use (the vault copy wins), and an exposed value in
// the vault was never rotated again (BO-A3b).
//
// Fill `key` when .env has no value for it — unless the vault holds it, where
// a line here would only be a second, dead copy.
function ensureEnvKey(envText, key, gen, { heldInVault = false } = {}) {
  const m = envText.match(new RegExp('^' + key + '=(.*)$', 'm'));
  if ((m && m[1].trim()) || heldInVault) return { env: envText, added: false };
  const v = gen();
  return {
    env: m ? envText.replace(new RegExp('^' + key + '=.*$', 'm'), `${key}=${v}`) : envText + `\n${key}=${v}`,
    added: true,
  };
}

// What the provider vault holds, after replacing any known-exposed value it
// can mint (`generate(key)` → new value, or null). The vault module takes its
// master key from process.env, which the launcher never loads (the server
// does), so it is lent for this call only. null when the vault cannot be read
// here — on a first run node_modules is not installed yet — and the launcher
// then behaves exactly as it did before keys moved.
function checkProviderVault({ envText, listFile, generate }) {
  const prev = process.env.AEON_VAULT_MASTER_KEY;
  try {
    const master = prev || require('dotenv').parse(envText).AEON_VAULT_MASTER_KEY;
    if (!master) return null;
    process.env.AEON_VAULT_MASTER_KEY = master;
    if (!require('./src/kernel/vault.cjs').isUnlocked()) return null;
    const settings = require('./services/settings.js');
    const store = settings.createProviderCredentialStore();
    if (store.metadata().__unreadable) return null;
    const { rotated, exposed } = settings.rotateCompromisedSecrets({ listFile, store, generate });
    const held = store.metadata();
    return { holds: (key) => !!held[key], rotated, exposed };
  } catch {
    return null;
  } finally {
    if (prev === undefined) delete process.env.AEON_VAULT_MASTER_KEY;
    else process.env.AEON_VAULT_MASTER_KEY = prev;
  }
}

// ── Dependencies: finished, or only started ─────────────────────────────────
// npm install used to run only when node_modules did not exist. An install cut
// short — the window closed, the laptop slept, Wi-Fi dropped, a 504 on a
// package's download script — leaves node_modules half full, and every
// relaunch then said "Dependencies ready" and failed in the build (measured
// 2026-09-30: 574 entries, no multer, "Cannot find module 'multer'"), while
// the failure message told the customer to run LAUNCH again (A098).
//
// npm writes node_modules/.package-lock.json only once the whole tree is on
// disk and its install scripts have run (arborist reify saves it after
// _build), so its presence means an install finished. INSTALL_MARKER is this
// launcher's own record of the same fact, written after npm exits 0, so an npm
// that skips the hidden lockfile cannot send every launch into a reinstall.
const INSTALL_MARKER = '.aeon-install-complete';
function dependenciesReady(root) {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return { ready: false, reason: 'missing' };
  if (fs.existsSync(path.join(nm, '.package-lock.json')) || fs.existsSync(path.join(nm, INSTALL_MARKER))) {
    return { ready: true, reason: null };
  }
  return { ready: false, reason: 'incomplete' };
}
function markDependenciesInstalled(root) {
  try { fs.writeFileSync(path.join(root, 'node_modules', INSTALL_MARKER), `${new Date().toISOString()}\n`); return true; }
  catch { return false; }
}

// ── The interface: built, and built from what is on disk now ───────────────
// A block's screen only exists after `npm run build`, and the launcher built
// only when dist/ was missing — so closing and reopening AEON, or Settings →
// Restart, never showed a block installed since the last build. tools/build-
// stamp.cjs records what the bundle was made from; this rebuilds when that no
// longer matches. A failed rebuild keeps the old interface and says so: a
// working AEON without the newest screen beats no AEON.
function ensureInterface(root, opts) {
  return require('./tools/ensure-interface.cjs').ensureInterface(root, opts);
}

// ── Which port, and whether AEON is what answers there ─────────────────────
// Every launcher assumed 3001 and opened the browser on the first HTTP reply
// of any kind. With another program on 3001 the customer got that program's
// page, then AEON gave up and told them to set PORT (A046, measured
// 2026-09-30). The carried drive's launchers already take the first free port
// (tools/free-port.cjs); this one now does too. PORT, when set, still wins.
async function choosePort({ env = process.env, from = 3001, to = 3020, find } = {}) {
  const asked = String(env.PORT || '').trim();
  if (asked) return { port: asked, chosen: false };
  const port = await (find || require('./tools/free-port.cjs').firstFreePort)(from, to);
  return { port: port == null ? null : String(port), chosen: true };
}

// Only AEON's own /api/ping counts as AEON — the same answers
// src/kernel/runtime.cjs accepts when it asks a lock's port.
function isAeonPing(statusCode, body) {
  let j = null;
  try { j = JSON.parse(body); } catch { return false; }
  return !!j && ((statusCode === 200 && j.name === 'aeon')
    || (statusCode === 401 && (j.error === 'UNAUTHORIZED_SESSION' || /^AEON-/.test(String(j.correlation_id)))));
}

/** @returns {Promise<'aeon'|'other'|'none'>} none: nothing answered (yet). */
function probeAeon(base, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = require('http').get(`${base}/api/ping`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 8192) body += d; });
      res.on('end', () => resolve(isAeonPing(res.statusCode, body) ? 'aeon' : 'other'));
      res.on('error', () => resolve('none'));
    });
    req.on('error', () => resolve('none'));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve('none'); });
  });
}

// ── The vault master key, before the server boots ──────────────────────────
// .env holds one half of the vault key, secrets/aeon-keyslots.json the other.
// This launcher filled AEON_VAULT_MASTER_KEY whenever .env had none — also
// when keyslots already existed, i.e. when .env had been lost or replaced. The
// new key unwrapped nothing and the vault stayed locked without a word:
// server.js refuses (vaultBootGuard) only when the key is MISSING, and the
// launcher had just made it present. P0-01's defect, in the launcher (A017).
//
// And the recovery code printed once when the vault was made had nowhere to
// go: no route, command or screen called vault.recoverWithCode (A045/A017).
// The launcher is that place now. It runs before the server, in the window
// where the code was first shown, and it is what a customer double-clicks.
//
//   mint     no vault yet                                → generate a key
//   keep     the key opens the vault, or there is no vault to check
//   recover  a vault the key cannot open, with a recovery slot → ask for the code
//   sealed   a vault the key cannot open, no usable recovery slot → say so
//
// Only 'mint' writes a new key: a fresh key cannot open an existing vault.
function envValue(envText, key) {
  const m = String(envText || '').match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}
function withMasterKey(key, fn) {
  const prev = process.env.AEON_VAULT_MASTER_KEY;
  try {
    if (key) process.env.AEON_VAULT_MASTER_KEY = key; else delete process.env.AEON_VAULT_MASTER_KEY;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AEON_VAULT_MASTER_KEY;
    else process.env.AEON_VAULT_MASTER_KEY = prev;
  }
}
// The server reads process.env first (dotenv never overrides it), so this does.
function vaultKeyPlan({ envText, vault }) {
  const key = process.env.AEON_VAULT_MASTER_KEY || envValue(envText, 'AEON_VAULT_MASTER_KEY');
  let status = null;
  try { status = vault ? vault.getRecoveryStatus() : null; } catch { status = null; }
  if (!status || !status.hasKeyslots) return key ? 'keep' : 'mint';
  let opens = false;
  try { opens = !!key && withMasterKey(key, () => vault.isUnlocked()); } catch { opens = false; }
  if (opens) return 'keep';
  return status.hasRecoverySlot ? 'recover' : 'sealed';
}

// Ask for the recovery code until it opens the vault, the operator skips, or
// the tries run out. recoverWithCode unwraps the data key with the code and
// writes a NEW AEON_VAULT_MASTER_KEY to .env (the file this launcher writes);
// nothing stored is re-encrypted, so every saved key comes back.
async function recoverVault({ vault, ask, say = () => {}, tries = 3 }) {
  for (let i = 0; i < tries; i++) {
    const code = String((await ask('  Recovery code (or press Enter to skip): ')) || '').trim();
    if (!code) return { ok: false, error: 'skipped' };
    let r;
    try { r = vault.recoverWithCode(code); } catch (e) { return { ok: false, error: e.message }; }
    if (r && r.ok) return r;
    if (!r || r.error !== 'invalid-code') return r || { ok: false, error: 'unknown' };
    say('That code does not open this vault. Check it and try again.');
  }
  return { ok: false, error: 'invalid-code' };
}

// The recovery code is minted with the keyslots and printed once. Made here,
// the launcher can stop on it before the browser opens over this window; made
// by the server mid-boot, it scrolled away with the rest of the log (A045).
// Returns the code, or null when keyslots already existed or could not be made
// here (the server then makes them, as before).
function createKeyslots({ vault, envText }) {
  const key = process.env.AEON_VAULT_MASTER_KEY || envValue(envText, 'AEON_VAULT_MASTER_KEY');
  if (!vault || !key) return null;
  try {
    return withMasterKey(key, () => {
      const r = vault.ensureKeyslots();
      const code = vault.consumePendingRecoveryCode();
      return r && r.created ? code : null;
    });
  } catch { return null; }
}

// ── `node launch.js --recover-vault` ───────────────────────────────────────
// The recovery step on its own: no packages, no build, no server. The carried
// drive's and USB builds' launchers run `node server.cjs`, never this file's
// full launch, so the code needs a way in that works on every layout.
// vault.cjs needs only Node built-ins, and the vault and .env resolve through
// the same authorities the server uses (aeonHome.cjs, envFile.cjs), a carried
// drive's home included. Returns the exit code.
async function recoverOnly({ vault, envText, ask, log }) {
  const plan = vaultKeyPlan({ envText, vault });
  if (plan === 'keep') { log.ok('The key in .env already opens this vault. Nothing to recover.'); return 0; }
  if (plan === 'mint') { log.info('There is no vault here yet (no keyslot file), so there is nothing to recover.'); return 0; }
  if (plan === 'sealed') {
    log.warn('The key in .env does not open this vault, and the vault has no readable recovery');
    log.warn('slot (secrets/aeon-keyslots.json), so a recovery code cannot open it either.');
    log.warn('Restore the original .env and the secrets folder beside it.');
    return 1;
  }
  log.info('The key in .env does not open this vault. Paste the recovery code shown when');
  log.info('the vault was created.');
  const r = await recoverVault({ vault, ask, say: log.warn });
  if (!r.ok) {
    log.warn(r.error === 'skipped' ? 'Skipped. The vault stays sealed.' : `The vault was not reopened (${r.error}).`);
    return 1;
  }
  if (r.envKeyReissued === false) {
    // The recovery slot is unchanged, so the same code works again.
    log.warn(`The code was right, but the new key could not be written to .env (${r.warn}).`);
    log.warn('Make that file writable and run this again with the same code.');
    return 1;
  }
  log.ok('Vault reopened. A new key was written to .env; your stored keys are back.');
  log.info('If AEON is running, close its window and start it again so it uses the new key.');
  return 0;
}

// ── Already running on this home? ──────────────────────────────────────────
// A second double-click (the Desktop icon, launch.command) while AEON ran went
// through the whole launch: it found 3001 busy — held by that very AEON —
// printed "AEON will use 3002 instead" and "AEON IS STARTING", started a
// server that refused at the home lock, and opened the running AEON only when
// that server's minute-long redirect ended: about 65 s (review 2026-09-30).
// The home lock names the running AEON's port (src/kernel/runtime.cjs), so
// the launcher asks it first.
function runningAeon(home, { holderOf } = {}) {
  let holder = null;
  try { holder = (holderOf || require('./src/kernel/runtime.cjs').homeHolder)(home); } catch { return null; }
  const port = holder ? Number(holder.port) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, pid: holder.pid || null, starting: !!holder.starting };
}

/** Ask `base` until AEON answers there or the tries run out; the last answer. */
async function waitForAeon(base, { tries = 120, everyMs = 500, probe = probeAeon } = {}) {
  let who = 'none';
  for (let i = 0; i < tries; i++) {
    who = await probe(base);
    if (who === 'aeon') break;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  return who;
}

function openInBrowser(to) {
  const cmd = os.platform() === 'win32' ? `start "" "${to}"`
            : os.platform() === 'darwin' ? `open "${to}"` : `xdg-open "${to}"`;
  try { execSync(cmd, { stdio: 'ignore', shell: true }); return true; } catch { return false; }
}

// Where to get a Node that runs here, for the "too old" stop below. Node 24's
// macOS builds need macOS 13.5, so on macOS 11–13.4 the current LTS download
// would not start; name Node 22 LTS there, as launch.command does.
function nodeDownloadAdvice(platform, macosVersion) {
  if (platform === 'darwin' && macosVersion) {
    const [major, minor] = String(macosVersion).split('.').map(n => parseInt(n, 10) || 0);
    if (major > 0 && (major < 13 || (major === 13 && minor < 5))) {
      return `This Mac runs macOS ${macosVersion}, and Node.js 24 needs macOS 13.5 or newer. ` +
        'Install Node.js 22 LTS from https://nodejs.org/en/download and run LAUNCH again.';
    }
  }
  return 'Download the current LTS from https://nodejs.org and run LAUNCH again.';
}

// Required (tests) rather than run: export the helpers, run nothing — the rest
// of this file is the interactive launcher and ends by booting the server.
if (require.main !== module) {
  module.exports = {
    writeEnvFile, secureEnvFile, ENV_MODE, ensureEnvKey, checkProviderVault,
    INSTALL_MARKER, dependenciesReady, markDependenciesInstalled,
    choosePort, isAeonPing, probeAeon, runningAeon, waitForAeon,
    envValue, vaultKeyPlan, recoverVault, createKeyslots, recoverOnly,
    nodeDownloadAdvice, ensureInterface,
  };
  return;
}

// ── colors ──────────────────────────────────────────────────────────────────
const PU = '\x1b[38;5;141m', LP = '\x1b[38;5;183m', DG = '\x1b[38;5;240m',
      GR = '\x1b[38;5;245m', GN = '\x1b[32m', YL = '\x1b[33m', RD = '\x1b[31m', RS = '\x1b[0m';
const p = (line, c = '') => process.stdout.write((c || '') + line + RS + '\n');
const ok   = (m) => p('  [OK] ' + m, GN);
const info = (m) => p('  [--] ' + m, DG);
const warn = (m) => p('  [!!] ' + m, YL);
const fail = (m) => p('  [XX] ' + m, RD);

function sh(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true, ...opts }).trim(); }
  catch { return null; }
}

// ── splash ──────────────────────────────────────────────────────────────────
process.stdout.write('\x1b[2J\x1b[H');
p('');
p('      █████╗ ███████╗ ██████╗ ███╗   ██╗    ██████╗ ', PU);
p('     ██╔══██╗██╔════╝██╔═══██╗████╗  ██║    ╚════██╗', PU);
p('     ███████║█████╗  ██║   ██║██╔██╗ ██║     █████╔╝', PU);
p('     ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║     ╚═══██╗', LP);
p('     ██║  ██║███████╗╚██████╔╝██║ ╚████║    ██████╔╝', LP);
p('     ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═════╝ ', LP);
p('');
p('  ────────────────────────────────────────────────────────────', DG);
p('     AEON  ·  a local-first AI workspace', GR);
p('     Broken Gear Industries', GR);
p('  ────────────────────────────────────────────────────────────', DG);
p('');

// ── 1. environment scan ─────────────────────────────────────────────────────
p('  ENVIRONMENT', PU);

// Keep in step with "engines.node" in package.json — a test asserts they agree.
// This gate said 18 while pdfjs-dist (required server-side) needs >=22.13, and
// npm only WARNS on EBADENGINE, so a user on 18 or 20 passed this check, was
// told they were fine, and then failed during install with a broken build.
const NODE_MIN_MAJOR = 22;
const NODE_MIN_MINOR = 13;
const nodeVer = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVer.split('.').map(n => parseInt(n, 10));
if (nodeMajor < NODE_MIN_MAJOR || (nodeMajor === NODE_MIN_MAJOR && nodeMinor < NODE_MIN_MINOR)) {
  fail(`Node.js ${nodeVer} is too old — AEON needs ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} or newer.`);
  fail(nodeDownloadAdvice(os.platform(), os.platform() === 'darwin' ? sh('sw_vers -productVersion') : null));
  process.exit(1);
}
ok(`Node.js ${nodeVer} (${os.platform()} ${os.arch()})`);

const ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
ok(`Memory: ${ramGb} GB RAM`);

// GPU probe (best-effort, purely informational — Cookbook uses this later)
let gpuName = null;
const smi = sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
if (smi) { gpuName = smi.split(',')[0].trim(); ok(`GPU: ${gpuName}`); }
else if (os.platform() === 'darwin' && /Apple/.test(sh('sysctl -n machdep.cpu.brand_string') || '')) { gpuName = 'Apple Silicon'; ok('GPU: Apple Silicon (Metal)'); }
else info('No dedicated GPU detected — cloud + small local models still work.');


// ── interactive helpers ─────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let rlClosed = false;
rl.on('close', () => { rlClosed = true; });
// If stdin is closed or not a terminal (CI, double-click edge cases), every
// prompt resolves to "" — the skip path — instead of hanging forever.
const ask = (q) => new Promise((res) => {
  if (rlClosed || !process.stdin.isTTY) return res('');
  rl.once('close', () => res(''));
  rl.question(q, (a) => res((a || '').trim()));
});

async function main() {
  // --recover-vault on a portable USB build: its launchers export
  // AEON_PORTABLE=true before starting AEON, and its .env (made from .env.usb
  // at each boot) says the same. Do that before any path resolves, or this
  // would look for a home on the host — and move the drive's vault there —
  // instead of opening the drive's vault. .env.usb counts too: it is the
  // .env this mode may be recovering from the loss of.
  const recoverMode = process.argv.includes('--recover-vault');
  if (recoverMode && !process.env.AEON_PORTABLE) {
    for (const f of ['.env', '.env.usb']) {
      try {
        if (envValue(fs.readFileSync(path.join(ROOT, f), 'utf8'), 'AEON_PORTABLE') === 'true') { process.env.AEON_PORTABLE = 'true'; break; }
      } catch { /* not there: not a portable build, or not this file */ }
    }
  }

  // ── 1b. AEON home ─────────────────────────────────────────────────────────
  // Your data lives in ~/AEON (or AEON_HOME), not in this folder, so a
  // reinstall is `git pull`. An install from before that has its Vault, models,
  // keys, .env, runtime state and settings in here; they move now, once, root
  // by root — BEFORE the .env branch below could copy a fresh template and
  // mint a new vault key (that would orphan the existing keyslots), and before
  // anything reads a storage root. server.js repeats the call (a no-op then)
  // for `npm run server`.
  const { prepareHome } = require('./src/kernel/homeMigration.cjs');
  const homeBoot = prepareHome({ appRoot: ROOT, env: process.env, log: () => {} });
  const mig = homeBoot.migration;
  if (mig.moved.length || mig.refused.length || mig.warnings.length) {
    p('');
    p('  MIGRATION', PU);
    const label = { envFile: '.env', secrets: 'secrets', settings: 'settings', db: 'runtime state', vault: 'Vault', data: 'data (models, indexes)' };
    for (const m of mig.moved) ok(`${label[m.root] || m.root} moved to ${m.to}`);
    for (const r of mig.refused) {
      warn(`${label[r.root] || r.root} NOT moved — ${r.reason}`);
      warn(`    legacy: ${r.from}`);
      warn(`    target: ${r.to}`);
    }
    for (const w of mig.warnings) warn(w);
    if (mig.moved.length) ok(`Your data now lives in ${homeBoot.roots.home}`);
  }

  // ── 1c. vault recovery only (`node launch.js --recover-vault`) ───────────
  // Before the running check: a sealed AEON may be running, and this is how
  // it gets its key back.
  if (recoverMode) {
    p('');
    p('  VAULT RECOVERY', PU);
    // Resolved again: ENV_PATH above was fixed before AEON_PORTABLE could be.
    const envPath = envFilePath({ appRoot: ROOT });
    info(`Vault keys: ${homeBoot.roots.secrets}`);
    info(`Key file:   ${envPath}`);
    let vault = null;
    try { vault = require('./src/kernel/vault.cjs'); }
    catch (e) { fail(`The vault module did not load: ${e.message}`); process.exit(1); }
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    process.exit(await recoverOnly({ vault, envText, ask, log: { ok, info, warn } }));
  }

  // ── 1d. AEON already running on this home ────────────────────────────────
  // Open it and end here; nothing below may start a second one (see
  // runningAeon above).
  const running = runningAeon(homeBoot.roots.home);
  if (running) {
    const at = `http://localhost:${running.port}`;
    p('');
    p('  ALREADY RUNNING', PU);
    info(running.starting
      ? `AEON is starting on this computer at ${at}. Waiting for it to answer...`
      : `AEON is already running on this computer at ${at}.`);
    const who = await waitForAeon(at);
    if (who === 'aeon') {
      openInBrowser(at);
      ok('Opened in your browser. This window can be closed: AEON runs in its own window.');
      process.exit(0);
    }
    warn(`AEON did not answer at ${at} within a minute${who === 'other' ? ' (another program answers there)' : ''}.`);
    warn('This launch did not start a second AEON. The running one\'s window may say why.');
    process.exit(1);
  }

  // ── 2. Local AI models ────────────────────────────────────────────────────
  // AEON runs local models with a llama.cpp worker that Cookbook downloads
  // (not bundled) — no daemon, no system-wide install, everything inside
  // <home>/data. The runtime and the GGUF models are large, so fetching them
  // is the Cookbook block's job (it has progress, cancel, and disk-space
  // checks); the launcher only reports what is already installed. AEON boots
  // fine on cloud AI either way.
  // Read the registry, never probe a daemon — and only now, after the data
  // root is settled (requiring storage resolves it for the whole process).
  let localRuntime = { available: false, runtimeId: null, readyModels: [] };
  try {
    localRuntime = require(path.join(ROOT, 'services', 'local-runtime', 'index.cjs')).status();
  } catch {}
  p('');
  p('  LOCAL AI MODELS', PU);
  if (localRuntime.available) {
    ok(`Local runtime ready — ${localRuntime.runtimeId} (${localRuntime.runtimeBackend}), ${localRuntime.readyModels.length} model(s).`);
  } else if (localRuntime.runtimeId) {
    ok(`Local runtime installed — ${localRuntime.runtimeId} (${localRuntime.runtimeBackend}).`);
    info('No models downloaded yet. Add one from the Cookbook block inside AEON.');
  } else {
    info('Local models let AEON run free and private on this computer — no API');
    info('key, no internet. Install them from the Cookbook block inside AEON;');
    info(`everything stays in your AEON home (${homeBoot.roots.home}).`);
    info('Until then AEON uses cloud AI (Gemini, Groq, OpenRouter).');
  }

  // ── 3. .env onboarding ────────────────────────────────────────────────────
  p('');
  p('  CONFIGURATION', PU);
  if (!fs.existsSync(ENV_PATH)) {
    // AEON_ENV_FILE may point outside the install (packaged builds put it in
    // userData); that directory need not exist yet.
    try { fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true }); } catch { }
    fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    secureEnvFile(ENV_PATH); // the copy inherits the template's 0644
    ok(`Created your private configuration file at ${ENV_PATH}`);
    p('');
    info('AEON can use free cloud AI (Gemini, Groq, OpenRouter). If you already');
    info('have keys, paste them now. If not, just press Enter — you can add');
    info('everything later inside AEON under Settings -> Account.');
    p('');
    const wizardKeys = [
      ['GEMINI_FREE_KEY_1', 'Gemini key (free at aistudio.google.com)'],
      ['GROQ_API_KEY',      'Groq key (free at console.groq.com)'],
      ['OPENROUTER_API_KEY','OpenRouter key (openrouter.ai — 200+ models)'],
    ];
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    for (const [key, label] of wizardKeys) {
      const v = await ask(`  ${label}\n    ${key} = `);
      if (v) {
        env = env.includes(key + '=')
          ? env.replace(new RegExp('^' + key + '=.*$', 'm'), `${key}=${v}`)
          : env + `\n${key}=${v}`;
        ok('Saved.');
      } else info('Skipped — add it later in Settings.');
    }
    writeEnvFile(ENV_PATH, env);
  } else ok('.env configuration found.');

  // ── 4. vault bootstrap — master key is generated, never asked for ─────────
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  const ensure = (key, gen, opts) => {
    const r = ensureEnvKey(env, key, gen, opts);
    env = r.env;
    return r.added;
  };
  // ── Compromised-credential rotation (BO-A3b) ──────────────────────────────
  // ensure() only fills a value that is MISSING. A credential that is present
  // and known-exposed sails straight through, which is exactly what happened
  // to AEON_MOBILE_SECRET: it was owed rotation across three build orders, the
  // install was deleted and re-cloned — which would have generated a fresh one
  // — and then the preserved .env put the exposed value back, because that
  // .env must be restored for the vault master key.
  //
  // So rotation cannot be a manual step; nobody is ever blocked by it. AEON
  // carries fingerprints of credentials it knows are burned and replaces them
  // at launch. Only the digest is stored, never the value.
  //
  // Deliberately NOT applied to AEON_VAULT_MASTER_KEY: rotating that without
  // rewrapping the keyslots is a lockout, and owner lockout is never
  // acceptable. If a master key is ever exposed it needs its own guided
  // re-wrap, not a silent regeneration.
  const rotateCompromised = (key, gen) => {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'security', 'compromised-credentials.json'), 'utf8')).credentials || [];
    } catch { return false; }

    const m = env.match(new RegExp('^' + key + '=(.*)$', 'm'));
    const current = (m && m[1] || '').trim();
    if (!current) return false;

    const digest = crypto.createHash('sha256').update(current).digest('hex');
    if (!list.some(c => c.key === key && c.sha256 === digest)) return false;

    env = env.replace(new RegExp('^' + key + '=.*$', 'm'), `${key}=${gen()}`);
    return true;
  };

  // vault.cjs needs only Node built-ins, so it loads before npm install has
  // ever run. null if it cannot: the launcher then mints as it always did.
  let vault = null;
  try { vault = require('./src/kernel/vault.cjs'); } catch { vault = null; }
  const plan = vaultKeyPlan({ envText: env, vault });
  let recovered = false;
  if (plan === 'recover') {
    p('');
    warn('AEON already has a vault on this computer, but the key in .env does not open it.');
    warn('(.env was lost or replaced, or restored without the secrets folder beside it.)');
    info('If you saved the recovery code shown when the vault was created, paste it');
    info('below to reopen the vault. Press Enter to skip: AEON still starts, but the');
    info('keys stored in the vault stay locked until it is reopened.');
    const r = await recoverVault({ vault, ask, say: warn });
    if (r.ok) {
      // recoverWithCode wrote the new key to .env and into this process;
      // put it in the text this launcher writes back below as well, so that
      // write cannot undo it (and so it lands even if its own write failed).
      const line = `AEON_VAULT_MASTER_KEY=${process.env.AEON_VAULT_MASTER_KEY}`;
      env = fs.readFileSync(ENV_PATH, 'utf8');
      env = /^AEON_VAULT_MASTER_KEY=.*$/m.test(env)
        ? env.replace(/^AEON_VAULT_MASTER_KEY=.*$/m, () => line)
        : `${env}${env.endsWith('\n') || !env ? '' : '\n'}${line}\n`;
      recovered = true;
    }
  } else if (plan === 'sealed') {
    p('');
    warn('AEON already has a vault on this computer, but the key in .env does not open it,');
    warn('and the vault has no readable recovery slot (secrets/aeon-keyslots.json).');
  }
  const madeVault = plan === 'mint' && ensure('AEON_VAULT_MASTER_KEY', () => crypto.randomBytes(32).toString('hex'));
  const newMobile = () => crypto.randomBytes(24).toString('hex');
  // The vault's copy first: rotated there if it is known-exposed, and a vault
  // copy means .env gets no second one (see checkProviderVault above).
  const inVault = checkProviderVault({
    envText: env,
    listFile: path.join(ROOT, 'security', 'compromised-credentials.json'),
    generate: (key) => (key === 'AEON_MOBILE_SECRET' ? newMobile() : null),
  });
  if (inVault && inVault.rotated.includes('AEON_MOBILE_SECRET')) {
    ok('AEON_MOBILE_SECRET in the vault was a known-exposed value — rotated automatically.');
  }
  for (const k of (inVault ? inVault.exposed.filter((x) => !inVault.rotated.includes(x)) : [])) {
    warn(`${k} in the vault is a known-exposed credential — replace it in Settings.`);
  }
  ensure('AEON_MOBILE_SECRET', newMobile, { heldInVault: !!(inVault && inVault.holds('AEON_MOBILE_SECRET')) });
  if (rotateCompromised('AEON_MOBILE_SECRET', newMobile)) {
    ok('AEON_MOBILE_SECRET was a known-exposed value — rotated automatically.');
  }
  writeEnvFile(ENV_PATH, env);
  if (madeVault) ok('Vault created — your API keys will be encrypted on this computer.');
  else if (recovered) ok('Vault reopened with your recovery code. A new key was written to .env; your stored keys are back.');
  else if (plan === 'keep') ok('Vault key present.');
  else {
    // Nothing was minted: a new key cannot open this vault, it would only
    // hide the problem. The server says the same and stays up (vaultBootGuard).
    warn('Vault left SEALED — the keys stored in it cannot be read this session.');
    if (plan === 'recover') {
      warn('To reopen it: restore the original .env and run LAUNCH again,');
      warn('or run LAUNCH again and paste the recovery code when asked.');
    } else warn('To reopen it: restore the original .env (and the secrets folder beside it) and run LAUNCH again.');
  }
  // Only once .env holds the key: keyslots wrapped under a key that was never
  // saved would seal the vault on the next start.
  const recoveryCode = createKeyslots({ vault, envText: env });
  if (recoveryCode) {
    // vault.ensureKeyslots printed the code just above. Stop on it while the
    // window still shows it — the browser opens over this window later.
    await ask('  Write the recovery code down, then press Enter to continue. ');
  }
  // Every launch, not only the first: an install from before this fix has a
  // 0644 .env that nothing else would ever tighten. Said out loud (R-05).
  const envMode = secureEnvFile(ENV_PATH);
  if (envMode.changed) ok(`.env made owner-only (was ${envMode.from}, now 600) — it holds your vault key.`);
  else if (envMode.error) warn(`Could not restrict .env permissions: ${envMode.error}`);

  // (db/host-runtime.json used to be written here; nothing ever read it.)

  // data/local-runtime.json is the native runtime's own transactional registry
  // (services/local-runtime/registry.cjs owns it). The launcher must never
  // write it — a hand-seeded file would be read as a corrupt registry.

  rl.close();

  // ── 5. dependencies ───────────────────────────────────────────────────────
  p('');
  p('  DEPENDENCIES', PU);
  const deps = dependenciesReady(ROOT);
  if (!deps.ready) {
    // A half-finished tree gets `npm ci`: it empties node_modules and installs
    // exactly what package-lock.json names, so a package cut off mid-download
    // cannot pass for an installed one.
    let first = 'npm install --prefer-offline --no-audit --no-fund';
    if (deps.reason === 'incomplete') {
      warn('The last package install did not finish (the window was closed, the computer');
      warn('slept, or a download failed). Installing the packages again from the start.');
      info('A few minutes; needs internet...');
      first = 'npm ci --prefer-offline --no-audit --no-fund';
    } else info('First run — installing packages (one time, a few minutes)...');
    try { execSync(first, { cwd: ROOT, stdio: 'inherit', shell: true }); }
    catch {
      try { execSync('npm install', { cwd: ROOT, stdio: 'inherit', shell: true }); }
      catch { fail('npm install failed. Check your internet connection and run LAUNCH again.'); process.exit(1); }
    }
    markDependenciesInstalled(ROOT);
  }
  ok('Dependencies ready.');

  // ── 6. frontend build (server serves dist/; rebuilt when blocks changed) ──
  {
    const r = ensureInterface(ROOT, { say: info, warnFn: warn });
    if (!r.ok && r.reason === 'missing') { fail('Interface build failed. Run "npm run build" to see details.'); process.exit(1); }
  }
  ok('Interface ready.');

  // ── 6b. desktop icon ──────────────────────────────────────────────────────
  // First run puts AEON on the Desktop (AEON.app on macOS, AEON.lnk on
  // Windows) so the operator never has to find this launcher inside a cloned
  // folder again. Skipped on USB/portable media and with
  // AEON_NO_DESKTOP_ICON=1; an icon the operator deleted stays deleted until
  // they run `node launch.js --desktop-icon`. Never allowed to stop a boot.
  try {
    const { ensureDesktopShortcut } = require(path.join(ROOT, 'tools', 'desktop-shortcut.cjs'));
    const sc = ensureDesktopShortcut({
      root: ROOT, platform: os.platform(), env: process.env,
      dataRoot: homeBoot.roots.data,
      force: process.argv.includes('--desktop-icon'),
    });
    if (sc.status === 'created') ok(`Desktop icon created — ${sc.path}. Open AEON from there next time.`);
    else if (sc.status === 'updated') ok(`Desktop icon updated to this install — ${sc.path}`);
    else if (sc.status === 'failed') warn(`Could not create the desktop icon: ${sc.reason}`);
    else if (sc.reason === 'removed-by-user') info('Desktop icon was removed — run "node launch.js --desktop-icon" to bring it back.');
    else if (sc.reason === 'unsupported-platform') info('No Desktop icon on Linux yet — start AEON with ./launch.sh.');
    if (sc.warning) warn(sc.warning);
  } catch (e) {
    warn(`Desktop icon skipped: ${e.message}`);
  }

  // ── 7. boot ───────────────────────────────────────────────────────────────
  const { port: PORT, chosen } = await choosePort();
  if (PORT == null) {
    fail('Ports 3001-3020 are all in use by other programs. Close one and run LAUNCH again.');
    process.exit(1);
  }
  if (chosen && PORT !== '3001') info(`Port 3001 is in use — AEON will use ${PORT} instead.`);
  p('');
  p('  ────────────────────────────────────────────────────────────', DG);
  p(`   AEON IS STARTING  ->  http://localhost:${PORT}`, PU);
  p('   Keep this window open. Close it to shut AEON down.', GR);
  p('  ────────────────────────────────────────────────────────────', DG);
  p('');

  // AEON_SUPERVISED: Settings → RESTART exits with 75 and startServer()
  // below brings it back; any other exit ends the launcher.
  const startServer = () => {
    const child = spawn('node', ['server/server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT, AEON_SUPERVISED: '1' } });
    child.on('exit', (code) => {
      if (code === 75) {
        p('   Restarting AEON...', GR);
        // A block installed while AEON ran has no screen until the interface
        // is rebuilt; Restart is when the operator expects it to appear.
        ensureInterface(ROOT, { say: info, warnFn: warn });
        startServer(); return;
      }
      // A second double-click while AEON runs: this server refuses at once
      // (one AEON per home, src/kernel/runtime.cjs) and exits before the
      // probe below first fires, so the icon only printed a message where it
      // used to open the running AEON. Open that one, then end.
      if (code && !opened) {
        let holder = null;
        try { holder = require('./src/kernel/runtime.cjs').homeHolder(homeBoot.roots.home); } catch { /* no lock to read */ }
        const running = holder && Number(holder.port);
        if (Number.isInteger(running) && running > 0) { opened = true; openBrowser(`http://localhost:${running}`); }
      }
      process.exit(code || 0);
    });
    return child;
  };
  const server = startServer();
  const url = `http://localhost:${PORT}`;

  // Open the browser only AFTER the kernel is actually listening. A fixed
  // timer raced the boot: on a slower machine Chrome hit the port before the
  // server bound it and flashed "can't reach this site" before recovering.
  // We poll AEON's /api/ping and open exactly once AEON answers. Any HTTP
  // reply used to count, so another program on the port got its page opened.
  //
  // The probe asks `localhost`, as the browser will: whatever answers the
  // probe is what the browser would show.
  const openBrowser = (to = url) => {
    openInBrowser(to);
    ok('Opened in your browser.');
  };
  let opened = false;
  let sawOther = false;
  const waitForServer = async (attempt = 0) => {
    if (opened) return;
    // ~60s ceiling — open anyway, unless what answers there is not AEON.
    if (attempt > 120) {
      if (!sawOther) { opened = true; openBrowser(); }
      else warn(`AEON never answered at ${url}; another program does. The browser was not opened.`);
      return;
    }
    const who = await probeAeon(url);
    if (opened) return;
    if (who === 'aeon') { opened = true; openBrowser(); return; }
    if (who === 'other' && !sawOther) {
      sawOther = true;
      // Two launches at the same moment: the other one took this home first,
      // and this server only redirects to it. Open that AEON.
      const first = runningAeon(homeBoot.roots.home);
      if (first && String(first.port) !== String(PORT)) {
        opened = true; openBrowser(`http://localhost:${first.port}`); return;
      }
      // Said, not just remembered (R-05): a silent minute reads as a hang.
      warn(`Another program answers at ${url}. The browser will open only once AEON does.`);
    }
    setTimeout(() => waitForServer(attempt + 1), 500);
  };
  setTimeout(() => waitForServer(), 600); // small head start before first probe

}

main().catch((e) => { fail(e.message); process.exit(1); });
