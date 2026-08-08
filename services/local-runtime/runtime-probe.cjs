'use strict';
/**
 * Phase 3 — Runtime probe.
 *
 * Launches the verified binary by absolute path, captures --version output,
 * detects CPU feature flags and available GPU backend, and records results in
 * the registry under runtime.probe. Never touches PATH, never spawns a shell,
 * never relies on OLLAMA or any daemon.
 *
 * Called by runtime-installer after hash verification, and by Settings on the
 * "Re-verify" button. Result is written into the registry; callers decide what
 * to do with it.
 */

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Named remedies for host libraries llama.cpp needs but does not ship.
 *
 * §08 — an error must name every remedy, cheapest first. "libgomp.so.1 not
 * found" is a true statement that leaves an operator nowhere to go; the
 * package name is the part they can act on.
 */
const MISSING_LIB_REMEDIES = {
  'libgomp.so.1':
    'install the OpenMP runtime — Debian/Ubuntu: sudo apt-get install -y libgomp1 · '
    + 'Fedora/RHEL: sudo dnf install -y libgomp · Arch: sudo pacman -S gcc-libs',
  'libstdc++.so.6':
    'install the C++ standard library — Debian/Ubuntu: sudo apt-get install -y libstdc++6 · '
    + 'Fedora/RHEL: sudo dnf install -y libstdc++',
};

/**
 * @param {string} entryAbsPath  Absolute path to llama-cli (or llama-cli.exe)
 * @param {string[]} probeArgs   From runtime-assets.json (usually ["--version"])
 * @returns {{ reportedVersion: string, cpuFeatures: string[], gpuBackend: string|null, probedAt: string }}
 * @throws if binary is missing, not executable, or probe times out
 */
function probe(entryAbsPath, probeArgs = ['--version']) {
  if (!path.isAbsolute(entryAbsPath)) {
    throw new Error(`probe: entryAbsPath must be absolute, got: ${entryAbsPath}`);
  }
  const fs = require('fs');
  if (!fs.existsSync(entryAbsPath)) {
    throw new Error(`probe: binary not found: ${entryAbsPath}`);
  }

  // spawnSync, not execFileSync: llama.cpp writes its version banner, its CPU
  // feature line and its GPU init messages to STDERR, and execFileSync returns
  // only stdout on success. The probe therefore parsed an empty string and
  // recorded reportedVersion "unknown", cpuFeatures [] and gpuBackend null —
  // for a binary that had just printed all three. Worse, execFileSync inherits
  // stderr by default, so that banner leaked into the installer's console
  // output, which is exactly where we saw "version: 5060" while the registry
  // said "unknown".
  //
  // Both streams are captured and concatenated. Exit code is deliberately not
  // checked: some llama.cpp builds print --version and exit non-zero.
  const res = spawnSync(entryAbsPath, probeArgs, {
    timeout: PROBE_TIMEOUT_MS,
    encoding: 'utf8',
    // No shell. No PATH lookup. Absolute path only.
    shell: false,
    // Capture both streams rather than letting either reach the parent console.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Suppress a console window on a GUI launcher.
    windowsHide: true,
  });

  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error(`probe: binary did not respond within ${PROBE_TIMEOUT_MS}ms: ${entryAbsPath}`);
    }
    throw new Error(`probe: could not run binary: ${res.error.message}`);
  }

  const raw = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (!raw.trim()) {
    throw new Error(`probe: binary produced no output on ${probeArgs.join(' ')}: ${entryAbsPath}`);
  }

  // BO-E2 — a binary that cannot load its shared libraries must FAIL the probe.
  //
  // Found on a clean Ubuntu 24.04: llama.cpp's Linux build links against
  // libgomp (GCC's OpenMP runtime), which is absent from a minimal install and
  // present on every developer machine — build-essential pulls it in. So this
  // has never been seen, and it is precisely what a clean-machine test is for.
  //
  // Without this check the failure was WORSE than a crash. The loader writes
  // "error while loading shared libraries: libgomp.so.1" to stderr, so `raw` is
  // non-empty, parseVersion() finds no version and returns "unknown", and the
  // probe RETURNS SUCCESS — recording a runtime as ready when it cannot execute
  // a single token. §08: readiness must reflect ability, not declaration.
  const loaderError = /error while loading shared libraries:\s*([^\s:]+)/i.exec(raw);
  if (loaderError) {
    const lib = loaderError[1];
    const remedy = MISSING_LIB_REMEDIES[lib] || `install the system package providing ${lib}`;
    throw new Error(
      `probe: the runtime binary cannot start — the system library ${lib} is missing. `
      + `Remedy: ${remedy}. `
      + `This is a host dependency of llama.cpp, not a fault in the download (${entryAbsPath}).`
    );
  }

  const reportedVersion = parseVersion(raw);
  const cpuFeatures = parseCpuFeatures(raw);
  const gpuBackend = parseGpuBackend(raw);

  return {
    reportedVersion,
    cpuFeatures,
    gpuBackend,
    probedAt: new Date().toISOString(),
  };
}

