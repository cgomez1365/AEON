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
 * Refuse to install anything whose hash was never verified.
 *
 * Extracted so it can be tested against a SYNTHETIC value. It used to be
 * inline, and its test asserted that the shipped manifest still contained
 * PENDING_VERIFICATION — so filling in real hashes broke the test that
 * protects the invariant. A guard's test must not depend on the guard
 * currently having something to catch.
 *
 * @param {string} kind   'Runtime asset' | 'Model'
 * @param {string} id
 * @param {string} sha256
 * @param {string} manifest  filename to point the operator at
 */
function assertHashVerified(kind, id, sha256, manifest) {
  if (sha256 === 'PENDING_VERIFICATION') {
    throw new Error(
      `${kind} ${id} has a PENDING_VERIFICATION SHA-256. ` +
      `Compute the real hash from the downloaded file — never copy one from a page — ` +
      `with: node tools/fetch-runtime-hashes.mjs. ` +
      `See services/local-runtime/${manifest}.`
    );
  }
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) {
    throw new Error(`${kind} ${id} has a malformed SHA-256 in ${manifest}: ${JSON.stringify(String(sha256).slice(0, 80))}`);
  }
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
 * Extract an archive IN PROCESS. No shell, no external tool, no PATH lookup.
 *
 * This used to shell out: PowerShell's Expand-Archive on Windows, `unzip` on
 * POSIX. Both were liabilities:
 *
 *   - Expand-Archive was invoked through `-Command` with the paths interpolated
 *     into a single-quoted PowerShell string, and dataRoot derives from
 *     DATA_PATH, which the user controls. A quote in that path closed the
 *     literal.
 *   - `unzip` is absent on minimal Linux images and not guaranteed on macOS.
 *     When missing, spawnSync set status=null, and a `status !== 0` check threw
 *     "Extraction failed: " with an empty message.
 *
 * adm-zip and tar are already dependencies. Using them removes an entire class
 * of failure: nothing to inject into, nothing to be missing, and identical
 * behaviour on every platform. It is also what makes .tar.gz releases usable —
 * llama.cpp ships macOS and Linux as tarballs.
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {'zip'|'tar.gz'} kind
 * @param {number} stripComponents  leading path segments to drop (tar only)
 */
