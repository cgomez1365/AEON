#!/usr/bin/env node
'use strict';
/**
 * AEON 3 — Universal Launcher
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

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
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
p('     AEON Console  ·  an AI-native operating system', GR);
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

// Native local runtime (llama.cpp) — read the registry, never probe a daemon.
let localRuntime = { available: false, runtimeId: null, readyModels: [] };
try {
  localRuntime = require(path.join(ROOT, 'services', 'local-runtime', 'index.cjs')).status();
} catch {}

// local model capability hint, written for Cookbook + Settings to read at boot
const runtimeHints = {
  scannedAt: new Date().toISOString(),
  platform: os.platform(), arch: os.arch(), ramGb, gpu: gpuName,
  localRuntime: {
    installed: !!localRuntime.runtimeId,
    backend: localRuntime.runtimeBackend || null,
    readyModels: (localRuntime.readyModels || []).length,
  },
};

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
  // ── 2. Local AI models ────────────────────────────────────────────────────
  // AEON runs local models with a bundled llama.cpp worker — no daemon, no
  // system-wide install, everything inside <AEON>/data. The runtime and the
  // GGUF models are large, so fetching them is the Cookbook block's job (it
  // has progress, cancel, and disk-space checks); the launcher only reports
  // what is already installed. AEON boots fine on cloud AI either way.
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
    info('everything stays contained in the AEON folder.');
    info('Until then AEON uses cloud AI (Gemini, Groq, OpenRouter).');
  }

  // ── 3. .env onboarding ────────────────────────────────────────────────────
  p('');
  p('  CONFIGURATION', PU);
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    ok('Created your private .env configuration file.');
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
  const madeVault = ensure('AEON_VAULT_MASTER_KEY', () => crypto.randomBytes(32).toString('hex'));
  ensure('AEON_MOBILE_SECRET', () => crypto.randomBytes(24).toString('hex'));
  fs.writeFileSync(ENV_PATH, env);
  if (madeVault) ok('Vault created — your API keys will be encrypted on this computer.');
  else ok('Vault key present.');

  // flash runtime hints for Cookbook/Settings
  try {
    const dataDir = path.join(ROOT, 'db');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'host-runtime.json'), JSON.stringify(runtimeHints, null, 2));
  } catch {}

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