/**
 * Extract "build NNNN" or "version b5060" style strings.
 * llama.cpp prints something like:
 *   version: 5060 (abc1234)
 *   built with gcc 13.2 ...
 */
function parseVersion(raw) {
  // "version: 5060 (abc1234)"
  const m1 = raw.match(/version:\s*(\d+)/i);
  if (m1) return `b${m1[1]}`;
  // "build: 5060"
  const m2 = raw.match(/build:\s*(\d+)/i);
  if (m2) return `b${m2[1]}`;
  // Fallback: grab the first token that looks like a version
  const m3 = raw.match(/\b(b\d{4,5}|\d\.\d+\.\d+)\b/);
  if (m3) return m3[1];
  return raw.split('\n')[0].trim().slice(0, 80) || 'unknown';
}

/**
 * Detected SIMD feature flags, e.g. "AVX = 1 | AVX2 = 1 | AVX512 = 0 | ...".
 *
 * Note: b5060's `--version` prints only the version and the compiler banner —
 * the feature line appears when a MODEL is loaded, not on --version. An empty
 * cpuFeatures array from a --version probe is therefore correct, not a parse
 * failure. Do not "fix" it by loosening these patterns.
 */
function parseCpuFeatures(raw) {
  const features = [];
  const patterns = [
    /AVX512[A-Z_]*\s*=\s*1/gi,
    /\bAVX2\s*=\s*1/i,
    /\bAVX\s*=\s*1/i,
    /\bFMA\s*=\s*1/i,
    /\bNEON\s*=\s*1/i,
    /\bF16C\s*=\s*1/i,
    /\bSSE3\s*=\s*1/i,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) {
      const label = m[0].split('=')[0].trim().replace(/\s+/g, '_').toUpperCase();
      if (!features.includes(label)) features.push(label);
    }
  }
  return features;
}

/**
 * Detect which GPU backend is active. llama.cpp prints something like:
 *   "ggml_cuda_init: found 1 CUDA devices:"
 *   "ggml_metal_init: allocating..."
 *   "Using Vulkan backend"
 */
function parseGpuBackend(raw) {
  if (/ggml_cuda_init|CUDA\s+device/i.test(raw)) return 'cuda';
  if (/ggml_metal_init|metal\s+device/i.test(raw)) return 'metal';
  if (/vulkan\s+backend|ggml_vk/i.test(raw)) return 'vulkan';
  if (/ggml_rocm|HIP\s+device/i.test(raw)) return 'rocm';
  return null;
}

/**
 * Quick sanity check: can the binary be found and exec'd at all?
 * Does not write to the registry — just returns true/false + reason.
 */
function canExec(entryAbsPath) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(entryAbsPath)) return { ok: false, reason: 'not found' };
    // On POSIX we can check the execute bit cheaply.
    if (os.platform() !== 'win32') {
      try { fs.accessSync(entryAbsPath, fs.constants.X_OK); }
      catch { return { ok: false, reason: 'not executable (missing +x)' }; }
    }
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { probe, canExec, parseVersion, parseCpuFeatures, parseGpuBackend };
