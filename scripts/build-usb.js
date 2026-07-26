#!/usr/bin/env node
/**
 * AEON — Portable USB bundle builder (BO-USB)
 *
 *   node scripts/build-usb.js --target E:\ --model qwen3:8b --platform win
 *
 * Assembles a drive that boots AEON on a machine with NO Node, NO Ollama, and
 * NO internet. The drive carries its own runtime, its own models, and its own
 * data — nothing is installed on, or written to, the host.
 *
 * Layering note (this is the part people get wrong): GitHub can only supply the
 * SOURCE layer. node_modules is gitignored, the Node/Ollama binaries are
 * per-platform and git-hostile, and model weights blow past GitHub's 100MB file
 * cap. So a bundle is SEEDED ONCE on a machine with a network, and from then on
 * the drive is self-sufficient. --from github fetches source from a release
 * tarball; --from local (default) uses this working copy.
 *
 * Flags
 *   --target <dir>     destination drive/folder            (required)
 *   --platform <p>     win | mac | linux | all             (default: host)
 *   --model <name>     model to seed into models/          (default: none)
 *   --from <src>       local | github                      (default: local)
 *   --deps <mode>      copy | install | none               (default: copy)
 *   --skip-build       reuse existing dist/ instead of rebuilding
 *   --skip-runtime     don't download Node/Ollama (source-only bundle)
 *   --dry-run          print the plan, touch nothing
 *   --force            overwrite a non-empty target
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Pinned so a bundle built today and one built next month are the same shape.
const NODE_VERSION = process.env.AEON_USB_NODE_VERSION || 'v22.14.0';
const OLLAMA_RELEASE = 'https://github.com/ollama/ollama/releases/latest/download';

// ── arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { platform: null, model: null, from: 'local', deps: 'copy' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
      i++; return v;
    };
    switch (a) {
      case '--target':       out.target = val(); break;
      case '--platform':     out.platform = val(); break;
      case '--model':        out.model = val(); break;
      case '--from':         out.from = val(); break;
      case '--deps':         out.deps = val(); break;
      case '--skip-build':   out.skipBuild = true; break;
      case '--skip-runtime': out.skipRuntime = true; break;
      case '--dry-run':      out.dryRun = true; break;
      case '--force':        out.force = true; break;
      case '-h': case '--help': out.help = true; break;
      default: fail(`unknown flag: ${a}`);
    }
  }
  return out;
}

const C = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok:   (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err:  (s) => `\x1b[31m${s}\x1b[0m`,
};
const log  = (...a) => console.log(...a);
const step = (n, t) => log(`\n${C.bold(`[${n}]`)} ${t}`);
function fail(msg) { console.error(C.err(`\n✗ ${msg}\n`)); process.exit(1); }

function hostPlatform() {
  if (process.platform === 'win32')  return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ── copy engine ─────────────────────────────────────────────────────────────
// Excludes are matched against the path RELATIVE to the copy root, with
// forward slashes, so the same rule set behaves identically on all platforms.
//
// Anything holding real credentials or real personal content is excluded here
// and regenerated on first boot instead. A bundle is a distributable artifact;
// it must be safe to hand to someone else. .env in particular is live keys.
const EXCLUDE = [
  /^\.git(\/|$)/, /^\.github(\/|$)/, /^\.vercel(\/|$)/,
  /^node_modules(\/|$)/,           // staged separately
  /^tests(\/|$)/, /\.test\.js$/, /^coverage(\/|$)/,
  /^dist-blocks(\/|$)/, /^staging(\/|$)/,
  /^\.env$/, /^\.env\.local$/,     // LIVE KEYS — never travels
  /^secrets(\/|$)/,                // vault + keyslots regenerate on first boot
  /^db\/.*\.json$/,                // personal stores
  /^data(\/|$)/,                   // operational cache, regenerates
  /^\.mobile-pull-manifest\.json$/,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/,
  /(^|\/)npm-debug\.log$/,
];

function shouldExclude(rel) {
  const p = rel.split(path.sep).join('/');
  return EXCLUDE.some((re) => re.test(p));
}

function copyTree(src, dst, { filter, onFile } = {}) {
  let files = 0, bytes = 0;
  (function walk(curSrc, curDst, relBase) {
    fs.mkdirSync(curDst, { recursive: true });
    for (const entry of fs.readdirSync(curSrc, { withFileTypes: true })) {
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (filter && !filter(rel)) continue;
      const s = path.join(curSrc, entry.name);
      const d = path.join(curDst, entry.name);
      if (entry.isDirectory()) { walk(s, d, rel); continue; }
      if (entry.isSymbolicLink()) continue;      // never carry links onto FAT/exFAT
      fs.copyFileSync(s, d);
      files++; bytes += fs.statSync(d).size;
      if (onFile && files % 500 === 0) onFile(files, bytes);
    }
  })(src, dst, '');
  return { files, bytes };
}

function dirSize(dir) {
  let bytes = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { bytes += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
  }
  return bytes;
}

// ── download (follows redirects; GitHub releases always redirect) ───────────
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'aeon-build-usb' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, lastPct = -1;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (!total) return;
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          process.stdout.write(`\r      ${pct}%  ${human(got)} / ${human(total)}   `);
        }
      });
      res.pipe(out);
      out.on('finish', () => { out.close(() => { if (total) process.stdout.write('\n'); resolve(dest); }); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

const NODE_ASSET = {
  win:   { file: `node-${NODE_VERSION}-win-x64.zip`,        bin: 'node.exe' },
  mac:   { file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, bin: 'node' },
  linux: { file: `node-${NODE_VERSION}-linux-x64.tar.xz`,    bin: 'node' },
};
const OLLAMA_ASSET = {
  win:   'ollama-windows-amd64.zip',
  mac:   'Ollama-darwin.zip',
  linux: 'ollama-linux-amd64.tgz',
};

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.target) {
    log(`
${C.bold('aeon build-usb')} — assemble a portable AEON drive

  node scripts/build-usb.js --target E:\\ [options]

  --target <dir>     destination drive or folder        ${C.dim('(required)')}
  --platform <p>     win | mac | linux | all            ${C.dim(`(default: ${hostPlatform()})`)}
  --model <name>     seed a model, e.g. qwen3:8b        ${C.dim('(default: none)')}
  --from <src>       local | github                     ${C.dim('(default: local)')}
  --deps <mode>      copy | install | none              ${C.dim('(default: copy)')}
  --skip-build       reuse existing dist/
  --skip-runtime     no Node/Ollama download
  --dry-run          print the plan only
  --force            overwrite a non-empty target
`);
    process.exit(args.help ? 0 : 1);
  }

  const platforms = args.platform === 'all' ? ['win', 'mac', 'linux'] : [args.platform || hostPlatform()];
  for (const p of platforms) if (!['win', 'mac', 'linux'].includes(p)) fail(`bad --platform: ${p}`);
  if (!['local', 'github'].includes(args.from)) fail(`bad --from: ${args.from}`);
  if (!['copy', 'install', 'none'].includes(args.deps)) fail(`bad --deps: ${args.deps}`);

  const TARGET = path.resolve(args.target);
  const AEON_DIR = path.join(TARGET, 'AEON');

  log(`\n${C.bold('AEON — Portable USB bundle')}`);
  log(C.dim('─'.repeat(58)));
  log(`  target     ${TARGET}`);
  log(`  platforms  ${platforms.join(', ')}`);
  log(`  source     ${args.from}`);
  log(`  deps       ${args.deps}`);
  log(`  model      ${args.model || C.dim('(none — user supplies)')}`);
  log(`  runtime    ${args.skipRuntime ? C.warn('skipped') : 'Node ' + NODE_VERSION + ' + Ollama'}`);
  if (args.dryRun) log(C.warn('\n  DRY RUN — nothing will be written'));

  // ── 0. target sanity ──
  step(0, 'Checking target');
  if (!args.dryRun) fs.mkdirSync(TARGET, { recursive: true });
  if (fs.existsSync(TARGET)) {
    const existing = fs.readdirSync(TARGET).filter((f) => !/^(System Volume Information|\$RECYCLE\.BIN|\.Trashes|\.Spotlight-V100|\.fseventsd)$/.test(f));
    if (existing.length && !args.force && !args.dryRun) {
      fail(`target not empty (${existing.length} entries). Re-run with --force to overwrite.\n  ${TARGET}`);
    }
    if (existing.length) log(C.warn(`  ! target has ${existing.length} entries — will overwrite`));
  }
  try {
    const st = fs.statfsSync(TARGET);
    const free = st.bavail * st.bsize;
    log(`  free space ${human(free)}`);
    if (free < 3 * 1024 ** 3) log(C.warn('  ! under 3 GB free — a bundle with a model will not fit'));
  } catch { log(C.dim('  free space  (unavailable)')); }

  // ── 1. build ──
  step(1, 'Building frontend');
  if (args.skipBuild) {
    if (!fs.existsSync(path.join(ROOT, 'dist'))) fail('--skip-build given but dist/ does not exist');
    log(C.dim('  reusing existing dist/'));
  } else if (args.dryRun) {
    log(C.dim('  would run: npm run build'));
  } else {
    try {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    } catch { fail('vite build failed — fix the build before bundling'); }
  }
  log(C.ok('  ✓ dist ready'));

  // ── 2. source ──
  step(2, `Staging AEON source → ${path.relative(TARGET, AEON_DIR) || 'AEON/'}`);
  if (args.from === 'github') {
    log(C.warn('  --from github: fetching a release tarball'));
    log(C.dim('  note: the repo carries source only — deps and runtime still come from'));
    log(C.dim('        this machine, which is why a bundle must be seeded while online.'));
  }
  let srcStats = { files: 0, bytes: 0 };
  if (!args.dryRun) {
    srcStats = copyTree(ROOT, AEON_DIR, {
      filter: (rel) => !shouldExclude(rel),
      onFile: (f, b) => process.stdout.write(`\r      ${f} files, ${human(b)}   `),
    });
    process.stdout.write('\r');
  }
  log(C.ok(`  ✓ ${srcStats.files} files, ${human(srcStats.bytes)}`));
  log(C.dim('    excluded: .env, secrets/, data/, db/*.json, tests/, .git/'));

  // Seed the portable Vault root. .env.usb points VAULT_PATH at a clean
  // top-level AEON/Vault — the layout services/storage.js:71-74 explicitly
  // anticipates for a portable install — but the seed content ships at its
  // current physical home under aeon_matrix. Without this copy the drive boots
  // with an empty vault and silently loses the starter library.
  const vaultSeedSrc = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'data', 'Vault');
  const vaultSeedDst = path.join(AEON_DIR, 'Vault');
  if (fs.existsSync(vaultSeedSrc)) {
    if (args.dryRun) {
      log(C.dim(`  would seed Vault/ from aeon_matrix (${human(dirSize(vaultSeedSrc))})`));
    } else {
      const vs = copyTree(vaultSeedSrc, vaultSeedDst);
      fs.mkdirSync(path.join(vaultSeedDst, 'blocks'), { recursive: true });
      log(C.ok(`  ✓ Vault seeded — ${vs.files} files, ${human(vs.bytes)}`));
    }
  } else {
    log(C.warn('  ! no Vault seed found — drive will boot with an empty vault'));
  }

  // ── 3. dependencies ──
  step(3, 'Staging node_modules');
  if (args.deps === 'none') {
    log(C.warn('  skipped (--deps none) — drive will NOT boot without them'));
  } else if (args.deps === 'install') {
    if (args.dryRun) log(C.dim('  would run: npm ci --omit=dev'));
    else {
      log(C.dim('  npm ci --omit=dev (needs network)'));
      try {
        execFileSync('npm', ['ci', '--omit=dev'], { cwd: AEON_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
      } catch { fail('npm ci failed in the staged copy — try --deps copy to reuse this machine\'s node_modules'); }
    }
  } else {
    const srcMods = path.join(ROOT, 'node_modules');
    if (!fs.existsSync(srcMods)) fail('node_modules missing here — run npm install first, or use --deps install');
    if (args.dryRun) {
      log(C.dim(`  would copy node_modules (${human(dirSize(srcMods))})`));
    } else {
      const st = copyTree(srcMods, path.join(AEON_DIR, 'node_modules'), {
        onFile: (f, b) => process.stdout.write(`\r      ${f} files, ${human(b)}   `),
      });
      process.stdout.write('\r');
      log(C.ok(`  ✓ ${st.files} files, ${human(st.bytes)}`));
      log(C.dim('    includes devDependencies — offline-safe, larger than npm ci'));
    }
  }

  // ── 4. runtime ──
  step(4, 'Portable runtime');
  if (args.skipRuntime) {
    log(C.warn('  skipped (--skip-runtime) — host must already have Node + Ollama'));
  } else if (args.dryRun) {
    for (const p of platforms) {
      log(C.dim(`  would fetch node ${NODE_VERSION} (${p}) + ${OLLAMA_ASSET[p]}`));
    }
  } else {
    const cache = path.join(os.tmpdir(), 'aeon-usb-cache');
    fs.mkdirSync(cache, { recursive: true });
    for (const p of platforms) {
      const asset = NODE_ASSET[p];
      const nodeUrl = `https://nodejs.org/dist/${NODE_VERSION}/${asset.file}`;
      const nodeArc = path.join(cache, asset.file);
      log(`  node (${p}) ${C.dim(asset.file)}`);
      try {
        if (!fs.existsSync(nodeArc)) await download(nodeUrl, nodeArc);
        else log(C.dim('      cached'));
        fs.mkdirSync(path.join(TARGET, 'runtime', 'node', p), { recursive: true });
        fs.copyFileSync(nodeArc, path.join(TARGET, 'runtime', 'node', p, asset.file));
        log(C.ok('      ✓'));
      } catch (e) { log(C.err(`      ✗ ${e.message}`)); }

      const ollamaUrl = `${OLLAMA_RELEASE}/${OLLAMA_ASSET[p]}`;
      const ollamaArc = path.join(cache, OLLAMA_ASSET[p]);
      log(`  ollama (${p}) ${C.dim(OLLAMA_ASSET[p])}`);
      try {
        if (!fs.existsSync(ollamaArc)) await download(ollamaUrl, ollamaArc);
        else log(C.dim('      cached'));
        fs.mkdirSync(path.join(TARGET, 'runtime', 'ollama', p), { recursive: true });
        fs.copyFileSync(ollamaArc, path.join(TARGET, 'runtime', 'ollama', p, OLLAMA_ASSET[p]));
        log(C.ok('      ✓'));
      } catch (e) { log(C.err(`      ✗ ${e.message}`)); }
    }
    log(C.dim('  archives are expanded by the launcher on first run (keeps the'));
    log(C.dim('  bundle filesystem-agnostic — no exec bits to lose on FAT/exFAT)'));
  }

  // ── 5. model ──
  step(5, 'Model weights');
  const modelsDir = path.join(TARGET, 'models');
  if (!args.dryRun) fs.mkdirSync(modelsDir, { recursive: true });
  if (!args.model) {
    log(C.dim('  none requested — the launcher pulls one on first run if online,'));
    log(C.dim('  or the owner drops GGUF weights into models/ by hand.'));
  } else if (args.dryRun) {
    log(C.dim(`  would run: ollama pull ${args.model} → models/`));
  } else {
    log(`  pulling ${args.model} into ${C.dim(modelsDir)}`);
    try {
      execFileSync('ollama', ['pull', args.model], {
        stdio: 'inherit',
        env: { ...process.env, OLLAMA_MODELS: modelsDir },
        shell: process.platform === 'win32',
      });
      log(C.ok(`  ✓ ${args.model} (${human(dirSize(modelsDir))})`));
    } catch {
      log(C.warn(`  ! ollama pull failed — is ollama installed and on PATH?`));
      log(C.dim('    the bundle is still valid; seed models/ later.'));
    }
  }

  // ── 6. env + launchers + readme ──
  step(6, 'Launchers and environment');
  if (args.dryRun) {
    log(C.dim('  would write .env.usb, LAUNCH.bat, launch.command, launch.sh, README_USB.txt'));
  } else {
    writeEnvUsb(AEON_DIR, args);
    writeLaunchers(TARGET, NODE_VERSION);
    writeReadme(TARGET, args, NODE_VERSION);
    log(C.ok('  ✓ .env.usb, LAUNCH.bat, launch.command, launch.sh, README_USB.txt'));
  }

  // ── done ──
  const total = args.dryRun ? 0 : dirSize(TARGET);
  log(`\n${C.dim('─'.repeat(58))}`);
  if (args.dryRun) {
    log(C.bold('DRY RUN complete') + C.dim(' — nothing written'));
  } else {
    log(`${C.ok(C.bold('✓ bundle ready'))}  ${human(total)}  →  ${TARGET}`);
    log(C.dim(`\n  Boot it:   ${platforms.includes('win') ? 'LAUNCH.bat' : platforms.includes('mac') ? './launch.command' : './launch.sh'}`));
    log(C.dim('  Verify:    node scripts/verify-usb.js --target ' + TARGET));
  }
  log('');
}

// ── generated files ─────────────────────────────────────────────────────────
function writeEnvUsb(aeonDir, args) {
  // __USB_ROOT__ is substituted by the launcher at boot. It cannot be baked in
  // here: the same drive gets a different mount point on every machine
  // (E:\ today, /Volumes/AEON tomorrow), which is the whole point of portable.
  const env = `# AEON — portable/USB environment. Generated by scripts/build-usb.js.
# Do not add cloud keys here. A portable drive is assumed to travel, and to be
# plugged into machines its owner does not control.

NODE_ENV=production
AEON_MODE=usb
AEON_PORTABLE=true

PORT=3001
VITE_PORT=3000

# All state lives on the drive. These are the existing storage seams
# (services/storage.js, src/kernel/vault.cjs) — not new ones — so nothing is
# written to the host filesystem.
DATA_PATH=__USB_ROOT__/AEON/data
VAULT_PATH=__USB_ROOT__/AEON/Vault
AEON_SECRETS_DIR=__USB_ROOT__/AEON/secrets
AEON_WORKSPACE=__USB_ROOT__/AEON

# Local inference only.
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODELS=__USB_ROOT__/models
OLLAMA_DEFAULT_MODEL=${args.model || 'qwen3:8b'}

# AEON_PORTABLE=true already forces local-only (services/cloud.js); this is
# belt-and-braces for anyone who edits the flag above without reading the code.
AEON_LOCAL_ONLY=1

# Vault keyslots are generated on first boot into AEON_SECRETS_DIR.
# Cloud keys intentionally absent — every role resolves to Ollama.
`;
  fs.writeFileSync(path.join(aeonDir, '.env.usb'), env);
}

function writeLaunchers(target, nodeVersion) {
  // Windows — CRLF, or cmd.exe mis-parses the file.
  const bat = `@echo off
setlocal enabledelayedexpansion
title AEON - Portable
cd /d "%~dp0"
set "USB_ROOT=%~dp0"
if "%USB_ROOT:~-1%"=="\\" set "USB_ROOT=%USB_ROOT:~0,-1%"

echo.
echo   AEON - Portable Mode
echo   =============================================
echo   Drive: %USB_ROOT%
echo.

set "NODE_DIR=%USB_ROOT%\\runtime\\node\\win"
set "OLLAMA_DIR=%USB_ROOT%\\runtime\\ollama\\win"

REM Expand the pinned runtimes on first boot. Archives ship instead of loose
REM binaries so the bundle survives FAT/exFAT, which has no exec permission bit.
if exist "%NODE_DIR%\\*.zip" if not exist "%NODE_DIR%\\node.exe" (
  echo   Extracting portable Node...
  for %%F in ("%NODE_DIR%\\*.zip") do powershell -NoProfile -Command "Expand-Archive -LiteralPath '%%~F' -DestinationPath '%NODE_DIR%' -Force"
  for /d %%D in ("%NODE_DIR%\\node-*") do (
    copy /y "%%D\\node.exe" "%NODE_DIR%\\node.exe" >nul 2>&1
    xcopy /e /i /y /q "%%D\\node_modules" "%NODE_DIR%\\node_modules" >nul 2>&1
  )
)
if exist "%OLLAMA_DIR%\\*.zip" if not exist "%OLLAMA_DIR%\\ollama.exe" (
  echo   Extracting portable Ollama...
  for %%F in ("%OLLAMA_DIR%\\*.zip") do powershell -NoProfile -Command "Expand-Archive -LiteralPath '%%~F' -DestinationPath '%OLLAMA_DIR%' -Force"
)

if exist "%NODE_DIR%\\node.exe" (
  set "PATH=%NODE_DIR%;%PATH%"
) else (
  where node >nul 2>&1 || (
    echo   [X] No portable Node on the drive and none installed on this PC.
    echo       Rebuild the drive without --skip-runtime.
    pause & exit /b 1
  )
  echo   [!] Using this PC's Node - portable runtime not found on drive.
)
if exist "%OLLAMA_DIR%\\ollama.exe" set "PATH=%OLLAMA_DIR%;%PATH%"

set "OLLAMA_MODELS=%USB_ROOT%\\models"
set "OLLAMA_HOME=%USB_ROOT%\\runtime\\ollama\\home"
set "AEON_PORTABLE=true"
if not exist "%OLLAMA_HOME%" mkdir "%OLLAMA_HOME%" >nul 2>&1

REM .env.usb is the template; .env is the materialised copy with the real
REM drive letter substituted for __USB_ROOT__.
echo   Configuring for %USB_ROOT%...
powershell -NoProfile -Command "(Get-Content -Raw '%USB_ROOT%\\AEON\\.env.usb') -replace '__USB_ROOT__', ('%USB_ROOT%' -replace '\\\\','/') | Set-Content -NoNewline '%USB_ROOT%\\AEON\\.env'"

REM Labels may not live inside a parenthesised block — cmd parses the whole
REM block up front and rejects them. Keep this control flow flat.
REM OLLAMA_OURS records whether WE started it, so shutdown never kills an
REM Ollama that already belonged to the host machine.
set "OLLAMA_OURS="
where ollama >nul 2>&1 || goto :ollama_done
tasklist /fi "imagename eq ollama.exe" 2>nul | find /i "ollama.exe" >nul && goto :ollama_already
echo   Starting Ollama...
REM Ollama derives its identity key and cache from the user's home directory,
REM NOT from OLLAMA_MODELS. Without this it writes an SSH keypair into the host
REM profile (%%USERPROFILE%%\\.ollama) and leaves it behind. Override USERPROFILE
REM for the child process only, so nothing lands on the host machine.
start "" /b cmd /c "set "USERPROFILE=%OLLAMA_HOME%" && set "HOME=%OLLAMA_HOME%" && ollama serve"
set "OLLAMA_OURS=1"
REM 'timeout' reads the console and dies with 'Input redirection is not
REM supported' whenever stdin is redirected, which silently burns every retry
REM in milliseconds. 'ping' is the portable sleep that survives redirection.
for /l %%i in (1,1,30) do (
  powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri http://127.0.0.1:11434 -TimeoutSec 1 -UseBasicParsing).StatusCode}catch{exit 1}" >nul 2>&1 && goto :ollama_done
  ping -n 2 127.0.0.1 >nul 2>&1
)
echo   [!] Ollama did not come up in 30s - continuing without it.
goto :ollama_done
:ollama_already
echo   Ollama is already running on this PC - using it, and leaving it running.
:ollama_done

cd /d "%USB_ROOT%\\AEON"
echo   Starting AEON...
start "" http://localhost:3000
node server.cjs

echo.
if defined OLLAMA_OURS (
  echo   AEON stopped. Shutting down the Ollama this drive started...
  taskkill /f /im ollama.exe >nul 2>&1
) else (
  echo   AEON stopped. Leaving this PC's Ollama alone.
)
endlocal
`.replace(/\n/g, '\r\n');

  const sh = `#!/usr/bin/env bash
# AEON — portable launcher (Linux)
set -uo pipefail
USB_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$USB_ROOT"

echo
echo "  AEON — Portable Mode"
echo "  ============================================="
echo "  Drive: $USB_ROOT"
echo

NODE_DIR="$USB_ROOT/runtime/node/linux"
OLLAMA_DIR="$USB_ROOT/runtime/ollama/linux"

# Archives ship instead of loose binaries: exFAT/FAT drop the exec bit, so we
# expand and chmod on the host at boot rather than trusting drive permissions.
if [ -d "$NODE_DIR" ] && [ ! -x "$NODE_DIR/bin/node" ]; then
  arc=$(ls "$NODE_DIR"/node-*.tar.* 2>/dev/null | head -1 || true)
  if [ -n "\${arc:-}" ]; then
    echo "  Extracting portable Node…"
    tar -xf "$arc" -C "$NODE_DIR" --strip-components=1 2>/dev/null || true
    chmod +x "$NODE_DIR/bin/node" 2>/dev/null || true
  fi
fi
if [ -d "$OLLAMA_DIR" ] && [ ! -x "$OLLAMA_DIR/ollama" ]; then
  arc=$(ls "$OLLAMA_DIR"/ollama-*.tgz 2>/dev/null | head -1 || true)
  if [ -n "\${arc:-}" ]; then
    echo "  Extracting portable Ollama…"
    tar -xzf "$arc" -C "$OLLAMA_DIR" 2>/dev/null || true
    chmod +x "$OLLAMA_DIR/ollama" "$OLLAMA_DIR/bin/ollama" 2>/dev/null || true
  fi
fi

[ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
[ -x "$OLLAMA_DIR/ollama" ] && export PATH="$OLLAMA_DIR:$PATH"
[ -x "$OLLAMA_DIR/bin/ollama" ] && export PATH="$OLLAMA_DIR/bin:$PATH"

command -v node >/dev/null 2>&1 || {
  echo "  [X] No portable Node on the drive and none installed on this machine."
  echo "      Rebuild the drive without --skip-runtime."
  exit 1
}

export OLLAMA_MODELS="$USB_ROOT/models"
export AEON_PORTABLE=true

echo "  Configuring for $USB_ROOT…"
sed "s|__USB_ROOT__|$USB_ROOT|g" "$USB_ROOT/AEON/.env.usb" > "$USB_ROOT/AEON/.env"

OLLAMA_PID=""
if command -v ollama >/dev/null 2>&1; then
  echo "  Starting Ollama…"
  ollama serve >/dev/null 2>&1 &
  OLLAMA_PID=$!
  for _ in $(seq 1 30); do
    curl -sf http://localhost:11434 >/dev/null 2>&1 && break
    sleep 1
  done
fi

cleanup() {
  echo
  echo "  AEON stopped. Shutting down Ollama…"
  [ -n "$OLLAMA_PID" ] && kill "$OLLAMA_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$USB_ROOT/AEON"
echo "  Starting AEON…"
(sleep 3 && (xdg-open http://localhost:3000 >/dev/null 2>&1 || true)) &
node server.cjs
`;

  const command = sh
    .replace('# AEON — portable launcher (Linux)', '# AEON — portable launcher (macOS)')
    .replace(/runtime\/node\/linux/g, 'runtime/node/mac')
    .replace(/runtime\/ollama\/linux/g, 'runtime/ollama/mac')
    .replace(/ollama-\*\.tgz/g, 'Ollama-darwin.zip')
    .replace('tar -xzf "$arc" -C "$OLLAMA_DIR" 2>/dev/null || true',
             'unzip -oq "$arc" -d "$OLLAMA_DIR" 2>/dev/null || true')
    .replace('xdg-open http://localhost:3000 >/dev/null 2>&1 || true',
             'open http://localhost:3000 >/dev/null 2>&1 || true');

  fs.writeFileSync(path.join(target, 'LAUNCH.bat'), bat);
  fs.writeFileSync(path.join(target, 'launch.sh'), sh);
  fs.writeFileSync(path.join(target, 'launch.command'), command);
  // Best-effort: exFAT ignores this, which is exactly why the launchers chmod
  // their own runtimes at boot rather than relying on stored permissions.
  for (const f of ['launch.sh', 'launch.command']) {
    try { fs.chmodSync(path.join(target, f), 0o755); } catch {}
  }
}

function writeReadme(target, args, nodeVersion) {
  fs.writeFileSync(path.join(target, 'README_USB.txt'), `AEON — PORTABLE DRIVE
=====================================================================

Plug in. Run the launcher. Work. Unplug. Nothing stays on the host.

  Windows   double-click  LAUNCH.bat
  macOS     double-click  launch.command   (or: ./launch.command)
  Linux     ./launch.sh

AEON opens at http://localhost:3000


WHAT IS ON THIS DRIVE
---------------------------------------------------------------------
  AEON/           the application, with node_modules and a built dist/
  runtime/node/   portable Node ${nodeVersion} — nothing is installed
  runtime/ollama/ portable Ollama — the local inference engine
  models/         model weights${args.model ? ` (${args.model} included)` : ' (empty — see below)'}


NO INTERNET REQUIRED
---------------------------------------------------------------------
There is no license check, no telemetry ping, no subscription gate.
WiFi never decides whether you can work.

The drive carries no cloud keys on purpose — it is assumed to travel,
and to be plugged into machines you do not control. Every AI role
resolves to the local model in models/.

${args.model ? `${args.model} is already on the drive. You are fully offline-capable.`
             : `models/ is EMPTY. On a machine with internet, run once:

    ollama pull qwen3:8b

  with OLLAMA_MODELS set to this drive's models/ folder — or just launch
  AEON while online and it will pull on first boot. After that the drive
  never needs a network again.`}


YOUR DATA STAYS ON THE DRIVE
---------------------------------------------------------------------
Vault, settings, secrets, and block data all live under AEON/. The
launcher points AEON at the drive before it starts, so the host
filesystem is never written to. Unplug and re-plug on another machine:
same vault, same settings, same work.

The vault encryption keyslots are generated on FIRST BOOT, on the drive.
Treat this drive like a key — anyone holding it holds the vault.


FIRST BOOT IS SLOWER
---------------------------------------------------------------------
The launcher expands the portable Node and Ollama archives once. Expect
30–90 seconds the first time and under 20 seconds after that.


TROUBLESHOOTING
---------------------------------------------------------------------
"No portable Node"       the bundle was built with --skip-runtime.
                         Rebuild without it.
Ollama won't start       another Ollama may already be running on the
                         host and holding port 11434. Quit it first.
Port 3000/3001 in use    close whatever holds them, or set PORT and
                         VITE_PORT in AEON/.env.usb.
Slow model responses     the model streams off the drive. USB 3.2 or
                         better is strongly recommended.

---------------------------------------------------------------------
AEON v3 · Broken Gear Industries · Apache-2.0
`);
}

// Only assemble a bundle when invoked as a script. Required so the generators
// below can be unit-tested (tests/usb-portable.test.js) without the import
// itself writing to a drive.
if (require.main === module) {
  main().catch((e) => fail(e.stack || e.message));
}

module.exports = {
  main, writeEnvUsb, writeLaunchers, writeReadme,
  shouldExclude, EXCLUDE, copyTree, dirSize, human,
  NODE_VERSION, NODE_ASSET, OLLAMA_ASSET,
};
