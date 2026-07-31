'use strict';
/**
 * Phase 3 — Runtime installer.
 *
 * Downloads the version-pinned llama.cpp release for this platform, verifies
 * the SHA-256 hash, extracts into the managed staging area, probes the binary,
 * and atomically promotes to "ready" in the registry. On any failure the
 * staging dir is cleaned and the registry stays in "staged" state.
 *
 * Constraints:
 *   - No admin rights required (user-writable data dir only)
 *   - No PATH lookup — binary always invoked by absolute managed path
 *   - No shell interpolation — execFileSync/spawnSync only
 *   - No Ollama — not referenced, not detected, not migrated here
 *   - No silent download — caller must pass { onProgress } and surface it in UX
 *   - A wrong hash or bad layout CANNOT produce state="ready"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const P = require('./paths.cjs');
const R = require('./registry.cjs');
const { download: sharedDownload } = require('./download.cjs');
const { probe, canExec } = require('./runtime-probe.cjs');

const ASSETS = require('./runtime-assets.json');

/**
 * Select the best platform asset for the current machine.
 * Prefer CUDA on Windows/Linux when the env says so; Metal on macOS arm64.
 *
 * @param {{ preferBackend?: 'cpu'|'cuda'|'metal'|'vulkan'|'rocm' }} opts
 * @returns {object} asset record from runtime-assets.json
 */
function selectAsset(opts = {}) {
  const plat = os.platform();
  const arch = os.arch();
  const prefer = opts.preferBackend || process.env.AEON_LLM_BACKEND || 'cpu';

  // Prefer the requested backend; fall back to cpu for the same platform+arch.
  const candidates = ASSETS.platforms.filter(a => a.platform === plat && a.arch === arch);
  if (!candidates.length) {
    throw new Error(`No llama.cpp asset available for ${plat}/${arch}. Supported: win32/x64, darwin/arm64, darwin/x64, linux/x64`);
  }

  return candidates.find(a => a.backend === prefer) || candidates.find(a => a.backend === 'cpu') || candidates[0];
}

/**
 * Download a URL to destPath, streaming.
 *
 * The implementation lives in ./download.cjs — one copy, shared with
 * model-installer.cjs. See that file for why the previous inline version
 * killed the process on every real download.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {{ onProgress?: (pct: number, bytes: number, total: number) => void }} opts
 * @returns {Promise<{url:string, bytes:number, redirects:number}>}
 */
function download(url, destPath, { onProgress } = {}) {
  return sharedDownload(url, destPath, { onProgress, timeoutMs: 120_000 });
}

/**
 * SHA-256 a file on disk. Returns lowercase hex string.
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Extract a .zip archive into destDir without any shell.
 * Uses the system unzip on POSIX; on Windows uses PowerShell's Expand-Archive
 * (available since PowerShell 5, standard on Win10+).
 *
 * If a subdir is specified in the asset, only that subdir is extracted.
 */
function extractZip(zipPath, destDir) {
  const { spawnSync } = require('child_process');

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Failure reporting shared by both branches. spawnSync sets status=null and
  // error=ENOENT when the tool is absent — the old code only checked
  // `status !== 0`, so a missing extractor produced `"Extraction failed: "`
  // with an empty message and no clue what to install.
  const check = (result, tool) => {
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error(`Extraction failed: "${tool}" is not installed or not on PATH.`);
    }
    if (result.error) throw new Error(`Extraction failed: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').toString().trim();
      throw new Error(`Extraction failed (${tool} exit ${result.status})${detail ? ': ' + detail : ''}`);
    }
  };

  if (os.platform() === 'win32') {
    // Paths reach PowerShell as -Command string interpolation, and dataRoot
    // derives from DATA_PATH (user-controlled). A single quote in that path
    // would close the literal and inject. Doubling is PowerShell's own escape
    // for a single-quoted string; it is the whole escape rule for that context.
    const psLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(destDir)} -Force`,
    ], { timeout: 120_000, shell: false, windowsHide: true });
    check(result, 'powershell.exe');
  } else {
    const result = spawnSync('unzip', ['-o', zipPath, '-d', destDir], {
      timeout: 120_000, shell: false,
    });
    check(result, 'unzip');
  }
}

