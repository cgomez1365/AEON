#!/usr/bin/env node
/**
 * AEON — portable bundle verifier (BO-USB testing phase)
 *
 *   node scripts/verify-usb.js --target E:\
 *
 * Audits an assembled bundle WITHOUT booting it. Runs against a real drive, a
 * subst'd virtual drive, a mounted VHDX, or a plain folder — the checks are
 * filesystem-shaped, not hardware-shaped, so a bundle can be fully validated
 * on a machine that has no USB stick in it.
 *
 * Exit 0 = shippable. Exit 1 = at least one FAIL. Warnings never fail the run.
 *
 * The leak checks are the point of this script. A bundle is a distributable
 * artifact: if it carries live keys or personal data, that travels to every
 * machine the drive touches. Those checks are FAILs, never warnings.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`,
};

let pass = 0, warn = 0, failed = 0;
const PASS = (m, d) => { pass++;   console.log(`  ${C.ok('✓')} ${m}${d ? C.dim(`  ${d}`) : ''}`); };
const WARN = (m, d) => { warn++;   console.log(`  ${C.warn('!')} ${m}${d ? C.dim(`  ${d}`) : ''}`); };
const FAIL = (m, d) => { failed++; console.log(`  ${C.err('✗')} ${m}${d ? C.dim(`  ${d}`) : ''}`); };
const section = (t) => console.log(`\n${C.bold(t)}`);

function human(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function dirSize(d) {
  let b = 0;
  if (!fs.existsSync(d)) return 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    try { b += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
  }
  return b;
}
function walk(dir, cb, depth = 0) {
  if (depth > 12 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, cb, depth + 1);
    } else cb(p);
  }
}

// ── args ──
const argv = process.argv.slice(2);
let target = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target') target = argv[++i];
  else if (argv[i] === '-h' || argv[i] === '--help') {
    console.log('\n  node scripts/verify-usb.js --target <drive-or-folder>\n');
    process.exit(0);
  }
}
if (!target) { console.error(C.err('\n✗ --target is required\n')); process.exit(1); }

const T = path.resolve(target);
const A = path.join(T, 'AEON');

console.log(`\n${C.bold('AEON — portable bundle verification')}`);
console.log(C.dim('─'.repeat(58)));
console.log(`  target  ${T}`);
if (!fs.existsSync(T)) { console.error(C.err(`\n✗ target does not exist: ${T}\n`)); process.exit(1); }

// ── 1. structure ──
section('1. Bundle structure');
for (const [p, label] of [
  [A, 'AEON/'], [path.join(T, 'models'), 'models/'],
  [path.join(T, 'LAUNCH.bat'), 'LAUNCH.bat'],
  [path.join(T, 'launch.command'), 'launch.command'],
  [path.join(T, 'launch.sh'), 'launch.sh'],
  [path.join(T, 'README_USB.txt'), 'README_USB.txt'],
]) fs.existsSync(p) ? PASS(label) : FAIL(`${label} missing`);

for (const [p, label] of [
  [path.join(A, 'server.cjs'), 'AEON/server.cjs'],
  [path.join(A, 'package.json'), 'AEON/package.json'],
  [path.join(A, 'server'), 'AEON/server/'],
  [path.join(A, 'src'), 'AEON/src/'],
  [path.join(A, 'services'), 'AEON/services/'],
]) fs.existsSync(p) ? PASS(label) : FAIL(`${label} missing`);

fs.existsSync(path.join(A, 'dist'))
  ? PASS('AEON/dist/', human(dirSize(path.join(A, 'dist'))))
  : FAIL('AEON/dist/ missing — production server has nothing to serve');

const mods = path.join(A, 'node_modules');
if (fs.existsSync(mods)) {
  PASS('AEON/node_modules/', human(dirSize(mods)));
  fs.existsSync(path.join(mods, 'express'))
    ? PASS('express present')
    : FAIL('express missing from node_modules — bundle will not boot');
} else {
  WARN('AEON/node_modules/ absent', 'built with --deps none; drive will NOT boot');
}

// ── 2. leak audit (the important part) ──
section('2. Leak audit');
for (const [rel, why] of [
  ['.env', 'LIVE API KEYS'], ['.env.local', 'live local overrides'],
  ['secrets', 'vault + keyslots'], ['.git', 'full history, may contain old keys'],
  ['data', 'personal operational state'],
]) {
  fs.existsSync(path.join(A, rel))
    ? FAIL(`${rel} present in bundle`, why)
    : PASS(`${rel} excluded`);
}

const personalDb = fs.existsSync(path.join(A, 'db'))
  ? fs.readdirSync(path.join(A, 'db')).filter((f) => f.endsWith('.json'))
  : [];
personalDb.length
  ? FAIL(`db/ carries ${personalDb.length} personal json store(s)`, personalDb.slice(0, 3).join(', '))
  : PASS('db/ carries no personal json stores');

// Content scan. Patterns are provider key shapes plus JWTs; a hit here means a
// credential survived the copy filter and the bundle must not ship.
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI-style key'],
  [/\bAIza[A-Za-z0-9_\-]{30,}/, 'Google API key'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'Groq key'],
  [/\bsk-ant-[A-Za-z0-9\-_]{20,}/, 'Anthropic key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJhbGciOi[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, 'JWT'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub PAT'],
];
const SCAN_EXT = /\.(js|cjs|mjs|jsx|ts|tsx|json|env|txt|md|yml|yaml|sh|bat|command|sql)$/i;
const hits = [];
walk(A, (f) => {
  if (!SCAN_EXT.test(f)) return;
  if (/(^|[\\/])(package-lock\.json|dist)([\\/]|$)/.test(f)) return;
  let text;
  try {
    if (fs.statSync(f).size > 2 * 1024 * 1024) return;
    text = fs.readFileSync(f, 'utf8');
  } catch { return; }
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) { hits.push(`${path.relative(T, f)} (${label})`); break; }
  }
});
hits.length
  ? hits.slice(0, 8).forEach((h) => FAIL('credential-shaped string', h))
  : PASS('no credential-shaped strings found', 'scanned source, config, docs');

// ── 3. portable environment ──
section('3. Portable environment');
const envUsbPath = path.join(A, '.env.usb');
if (!fs.existsSync(envUsbPath)) {
  FAIL('.env.usb missing — launcher has no template to materialise');
} else {
  const env = fs.readFileSync(envUsbPath, 'utf8');
  const need = {
    AEON_PORTABLE: 'true', AEON_MODE: 'usb', AEON_LOCAL_ONLY: '1',
    DATA_PATH: null, VAULT_PATH: null, AEON_SECRETS_DIR: null,
    AEON_WORKSPACE: null,
  };
  for (const [k, expected] of Object.entries(need)) {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    if (!m) { FAIL(`.env.usb missing ${k}`); continue; }
    if (expected && m[1].trim() !== expected) FAIL(`.env.usb ${k}=${m[1].trim()}`, `expected ${expected}`);
    else PASS(`.env.usb ${k}`, m[1].trim());
  }
  // Every path var must be drive-relative. A literal absolute host path here
  // means the bundle writes to whatever machine built it.
  for (const k of ['DATA_PATH', 'VAULT_PATH', 'AEON_SECRETS_DIR', 'AEON_WORKSPACE']) {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    if (!m) continue;
    const v = m[1].trim();
    if (v.includes('__USB_ROOT__')) PASS(`${k} is drive-relative`);
    else if (/^[A-Za-z]:[\\/]|^\/(Users|home|Volumes)\//.test(v)) FAIL(`${k} hardcodes a host path`, v);
    else WARN(`${k} is neither tokenised nor absolute`, v);
  }
  for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_PAID_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY']) {
    new RegExp(`^${forbidden}=.+`, 'm').test(env)
      ? FAIL(`.env.usb sets ${forbidden}`, 'cloud keys must not travel on portable media')
      : PASS(`.env.usb has no ${forbidden}`);
  }
}

// ── 4. vault seed ──
section('4. Vault seed');
const envText = fs.existsSync(envUsbPath) ? fs.readFileSync(envUsbPath, 'utf8') : '';
const vaultVar = (envText.match(/^VAULT_PATH=(.*)$/m) || [])[1];
if (vaultVar) {
  const rel = vaultVar.trim().replace('__USB_ROOT__', '').replace(/^[\\/]+/, '');
  const resolved = path.join(T, rel);
  if (fs.existsSync(resolved)) {
    const n = dirSize(resolved);
    PASS('VAULT_PATH resolves to a real directory', `${rel} — ${human(n)}`);
    if (n === 0) WARN('vault seed is empty', 'drive boots with no starter library');
  } else {
    FAIL('VAULT_PATH points at a directory that does not exist', rel);
  }
}

// ── 5. launchers ──
section('5. Launchers');
const bat = path.join(T, 'LAUNCH.bat');
if (fs.existsSync(bat)) {
  const raw = fs.readFileSync(bat, 'latin1');
  // cmd.exe mis-parses LF-only batch files — this is a real boot failure, not style.
  raw.includes('\r\n') ? PASS('LAUNCH.bat has CRLF line endings') : FAIL('LAUNCH.bat is LF-only', 'cmd.exe will mis-parse it');
  raw.includes('__USB_ROOT__') ? PASS('LAUNCH.bat substitutes __USB_ROOT__') : FAIL('LAUNCH.bat never substitutes __USB_ROOT__');
  /AEON_PORTABLE/.test(raw) ? PASS('LAUNCH.bat sets AEON_PORTABLE') : FAIL('LAUNCH.bat does not set AEON_PORTABLE');
}
for (const name of ['launch.sh', 'launch.command']) {
  const p = path.join(T, name);
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, 'latin1');
  // A stray CR makes the shebang `#!/usr/bin/env bash\r` — "bad interpreter".
  raw.includes('\r') ? FAIL(`${name} contains CR`, 'bash will fail with "bad interpreter"') : PASS(`${name} is LF-clean`);
  raw.startsWith('#!') ? PASS(`${name} has a shebang`) : FAIL(`${name} has no shebang`);
  raw.includes('__USB_ROOT__') ? PASS(`${name} substitutes __USB_ROOT__`) : FAIL(`${name} never substitutes __USB_ROOT__`);
}

// ── 6. runtime + models ──
section('6. Runtime and models');
const rtNode = path.join(T, 'runtime', 'node');
// This used to also verify a staged model-daemon runtime. The builder stopped staging
// system-wide model daemon when AEON moved to its own bundled llama.cpp
// runtime; the check was never updated, so it warned about a directory nothing
// creates any more. Local inference now lives under the app's own data root and
// is verified by the runtime registry, not by a staged vendor folder.
if (fs.existsSync(rtNode)) {
  const plats = fs.readdirSync(rtNode).filter((p) => fs.statSync(path.join(rtNode, p)).isDirectory());
  plats.length ? PASS(`portable Node staged`, `${plats.join(', ')} — ${human(dirSize(rtNode))}`)
               : WARN('runtime/node/ is empty');
} else WARN('runtime/node/ absent', 'host must already have Node');

const modelsSize = dirSize(path.join(T, 'models'));
modelsSize > 0 ? PASS('models/ seeded', human(modelsSize))
               : WARN('models/ is empty', 'first boot needs a network to pull one');

// ── summary ──
console.log(`\n${C.dim('─'.repeat(58))}`);
console.log(`  total bundle: ${C.bold(human(dirSize(T)))}`);
console.log(`  ${C.ok(`${pass} passed`)}   ${warn ? C.warn(`${warn} warnings`) : `${warn} warnings`}   ${failed ? C.err(`${failed} failed`) : '0 failed'}`);
if (failed) {
  console.log(`\n  ${C.err(C.bold('NOT SHIPPABLE'))} — resolve the failures above.\n`);
  process.exit(1);
}
console.log(`\n  ${C.ok(C.bold('BUNDLE VERIFIED'))}${warn ? C.dim(' — review warnings before shipping') : ''}\n`);
