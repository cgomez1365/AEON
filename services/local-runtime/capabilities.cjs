/**
 * Machine capabilities — the ONE place AEON asks what this computer can run.
 *
 * BO-B1a. Before this, hardware facts were discovered in several places and
 * agreed with each other by luck: the GPU probe lived in the cookbook router,
 * RAM was read ad hoc, free disk was not checked at all, and nothing combined
 * them into a single answer. The Cookbook then offered every model in the
 * catalog regardless, so an operator could download 5.8 GB of weights their
 * runtime could never open.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: an unknown capability is reported as
 * UNKNOWN, never as zero and never as unlimited. A failed GPU probe means "we
 * could not tell", which is a different fact from "there is no GPU", and the
 * fit engine must be able to distinguish them — otherwise a machine with a
 * perfectly good card gets told nothing fits, or a machine with none gets told
 * everything does.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GB = 1024 * 1024 * 1024;

/** Run a probe binary without a shell. Never throws — returns a result object. */
function run(file, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: err.message, stdout: stdout || '', stderr: stderr || '' });
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

/**
 * NVIDIA VRAM via nvidia-smi.
 * Returns { available: true, gpus: [...] } | { available: false, reason }
 */
async function probeNvidia() {
  const r = await run('nvidia-smi',
    ['--query-gpu=index,name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits']);
  if (!r.ok) {
    // Not an error worth surfacing as a failure — most machines have no NVIDIA
    // card, and that is a normal, correct answer.
    return { available: false, reason: 'nvidia-smi not present or returned no data' };
  }
  const gpus = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 5 || !p[0]) continue;
    const totalMb = parseInt(p[2], 10);
    const freeMb = parseInt(p[4], 10);
    if (!Number.isFinite(totalMb)) continue;
    gpus.push({
      index: parseInt(p[0], 10),
      name: p[1],
      vramTotalBytes: totalMb * 1024 * 1024,
      vramFreeBytes: Number.isFinite(freeMb) ? freeMb * 1024 * 1024 : null,
    });
  }
  if (!gpus.length) return { available: false, reason: 'nvidia-smi returned no GPUs' };
  return { available: true, vendor: 'nvidia', gpus };
}

/** Apple Silicon: unified memory means the GPU shares system RAM. */
function probeAppleUnified() {
  if (os.platform() !== 'darwin' || os.arch() !== 'arm64') return null;
  // On unified-memory Macs a sensible working ceiling is ~70% of system RAM;
  // macOS will not let a single process map all of it.
  const total = os.totalmem();
  return {
    available: true, vendor: 'apple', unified: true,
    gpus: [{ index: 0, name: 'Apple Silicon (unified memory)', vramTotalBytes: Math.floor(total * 0.7), vramFreeBytes: null }],
  };
}

/** Free bytes on the volume holding `dir`. Null when it cannot be determined. */
function probeFreeDisk(dir) {
  try {
    // statfsSync landed in Node 18.15 / 19. Older runtimes return null rather
    // than a guess.
    if (typeof fs.statfsSync !== 'function') return null;
    let probe = dir;
    // Walk up to the nearest directory that exists — the data root may not be
    // created yet on a first run.
    for (let i = 0; i < 6 && !fs.existsSync(probe); i++) probe = path.dirname(probe);
    const st = fs.statfsSync(probe);
    return st.bavail * st.bsize;
  } catch { return null; }
}

function probeCpu() {
  const cpus = os.cpus() || [];
  return {
    model: cpus.length ? String(cpus[0].model).trim() : 'unknown',
    cores: cpus.length || null,
    arch: os.arch(),
    platform: os.platform(),
  };
}

/**
 * Full capability snapshot.
 *
 * @param {object} opts
 * @param {string} [opts.dataRoot]      where models will be written (for free-disk)
 * @param {object} [opts.activeRuntime] registry's active runtime, if any
 */
async function detect(opts = {}) {
  const { dataRoot, activeRuntime } = opts;

  let gpu = probeAppleUnified();
  if (!gpu) gpu = await probeNvidia();

  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const freeDisk = dataRoot ? probeFreeDisk(dataRoot) : null;

  // The backend actually installed decides whether VRAM or RAM is the ceiling.
  // A CUDA build with no card still runs on CPU; a CPU build never touches the
  // GPU even when one is present. Reading the runtime rather than the hardware
  // is what keeps this honest.
  const backend = activeRuntime?.backend || null;
  const usesGpu = backend === 'cuda' || backend === 'metal' || backend === 'rocm' || backend === 'vulkan';

  const vramTotal = gpu.available
    ? gpu.gpus.reduce((n, g) => Math.max(n, g.vramTotalBytes), 0)
    : null;

  return {
    probedAt: new Date().toISOString(),
    cpu: probeCpu(),
    ram: {
      totalBytes: totalRam,
      freeBytes: freeRam,
      totalGb: +(totalRam / GB).toFixed(1),
      freeGb: +(freeRam / GB).toFixed(1),
    },
    gpu: gpu.available
      ? { present: true, vendor: gpu.vendor, unified: !!gpu.unified, gpus: gpu.gpus,
          vramTotalBytes: vramTotal, vramTotalGb: +(vramTotal / GB).toFixed(1) }
      : { present: false, reason: gpu.reason, vramTotalBytes: null, vramTotalGb: null },
    disk: {
      freeBytes: freeDisk,
      freeGb: freeDisk === null ? null : +(freeDisk / GB).toFixed(1),
      known: freeDisk !== null,
    },
    runtime: activeRuntime
      ? { id: activeRuntime.id, backend, version: activeRuntime.version, usesGpu }
      : { id: null, backend: null, version: null, usesGpu: false },

    /**
     * The number the fit engine actually compares against, and WHY it chose it.
     * Stated explicitly so the UI can explain a verdict instead of asserting it.
     */
    budget: (() => {
      if (usesGpu && vramTotal) {
        return { bytes: vramTotal, basis: 'vram',
          why: `the installed runtime uses the GPU (${backend}), so VRAM is the ceiling` };
      }
      if (usesGpu && !vramTotal) {
        return { bytes: totalRam, basis: 'ram',
          why: `the runtime is built for ${backend} but no GPU memory could be read, so system RAM is the ceiling` };
      }
      return { bytes: totalRam, basis: 'ram',
        why: backend
          ? `the installed runtime is a ${backend} build, so system RAM is the ceiling`
          : 'no runtime is installed yet — system RAM is assumed as the ceiling' };
    })(),
  };
}

module.exports = { detect, probeNvidia, probeFreeDisk, GB };