/**
 * Verify all required files for this platform are present in extractDir.
 */
function verifyLayout(extractDir, asset) {
  const key = `${asset.platform}-${asset.arch}-${asset.backend}`;
  const required = ASSETS.requiredFiles[key] || [];
  const missing = required.filter(f => !fs.existsSync(path.join(extractDir, f)));
  if (missing.length) {
    throw new Error(`Missing required files after extraction: ${missing.join(', ')}`);
  }
}

/**
 * Set execute bit on POSIX binaries after extraction.
 * No-op on Windows.
 */
function markExecutable(extractDir, asset) {
  if (os.platform() === 'win32') return;
  const key = `${asset.platform}-${asset.arch}-${asset.backend}`;
  const required = ASSETS.requiredFiles[key] || [asset.entrypoint];
  for (const f of required) {
    const fp = path.join(extractDir, f);
    if (fs.existsSync(fp)) {
      try { fs.chmodSync(fp, 0o755); } catch {}
    }
  }
}

/**
 * Main entry point.
 *
 * @param {object} opts
 * @param {string}   opts.dataRoot         Absolute path to AEON data directory
 * @param {'cpu'|'cuda'|'metal'|'vulkan'|'rocm'} [opts.preferBackend]
 * @param {function} [opts.onProgress]     (pct, receivedBytes, totalBytes) => void
 * @param {function} [opts.onStatus]       (string) => void  — human-readable status lines
 * @returns {Promise<{ runtimeId: string, entryAbsPath: string, probe: object }>}
 */
