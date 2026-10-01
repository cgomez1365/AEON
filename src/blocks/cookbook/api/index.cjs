// routes/cookbook.js — Cookbook Hardware: GPU probing, model download/serve, cache scan
// Ported from Python cookbook_routes.py + cookbook_helpers.py + hwfit_routes.py
// Runs directly on the host via child_process (no Docker/tmux/SSH) — Windows, macOS, Linux.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const { isCloud: _isCloud } = require('../../../kernel/runtime.cjs');
const { ggufProbe } = require('./_ggufProbe.cjs');
const { stopProcessTree } = require('./_procControl.cjs');
const {
  parseServeCommand, isModelInstalled, checkVramFit, estimateVram, vramErrorMessage,
} = require('./_serveCommand.cjs');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ── Task registries — one per data root, for the whole PROCESS ──────────────
//
// Downloads and serves are detached children that outlive this module. Every
// block rescan (Remove, Restore or Start of any block, a store install or
// update, an approve) purges this file from the require cache and calls the
// factory again, and the registry used to be a `{}` in the factory closure: the
// remounted Cookbook started empty while a download or a llama-server holding
// gigabytes kept running. /cookbook/tasks/status stopped listing it, Stop
// answered 404 "may have belonged to an earlier AEON session", and kill-pid no
// longer recognised the pid as Cookbook's (sweep C27, 2026-09-28). A module-
// level map would be purged with the module, so the map lives on globalThis,
// keyed by the Cookbook data folder; a remount picks up the same tasks, and
// their exit handlers — closures of the old instance — keep updating them.
const TASKS_KEY = Symbol.for('aeon.cookbook.activeTasks');
const TASK_REGISTRIES = globalThis[TASKS_KEY] || (globalThis[TASKS_KEY] = new Map());
function tasksFor(dir) {
  const key = path.resolve(dir);
  if (!TASK_REGISTRIES.has(key)) TASK_REGISTRIES.set(key, {});
  return TASK_REGISTRIES.get(key);
}

// A rescan used to empty the registry as a side effect; now nothing does, and
// each finished task holds its process handle and emitter for the life of the
// process while status re-reads its log on every poll. Finished tasks stay
// listed (the Active tab shows how each ended), the newest FINISHED_KEPT of
// them; running ones are never dropped.
const FINISHED_KEPT = 20;
const FINISHED_STATES = new Set(['done', 'completed', 'failed', 'error', 'stopped']);
function pruneFinished(tasks) {
  const finished = Object.entries(tasks)
    .filter(([, t]) => t && (t.exited || FINISHED_STATES.has(t.status)))
    .sort((a, b) => (b[1].started_at || 0) - (a[1].started_at || 0));
  for (const [sid] of finished.slice(FINISHED_KEPT)) delete tasks[sid];
}

// ── A model server listens on this computer only ────────────────────────────
//
// AEON binds loopback. Serve (sweep C18, 2026-09-28) sent `--host 0.0.0.0`, so
// a llama-server or vLLM with no login answered anyone on the network. An
// explicit non-loopback --host is refused by name; vLLM, which listens on every
// interface when no --host is given, gets --host 127.0.0.1.
const LOOPBACK_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/i;
function bindLoopback(bin, args) {
  const out = args.slice();
  let seen = false;
  for (let i = 0; i < out.length; i++) {
    let host;
    if (out[i] === '--host') host = out[i + 1];
    else if (out[i].startsWith('--host=')) host = out[i].slice('--host='.length);
    else continue;
    seen = true;
    if (!host || !LOOPBACK_HOST_RE.test(host)) return { ok: false, host: host || '' };
  }
  const isVllm = /^vllm(\.exe)?$/i.test(bin) || out.some(a => /^vllm\./.test(a));
  if (!seen && isVllm) out.push('--host', '127.0.0.1');
  return { ok: true, args: out };
}

/** Where llama-server's model argument sits: `--model X`, `-m X` or `--model=X`. */
function modelArg(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--model' || args[i] === '-m') && i + 1 < args.length) return { at: i + 1, prefix: '' };
    if (args[i].startsWith('--model=')) return { at: i, prefix: '--model=' };
  }
  return null;
}

// ── A model's license, shown before its download starts ─────────────────────
//
// Every catalogue entry carries `license` and `licenseUrl`, and nothing showed
// them: a Cookbook row was a name, a size and an Install button (audit finding
// A074, 2026-09-30). That matters most for Llama and Gemma. Using those models
// means accepting Meta's or Google's terms, and Meta's and Google's own
// downloads ask first; the catalogue uses public copies that do not ask (a
// gated repo needs a token AEON never ships — model-catalog.json's own note).
// So AEON says it itself, and links the licensor's terms rather than the
// re-host's page. It informs; it does not block the download.
//
// Matched on the display name as well as the license field: the catalogue
// labels Llama 3.1 8B "Llama 3 Community License". Most specific first.
const LICENSOR_TERMS = [
  { match: /llama[\s-]*3\.2/i, licensor: 'Meta', name: 'Llama 3.2 Community License',
    url: 'https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct/blob/main/LICENSE.txt',
    policyName: 'Acceptable Use Policy', policyUrl: 'https://www.llama.com/llama3_2/use-policy' },
  { match: /llama[\s-]*3\.1/i, licensor: 'Meta', name: 'Llama 3.1 Community License',
    url: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/blob/main/LICENSE',
    policyName: 'Acceptable Use Policy', policyUrl: 'https://llama.meta.com/llama3_1/use-policy' },
  { match: /gemma/i, licensor: 'Google', name: 'Gemma Terms of Use',
    url: 'https://ai.google.dev/gemma/terms',
    policyName: 'Prohibited Use Policy', policyUrl: 'https://ai.google.dev/gemma/prohibited_use_policy' },
];

