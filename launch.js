#!/usr/bin/env node
'use strict';
/**
 * AEON 3 — Universal Launcher
 * One file, every platform. Detects the environment, walks a non-technical
 * user through first-run setup, and boots the console.
 *
 *   1. Environment scan   — Node, npm, RAM, GPU, Ollama
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

const nodeVer = process.versions.node;
const nodeMajor = parseInt(nodeVer.split('.')[0], 10);
if (nodeMajor < 18) {
  fail(`Node.js ${nodeVer} is too old — AEON needs 18 or newer.`);
  fail('Download the latest from https://nodejs.org and run LAUNCH again.');
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

// Ollama detection
let ollamaState = 'missing';
if (sh('ollama --version')) {
  const running = os.platform() === 'win32'
    ? /ollama/i.test(sh('tasklist') || '')
    : !!sh('pgrep -x ollama');
  ollamaState = running ? 'running' : 'installed';
}

// local model capability hint, written for Cookbook + Settings to read at boot
const runtimeHints = {
  scannedAt: new Date().toISOString(),
  platform: os.platform(), arch: os.arch(), ramGb, gpu: gpuName,
  ollama: ollamaState,
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
  // AEON never installs anything system-wide on your behalf — but a local
  // model runtime is genuinely useful (free, private, offline), so on a
  // fresh install with nothing detected, it offers a CONTAINED download:
  // straight into <AEON>/data/cookbook/runtime/ollama, nothing touches the
  // system, delete the folder and it's gone. Recommended, never forced —
  // Enter skips and AEON runs fine on cloud AI either way. Same install code
  // path as the Cookbook block's own button (services/ollamaVendor.js), so
  // there's one place that knows how to fetch/extract it.
  const ollamaVendor = require(path.join(ROOT, 'services', 'ollamaVendor.js'));
  const vendorDir = path.join(process.env.DATA_PATH || path.join(ROOT, 'data'), 'cookbook', 'runtime', 'ollama');
  const vendoredBin = ollamaVendor.vendoredBin(vendorDir);

  p('');
  p('  LOCAL AI MODELS', PU);
  if (vendoredBin) {
    ok('Ollama is installed inside AEON (contained — no system-wide install).');
    ollamaState = 'installed';
  } else if (ollamaState === 'running') {
    ok('Ollama detected and running — AEON will use it as a local option.');
  } else if (ollamaState === 'installed') {
    ok('Ollama detected — starting it in the background...');
    try { spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); ollamaState = 'running'; } catch {}
  } else {
    info('Ollama lets AEON run free, private AI models on this computer —');
    info('no API key and no internet needed. Downloaded here, it stays fully');
    info('contained inside AEON (not a system-wide install).');
    const status = await ollamaVendor.checkStatus(vendorDir);
    if (!status.supported) {
      info('No portable build available for this platform — skipping.');
      info('AEON runs fine on cloud AI. Add local models later from Cookbook.');
    } else {
      p('');
      const sizeNote = status.size ? ` (${status.size} download)` : '';
      const a = await ask(`  Download Ollama now${sizeNote}? [Y]es (recommended) / [Enter] to skip: `);
      if (/^y/i.test(a)) {
        p('');
        info('Downloading Ollama (this can take a while on a slow connection)...');
        try {
          await ollamaVendor.install(vendorDir, (line) => info(line));
          ok('Ollama installed — contained inside AEON.');
          ollamaState = 'installed';
        } catch (e) {
          warn(`Install did not finish: ${e.message}`);
          warn('You can retry any time from the Cookbook block — AEON works without it.');
        }
      } else {
        info('Skipped. Add local models any time from the Cookbook block inside AEON.');
      }
    }
  }
  runtimeHints.ollama = ollamaState;

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

  // Seed data/local-runtime.json so the kernel knows the local-model truth on
  // the very first boot (the Cookbook block owns and refreshes it afterwards).
  try {
    const rtFile = path.join(ROOT, 'data', 'local-runtime.json');
    if (!fs.existsSync(path.dirname(rtFile))) fs.mkdirSync(path.dirname(rtFile), { recursive: true });
    if (!fs.existsSync(rtFile)) {
      const models = [];
      // Vendored copy has no daemon running yet at this point in boot (it's
      // started on demand later) — nothing to list until then. A system
      // install may already be running, so ask it directly.
      if (ollamaState === 'running') {
        const out = sh('ollama list') || '';
        for (const line of out.split('\n').slice(1)) {
          const name = line.trim().split(/\s+/)[0];
          if (name) models.push({ id: name, backend: 'ollama', ready: true });
        }
      }
      fs.writeFileSync(rtFile, JSON.stringify({
        updated: new Date().toISOString(),
        models_dir: path.join(ROOT, 'data', 'cookbook', 'models'),
        runtimes: { ollama: { installed: ollamaState !== 'missing', vendored: !!vendoredBin, path: vendoredBin || null, host: process.env.OLLAMA_HOST || 'http://localhost:11434' } },
        models,
      }, null, 2));
    }
  } catch {}

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
