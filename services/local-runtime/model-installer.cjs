'use strict';
/**
 * Phase 4 — GGUF model installer.
 *
 * Downloads a specific model from the curated catalog, verifies SHA-256,
 * probes the GGUF header (architecture, embedding length), and atomically
 * promotes to "ready" in the registry. No model reaches ready without a
 * verified hash. No silent downloads — caller must pass onProgress/onStatus.
 *
 * Does NOT touch the legacy model store (~/.ollama) — GGUF models live // aeon-path-authority-allow
 * inside the managed local-runtime directory only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = require('./paths.cjs');
const R = require('./registry.cjs');
const { download: sharedDownload } = require('./download.cjs');
const { assertHashVerified } = require('./runtime-installer.cjs');
const CATALOG = require('./model-catalog.json');

// ── GGUF header probe ────────────────────────────────────────────────────────
// GGUF magic: 0x47475546 ("GGUF") at offset 0, version uint32 at offset 4.
// We read only the first 256 bytes to extract magic + version + architecture
// key from the metadata KV block (offset 12+). Full parsing is complex; we
// only need enough to confirm the file is a real GGUF and grab architecture.

// Derived from the string, never written as a hex literal. The literal here
// used to be 0x46465547, which is "GUFF" — the last two bytes transposed. Every
// real GGUF file was rejected as "Not a GGUF file", so no model could ever be
// installed. The unit test wrote the SAME transposed literal into its fixture,
// so it passed against a file that no model in the catalog resembles.
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii').readUInt32LE(0); // 0x46554747

function probeGgufHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const read = fs.readSync(fd, buf, 0, 256, 0);
    if (read < 8) throw new Error('File too small to be a GGUF');

    const magic = buf.readUInt32LE(0);
    if (magic !== GGUF_MAGIC) {
      throw new Error(`Not a GGUF file (magic: 0x${magic.toString(16).toUpperCase()})`);
    }
    const version = buf.readUInt32LE(4);
    // version 2 or 3 are the current standards; version 1 is legacy
    if (version < 1 || version > 4) {
      throw new Error(`Unknown GGUF version: ${version}`);
    }

    // Best-effort: scan for the architecture string in the first 256 bytes.
    // The architecture key is stored as "general.architecture" (length-prefixed).
    // For our purposes, a regex scan of the raw bytes is sufficient and avoids
    // full KV-block deserialization.
    const text = buf.toString('latin1');
    const archMatch = text.match(/general\.architecture[^\x00]{0,8}([a-z][a-z0-9_]{1,30})/);
    const architecture = archMatch ? archMatch[1] : null;

    return { version, architecture, probedAt: new Date().toISOString() };
  } finally {
    fs.closeSync(fd);
  }
}

// ── Download helper — shared with runtime-installer (BO-A0) ─────────────────
// Was a byte-identical copy differing only in timeout, so every fix had to land
// twice. Model files are large, hence the longer per-hop deadline.

function download(url, destPath, { onProgress } = {}) {
  return sharedDownload(url, destPath, { onProgress, timeoutMs: 600_000 });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List all catalog models, annotated with install state from the registry.
 */
function listCatalog(dataRoot) {
  let installed = [];
  try {
    const reg = R.createRegistry(dataRoot);
    installed = reg.load().models;
  } catch {}

  return CATALOG.models.map(entry => {
    const found = installed.find(m => m.id === entry.id);
    return {
      ...entry,
      sha256: undefined,       // never expose hash to the frontend
      url: undefined,          // never expose download URL to the frontend
      installState: found ? found.state : 'not_installed',
      installedAt: found ? found.installedAt : null,
      quarantineReason: found ? (found.quarantineReason || null) : null,
    };
  });
}

/**
 * Install a model by catalog id.
 *
 * @param {object} opts
 * @param {string}   opts.dataRoot
 * @param {string}   opts.modelId     Must be a known catalog id
 * @param {function} [opts.onProgress]  (pct, bytes, total) => void
 * @param {function} [opts.onStatus]    (string) => void
 * @returns {Promise<{ modelId: string, relPath: string, gguf: object }>}
 */