async function installRuntime({ dataRoot, preferBackend, onProgress, onStatus } = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new Error('installRuntime: dataRoot must be an absolute path');
  }

  const emit = (msg) => { if (onStatus) onStatus(msg); };
  const reg = R.createRegistry(dataRoot);

  // ── 1. Select asset ────────────────────────────────────────────────────────
  const asset = selectAsset({ preferBackend });
  emit(`Selected runtime: ${asset.id} (${asset.backend})`);

  // Guard: pending-verification hash means this manifest was never finalized.
  if (asset.sha256 === 'PENDING_VERIFICATION') {
    throw new Error(
      `Runtime asset ${asset.id} has a PENDING_VERIFICATION SHA-256. ` +
      `Fetch the real hash from the GitHub release page before shipping. ` +
      `See services/local-runtime/runtime-assets.json.`
    );
  }

  // ── 2. Check if already installed and ready ─────────────────────────────
  const existing = reg.load().runtimes.find(r => r.id === asset.id && r.state === 'ready');
  if (existing) {
    emit(`Runtime ${asset.id} already ready — skipping download`);
    const entryAbs = P.fromRegistryRelative(dataRoot, `${existing.relPath}/${existing.entrypoint}`);
    return { runtimeId: asset.id, entryAbsPath: entryAbs, probe: existing.probe || null };
  }

  // ── 3. Prepare staging paths ─────────────────────────────────────────────
  P.ensureManagedDirs(dataRoot);
  const stagingDir = P.stagingPath(dataRoot);
  const zipName = asset.filename;
  const zipStage = path.join(stagingDir, zipName);
  const extractTarget = path.join(stagingDir, `extract-${asset.id}`);

  // Clean stale leftovers from a previous interrupted install.
  try { if (fs.existsSync(zipStage)) fs.unlinkSync(zipStage); } catch {}
  try { if (fs.existsSync(extractTarget)) fs.rmSync(extractTarget, { recursive: true, force: true }); } catch {}

  // ── 4. Register as "staged" immediately so crash recovery is possible ────
  reg.upsertRuntime({
    id: asset.id,
    state: 'staged',
    version: ASSETS.runtimeVersion,
    backend: asset.backend,
    platform: asset.platform,
    arch: asset.arch,
    relPath: P.toRegistryRelative(dataRoot, path.join(P.runtimePath(dataRoot), asset.id)),
    entrypoint: asset.entrypoint,
    installedAt: new Date().toISOString(),
  });

  try {
    // ── 5. Download ──────────────────────────────────────────────────────────
    emit(`Downloading ${asset.filename} (${Math.round(asset.bytes / 1e6)} MB)…`);
    await download(asset.url, zipStage, { onProgress });
    emit('Download complete');

    // ── 6. Verify SHA-256 ────────────────────────────────────────────────────
    emit('Verifying SHA-256…');
    const actual = await sha256File(zipStage);
    if (actual !== asset.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${asset.filename}:\n` +
        `  expected: ${asset.sha256}\n` +
        `  got:      ${actual}`
      );
    }
    emit('Hash verified');

    // ── 7. Extract ───────────────────────────────────────────────────────────
    emit('Extracting…');
    extractZip(zipStage, extractTarget);

    // ── 8. Verify layout ─────────────────────────────────────────────────────
    verifyLayout(extractTarget, asset);
    markExecutable(extractTarget, asset);
    emit('Layout verified');

    // ── 9. Move to managed runtime dir (atomic on same filesystem) ───────────
    const finalDir = path.join(P.runtimePath(dataRoot), asset.id);
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(extractTarget, finalDir);
    emit(`Installed to managed runtime dir`);

    // ── 10. Probe the binary ─────────────────────────────────────────────────
    const entryAbs = path.join(finalDir, asset.entrypoint);
    emit(`Probing binary: ${asset.entrypoint}`);
    const probeResult = probe(entryAbs, asset.probeArgs);
    emit(`Probe OK — version: ${probeResult.reportedVersion}, GPU: ${probeResult.gpuBackend || 'none'}`);

    // ── 11. Promote to "ready" — only if hash + probe both passed ────────────
    reg.upsertRuntime({
      id: asset.id,
      state: 'ready',
      version: ASSETS.runtimeVersion,
      backend: asset.backend,
      platform: asset.platform,
      arch: asset.arch,
      relPath: P.toRegistryRelative(dataRoot, finalDir),
      sha256: actual,
      entrypoint: asset.entrypoint,
      probe: probeResult,
      installedAt: new Date().toISOString(),
    });
    reg.activateRuntime(asset.id);
    emit(`Runtime ${asset.id} is ready and active`);

    // ── 12. Clean staging zip ─────────────────────────────────────────────────
    try { fs.unlinkSync(zipStage); } catch {}

    return { runtimeId: asset.id, entryAbsPath: entryAbs, probe: probeResult };

  } catch (err) {
    // Any failure: quarantine the registry entry, clean staging.
    try {
      const current = reg.load().runtimes.find(r => r.id === asset.id);
      if (current && current.state === 'staged') {
        // No setRuntimeState shorthand; use upsertRuntime to set quarantined.
        reg.upsertRuntime({ ...current, state: 'quarantined', quarantineReason: err.message });
      }
    } catch {}
    try { if (fs.existsSync(zipStage)) fs.unlinkSync(zipStage); } catch {}
    try { if (fs.existsSync(extractTarget)) fs.rmSync(extractTarget, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

/**
 * Remove an installed runtime from the managed dir and the registry.
 * Only allowed when the runtime is NOT the active one, or when replacing.
 */
async function removeRuntime(dataRoot, runtimeId) {
  const reg = R.createRegistry(dataRoot);
  const active = reg.activeRuntime();
  if (active && active.id === runtimeId) {
    throw new Error(`Cannot remove the active runtime (${runtimeId}). Activate another first.`);
  }
  const entry = reg.load().runtimes.find(r => r.id === runtimeId);
  if (!entry) throw new Error(`Runtime ${runtimeId} not found in registry`);

  const dir = P.fromRegistryRelative(dataRoot, entry.relPath);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  // Mark removing then remove — mirrors model removal flow.
  reg.upsertRuntime({ ...entry, state: 'quarantined', quarantineReason: 'removed by user' });
  // No removeRuntime in registry (runtimes are superseded, not deleted), so just quarantine.
}

module.exports = { installRuntime, removeRuntime, selectAsset, sha256File, download };