/**
 * The license a catalogue model comes under, for display before install.
 * @returns {{ name: string, url: string|null, requiresAcceptance: boolean,
 *             licensor?: string, policyName?: string, policyUrl?: string, notice: string|null }}
 */
function modelLicense(entry) {
  const e = entry || {};
  const said = `${e.displayName || ''} ${e.id || ''} ${e.license || ''}`;
  const t = LICENSOR_TERMS.find(x => x.match.test(said));
  if (t) {
    return {
      name: t.name, url: t.url, requiresAcceptance: true, licensor: t.licensor,
      policyName: t.policyName, policyUrl: t.policyUrl,
      notice: `Using this model means accepting ${t.licensor}'s ${t.name} and its ${t.policyName}. `
            + `${t.licensor}'s own download asks you to agree first; this catalogue uses a public copy that does not ask, so read them before you install.`,
    };
  }
  // A Llama or Gemma model this table does not know yet: still say whose terms
  // apply, with whatever link the catalogue has, rather than nothing.
  const family = /llama/i.test(said) ? 'Meta' : /gemma/i.test(said) ? 'Google' : null;
  if (family) {
    return {
      name: e.license || `${family}'s license`, url: e.licenseUrl || null, requiresAcceptance: true, licensor: family,
      notice: `Using this model means accepting ${family}'s license for it. Read it before you install.`,
    };
  }
  return { name: e.license || 'not stated in the catalogue', url: e.licenseUrl || null, requiresAcceptance: false, notice: null };
}

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

  /**
   * A task log that cannot crash the process.
   *
   * fs.createWriteStream opens ASYNCHRONOUSLY, and an unhandled 'error' event on
   * a stream throws. All four of these logs are opened alongside long-running
   * installs and serves, so the window between opening and the first write is
   * wide: a removed data directory, a full disk or a permission change lands in
   * it. Measured on CI (run 34729764892, ubuntu 22.13, 2026-09-12): a test's
   * temp root was cleaned while a model install was still running, the open
   * failed with ENOENT, and the unhandled error took down the whole test file
   * without an assertion ever failing. In production the same event would take
   * down the server — a logging failure killing the thing it was logging.
   *
   * So the failure is reported and survivable (R-05): the directory is ensured
   * at open time rather than only at boot, the error is named on the console,
   * and later writes are dropped instead of throwing.
   */
  function openTaskLog(logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* reported by the handler below */ }
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', (e) => {
      console.warn(`[COOKBOOK] task log unavailable (${logFile}): ${e.message}. The task itself continues.`);
    });
    return stream;
  }

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


  // ── Discovered models — the HuggingFace cache, scanned, never persisted ──
  //
  // BO-C retired `writeLocalRuntime()`, which wrote this scan to
  // data/local-runtime.json and let Settings read it as the model authority.
  // That created two writers where the architecture record specifies one, and
  // Settings trusted the empty one. The scan itself is legitimate — it finds
  // models the operator downloaded before AEON — so it survives as a DERIVED
  // list with no file behind it.
  //
  // Nothing here is servable by itself. A cached HF repo is only servable if it
  // actually contains GGUF weights: on 2026-08-04 `Qwen/Qwen2.5-3B` reported
  // ready after a 5.8 GB safetensors download the runtime could never open
  // (Bible §17). `servable` is stated per entry, with the reason, always.
  function scanDiscovered() {
    try {
      let hfModels = scanHfCache(defaultHfCache());
      const legacy = legacyHfCache();
      if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(defaultHfCache())) {
        for (const m of scanHfCache(legacy)) {
          if (!hfModels.some(x => x.repo_id === m.repo_id)) hfModels.push(m);
        }
      }
      return hfModels.map(m => {
        const isGguf = !!m.is_gguf;
        return {
          id: m.repo_id, repo_id: m.repo_id, source: 'hf-cache',
          backend: 'hf', size: m.size, bytes: m.bytes || null, path: m.path,
          gguf: isGguf,
          servable: isGguf && m.status === 'ready',
          reason: isGguf
            ? (m.status === 'ready' ? null : 'download incomplete')
            : 'safetensors/PyTorch weights — the llama.cpp runtime reads GGUF only. Convert it in Cookbook, or install a GGUF build.',
        };
      });
    } catch { return []; }
  }

  // Models AEON installed and verified itself. The single authority.
  function listManaged() {
    try {
      const lr = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'index.cjs'));
      return lr.listReadyModels(null).map(m => ({
        id: m.id, displayName: m.displayName, source: 'aeon',
        capabilities: m.capabilities, quantization: m.quantization,
        servable: true, reason: null,
      }));
    } catch { return []; }
  }

  // Every model identifier this install can currently serve, from both naming
  // schemes at once: the on-disk HF cache (a scan) and the native registry.
  // Union, never intersection — /model/serve uses this to REFUSE, so a stale
  // miss on either side would block a serve that would have worked.
  // isModelInstalled() is permissive for the same reason.
  //
  // BO-C: the third source used to be the retired flat file, whose contents
  // were themselves derived from the same HF scan — redundant by construction.
  // The native registry replaces it and adds what it never had: AEON-managed
  // models.
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
      for (const m of listManaged()) if (m?.id) ids.add(m.id);
    } catch {}
    return [...ids];
  }

  // The .gguf builds llama-server can open for a Hugging Face cache entry, by
  // exact repo id — or null when no cache holds that repo. A vision projector
  // (mmproj) is not a model, a split model opens from its first shard, and a
  // file present in several snapshot revisions counts once (the newest). Each
  // build is named by its file name: unique in a repo, and what Serve sends
  // back to choose one (`gguf`), so no path crosses the command filter.
  function cachedGgufBuilds(repoId) {
    const caches = [defaultHfCache(), legacyHfCache()];
    for (const cache of caches) {
      let entry;
      try { entry = scanHfCache(cache).find(m => m.repo_id === repoId); } catch { entry = null; }
      if (!entry) continue;
      const byName = new Map();
      for (const g of entry.gguf_files || []) {
        if (/mmproj/i.test(g.name)) continue;
        const shard = /-(\d{5})-of-\d{5}\.gguf$/i.exec(g.name);
        if (shard && shard[1] !== '00001') continue;
        const full = path.join(entry.dir, 'snapshots', g.rel_path);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        const prev = byName.get(g.name);
        if (!prev || mtime > prev.mtime) byName.set(g.name, { file: g.name, quant: g.quant || '', size_bytes: g.size_bytes, full, mtime });
      }
      return [...byName.values()].sort((a, b) => a.file.localeCompare(b.file));
    }
    return null;
  }

  // ── GET /cookbook/models — THE local model inventory ────────────
  //
  // One surface, two states. Hardware's "N models ready" and the Models tab
  // both read this, so they cannot disagree — they did, for as long as each
  // had its own store: Hardware said "1 model ready" beside Models saying
  // "No cached models found", and neither was lying about its own file.
  //
  // `managed` and `discovered` stay separate because they are not the same
  // kind of thing. A managed model is SHA-256 verified, GGUF-probed and
  // servable. A discovered one is a folder that may hold weights the runtime
  // cannot open. Flattening them would recreate the exact defect §17 records.
  router.get('/cookbook/models', (req, res) => {
    if (_isCloud()) {
      return res.json({ managed: [], discovered: [], host: 'cloud',
        note: 'Local models are unavailable in cloud. Relay via the desktop bridge.' });
    }
    const managed = listManaged();
    const discovered = scanDiscovered();
    res.json({
      managed,
      discovered,
      counts: { managed: managed.length, discovered: discovered.length,
                servable: managed.length + discovered.filter(d => d.servable).length },
      models_dir: modelsRoot(),
    });
  });

  // GET /cookbook/runtime — retained for compatibility; now derived, not a file.
  router.get('/cookbook/runtime', (req, res) => {
    res.json({
      updated: new Date().toISOString(),
      models_dir: modelsRoot(),
      managed: listManaged(),
      discovered: scanDiscovered(),
    });
  });

  // ── In-memory task registry ─────────────────────────────────────
  // Tasks survive in memory while running; finished tasks are persisted to state.
  // Shared with every other mount of this block on the same data (tasksFor).
  const activeTasks = tasksFor(COOKBOOK_DIR);

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
  //
  // Operator finding F-02, 2026-08-12 — the absence of nvidia-smi is not an
  // error on a machine that cannot have it. A MacBook Pro showed a red
  // "nvidia-smi not found" card on the Hardware screen, which is a correct
  // state dressed as a failure: the inverse false-green, on the exact screen
  // where a first-time operator decides whether to trust the product.
  //
  // Three-valued, so the UI can tell the cases apart:
  //   gpus.length            NVIDIA hardware found
  //   notApplicable          this platform does not have nvidia-smi — expected
  //   error                  the tool IS present and failed — worth a red card
  async function probeNvidiaGpus() {
    const result = await runCmd('nvidia-smi', ['--query-gpu=index,name,memory.free,memory.total,memory.used,utilization.gpu,uuid', '--format=csv,noheader,nounits']);
    if (!result.ok || !result.stdout) {
      // ENOENT (and Windows' 127) mean the binary is not installed at all.
      const missing = result.code === 'ENOENT' || result.code === 127 || !result.stderr;
      if (missing) {
        return {
          gpus: [],
          notApplicable: true,
          reason: process.platform === 'darwin'
            ? 'No NVIDIA GPU tooling on macOS — models are ranked against system memory.'
            : 'No NVIDIA GPU detected — models are ranked against system memory.',
        };
      }
      return { gpus: [], error: result.stderr };
    }

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
    if (_isCloud()) return res.json({ ok: false, gpus: [], error: 'GPU probe unavailable in cloud. Use /start from terminal to relay to desktop.', backend: 'cloud' });
    try {
      const result = await probeNvidiaGpus();
      if (result.gpus.length) {
        return res.json({ ok: true, ...result });
      }
      // F-02, regressed here: probeNvidiaGpus says "notApplicable" with a reason
      // when the machine simply has no NVIDIA tooling (every Mac), and this
      // route dropped both — so the Hardware tab painted a red "No GPU probe
      // available" error on a correct state. Pass the distinction through.
      if (result.notApplicable) {
        return res.json({ ok: false, gpus: [], notApplicable: true, reason: result.reason });
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
          // No registry to refresh — /cookbook/models scans on read, so a
          // deleted model is gone from the inventory on the next request.
          return res.json({ ok: true, deleted: target });
        }
      }
      return res.json({ ok: false, error: 'Model not found in cache' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Kill GPU process ────────────────────────────────────────────

  //
  // The Hardware tab's Kill button, next to each process nvidia-smi lists on a
  // GPU. This ran `taskkill /F /T` on ANY pid >= 100 a caller named — a general
  // "kill a process on this machine" endpoint — and on macOS/Linux, where
  // taskkill does not exist, it did nothing. Now it stops only what Cookbook
  // can account for: one of its own running tasks, or a process nvidia-smi
  // lists on a GPU right now. Anything else is refused by name.
  router.post('/cookbook/kill-pid', async (req, res) => {
    const pid = parseInt(req.body && req.body.pid, 10);
    if (!Number.isInteger(pid) || pid < 100) return res.status(400).json({ ok: false, error: 'Invalid PID' });
    const own = Object.values(activeTasks).some(t => t && t.pid === pid && !t.exited);
    let onGpu = false;
    if (!own) {
      try {
        const probe = await probeNvidiaGpus();
        onGpu = (probe.gpus || []).some(g => (g.processes || []).some(p => p.pid === pid));
      } catch { onGpu = false; }
    }
    if (!own && !onGpu) {
      return res.status(403).json({
        ok: false,
        error: `PID ${pid} is not a Cookbook task or a process nvidia-smi lists on a GPU. Cookbook only stops processes it can account for.`,
      });
    }
    const result = await stopProcessTree(pid, { tree: own });
    if (!result.stopped) return res.status(500).json({ ok: false, pid, error: result.error });
    if (writeOSAudit) { try { writeOSAudit('COOKBOOK-KILL', `Stopped pid ${pid} (${own ? 'cookbook task' : 'GPU process'}, ${result.method})`); } catch {} }
    res.json({ ok: true, pid, method: result.method });
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
        dir: path.join(cacheDir, d),
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
    if (_isCloud()) return res.json({ models: [], host: 'cloud', note: 'Model cache unavailable in cloud. Relay via desktop bridge.' });
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

  // BO-D2e — identifier resolution, loaded the same guarded way this file
  // already loads its other local-runtime helpers, so a missing module
  // degrades to the strict org/repo behaviour rather than breaking the route.
  const identifierResolver = (() => {
    try { return require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'catalog-ids.cjs')); }
    catch { return null; }
  })();
  const modelCatalog = (() => {
    try { return require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'model-catalog.json')); }
    catch { return []; }
  })();
  const resolveIdentifier = (input) => {
    if (identifierResolver) {
      const list = Array.isArray(modelCatalog) ? modelCatalog : (modelCatalog.models || []);
      return identifierResolver.resolveModelIdentifier(input, list);
    }
    return REPO_ID_RE.test(String(input || '').trim())
      ? { ok: true, repoId: String(input).trim(), via: 'repo-id' }
      : { ok: false, error: `"${input}" is not a HuggingFace repository (org/repo).`, suggestions: [] };
  };

  /**
   * Install a catalogue model (and the llama.cpp engine first, if absent)
   * through the local-runtime installers, as a tracked Cookbook task.
   * Shared by POST /model/download (the /model-pull command) and
   * POST /cookbook/local/install (the Cookbook button).
   */
  function startLocalInstall(modelId) {
    // Injectable (deps.localInstallers) so a test of the ROUTING never moves
    // a byte over the network; production resolves the real installers.
    let RI = deps.localInstallers?.runtime || null, MI = deps.localInstallers?.model || null;
    if (!RI) { try { RI = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'runtime-installer.cjs')); } catch { /* unavailable on this deploy */ } }
    if (!MI) { try { MI = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'model-installer.cjs')); } catch { /* unavailable on this deploy */ } }
    const { getLocalRuntimeRegistry } = deps;
    const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
    if (!RI || !MI || !reg || !reg.file) {
      return { ok: false, status: 503, error: 'The local model installer is not available on this install.', remedy: 'Run npm install in the AEON folder and restart.' };
    }
    const dataRoot = path.resolve(reg.file, '..', '..');
    const entry = (Array.isArray(modelCatalog) ? modelCatalog : (modelCatalog.models || [])).find(m => m.id === modelId);
    const size = entry?.bytes ? (entry.bytes >= 1e9 ? `${(entry.bytes / 1e9).toFixed(1)} GB` : `${Math.round(entry.bytes / 1e6)} MB`) : 'unknown size';
    const needsRuntime = !reg.activeRuntime();

    const sessionId = `local-install-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const logStream = openTaskLog(logFile);
    activeTasks[sessionId] = { type: 'model-install', status: 'running', query: modelId, started_at: Date.now(), logFile, pct: 0, log: null, error: null };
    const status = (msg) => { logStream.write(`[STATUS] ${msg}\n`); const t = activeTasks[sessionId]; if (t) t.log = msg; if (typeof global.broadcastTerminalEvent === 'function') global.broadcastTerminalEvent('LOCAL_MODEL_INSTALL', `[${modelId}] ${msg}`); };
    const progress = (pct) => { logStream.write(`[PROGRESS] ${pct}%\n`); const t = activeTasks[sessionId]; if (t) t.pct = pct; };

    (async () => {
      if (needsRuntime) {
        status('Setting up the local AI engine first…');
        await RI.installRuntime({ dataRoot, onProgress: progress, onStatus: status });
        status('Local AI engine ready.');
      }
      await MI.installModel({ dataRoot, modelId, onStatus: status, onProgress: progress });
    })().then(() => {
      logStream.write('LOCAL_MODEL_INSTALL_OK\n'); logStream.end();
      const t = activeTasks[sessionId]; if (t) { t.status = 'done'; t.pct = 100; }
    }).catch((e) => {
      logStream.write(`ERROR: ${e.message}\nLOCAL_MODEL_INSTALL_FAILED\n`); logStream.end();
      const t = activeTasks[sessionId]; if (t) { t.status = 'failed'; t.error = e.message; }
    });

    // The terminal has no row to show the license on before the download, so
    // it comes with the first line /model-pull prints (A074).
    const lic = modelLicense(entry || { id: modelId });
    const licText = ` License: ${lic.name}${lic.url ? ` (${lic.url})` : ''}.`
      + (lic.notice ? ` ${lic.notice}${lic.policyUrl ? ` ${lic.policyName}: ${lic.policyUrl}` : ''}` : '');
    return {
      ok: true,
      session_id: sessionId,
      model: modelId,
      needsRuntime,
      licenseTerms: lic,
      // What the terminal prints. The download runs in the background; this
      // says what is happening, how big it is, and where to watch it.
      text: `Downloading ${entry?.displayName || modelId} (${size})${needsRuntime ? ' — installing the local AI engine first' : ''}. Verified by SHA-256 when it lands. Watch progress in Cookbook, or run /models in a minute.${licText}`,
    };
  }

  router.post('/model/download', async (req, res) => {
    const { repo_id: requested, backend, include, hf_token, local_dir, allowNonGguf } = req.body;
    if (!requested) return res.status(400).json({ ok: false, error: 'repo_id is required' });

    // BO-D2e — accept every identifier the operator is actually shown.
    //
    // This validated `requested` against a strict org/repo regex and answered
    // "Invalid repo_id" to anything else — including Cookbook's own display
    // names and the catalogue ids /model-pull's own description advertises.
    // "Invalid" also blamed the input for a vocabulary mismatch the product
    // created.
    const resolution = resolveIdentifier(requested);
    if (!resolution.ok) {
      return res.status(400).json({
        ok: false,
        error: resolution.error,
        // §08 — name the remedy. Both accepted forms, plus anything close.
        accepts: ['a catalogue model (id or the name shown in Cookbook)', 'a HuggingFace repository as org/repo'],
        ...(resolution.suggestions?.length ? { didYouMean: resolution.suggestions } : {}),
      });
    }
    const repo_id = resolution.repoId;

    // A CATALOGUE model — the thing /model-pull's own description advertises —
    // installs through AEON's own installer: the same SHA-256-verified path the
    // Cookbook's "Local models" button uses, needing no huggingface-cli and no
    // Python. Found by the CEO: `/model-pull qwen3-1.7b-q8` resolved the id
    // correctly and then 503'd for want of a tool the local installer never
    // needed. Only a raw org/repo still goes through Hugging Face tooling.
    if (resolution.matched) {
      const started = startLocalInstall(resolution.matched);
      if (!started.ok) return res.status(started.status || 503).json(started);
      return res.json(started);
    }

    // BO-H3a — a repo the runtime cannot open is a format problem, not a
    // download problem. Say so before gigabytes move, not after. The same
    // judgement already runs post-install (see `servable` above); it just ran
    // too late to save anyone a 5.8 GB fetch.
    //
    // Runs even when `include` is set. An earlier draft skipped it whenever the
    // caller narrowed the fetch — which was wrong, and would have rebuilt the
    // exact defect this guards: `allow_patterns=['*.gguf']` against an
    // all-safetensors repo matches nothing, downloads zero bytes, and exits 0.
    // A silent success is worse than the loud failure it replaced.
    //
    // The one legitimate reason to fetch non-GGUF weights is the Tier-3
    // converter, so that path opts out explicitly rather than by side effect.
    if (!allowNonGguf) {
      const probe = await ggufProbe(repo_id, hf_token);
      // ok:false means the probe could not answer — proceed. A network blip
      // must not become a refusal.
      if (probe.ok && !probe.hasGguf) {
        return res.status(400).json({
          ok: false,
          error: `${repo_id} publishes safetensors/PyTorch weights. The llama.cpp runtime reads GGUF only, so this download cannot produce a usable model.`,
          ...(probe.suggestion ? { didYouMean: [probe.suggestion] } : {}),
          hint: probe.suggestion
            ? `Try ${probe.suggestion} — same model, GGUF build.`
            : 'Install a GGUF build of this model, convert it in Cookbook (Tier 3), or pick from Local models, which are GGUF, hash-pinned and verified.',
        });
      }
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
      const logStream = openTaskLog(logFile);
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
          task.exited = true;
          task.status = 'error';
          task.exitCode = null;
          task.error = detail;
          task._emitter.emit('done', null);
        }
      });

      proc.on('close', (code) => {
        const task = activeTasks[sessionId];
        if (task) {
          task.exited = true;
          // A download the operator stopped is "stopped", not a failure.
          task.status = task.stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error');
          task.exitCode = code;
          logStream.write(`\n=== Process exited with code ${code} ===\n`);
          if (code === 0) logStream.write('DOWNLOAD_OK\n');
          else logStream.write('DOWNLOAD_FAILED\n');
          logStream.end();
          // One-click contract preserved without a write: /cookbook/models
          // derives the list on read, so a finished download appears with zero
          // extra steps and no second store to fall out of sync.
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
    const { cleaned, env: envAssignments, file: execFileName, bin: execBin } = parsed;

    const bound = bindLoopback(execBin, parsed.args);
    // llama-server also takes its bind address from LLAMA_ARG_HOST, so
    // `LLAMA_ARG_HOST=0.0.0.0 llama-server …` walked past the --host check.
    const envHost = envAssignments.LLAMA_ARG_HOST;
    if (!bound.ok || (envHost != null && !LOOPBACK_HOST_RE.test(envHost))) {
      const named = !bound.ok ? `--host ${bound.host || '(empty)'}` : `LLAMA_ARG_HOST=${envHost || '(empty)'}`;
      return res.status(400).json({
        ok: false,
        code: 'host_not_loopback',
        error: `AEON serves models on this computer only. ${named} would put a model server with no login on your network, where anyone could use it. Use --host 127.0.0.1.`,
      });
    }
    let serveArgs = bound.args;
    // What the VRAM check below judges, and names. A picked build replaces
    // both with that file (see there).
    let fitId = repo_id;
    let fitName = repo_id;

    // The Serve button names a Hugging Face cache entry by its repo id, and
    // llama-server's --model takes a FILE. `--model Org/Repo-GGUF` loaded
    // nothing (sweep C18). Resolve a cached repo id to its .gguf here; a path,
    // or a name no cache knows, passes through to the checks below as before.
    // Cookbook's own Download fetches every *.gguf in a repo, so several builds
    // (quants) in one repo is the usual case: they are listed for the operator
    // to choose from, and the choice comes back as `gguf` (a file name) —
    // never guessed between, since the wrong quant can overflow the card.
    const wantBuild = req.body.gguf == null || req.body.gguf === '' ? null : String(req.body.gguf);
    const marg = /^llama[-_]server(\.exe)?$/i.test(execBin) ? modelArg(serveArgs) : null;
    const value = marg ? serveArgs[marg.at].slice(marg.prefix.length) : null;
    const builds = marg && !fs.existsSync(value) ? cachedGgufBuilds(value) : null;
    if (wantBuild && !builds) {
      return res.status(400).json({
        ok: false,
        code: 'gguf_not_applicable',
        error: `gguf "${wantBuild}" names a build of a cached Hugging Face repo, and this command's --model is not one${marg ? ` (${value})` : ''}.`,
      });
    }
    if (builds) {
      const listed = builds.map(({ file, quant, size_bytes }) => ({ file, quant, size_bytes }));
      const pick = wantBuild ? builds.find(b => b.file === wantBuild) : (builds.length === 1 ? builds[0] : null);
      if (!pick) {
        const code = wantBuild ? 'gguf_not_found' : (builds.length ? 'gguf_ambiguous' : 'gguf_missing');
        return res.status(409).json({
          ok: false, code, repo_id: value, builds: listed,
          error: code === 'gguf_missing'
            ? `${value} is in the Hugging Face cache but holds no GGUF model file llama-server can open.`
            : code === 'gguf_not_found'
              ? `${value} has no GGUF build named "${wantBuild}". It holds: ${builds.map(b => b.file).join(', ') || 'none'}.`
              : `${value} holds ${builds.length} GGUF builds (${builds.map(b => b.quant || b.file).join(', ')}). Choose the one to serve.`,
        });
      }
      serveArgs = serveArgs.slice();
      serveArgs[marg.at] = marg.prefix + pick.full;
      // Judge the file that will load, not the repo. A GGUF repo id rarely
      // names a quant (`…/Qwen3-4B-GGUF`), so it read as fp16: 9.2 GB for a 4B
      // model, and every build — a 2.8 GB Q4_K_M included — was refused on a
      // 4 GB card before the operator's own choice was looked at. A file name
      // with no parameter count borrows the repo's: estimateVram reads the
      // first count and the first quant, so the file goes first.
      fitName = pick.file;
      fitId = estimateVram(pick.file).paramsB ? pick.file : `${pick.file}-${String(repo_id).split('/').pop()}`;
    }

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
        // Named in the screen's own words: the installer is the Hardware tab's
        // "Local AI runtime (llama.cpp)" section. "Local models" named nothing
        // the operator could find (measured 2026-09-23, What Fits ▸ Quick serve).
        error: `${short} is not installed. Install a model from the Hardware tab (Local AI runtime) first — AEON downloads and verifies it — then serve it from the Models tab.`,
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

      const fit = checkVramFit({ repoId: fitId, args: serveArgs, vramGb });
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
          error: vramErrorMessage(fit, fitName, fits?.id),
        });
      }
    }

    const sessionId = `serve-${crypto.randomBytes(4).toString('hex')}`;
    const logFile = path.join(LOGS_DIR, `${sessionId}.log`);
    const pidFile = path.join(LOGS_DIR, `${sessionId}.pid`);

    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...envAssignments };
    // The same address inherited from AEON's own environment is dropped, not
    // refused: the operator never typed it, and llama-server then binds its
    // loopback default. (One the command set was checked above.)
    if (env.LLAMA_ARG_HOST != null && !LOOPBACK_HOST_RE.test(env.LLAMA_ARG_HOST)) delete env.LLAMA_ARG_HOST;
    if (hf_token) env.HF_TOKEN = hf_token;
    if (gpus) env.CUDA_VISIBLE_DEVICES = gpus;

    try {
      const logStream = openTaskLog(logFile);
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
        if (t) { t.exited = true; t.status = 'error'; t.error = detail; }
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
        started_at: Date.now(), pid: proc.pid, logFile,
        // What actually runs — it differs from what was sent when a repo id
        // was resolved to its file or vLLM was given --host 127.0.0.1.
        cmd: serveArgs.join('\u0000') === parsed.args.join('\u0000') ? cleaned
          : [execFileName, ...serveArgs].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
        _emitter: emitter, _proc: proc,
      };

      proc.on('close', (code) => {
        const task = activeTasks[sessionId];
        if (task) {
          task.exited = true;
          task.status = task.stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error');
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
    pruneFinished(activeTasks);
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

  //
  // Was taskkill on every platform, failure swallowed, then ok:true — on macOS
  // and Linux Stop marked the task "stopped" while the process kept running
  // (tests/cookbook-task-stop.test.js). Now: stop the process tree Cookbook
  // spawned (_procControl.cjs), confirm it is gone, and say what happened.
  router.post('/cookbook/task-stop/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const task = activeTasks[sessionId];
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found — it may have belonged to an earlier AEON session.' });

    // The catalogue installers run INSIDE AEON: no child process, no abort
    // signal. Marking one "stopped" while it keeps downloading (and later flips
    // itself to "done") is the lie this route used to tell.
    if (!task.pid) {
      if (task.status !== 'running') return res.json({ ok: true, alreadyExited: true, status: task.status });
      return res.status(409).json({
        ok: false,
        error: 'This install runs inside AEON and cannot be stopped mid-download. It will finish or fail on its own; delete the model afterwards if you do not want it.',
      });
    }

    // Never signal a pid whose process already ended: the OS may have handed
    // that number to something else.
    if (task.exited) return res.json({ ok: true, alreadyExited: true, status: task.status });

    task.stopRequested = true;
    const result = await stopProcessTree(task.pid);
    if (!result.stopped) {
      task.stopRequested = false;
      return res.status(500).json({ ok: false, error: `Could not stop ${task.type} (pid ${task.pid}): ${result.error}` });
    }
    task.status = 'stopped';
    if (writeOSAudit) { try { writeOSAudit(`COOKBOOK-${sessionId}`, `Stopped ${task.type} pid ${task.pid} (${result.method})`); } catch {} }
    res.json({ ok: true, stopped: true, pid: task.pid, method: result.method });
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

        // BO-H3b — the fit engine ranked on hardware and was silent on
        // format, so it offered repos it could rank but the runtime could
        // never open (Qwen/Qwen3-14B, 2026-08-08). The HF tag is a free
        // signal; probing 50 repos individually is not, and the download
        // preflight remains the authority. Annotate, do not hide the row —
        // a ranking that silently drops entries is not honest about what
        // exists.
        models.push({
          repo_id: repoId,
          downloads: entry.downloads || 0,
          likes: entry.likes || 0,
          createdAt: entry.createdAt || '',
          tags: tags.slice(0, 5),
          pipeline_tag: entry.pipeline_tag || '',
          est_vram_gb: estVram ? Math.round(estVram * 10) / 10 : null,
          needed_vram_gb: neededVram ? Math.round(neededVram * 10) / 10 : null,
          gguf: tagText.includes('gguf') || nameText.includes('gguf'),
          runnable_reason: (tagText.includes('gguf') || nameText.includes('gguf'))
            ? null
            : 'no GGUF build listed — the llama.cpp runtime reads GGUF only',
        });
        if (models.length >= 50) break;
      }

      // Runnable first, then by fit. Both orderings are visible to the
      // operator; only the reason for the split is new.
      models.sort((a, b) => (b.gguf === true) - (a.gguf === true) || (b.downloads || 0) - (a.downloads || 0));

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
    // ── BO-B1: capabilities → fit → only what can actually run ────────────
    const lrDir = path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime');
    const capabilities = (() => { try { return require(path.join(lrDir, 'capabilities.cjs')); } catch { return null; } })();
    const fitEngine    = (() => { try { return require(path.join(lrDir, 'fit.cjs')); } catch { return null; } })();
    const converter    = (() => { try { return require(path.join(lrDir, 'model-converter.cjs')); } catch { return null; } })();

    /** Shared: registry + its data root, or null. */
    const regAndRoot = () => {
      const { getLocalRuntimeRegistry } = deps;
      const reg = getLocalRuntimeRegistry ? getLocalRuntimeRegistry() : null;
      if (!reg || !reg.file) return { reg: null, dataRoot: null };
      return { reg, dataRoot: path.resolve(reg.file, '..', '..') };
    };

    /**
     * GET /cookbook/local/capabilities — what this machine can run.
     *
     * The Cookbook asks this FIRST and shows it to the operator before any
     * model list. An unprobeable capability comes back as unknown rather than
     * as zero — see capabilities.cjs for why that distinction is load-bearing.
     */
    router.get('/cookbook/local/capabilities', async (req, res) => {
      if (!capabilities) return res.status(503).json({ ok: false, error: 'capability probe unavailable' });
      try {
        const { reg, dataRoot } = regAndRoot();
        const active = reg ? reg.activeRuntime() : null;
        const caps = await capabilities.detect({ dataRoot, activeRuntime: active });
        res.json({ ok: true, capabilities: caps });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    /**
     * GET /cookbook/local/catalog — the catalogue, already judged.
     *
     * Returns `shown` (installable here) and `hidden` (with the reason each
     * one was excluded). The UI defaults to `shown`. Hiding without a reason
     * would be its own dishonesty, so every hidden entry carries one.
     */
    router.get('/cookbook/local/catalog', async (req, res) => {
      try {
        const { reg, dataRoot } = regAndRoot();
        const models = modelInstaller.listCatalog(dataRoot || '')
          // catalogue is GGUF by construction; licenseTerms is what the row
          // shows before Install (A074)
          .map(m => ({ ...m, format: 'gguf', licenseTerms: modelLicense(m) }));

        if (!capabilities || !fitEngine) {
          return res.json({ ok: true, models, shown: models, hidden: [], capabilities: null,
            note: 'fit engine unavailable — showing the full catalogue unfiltered' });
        }

        const active = reg ? reg.activeRuntime() : null;
        const caps = await capabilities.detect({ dataRoot, activeRuntime: active });
        const ctx = Number(req.query.context) || undefined;
        const { shown, hidden, summary } = fitEngine.assessCatalog(models, caps, { contextTokens: ctx });
        const recommended = fitEngine.recommend(models, caps, { contextTokens: ctx });

        res.json({
          ok: true,
          models,                                   // full list, for callers that want it
          shown, hidden, summary,
          recommended: recommended ? recommended.id : null,
          capabilities: caps,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    /**
     * POST /cookbook/local/convert-preflight — Tier 3 cost disclosure.
     * Body: { repoId, sourceBytes?, quant? }
     *
     * Costs nothing and downloads nothing. This is the answer the operator
     * needed BEFORE 5.8 GB of safetensors landed in a cache the runtime cannot
     * read.
     */
    router.post('/cookbook/local/convert-preflight', async (req, res) => {
      if (!converter) return res.status(503).json({ ok: false, error: 'converter unavailable' });
      try {
        const { reg, dataRoot } = regAndRoot();
        const active = reg ? reg.activeRuntime() : null;
        const sourceBytes = Number(req.body?.sourceBytes) || 0;
        const quant = req.body?.quant || 'Q4_K_M';

        let quantizeExe = null;
        if (active && reg) {
          try {
            const rtDir = path.dirname(reg.resolveEntryPath(active));
            quantizeExe = path.join(rtDir, process.platform === 'win32' ? 'llama-quantize.exe' : 'llama-quantize');
          } catch {}
        }

        const pf = await converter.preflight({
          sourceBytes, dataRoot, quant,
          runtimeTag: active ? active.version : null,
          quantizeExe,
        });
        res.json({ ok: true, repoId: req.body?.repoId || null, preflight: pf });
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
      const logStream = openTaskLog(logFile);

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

module.exports.modelLicense = modelLicense;