async function installModel({ dataRoot, modelId, onProgress, onStatus } = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new Error('installModel: dataRoot must be absolute');
  }

  const emit = s => { if (onStatus) onStatus(s); };
  const entry = CATALOG.models.find(m => m.id === modelId);
  if (!entry) throw new Error(`Unknown model id: ${modelId}`);

  assertHashVerified('Model', modelId, entry.sha256, 'model-catalog.json');

  // Validate the catalogue entry against the registry's contract BEFORE
  // downloading anything.
  //
  // Found by the 2026-08-04 stress run: a catalogue entry declared capability
  // "code", which is not in the registry's allow-list. The download completed —
  // 1.65 GB — and only THEN did the registry write fail validation. The
  // operator paid full bandwidth for an entry that could never be installed.
  // Anything knowable up front must be checked up front.
  const ALLOWED_CAPS = new Set(['chat', 'embed', 'vision', 'tools']);
  const badCaps = (entry.capabilities || []).filter(c => !ALLOWED_CAPS.has(c));
  if (badCaps.length) {
    throw new Error(
      `Catalogue entry "${modelId}" declares unsupported capability: ${badCaps.join(', ')}. ` +
      `Allowed: ${[...ALLOWED_CAPS].join(', ')}. Fix model-catalog.json — refusing to download ` +
      `${((entry.bytes || 0) / 1e9).toFixed(2)} GB for an entry that cannot be registered.`
    );
  }

  const reg = R.createRegistry(dataRoot);

  // Already ready?
  const existing = reg.load().models.find(m => m.id === modelId && m.state === 'ready');
  if (existing) {
    emit(`Model ${modelId} already installed`);
    return { modelId, relPath: existing.relPath, gguf: existing.gguf || null };
  }

  P.ensureManagedDirs(dataRoot);

  // Compute final managed path from the template (substitutes dataRoot).
  // relPathTemplate is POSIX-relative-to-dataRoot, e.g. "local-runtime/models/..."
  const relPath = entry.relPathTemplate;
  const absDir = path.dirname(path.join(dataRoot, ...relPath.split('/')));
  const absFile = path.join(dataRoot, ...relPath.split('/'));
  // Caller-supplied staging token (see paths.cjs): concurrent installs of the
  // same model must not collide on one .part file. Was called with no token,
  // which threw before any download.
  const stagingToken = `md-${modelId}-${crypto.randomBytes(6).toString('hex')}`;
  const stagingFile = P.stagingPath(dataRoot, stagingToken, entry.filename);
  fs.mkdirSync(path.dirname(stagingFile), { recursive: true });

  // Clean stale staging
  try { if (fs.existsSync(stagingFile)) fs.unlinkSync(stagingFile); } catch {}

  // Register as staged immediately
  reg.upsertModel({
    id: modelId,
    state: 'staged',
    displayName: entry.displayName,
    relPath,
    bytes: entry.bytes,
    capabilities: entry.capabilities,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
    quantization: entry.quantization,
    contextCeiling: entry.contextCeiling,
    installedAt: new Date().toISOString(),
  });

  try {
    // ── Download ────────────────────────────────────────────────────────────
    emit(`Downloading ${entry.displayName} (${Math.round(entry.bytes / 1e9 * 10) / 10} GB)…`);
    await download(entry.url, stagingFile, { onProgress });
    emit('Download complete');

    // ── Verify SHA-256 ──────────────────────────────────────────────────────
    emit('Verifying SHA-256…');
    const actual = await sha256File(stagingFile);
    if (actual !== entry.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${entry.filename}:\n  expected: ${entry.sha256}\n  got: ${actual}`
      );
    }
    emit('Hash verified');

    // ── Probe GGUF header ───────────────────────────────────────────────────
    emit('Probing GGUF header…');
    const gguf = probeGgufHeader(stagingFile);
    emit(`GGUF version ${gguf.version}, architecture: ${gguf.architecture || 'unknown'}`);

    // ── Move to managed location ────────────────────────────────────────────
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
    if (fs.existsSync(absFile)) fs.unlinkSync(absFile);
    fs.renameSync(stagingFile, absFile);
    emit('Moved to managed model dir');

    // ── Promote to ready ────────────────────────────────────────────────────
    reg.upsertModel({
      id: modelId,
      state: 'ready',
      displayName: entry.displayName,
      relPath,
      bytes: entry.bytes,
      sha256: actual,
      capabilities: entry.capabilities,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      quantization: entry.quantization,
      contextCeiling: entry.contextCeiling,
      gguf,
      installedAt: new Date().toISOString(),
    });
    emit(`Model ${modelId} ready`);

    return { modelId, relPath, gguf };

  } catch (err) {
    try {
      const cur = reg.load().models.find(m => m.id === modelId);
      if (cur && cur.state === 'staged') {
        reg.upsertModel({ ...cur, state: 'quarantined', quarantineReason: err.message });
      }
    } catch {}
    try { if (fs.existsSync(stagingFile)) fs.unlinkSync(stagingFile); } catch {}
    throw err;
  }
}

/**
 * Remove an installed model.
 */
async function removeModel(dataRoot, modelId) {
  const reg = R.createRegistry(dataRoot);
  const entry = reg.load().models.find(m => m.id === modelId);
  if (!entry) throw new Error(`Model ${modelId} not in registry`);
  if (entry.state !== 'removing') {
    reg.setModelState(modelId, 'removing');
  }
  // Delete the file
  try {
    const absFile = path.join(dataRoot, ...entry.relPath.split('/'));
    if (fs.existsSync(absFile)) fs.unlinkSync(absFile);
    // Remove parent dir if empty
    const dir = path.dirname(absFile);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {}
  reg.removeModel(modelId);
}

module.exports = { listCatalog, installModel, removeModel, probeGgufHeader, sha256File };