async function extractArchive(archivePath, destDir, kind = 'zip', stripComponents = 1) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  try {
    if (kind === 'tar.gz') {
      const tar = require('tar');
      // llama.cpp's tarballs nest everything under a version directory
      // (llama-b10216/...) while the Windows zips are flat. Stripping one
      // component normalises both to the same on-disk layout, so requiredFiles
      // and the entrypoint path are platform-independent.
      await tar.x({ file: archivePath, cwd: destDir, strip: stripComponents });
      // BO-E1 — node-tar silently DROPS some symlinks. See the function below:
      // without this, local models cannot install on Linux at all.
      await restoreDroppedSymlinks(archivePath, destDir, stripComponents);
      return;
    }
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archivePath);
    // Guard against a crafted archive escaping destDir (zip-slip). The hash is
    // verified before we get here, so this is defence in depth rather than the
    // primary control — but the check is nearly free.
    const root = path.resolve(destDir);
    for (const entry of zip.getEntries()) {
      const target = path.resolve(root, entry.entryName);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`archive entry escapes the extract directory: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(destDir, true);
  } catch (e) {
    throw new Error(`Extraction failed (${kind}): ${e.message}`);
  }
}

/**
 * Re-create symlinks that node-tar dropped.
 *
 * BO-E1, found on a clean Ubuntu 24.04 that had never had AEON — which is the
 * only way it could have been found, and is exactly what Definition of Done
 * §20 #1 exists to surface.
 *
 * node-tar 7.5.22 extracts 58 of the 62 entries in llama.cpp's
 * `llama-b10216-bin-ubuntu-x64.tar.gz`. GNU tar extracts all of them. The four
 * it drops are every symlink whose target is ITSELF a symlink:
 *
 *     libllama.so       -> libllama.so.0       -> libllama.so.0.0.10216
 *     libggml-base.so   -> libggml-base.so.0   -> …
 *     libllama-common.so, libmtmd.so           (same two-hop shape)
 *
 * Single-hop links like `libggml.so -> libggml.so.0` survive, which is why
 * verifyLayout reported only `libllama.so` missing and nothing else looked
 * wrong. The consequence was total: the runtime never installed on Linux, so
 * `local first` — principle 01 — did not hold on the platform at all.
 *
 * The repair is deliberate rather than a switch to system `tar`. This file's
 * own header explains why the shell-out was removed: "nothing to inject into,
 * nothing to be missing, and identical behaviour on every platform." Shelling
 * out again to fix a library bug would trade a known defect for the class of
 * defect that was already paid for once.
 *
 * Instead: read the archive's link entries, and create any that are absent.
 * Containment is re-checked here because a symlink is precisely the thing that
 * can escape an extract directory — both the link's own path and its target
 * must resolve inside destDir, or it is skipped.
 *
 * @returns {Promise<string[]>} relative paths restored
 */
async function restoreDroppedSymlinks(archivePath, destDir, stripComponents = 1) {
  // Windows tar.gz assets do not exist (llama.cpp ships zips there), and
  // creating symlinks on Windows needs a privilege AEON must never ask for.
  if (os.platform() === 'win32') return [];

  const tar = require('tar');
  const root = path.resolve(destDir);
  const links = [];

  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (entry.type !== 'SymbolicLink') return;
      const rel = String(entry.path).split('/').filter(Boolean).slice(stripComponents).join('/');
      if (rel && entry.linkpath) links.push({ rel, target: String(entry.linkpath) });
    },
  });

  const restored = [];
  for (const { rel, target } of links) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;          // link escapes
    const resolvedTarget = path.resolve(path.dirname(abs), target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) continue; // target escapes

    // lstat, not existsSync: existsSync follows the link and reports false for
    // one whose target has not been written yet, which would make this restore
    // a link that is already there.
    try { fs.lstatSync(abs); continue; } catch { /* genuinely absent */ }

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(target, abs);
      restored.push(rel);
    } catch { /* best effort — verifyLayout is the gate that matters */ }
  }
  return restored;
}

/**
 * Verify all required files for this platform are present in extractDir.
 */
function verifyLayout(extractDir, asset) {
  const key = `${asset.platform}-${asset.arch}-${asset.backend}`;
  const required = ASSETS.requiredFiles[key] || [];
  const missing = required.filter(f => !fs.existsSync(path.join(extractDir, f)));
  if (missing.length) {
    // §08 — name what actually happened. This used to report only the missing
    // filename, which sent the reader looking for a corrupt download when the
    // archive was intact and the extractor had dropped the entry.
    const dangling = missing.filter((f) => {
      try { return fs.lstatSync(path.join(extractDir, f)).isSymbolicLink(); } catch { return false; }
    });
    const detail = dangling.length
      ? ` (${dangling.join(', ')} exist as symlinks whose target was not extracted)`
      : ' (absent from the extract directory — the archive was verified by hash, so this is an extraction fault, not a bad download)';
    throw new Error(`Missing required files after extraction: ${missing.join(', ')}${detail}`);
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
  assertHashVerified('Runtime asset', asset.id, asset.sha256, 'runtime-assets.json');

  // ── 2. Check if already installed and ready ─────────────────────────────
  const existing = reg.load().runtimes.find(r => r.id === asset.id && r.state === 'ready');
  if (existing) {
    emit(`Runtime ${asset.id} already ready — skipping download`);
    const entryAbs = P.fromRegistryRelative(dataRoot, `${existing.relPath}/${existing.entrypoint}`);
    return { runtimeId: asset.id, entryAbsPath: entryAbs, probe: existing.probe || null };
  }

  // ── 3. Prepare staging paths ─────────────────────────────────────────────
  P.ensureManagedDirs(dataRoot);
  // stagingPath() requires a caller-supplied token so two concurrent installs
  // never collide on one .part file — see paths.cjs. Both installers were
  // calling it with no token at all, which threw before a single byte was
  // fetched. Nothing had ever executed this path.
  const stagingToken = `rt-${asset.id}-${crypto.randomBytes(6).toString('hex')}`;
  const stagingDir = P.stagingPath(dataRoot, stagingToken);
  fs.mkdirSync(stagingDir, { recursive: true });
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
    relPath: P.toRegistryRelative(dataRoot, P.runtimePath(dataRoot, asset.id)),
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
    await extractArchive(zipStage, extractTarget, asset.archive || 'zip', asset.stripComponents ?? 1);

    // ── 8. Verify layout ─────────────────────────────────────────────────────
    verifyLayout(extractTarget, asset);
    markExecutable(extractTarget, asset);
    emit('Layout verified');

    // ── 9. Move to managed runtime dir (atomic on same filesystem) ───────────
    const finalDir = P.runtimePath(dataRoot, asset.id);
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

// extractArchive and restoreDroppedSymlinks are exported so BO-E1 can be gated
// directly. The alternative is a test that downloads a 16 MB release asset to
// prove a symlink was written, which would make the gate depend on GitHub being
// up — §19 gates run on every PR and must not.
module.exports = {
  installRuntime, removeRuntime, selectAsset, sha256File, download, assertHashVerified,
  extractArchive, restoreDroppedSymlinks,
};
