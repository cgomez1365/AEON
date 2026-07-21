// routes/cookbook.js — Cookbook Hardware: GPU probing, model download/serve, cache scan
// Ported from Python cookbook_routes.py + cookbook_helpers.py + hwfit_routes.py
// Runs directly on the Windows host via child_process (no Docker/tmux/SSH).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const os = require('os');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OLLAMA_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/;

module.exports = function createCookbookRouter(deps) {
  const router = express.Router();
  const { getLocalFile, getDataFile, writeOSAudit } = deps;

  // Was '../src/blocks/cookbook/data' — from cookbook/api/, that resolved to
  // cookbook/src/blocks/cookbook/data (nested garbage), same depth-miscalculation
  // bug class found in council and deep_research. getDataFile() fixes it structurally.
  const COOKBOOK_DIR = getDataFile ? getDataFile('cookbook') : path.join(__dirname, '../src/blocks/cookbook/data');
  const STATE_FILE = path.join(COOKBOOK_DIR, 'cookbook_state.json');
  const LOGS_DIR = path.join(COOKBOOK_DIR, 'logs');
  try { if (!fs.existsSync(COOKBOOK_DIR)) fs.mkdirSync(COOKBOOK_DIR, { recursive: true }); } catch {}
  try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

  // ── Model storage — INSIDE the AEON install by default ──────────
  // The bible's vision: "cookbook downloads local models inside it, so
  // Settings just reads cookbook." No hardcoded ~/.cache assumption —
  // models live in <AEON>/data/cookbook/models so the whole thing is
  // portable (delete the folder = models gone). Power users override with
  // AEON_MODELS_DIR or the standard HF_HOME.
  function modelsRoot() {
    if (process.env.AEON_MODELS_DIR) return process.env.AEON_MODELS_DIR;
    if (process.env.HF_HOME) return process.env.HF_HOME;
    return path.join(COOKBOOK_DIR, 'models');
  }
  // The user's pre-existing global HF cache, scanned as a SECONDARY source
  // so models downloaded before AEON still show up (never assumed to exist).
  function legacyHfCache() {
    return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir() || '', '.cache', 'huggingface', 'hub');
  }

  // ── Vendored Ollama — contained inside AEON, no system install ──
  // The official portable release (GitHub) is a plain zip/tarball of the
  // binary + GPU runners, no installer/admin rights needed. Extracted into
  // <AEON>/data/cookbook/runtime/ollama/ so "serve" never depends on
  // whatever (or whether) the operator has on their system PATH. Its models
  // live under modelsRoot()/ollama, same "delete the folder = it's gone"
  // portability contract as the HF model store. Asset resolution + download +
  // extraction live in services/ollamaVendor.js — launch.js's first-boot
  // offer uses the exact same code, so there's one place that knows how.
  const ollamaVendor = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'ollamaVendor.js'));
  const OLLAMA_VENDOR_DIR = path.join(COOKBOOK_DIR, 'runtime', 'ollama');
  function vendoredOllamaBin() { return ollamaVendor.vendoredBin(OLLAMA_VENDOR_DIR); }
  // The one thing every ollama-spawning call site should ask instead of
  // hardcoding 'ollama' — vendored copy wins if present, else whatever the
  // system has (never assumed either way).
  function ollamaBinary() {
    return vendoredOllamaBin() || (findExecutable('ollama') ? 'ollama' : null);
  }
  function ollamaModelsDir() {
    return path.join(modelsRoot(), 'ollama');
  }

  // GET /cookbook/ollama/vendor-status — what's installed + what a fresh
  // install would need to download, so the UI/launcher can show real numbers
  // before asking anyone to commit to a multi-hundred-MB-to-1.5GB download.
  router.get('/cookbook/ollama/vendor-status', async (req, res) => {
    res.json(await ollamaVendor.checkStatus(OLLAMA_VENDOR_DIR));
  });

  // POST /cookbook/ollama/install — download the platform release into the
  // vendor dir and extract it with the OS's own tools (PowerShell
  // Expand-Archive on Windows, tar everywhere else) — no new npm dependency,
  // no admin rights, nothing outside AEON's own folder.
  router.post('/cookbook/ollama/install', (req, res) => {
    if (vendoredOllamaBin()) return res.json({ ok: false, error: 'Already installed' });

    const sessionId = `ollama-install-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', () => {});
    const emitter = new EventEmitter();
    activeTasks[sessionId] = { type: 'ollama-install', status: 'running', query: 'Ollama runtime', started_at: Date.now(), logFile, _emitter: emitter };

    ollamaVendor.install(OLLAMA_VENDOR_DIR, (line) => logStream.write(line + '\n'))
      .then(() => {
        logStream.write('OLLAMA_INSTALL_OK\n');
        activeTasks[sessionId].status = 'done';
        writeLocalRuntime();
      })
      .catch((e) => {
        logStream.write(`\nERROR: ${e.message}\nOLLAMA_INSTALL_FAILED\n`);
        activeTasks[sessionId].status = 'error';
      })
      .finally(() => {
        logStream.end();
        activeTasks[sessionId]._emitter.emit('done');
      });

    res.json({ ok: true, session_id: sessionId });
  });

  // Start the daemon if nothing is answering OLLAMA_HOST yet. Only the
  // vendored copy has no auto-start service to rely on (a system install's
  // installer/tray-app/systemd-unit already keeps one running) — `pull`
  // otherwise fails outright with "could not connect". Idempotent: a quick
  // /api/tags probe first means calling this when something's already up is
  // a harmless no-op.
  async function ensureOllamaServing() {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    try {
      const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return true;
    } catch {}
    const bin = vendoredOllamaBin();
    if (!bin) return false; // system binary, no daemon up — nothing we can start
    try {
      fs.mkdirSync(ollamaModelsDir(), { recursive: true });
      const env = { ...process.env, OLLAMA_MODELS: ollamaModelsDir() };
      const proc = spawn(bin, ['serve'], { env, detached: true, stdio: 'ignore', windowsHide: true });
      proc.unref();
      for (let i = 0; i < 20; i++) { // up to ~10s for the daemon to bind
        await new Promise(r => setTimeout(r, 500));
        try {
          const r2 = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1000) });
          if (r2.ok) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  // POST /cookbook/ollama/serve — start the vendored (or system) daemon,
  // contained: OLLAMA_MODELS points inside AEON so pulled models never
  // touch the user's home directory.
  router.post('/cookbook/ollama/serve', async (req, res) => {
    const bin = ollamaBinary();
    if (!bin) return res.status(400).json({ ok: false, error: 'No Ollama runtime installed — install it from Cookbook first.' });
    const up = await ensureOllamaServing();
    res.json({ ok: up, models_dir: ollamaModelsDir() });
  });

  // ── Local runtime registry — THE file Settings/kernel read ──────
  // Cookbook owns local models, so Cookbook publishes the truth to
  // data/local-runtime.json: where models live, which runtimes exist,
  // and every installed model. No other block probes or guesses.
  const RUNTIME_FILE = getDataFile ? getDataFile('local-runtime.json') : path.join(COOKBOOK_DIR, '..', 'local-runtime.json');
  async function writeLocalRuntime() {
    try {
      const vendored = vendoredOllamaBin();
      const ollamaBin = !!(vendored || findExecutable('ollama'));
      const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
      // Ask the DAEMON what it serves (that's what AEON dials) — the CLI can
      // point at a different model store than the running server.
      let ollamaModels = [];
      try {
        const r = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2500) });
        const d = await r.json();
        ollamaModels = (d.models || []).map(m => ({ repo_id: m.name, size: formatSize(m.size || 0), status: 'ready' }));
      } catch {
        if (ollamaBin) ollamaModels = scanOllamaModels();
      }
      let hfModels = scanHfCache(defaultHfCache());
      const legacy = legacyHfCache();
      if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(defaultHfCache())) {
        for (const m of scanHfCache(legacy)) {
          if (!hfModels.some(x => x.repo_id === m.repo_id)) hfModels.push(m);
        }
      }
      const registry = {
        updated: new Date().toISOString(),
        models_dir: modelsRoot(),
        runtimes: {
          ollama: { installed: ollamaBin, vendored: !!vendored, path: vendored || null, models_dir: ollamaModelsDir(), host: process.env.OLLAMA_HOST || 'http://localhost:11434' },
          huggingface: { cache: defaultHfCache() },
        },
        models: [
          ...ollamaModels.map(m => ({ id: m.repo_id, backend: 'ollama', size: m.size, ready: m.status === 'ready' })),
          ...hfModels.map(m => ({ id: m.repo_id, backend: 'hf', size: m.size, path: m.path, gguf: !!m.is_gguf, ready: m.status === 'ready' })),
        ],
      };
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify(registry, null, 2), 'utf8');
      return registry;
    } catch (e) { return { error: e.message, models: [] }; }
  }
  // Publish on boot (deferred so the scan never slows the mount)
  setTimeout(writeLocalRuntime, 3000);

  // GET /cookbook/runtime — the registry, refreshed on demand
  router.get('/cookbook/runtime', async (req, res) => {
    if (req.query.refresh === '1') return res.json(await writeLocalRuntime());
    try { return res.json(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'))); }
    catch { return res.json(await writeLocalRuntime()); }
  });

  // ── In-memory task registry ─────────────────────────────────────
  // Tasks survive in memory while running; finished tasks are persisted to state.
  const activeTasks = {};

  function readState() {
    if (!fs.existsSync(STATE_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
  }

  function writeState(data) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  // ── GPU Probing ─────────────────────────────────────────────────

  function runCmd(cmd, timeout = 10000) {
    return new Promise((resolve) => {
      exec(cmd, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err ? err.code : 0 });
      });
    });
  }

  // NVIDIA GPU probe via nvidia-smi
  async function probeNvidiaGpus() {
    const query = 'nvidia-smi --query-gpu=index,name,memory.free,memory.total,memory.used,utilization.gpu,uuid --format=csv,noheader,nounits';
    const result = await runCmd(query);
    if (!result.ok || !result.stdout) return { gpus: [], error: result.stderr || 'nvidia-smi not found' };

    const gpus = [];
    for (const line of result.stdout.split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 7) continue;
      try {
        const idx = parseInt(parts[0]);
        const freeMb = parseInt(parseFloat(parts[2]));
        const totalMb = parseInt(parseFloat(parts[3]));
        const usedMb = parseInt(parseFloat(parts[4]));
        gpus.push({
          index: idx, name: parts[1], uuid: parts[6],
          free_mb: freeMb, total_mb: totalMb, used_mb: usedMb,
          util_pct: parseInt(parseFloat(parts[5])),
          busy: totalMb > 0 && (freeMb / totalMb) < 0.5,
          processes: [],
        });
      } catch { continue; }
    }

    // Best-effort process listing
    if (gpus.length) {
      const procQuery = 'nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name,used_memory --format=csv,noheader,nounits';
      const procResult = await runCmd(procQuery, 5000);
      if (procResult.ok && procResult.stdout) {
        const uuidToIdx = {};
        gpus.forEach(g => { uuidToIdx[g.uuid] = g.index; });
        for (const line of procResult.stdout.split('\n')) {
          const p = line.split(',').map(s => s.trim());
          if (p.length < 4) continue;
          const gIdx = uuidToIdx[p[1]];
          if (gIdx !== undefined) {
            const g = gpus.find(x => x.index === gIdx);
            if (g) g.processes.push({ pid: parseInt(p[0]), name: p[2], used_mb: parseInt(parseFloat(p[3])) });
          }
        }
      }
    }

    return { gpus, backend: 'cuda', source: 'nvidia-smi' };
  }

  router.get('/cookbook/gpus', async (req, res) => {
    if (process.env.VERCEL) return res.json({ ok: false, gpus: [], error: 'GPU probe unavailable in cloud. Use /start from terminal to relay to desktop.', backend: 'cloud' });
    try {
      const result = await probeNvidiaGpus();
      if (result.gpus.length) {
        return res.json({ ok: true, ...result });
      }
      // No NVIDIA — check for Ollama (implies some runtime is available)
      const ollamaBin = ollamaBinary();
      const ollamaCheck = ollamaBin ? await runCmd(`"${ollamaBin}" --version`, 3000) : { ok: false };
      if (ollamaCheck.ok) {
        return res.json({
          ok: true, gpus: [],
          backend: 'ollama', source: 'ollama-detected',
          note: 'No nvidia-smi but Ollama is available for CPU/Metal inference',
        });
      }
      return res.json({ ok: false, gpus: [], error: result.error || 'No GPU probe available' });
    } catch (e) {
      res.json({ ok: false, gpus: [], error: e.message });
    }
  });

  // ── Delete cached HF model ──────────────────────────────────────
  router.post('/cookbook/delete-cache', (req, res) => {
    const { repo } = req.body;
    if (!repo || typeof repo !== 'string') return res.status(400).json({ ok: false, error: 'repo required' });
    if (/[;&|`$]/.test(repo)) return res.status(400).json({ ok: false, error: 'Invalid repo name' });
    const folder = `models--${repo.replace(/\//g, '--')}`;
    // Look in AEON's own model store first, then the legacy global HF cache.
    const roots = [path.join(modelsRoot(), 'hub'), legacyHfCache()];
    try {
      const fs = require('fs');
      for (const cacheDir of roots) {
        const target = path.join(cacheDir, folder);
        if (!target.startsWith(cacheDir)) continue; // traversal guard
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          writeLocalRuntime();
          return res.json({ ok: true, deleted: target });
        }
      }
      return res.json({ ok: false, error: 'Model not found in cache' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Kill GPU process ────────────────────────────────────────────

  router.post('/cookbook/kill-pid', async (req, res) => {
    const { pid } = req.body;
    if (!pid || pid < 100) return res.status(400).json({ ok: false, error: 'Invalid PID' });
    try {
      execSync(`taskkill /F /T /PID ${parseInt(pid)}`, { stdio: 'ignore', windowsHide: true });
      res.json({ ok: true, pid });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Cached Model Scan ──────────────────────────────────────────

  function scanHfCache(cacheDir) {
    const models = [];
    if (!fs.existsSync(cacheDir)) return models;
    const entries = fs.readdirSync(cacheDir).filter(d => d.startsWith('models--'));
    for (const d of entries) {
      const repoId = d.replace('models--', '').replace(/--/g, '/');
      const blobsDir = path.join(cacheDir, d, 'blobs');
      const snapsDir = path.join(cacheDir, d, 'snapshots');
      let size = 0, fileCount = 0, hasIncomplete = false;

      if (fs.existsSync(blobsDir)) {
        for (const f of fs.readdirSync(blobsDir)) {
          try {
            const stat = fs.statSync(path.join(blobsDir, f));
            if (stat.isFile()) { fileCount++; size += stat.size; }
            if (f.endsWith('.incomplete')) hasIncomplete = true;
          } catch {}
        }
      }
      // Fallback: scan snapshots when blobs is empty (Windows HF cache layout)
      if (size === 0 && fs.existsSync(snapsDir)) {
        for (const sd of fs.readdirSync(snapsDir)) {
          const sf = path.join(snapsDir, sd);
          try {
            if (!fs.statSync(sf).isDirectory()) continue;
            for (const f of fs.readdirSync(sf)) {
              const fp = path.join(sf, f);
              try {
                const stat = fs.statSync(fp);
                if (stat.isFile()) { fileCount++; size += stat.size; }
                if (f.endsWith('.incomplete')) hasIncomplete = true;
              } catch {}
            }
          } catch {}
        }
      }

      let isDiffusion = false;
      let isGguf = false;
      const ggufFiles = [];

      if (fs.existsSync(snapsDir)) {
        for (const sd of fs.readdirSync(snapsDir)) {
          const sf = path.join(snapsDir, sd);
          try {
            if (!fs.statSync(sf).isDirectory()) continue;
            if (fs.existsSync(path.join(sf, 'model_index.json'))) isDiffusion = true;
            for (const f of fs.readdirSync(sf)) {
              if (f.toLowerCase().endsWith('.gguf') && !f.startsWith('._')) {
                isGguf = true;
                try {
                  const gs = fs.statSync(path.join(sf, f));
                  ggufFiles.push({ name: f, rel_path: `${sd}/${f}`, size_bytes: gs.size, role: 'model', quant: extractQuant(f) });
                } catch {}
              }
            }
          } catch {}
        }
      }

      models.push({
        repo_id: repoId,
        size: formatSize(size),
        size_bytes: size,
        nb_files: fileCount,
        has_incomplete: hasIncomplete,
        status: hasIncomplete ? 'downloading' : 'ready',
        path: cacheDir,
        is_diffusion: isDiffusion,
        is_gguf: isGguf,
        gguf_files: ggufFiles,
      });
    }
    return models;
  }

  function scanOllamaModels() {
    const models = [];
    const bin = ollamaBinary();
    if (!bin) return models;
    try {
      const out = execSync(`"${bin}" list`, { timeout: 8000, windowsHide: true, encoding: 'utf8' });
      const lines = out.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const name = parts[0];
        if (!name) continue;
        const sizeStr = parts[2] + ' ' + parts[3];
        const sizeBytes = parseSizeStr(sizeStr);
        models.push({
          repo_id: name, size: sizeStr, size_bytes: sizeBytes,
          nb_files: 1, has_incomplete: false, status: 'ready',
          path: 'ollama', backend: 'ollama', is_ollama: true,
        });
      }
    } catch {}
    return models;
  }

  function extractQuant(filename) {
    const m = filename.match(/(?:UD-)?(IQ[0-9]_[A-Z0-9_]+|Q[0-9](?:_[A-Z0-9]+)+|BF16|F16|FP16|F32|Q8_0)/i);
    return m ? m[0].toUpperCase() : '';
  }

  function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / (1024 ** 2))} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function parseSizeStr(s) {
    const m = (s || '').match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    if (u === 'TB') return Math.round(n * 1024 ** 4);
    if (u === 'GB') return Math.round(n * 1024 ** 3);
    if (u === 'MB') return Math.round(n * 1024 ** 2);
    return Math.round(n * 1024);
  }

  function defaultHfCache() {
    return path.join(modelsRoot(), 'hub');
  }

  router.get('/model/cached', (req, res) => {
    if (process.env.VERCEL) return res.json({ models: [], host: 'cloud', note: 'Model cache unavailable in cloud. Relay via desktop bridge.' });
    const modelDirs = [];
    if (req.query.model_dir) {
      for (const d of req.query.model_dir.split(',')) {
        const trimmed = d.trim();
        if (trimmed) modelDirs.push(trimmed);
      }
    }

    // Primary: AEON's own model store. Secondary: the user's global HF cache
    // (only if it exists) so pre-AEON downloads still appear. De-duped by repo.
    let models = scanHfCache(defaultHfCache());
    const legacy = legacyHfCache();
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(defaultHfCache())) {
      for (const m of scanHfCache(legacy)) {
        if (!models.some(x => x.repo_id === m.repo_id)) models.push(m);
      }
    }

    // Scan additional model directories
    for (const dir of modelDirs) {
      const expanded = dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir;
      if (fs.existsSync(expanded)) {
        try {
          for (const d of fs.readdirSync(expanded)) {
            if (d.startsWith('.') || d.startsWith('models--')) continue;
            const fp = path.join(expanded, d);
            try {
              if (!fs.statSync(fp).isDirectory()) continue;
            } catch { continue; }
            let isModel = false;
            let totalSize = 0, fileCount = 0;
            const ggufFiles = [];

            const walkDir = (dir) => {
              try {
                for (const f of fs.readdirSync(dir)) {
                  const fp2 = path.join(dir, f);
                  try {
                    const s = fs.statSync(fp2);
                    if (s.isDirectory()) { walkDir(fp2); continue; }
                    if (s.isFile()) {
                      fileCount++; totalSize += s.size;
                      const fl = f.toLowerCase();
                      if (fl.endsWith('.gguf') || fl.endsWith('.safetensors') || fl.endsWith('.bin') || f === 'config.json') isModel = true;
                      if (fl.endsWith('.gguf') && !f.startsWith('._')) {
                        ggufFiles.push({ name: f, rel_path: f, size_bytes: s.size, role: 'model', quant: extractQuant(f) });
                      }
                    }
                  } catch {}
                }
              } catch {}
            };
            walkDir(fp);

            if (isModel && !models.some(m => m.repo_id === d)) {
              models.push({
                repo_id: d, size: formatSize(totalSize), size_bytes: totalSize,
                nb_files: fileCount, has_incomplete: false, status: 'ready',
                path: expanded, is_local_dir: true,
                is_diffusion: fs.existsSync(path.join(fp, 'model_index.json')),
                is_gguf: ggufFiles.length > 0, gguf_files: ggufFiles,
              });
            }
          }
        } catch {}
      }
    }

    // Scan Ollama
    models = models.concat(scanOllamaModels());

    res.json({ models, host: 'local' });
  });

  // ── Model Download ─────────────────────────────────────────────

  router.post('/model/download', async (req, res) => {
    const { repo_id, backend, include, hf_token, local_dir } = req.body;
    if (!repo_id) return res.status(400).json({ ok: false, error: 'repo_id is required' });

    const isOllama = backend === 'ollama' || (!repo_id.includes('/') && repo_id.includes(':'));

    if (!isOllama && !REPO_ID_RE.test(repo_id)) {
      return res.status(400).json({ ok: false, error: 'Invalid repo_id' });
    }
    if (isOllama && !OLLAMA_MODEL_RE.test(repo_id)) {
      return res.status(400).json({ ok: false, error: 'Invalid Ollama model name' });
    }

    const sessionId = `cookbook-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const pidFile = path.join(LOGS_DIR, `${sessionId}.pid`);

    let cmd, args;
    if (isOllama) {
      cmd = ollamaBinary();
      if (!cmd) return res.status(400).json({ ok: false, error: 'No Ollama runtime installed — install it from the Hardware tab first.' });
      // `ollama pull` is just a client — it needs a daemon already answering
      // OLLAMA_HOST. A system install auto-starts one; the vendored copy
      // doesn't, so start it here if nothing's listening yet.
      const serving = await ensureOllamaServing();
      if (!serving) return res.status(400).json({ ok: false, error: 'Ollama runtime is installed but not running, and AEON could not start it. Try again from the Hardware tab.' });
      args = ['pull', repo_id];
    } else {
      // Use `hf` CLI if available, else Python huggingface_hub
      const hfCli = findExecutable('hf');
      if (hfCli) {
        cmd = hfCli;
        args = ['download', repo_id];
        if (include) { args.push('--include', include); }
      } else {
        cmd = findExecutable('python') || findExecutable('python3') || 'python';
        const pyScript = `from huggingface_hub import snapshot_download; snapshot_download('${repo_id}'${include ? `, allow_patterns=['${include}']` : ''})`;
        args = ['-c', pyScript];
      }
    }

    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    // Note: `ollama pull` is a thin client — where the model actually lands
    // is decided by the DAEMON's own OLLAMA_MODELS (set when the vendored
    // daemon was started in ensureOllamaServing() above), not by anything
    // set on this pull subprocess's env.
    if (hf_token && !isOllama) env.HF_TOKEN = hf_token;
    if (!isOllama) {
      // Default the download target to AEON's own model store so models land
      // INSIDE the install, not the user's hidden global cache. An explicit
      // local_dir still wins for power users who want them elsewhere.
      const raw = local_dir || modelsRoot();
      const expanded = raw.startsWith('~') ? raw.replace('~', os.homedir()) : raw;
      env.HF_HOME = expanded;
      env.HUGGINGFACE_HUB_CACHE = path.join(expanded, 'hub');
      env.HF_HUB_CACHE = path.join(expanded, 'hub');
    }

    try {
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      const proc = spawn(cmd, args, {
        env, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, detached: true,
      });
      proc.unref();

      fs.writeFileSync(pidFile, String(proc.pid), 'utf8');
      // Two sources piping into one destination: pipe() defaults to ending the
      // destination when ITS source ends, so whichever of stdout/stderr closed
      // first was silently ending the log file — the exit-code trailer below
      // then wrote to an already-closed stream and vanished. That's why a
      // failed download showed a bare "error" badge with no diagnosis: the
      // real error text (or even the exit marker) never made it to disk.
      // { end: false } + a single explicit end() in the close handler fixes it.
      logStream.on('error', () => {}); // never let a write-after-end crash the server
      proc.stdout.pipe(logStream, { end: false });
      proc.stderr.pipe(logStream, { end: false });

      const emitter = new EventEmitter();
      activeTasks[sessionId] = {
        type: 'download', status: 'running', query: repo_id,
        started_at: Date.now(), pid: proc.pid, logFile,
        _emitter: emitter, _proc: proc,
      };

      proc.on('close', (code) => {
        const task = activeTasks[sessionId];
        if (task) {
          task.status = code === 0 ? 'done' : 'error';
          task.exitCode = code;
          logStream.write(`\n=== Process exited with code ${code} ===\n`);
          if (code === 0) logStream.write('DOWNLOAD_OK\n');
          else logStream.write('DOWNLOAD_FAILED\n');
          logStream.end();
          // One-click contract: a finished download registers itself — Settings
          // and the kernel read the refreshed registry with zero extra steps.
          if (code === 0) writeLocalRuntime();
          task._emitter.emit('done', code);
        }
      });

      if (writeOSAudit) {
        writeOSAudit(`COOKBOOK-${sessionId}`, `Started downloading ${repo_id}`);
      }

      res.json({ ok: true, session_id: sessionId, remote: 'local' });
    } catch (e) {
      res.json({ ok: false, error: e.message, session_id: sessionId });
    }
  });

  // ── Model Serve ────────────────────────────────────────────────

  router.post('/model/serve', async (req, res) => {
    const { repo_id, cmd: serveCmd, gpus, hf_token, platform } = req.body;
    if (!repo_id) return res.status(400).json({ ok: false, error: 'repo_id is required' });
    if (!serveCmd) return res.status(400).json({ ok: false, error: 'cmd is required' });

    // Validate cmd starts with an allowed binary
    const ALLOWED = new Set(['vllm', 'llama-server', 'llama_server', 'ollama', 'python', 'python3', 'sglang', 'node', 'npx']);
    const cleaned = serveCmd.replace(/\\\n/g, ' ').trim();
    if (/[`\n\r]/.test(cleaned)) {
      return res.status(400).json({ ok: false, error: 'Invalid characters in cmd' });
    }
    const tokens = cleaned.split(/\s+/).filter(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    const firstBin = path.basename(tokens[0] || '');
    if (!ALLOWED.has(firstBin)) {
      return res.status(400).json({ ok: false, error: `cmd binary '${firstBin}' not allowed` });
    }

    const sessionId = `serve-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const pidFile = path.join(LOGS_DIR, `${sessionId}.pid`);

    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    if (hf_token) env.HF_TOKEN = hf_token;
    if (gpus) env.CUDA_VISIBLE_DEVICES = gpus;

    // Find bash (Git Bash on Windows)
    const bash = findBash();

    try {
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      let proc;

      if (bash) {
        // Run through bash for full command compatibility
        proc = spawn(bash, ['-c', cleaned], {
          env, stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true, detached: true,
        });
      } else {
        // Direct spawn — works for simple commands
        const parts = cleaned.split(/\s+/);
        proc = spawn(parts[0], parts.slice(1), {
          env, stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true, detached: true, shell: true,
        });
      }

      proc.unref();
      fs.writeFileSync(pidFile, String(proc.pid), 'utf8');
      // Same double-pipe truncation fix as /model/download above.
      logStream.on('error', () => {});
      proc.stdout.pipe(logStream, { end: false });
      proc.stderr.pipe(logStream, { end: false });

      const emitter = new EventEmitter();
      activeTasks[sessionId] = {
        type: 'serve', status: 'running', query: repo_id,
        started_at: Date.now(), pid: proc.pid, logFile, cmd: cleaned,
        _emitter: emitter, _proc: proc,
      };

      proc.on('close', (code) => {
        const task = activeTasks[sessionId];
        if (task) {
          task.status = code === 0 ? 'done' : 'error';
          task.exitCode = code;
          logStream.write(`\n=== Process exited with code ${code} ===\n`);
          logStream.end();
          task._emitter.emit('done', code);
        }
      });

      res.json({ ok: true, session_id: sessionId, remote: 'local' });
    } catch (e) {
      res.json({ ok: false, error: e.message, session_id: sessionId });
    }
  });

  // ── Task Status ────────────────────────────────────────────────

  router.get('/cookbook/tasks/status', (req, res) => {
    const results = [];
    for (const [sid, task] of Object.entries(activeTasks)) {
      let outputTail = '';
      try {
        if (task.logFile && fs.existsSync(task.logFile)) {
          const content = fs.readFileSync(task.logFile, 'utf8');
          const lines = content.split('\n');
          outputTail = lines.slice(-50).join('\n');
        }
      } catch {}

      // Check if process is still alive. Tasks with no OS pid (ollama-install
      // downloads over fetch() in-process rather than spawning a child) fully
      // manage their own status via .then()/.catch()/.finally() — they were
      // never "alive" by this check to begin with, so the no-pid branch below
      // must not treat "no pid" as "died" for them, or a genuinely still-
      // downloading task flips to "stopped" on the very next poll.
      let isAlive = false;
      if (task.pid) {
        try { process.kill(task.pid, 0); isAlive = true; } catch { isAlive = false; }
      }
      const selfManaged = !task.pid && task.type === 'ollama-install';

      let status = task.status;
      if (status === 'running' && !isAlive && !selfManaged) {
        if (outputTail.includes('DOWNLOAD_OK')) status = 'completed';
        else if (outputTail.includes('Application startup complete')) status = 'ready';
        else status = 'stopped';
        task.status = status;
      }
      if (isAlive && outputTail.includes('Application startup complete')) {
        status = 'ready';
        task.status = status;
      }

      // Parse serve phase
      let phase = '';
      if (task.type === 'serve') {
        if (/Application startup complete/i.test(outputTail)) phase = 'ready';
        else if (/Loading safetensors.*?(\d+)%/.test(outputTail)) {
          const m = outputTail.match(/Loading safetensors.*?(\d+)%/g);
          phase = m ? `loading ${m[m.length - 1].match(/(\d+)%/)[1]}%` : 'loading';
        }
        else if (/Downloading.*?(\d+)%/.test(outputTail)) phase = 'downloading';
        else if (isAlive) phase = 'starting';
      }

      // Download progress
      let progress = '';
      if (task.type === 'download' && isAlive) {
        const pctMatches = [...outputTail.matchAll(/(\d+)%/g)];
        if (pctMatches.length) progress = pctMatches[pctMatches.length - 1][1] + '%';
      }

      // Diagnose errors
      let diagnosis = null;
      if (status === 'error' || status === 'stopped') {
        diagnosis = diagnoseOutput(outputTail);
      }

      results.push({
        session_id: sid,
        type: task.type,
        model: (task.query || '').split('/').pop() || task.query,
        status,
        progress: phase || progress,
        phase,
        diagnosis,
        output_tail: outputTail.slice(-2000),
        exit_code: task.exitCode || null,
        cmd: task.cmd || '',
        remote: 'local',
      });
    }
    res.json({ tasks: results });
  });

  // ── Task Log Stream (SSE) ──────────────────────────────────────

  router.get('/cookbook/task-stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!SESSION_ID_RE.test(sessionId)) return res.status(400).end();

    const task = activeTasks[sessionId];
    const logFile = task ? task.logFile : path.join(LOGS_DIR, `${sessionId}.log`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let lastSize = 0;
    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        if (stat.size <= lastSize) return;
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(Math.min(stat.size - lastSize, 4096));
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const chunk = buf.toString('utf8').replace(/\r/g, '');
        res.write(`data: ${JSON.stringify({ data: chunk })}\n\n`);
      } catch {}

      // Check if task is done
      const t = activeTasks[sessionId];
      if (t && t.status !== 'running') {
        res.write(`data: ${JSON.stringify({ status: t.status, final: true })}\n\n`);
        clearInterval(poll);
        setTimeout(() => res.end(), 500);
      }
    }, 1000);

    req.on('close', () => clearInterval(poll));
  });

  // ── Stop Task ──────────────────────────────────────────────────

  router.post('/cookbook/task-stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const task = activeTasks[sessionId];
    if (!task) return res.json({ ok: false, error: 'Task not found' });

    if (task.pid) {
      try {
        execSync(`taskkill /F /T /PID ${task.pid}`, { stdio: 'ignore', windowsHide: true });
      } catch {}
    }
    task.status = 'stopped';
    res.json({ ok: true });
  });

  // ── Cookbook State Persistence ──────────────────────────────────

  router.get('/cookbook/state', (req, res) => {
    res.json(readState());
  });

  router.post('/cookbook/state', (req, res) => {
    try {
      const data = req.body || {};
      writeState(data);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── HuggingFace Latest Models ──────────────────────────────────

  let hfLatestCache = { models: [], ts: 0 };

  router.get('/cookbook/hf-latest', async (req, res) => {
    const vramGb = parseFloat(req.query.vram_gb) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const pipeline = req.query.pipeline || 'text-generation';

    const TTL = 600000; // 10 min
    if (Date.now() - hfLatestCache.ts < TTL && hfLatestCache.models.length) {
      let models = hfLatestCache.models;
      if (vramGb > 0) models = models.filter(m => !m.needed_vram_gb || m.needed_vram_gb <= vramGb);
      return res.json({ models: models.slice(0, limit) });
    }

    try {
      const https = require('https');
      const url = `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=100&filter=${pipeline}`;
      const data = await new Promise((resolve, reject) => {
        https.get(url, { timeout: 15000 }, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });

      const EXCLUDE = ['lora', 'adapter', 'peft', 'qlora', 'dataset', 'embedding'];
      const models = [];
      for (const entry of (Array.isArray(data) ? data : [])) {
        const repoId = entry.modelId || entry.id || '';
        if (!repoId) continue;
        const tags = entry.tags || [];
        const tagText = tags.join(' ').toLowerCase();
        const nameText = repoId.toLowerCase();
        if (EXCLUDE.some(e => nameText.includes(e) || tagText.includes(e))) continue;

        // Estimate VRAM
        const paramMatch = repoId.match(/[-_/](\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])/);
        const paramsB = paramMatch ? parseFloat(paramMatch[1]) : null;
        const estVram = paramsB ? paramsB * 2.0 : null;
        const neededVram = estVram ? estVram * 1.3 : null;

        if (vramGb > 0 && neededVram && neededVram > vramGb) continue;

        models.push({
          repo_id: repoId,
          downloads: entry.downloads || 0,
          likes: entry.likes || 0,
          createdAt: entry.createdAt || '',
          tags: tags.slice(0, 5),
          pipeline_tag: entry.pipeline_tag || '',
          est_vram_gb: estVram ? Math.round(estVram * 10) / 10 : null,
          needed_vram_gb: neededVram ? Math.round(neededVram * 10) / 10 : null,
        });
        if (models.length >= 50) break;
      }

      hfLatestCache = { models, ts: Date.now() };
      res.json({ models: models.slice(0, limit) });
    } catch (e) {
      res.json({ models: [], error: e.message });
    }
  });

  // ── Ollama Library ─────────────────────────────────────────────

  const OLLAMA_FALLBACK = [
    { name: 'qwen2.5', description: 'Qwen2.5 — strong general/coding model.', sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b', '72b'] },
    { name: 'qwen3', description: 'Qwen3 — hybrid reasoning.', sizes: ['0.6b', '1.7b', '4b', '8b', '14b', '32b'] },
    { name: 'llama3.2', description: 'Meta Llama 3.2 instruct.', sizes: ['1b', '3b', '11b', '90b'] },
    { name: 'gemma3', description: 'Google Gemma 3 multimodal.', sizes: ['1b', '4b', '12b', '27b'] },
    { name: 'mistral', description: 'Mistral 7B instruct.', sizes: ['7b'] },
    { name: 'deepseek-r1', description: 'DeepSeek R1 reasoning.', sizes: ['1.5b', '7b', '8b', '14b', '32b', '70b'] },
    { name: 'phi4', description: 'Microsoft Phi-4 14B.', sizes: ['14b'] },
    { name: 'codellama', description: 'Meta Code Llama.', sizes: ['7b', '13b', '34b', '70b'] },
    { name: 'nomic-embed-text', description: 'Text embedding model.', sizes: ['latest'] },
    { name: 'llava', description: 'LLaVA vision-language model.', sizes: ['7b', '13b', '34b'] },
  ];

  router.get('/cookbook/ollama/library', (req, res) => {
    res.json({ models: OLLAMA_FALLBACK, fetched_at: Date.now(), error: null });
  });

  // ── Error Diagnosis ────────────────────────────────────────────

  function diagnoseOutput(text) {
    if (!text) return null;
    const tail = text.slice(-6000);
    const patterns = [
      [
        /No available memory for the cache blocks|Available KV cache memory:.*-/i,
        'No GPU memory left for KV cache after loading model.',
        [
          { label: 'Retry with GPU memory utilization 0.95', op: 'replace', flag: '--gpu-memory-utilization', value: '0.95' },
          { label: 'Retry with context 2048', op: 'replace', flag: '--max-model-len', value: '2048' },
        ],
      ],
      [
        /CUDA out of memory|torch\.cuda\.OutOfMemoryError|CUDA error: out of memory|warming up sampler|max_num_seqs.*gpu_memory_utilization/i,
        'GPU ran out of memory during startup or warmup.',
        [
          { label: 'Retry with context 4096', op: 'replace', flag: '--max-model-len', value: '4096' },
          { label: 'Retry with GPU memory utilization 0.80', op: 'replace', flag: '--gpu-memory-utilization', value: '0.80' },
          { label: 'Retry with --enforce-eager', op: 'append', arg: '--enforce-eager' },
        ],
      ],
      [
        /not divisib|must be divisible|attention heads.*divisible/i,
        'Tensor parallel size is incompatible with the model.',
        [
          { label: 'Retry with tensor parallel size 1', op: 'replace', flag: '--tensor-parallel-size', value: '1' },
          { label: 'Retry with tensor parallel size 2', op: 'replace', flag: '--tensor-parallel-size', value: '2' },
        ],
      ],
      [
        /KV cache.*too (small|large)|max_model_len.*exceeds|maximum.*context/i,
        'Context length is too large for available GPU memory.',
        [
          { label: 'Retry with context 8192', op: 'replace', flag: '--max-model-len', value: '8192' },
          { label: 'Retry with context 4096', op: 'replace', flag: '--max-model-len', value: '4096' },
        ],
      ],
      [
        /enable-auto-tool-choice requires --tool-call-parser/i,
        'Auto tool choice requires an explicit tool call parser.',
        [{ label: 'Retry with Hermes tool parser', op: 'append', arg: '--tool-call-parser hermes' }],
      ],
      [
        /Please pass.*trust.remote.code=True|contains custom code which must be executed|does not recognize this architecture|model type.*but Transformers does not/i,
        'Model requires custom code or newer model support.',
        [{ label: 'Retry with --trust-remote-code', op: 'append', arg: '--trust-remote-code' }],
      ],
      [
        /Either a revision or a version must be specified|transformers\.integrations\.hub_kernels|kernels\/layer/i,
        'vLLM/Transformers kernel package mismatch.',
        [{ label: 'Update vLLM, Transformers, and kernels', op: 'dependency', package: 'vllm transformers kernels' }],
      ],
      [
        /Address already in use|bind.*address.*in use/i,
        'Port is already in use.',
        [{ label: 'Retry on port 8001', op: 'replace', flag: '--port', value: '8001' }],
      ],
      [
        /No CUDA GPUs are available|no GPU.*found|CUDA_VISIBLE_DEVICES.*invalid/i,
        'No GPUs are visible to the serve process.',
        [{ label: 'Clear GPU selection or choose available GPUs', op: 'settings', field: 'gpus', value: '' }],
      ],
      [
        /Failed to infer device type|NVML Shared Library Not Found|No module named 'amdsmi'|platform is not available/i,
        'vLLM could not find a supported GPU (CUDA or ROCm). This machine may have integrated or unsupported graphics only.',
        [
          { label: 'Switch to llama.cpp (CPU/Metal)', op: 'manual' },
          { label: 'Switch to Ollama (CPU/Metal)', op: 'manual' },
        ],
      ],
      [
        /vllm.*command not found|No module named vllm|ERROR: vLLM is not installed/i,
        'vLLM is not installed or not in PATH.',
        [{ label: 'pip install vllm', op: 'dependency', package: 'vllm' }],
      ],
      [
        /sglang.*command not found|No module named sglang|SGLang is not installed/i,
        'SGLang is not installed or not in PATH.',
        [{ label: 'pip install sglang[all]', op: 'dependency', package: 'sglang[all]' }],
      ],
      [
        /llama-server.*command not found|llama\.cpp.*not found|No module named.*llama_cpp|No module named 'starlette_context'|git: command not found|cmake: command not found/i,
        // On Windows/macOS without a C/C++ toolchain, pip has to compile
        // llama-cpp-python from source — that silently means "go install
        // Visual Studio Build Tools" (multi-GB) with no warning up front.
        // Ollama already ships prebuilt binaries and is usually already
        // installed, so it's the low-friction fix for the same model.
        'llama.cpp / llama-cpp-python is not installed — and installing it usually requires a C/C++ compiler (Visual Studio Build Tools on Windows, Xcode Command Line Tools on Mac), which pip cannot set up for you.',
        [
          { label: 'Serve this model with Ollama instead (recommended — no compiler needed)', op: 'manual' },
          { label: 'pip install llama-cpp-python[server] (requires a C/C++ compiler already installed)', op: 'dependency', package: 'llama-cpp-python[server]' },
        ],
      ],
      [
        /No GGUF found on this host|no \.gguf file|No GGUF file found/i,
        'No GGUF file found for this model. The llama.cpp backend needs a .gguf file.',
        [{ label: 'Download a GGUF build (repo ending in -GGUF, file like Q4_K_M.gguf)', op: 'manual' }],
      ],
      [
        /No module named 'torch'|No module named torch|No module named 'diffusers'|No module named diffusers/i,
        'Diffusion serving requires PyTorch and diffusers.',
        [{ label: 'pip install diffusers[torch]', op: 'dependency', package: 'diffusers[torch]' }],
      ],
      [
        /403 Forbidden|401 Unauthorized|Access to model.*is restricted|gated repo|not in the authorized list|awaiting a review/i,
        'Model access is gated or unauthorized.',
        [{ label: 'Set HF token and request model access on HuggingFace', op: 'manual' }],
      ],
      [
        /ollama.*command not found/i,
        'Ollama is not installed.',
        [{ label: 'Install from ollama.com', op: 'manual' }],
      ],
      [
        /No space left on device/i,
        'Disk full.',
        [{ label: 'Free disk space or change download directory', op: 'manual' }],
      ],
      [
        /ConnectionResetError|SSLError|SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC/i,
        'Network error during download — connection reset or SSL failure.',
        [{ label: 'Retry download (resume should pick up where it left off)', op: 'manual' }],
      ],
    ];
    for (const [re, msg, suggestions] of patterns) {
      if (re.test(tail)) return { message: msg, suggestions };
    }
    if (/Traceback \(most recent call last\)/i.test(tail) &&
        !/Application startup complete|GET \/v1\/|Uvicorn running on/i.test(tail)) {
      return {
        message: 'Python traceback detected during serve startup.',
        suggestions: [{ label: 'Inspect traceback and retry with adjusted settings', op: 'manual' }],
      };
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────

  function findExecutable(name) {
    try {
      const result = execSync(`where ${name}`, { timeout: 3000, windowsHide: true, encoding: 'utf8' });
      const first = result.split('\n')[0].trim();
      return first || null;
    } catch { return null; }
  }

  function findBash() {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return findExecutable('bash');
  }

  return router;
};
