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
 *   6. Boot               — kernel on :3001, browser opens itself
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
const PORT = process.env.PORT || 3001;

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
  fail('Download the current LTS from https://nodejs.org and run LAUNCH again.');
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

  // ── 2. Local AI models ────────────────────────────────────────────────────
  // AEON runs local models with a bundled llama.cpp worker — no daemon, no
  // system-wide install, everything inside <home>/data. The runtime and the
  // GGUF models are large, so fetching them is the Cookbook block's job (it
  // has progress, cancel, and disk-space checks); the launcher only reports
  // what is already installed. AEON boots fine on cloud AI either way.
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
    fs.writeFileSync(ENV_PATH, env);
  } else ok('.env configuration found.');

  // ── 4. vault bootstrap — master key is generated, never asked for ─────────
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  const ensure = (key, gen) => {
    const m = env.match(new RegExp('^' + key + '=(.*)$', 'm'));
    if (!m || !m[1].trim()) {
      const v = gen();
      env = m ? env.replace(new RegExp('^' + key + '=.*$', 'm'), `${key}=${v}`) : env + `\n${key}=${v}`;
      return true;
    }
    return false;
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

  const madeVault = ensure('AEON_VAULT_MASTER_KEY', () => crypto.randomBytes(32).toString('hex'));
  const newMobile = () => crypto.randomBytes(24).toString('hex');
  ensure('AEON_MOBILE_SECRET', newMobile);
  if (rotateCompromised('AEON_MOBILE_SECRET', newMobile)) {
    ok('AEON_MOBILE_SECRET was a known-exposed value — rotated automatically.');
  }
  fs.writeFileSync(ENV_PATH, env);
  if (madeVault) ok('Vault created — your API keys will be encrypted on this computer.');
  else ok('Vault key present.');

  // (db/host-runtime.json used to be written here; nothing ever read it.)

  // data/local-runtime.json is the native runtime's own transactional registry
  // (services/local-runtime/registry.cjs owns it). The launcher must never
  // write it — a hand-seeded file would be read as a corrupt registry.

  rl.close();

  // ── 5. dependencies ───────────────────────────────────────────────────────
  p('');
  p('  DEPENDENCIES', PU);
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    info('First run — installing packages (one time, a few minutes)...');
    try { execSync('npm install --prefer-offline --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', shell: true }); }
    catch {
      try { execSync('npm install', { cwd: ROOT, stdio: 'inherit', shell: true }); }
      catch { fail('npm install failed. Check your internet connection and run LAUNCH again.'); process.exit(1); }
    }
  }
  ok('Dependencies ready.');

  // ── 6. frontend build (one-time; server serves dist/) ───────────────────
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    info('Building the interface (one time)...');
    try { execSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true }); }
    catch { fail('Interface build failed. Run "npm run build" to see details.'); process.exit(1); }
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
  p('');
  p('  ────────────────────────────────────────────────────────────', DG);
  p(`   AEON IS STARTING  ->  http://localhost:${PORT}`, PU);
  p('   Keep this window open. Close it to shut AEON down.', GR);
  p('  ────────────────────────────────────────────────────────────', DG);
  p('');

  const server = spawn('node', ['server/server.js'], { cwd: ROOT, stdio: 'inherit' });
  const url = `http://localhost:${PORT}`;

  // Open the browser only AFTER the kernel is actually listening. A fixed
  // timer raced the boot: on a slower machine Chrome hit the port before the
  // server bound it and flashed "can't reach this site" before recovering.
  // We poll the health endpoint and open exactly once it answers.
  const http = require('http');
  const openBrowser = () => {
    const cmd = os.platform() === 'win32' ? `start "" "${url}"`
              : os.platform() === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    try { execSync(cmd, { stdio: 'ignore', shell: true }); } catch {}
    ok('Opened in your browser.');
  };
  let opened = false;
  const waitForServer = (attempt = 0) => {
    if (opened) return;
    if (attempt > 120) { openBrowser(); return; } // ~60s ceiling — open anyway
    const req = http.get(url, (res) => {
      res.resume();
      if (!opened) { opened = true; openBrowser(); }
    });
    req.on('error', () => setTimeout(() => waitForServer(attempt + 1), 500));
    req.setTimeout(1500, () => { req.destroy(); setTimeout(() => waitForServer(attempt + 1), 500); });
  };
  setTimeout(() => waitForServer(), 600); // small head start before first probe

  server.on('exit', (code) => process.exit(code || 0));
}

main().catch((e) => { fail(e.message); process.exit(1); });
