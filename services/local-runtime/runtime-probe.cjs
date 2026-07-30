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

const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT_MS = 15_000;

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

  let raw = '';
  try {
    raw = execFileSync(entryAbsPath, probeArgs, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      // No shell. No PATH lookup. Absolute path only.
      shell: false,
      // Suppress inherited stdio so a GUI launcher doesn't pop a console.
      windowsHide: true,
    });
  } catch (err) {
    // Some llama.cpp builds exit with code 1 on --version (prints and exits).
    // Treat any output as success if the process produced something useful.
    raw = (err.stdout || '') + (err.stderr || '');
    if (!raw.trim()) throw new Error(`probe: binary exited with no output: ${err.message}`);
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
 * llama.cpp --version logs detected SIMD feature flags on stderr.
 * Example: "AVX = 1 | AVX2 = 1 | AVX512 = 0 | ..."
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
