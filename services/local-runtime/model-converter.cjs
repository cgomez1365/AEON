/**
 * Tier 3 — install any HuggingFace model, honestly.
 *
 * BO-B1c. llama.cpp reads GGUF and nothing else. A HuggingFace repo is usually
 * safetensors, which is why `Qwen/Qwen2.5-3B` downloaded 5.8 GB successfully
 * and could never be served: the download path and the serve path wanted
 * different things and nobody compared them.
 *
 * "Only these five models" is the cheap fix and it makes the product smaller
 * than its own claim. The honest fix is to convert — llama.cpp ships
 * `convert_hf_to_gguf.py` for exactly this — and to state the cost BEFORE a
 * byte moves.
 *
 * THE CONTRACT OF THIS FILE:
 *   preflight() answers "can this machine convert this model, and what will it
 *   cost you?" without downloading anything. Every blocker it returns names a
 *   remedy. Nothing here starts work the operator has not agreed to after
 *   seeing that answer.
 *
 * Conversion is genuinely expensive — a Python toolchain, several minutes, and
 * peak disk of roughly 3x the final model. Those are facts to disclose, not to
 * hide behind a spinner.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const GB = 1024 * 1024 * 1024;

/**
 * llama.cpp pins its converter to a release; use the same tag as the runtime.
 *
 * BO-SHIP P4 — audit P0-05. This returned a URL on `master` by default: a
 * MUTABLE branch ref, fetched and then executed with operator privileges. An
 * independent harness replaced fetch() with an arbitrary Python payload and
 * ensureConverter()/convert() ran it, returning convertOk:true. There was no
 * hash, signature, or immutable ref — only a loose content regex, which any
 * payload containing the word "gguf" satisfies.
 *
 * A mutable ref is now refused outright. Immutable means a llama.cpp release
 * tag (b12345) or a full 40-hex commit SHA.
 */
const IMMUTABLE_REF = /^(b\d+|[0-9a-f]{40})$/;

function isImmutableRef(tag) {
  return IMMUTABLE_REF.test(String(tag || ''));
}

function converterUrl(tag) {
  if (!isImmutableRef(tag)) {
    throw new Error(
      `[CONVERTER] refusing a mutable ref "${tag}". The converter is executed with `
      + `operator privileges, so it must be pinned to a release tag (b12345) or a full commit SHA.`
    );
  }
  return `https://raw.githubusercontent.com/ggml-org/llama.cpp/${tag}/convert_hf_to_gguf.py`;
}

function run(file, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err, error: err ? err.message : null,
        stdout: stdout || '', stderr: stderr || '',
      }));
  });
}

/** Find a usable Python 3. Returns { ok, exe, version } | { ok:false, reason }. */
async function findPython() {
  const candidates = os.platform() === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const exe of candidates) {
    const r = await run(exe, ['--version'], 8000);
    const out = `${r.stdout}${r.stderr}`.trim();
    const m = /Python (\d+)\.(\d+)/.exec(out);
    if (r.ok && m && Number(m[1]) >= 3 && Number(m[2]) >= 8) {
      return { ok: true, exe, version: `${m[1]}.${m[2]}` };
    }
  }
  return { ok: false, reason: 'No Python 3.8+ found on PATH' };
}

/**
 * Which of the converter's imports are missing.
 *
 * ONE interpreter start, not one per module. The first version spawned Python
 * five times — importing torch alone can take several seconds, so a preflight
 * that should feel instant took most of a minute and timed out under a loaded
 * test run. importlib.util.find_spec checks availability WITHOUT executing the
 * module, which is both correct and far faster than importing it.
 */
const PY_DEPS = ['gguf', 'numpy', 'torch', 'sentencepiece', 'transformers'];

async function checkPyDeps(pythonExe) {
  const script = [
    'import importlib.util as u',
    `mods = ${JSON.stringify(PY_DEPS)}`,
    'print(",".join(m for m in mods if u.find_spec(m) is None))',
  ].join('; ');

  const r = await run(pythonExe, ['-c', script], 25000);
  if (!r.ok) return PY_DEPS.slice();          // cannot tell → assume all missing
  return r.stdout.trim().split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Can we convert, and what will it cost?
 *
 * Cheap and side-effect free — no network, no download. Safe to call every
 * time the operator looks at a model.
 *
 * @param {object} o
 * @param {number} o.sourceBytes   size of the HF repo (safetensors total)
 * @param {string} o.dataRoot      where the result will be written
 * @param {string} [o.quant]       target quantisation, default Q4_K_M
 * @param {string} [o.runtimeTag]  llama.cpp release tag, for a matching converter
 * @param {string} [o.quantizeExe] absolute path to llama-quantize, if installed
 */
async function preflight(o = {}) {
  const sourceBytes = Number(o.sourceBytes) || 0;
  const quant = o.quant || 'Q4_K_M';

  // f16 intermediate is roughly the source size; the quantised result is
  // roughly a third of that for Q4. Peak disk is source + f16 + result.
  const f16Bytes = sourceBytes;
  const resultBytes = Math.round(sourceBytes * (quant.startsWith('Q8') ? 0.55 : 0.32));
  const peakBytes = sourceBytes + f16Bytes + resultBytes;

  const blockers = [];
  const warnings = [];

  const py = await findPython();
  let missingDeps = [];
  if (!py.ok) {
    blockers.push({
      code: 'no_python',
      message: 'Converting a HuggingFace model needs Python 3.8 or newer.',
      remedy: 'Install Python from python.org, then re-run this check.',
    });
  } else {
    missingDeps = await checkPyDeps(py.exe);
    if (missingDeps.length) {
      blockers.push({
        code: 'missing_python_packages',
        message: `Python is installed but the converter needs: ${missingDeps.join(', ')}.`,
        remedy: `Run:  ${py.exe} -m pip install ${missingDeps.join(' ')}`,
        detail: missingDeps.includes('torch')
          ? 'torch is a large download (roughly 2 GB) — this is the expensive part.'
          : null,
      });
    }
  }

  if (o.quantizeExe && !fs.existsSync(o.quantizeExe)) {
    warnings.push({
      code: 'no_quantize',
      message: 'llama-quantize was not found, so the result will stay at f16.',
      detail: `An f16 model is about 3x larger (~${(f16Bytes / GB).toFixed(1)} GB) and needs far more memory to run.`,
    });
  }

  // Disk is a hard blocker — conversion writes three copies at its peak.
  let freeDisk = null;
  try {
    if (typeof fs.statfsSync === 'function' && o.dataRoot) {
      let probe = o.dataRoot;
      for (let i = 0; i < 6 && !fs.existsSync(probe); i++) probe = path.dirname(probe);
      const st = fs.statfsSync(probe);
      freeDisk = st.bavail * st.bsize;
    }
  } catch { /* unknown stays unknown */ }

  if (freeDisk !== null && peakBytes > freeDisk) {
    blockers.push({
      code: 'no_disk',
      message: `Conversion peaks at about ${(peakBytes / GB).toFixed(1)} GB; this drive has ${(freeDisk / GB).toFixed(1)} GB free.`,
      remedy: 'Free up space, or pick a smaller model.',
    });
  }

  return {
    possible: blockers.length === 0,
    blockers,
    warnings,
    python: py.ok ? { exe: py.exe, version: py.version, missingDeps } : null,
    cost: {
      downloadBytes: sourceBytes,
      peakDiskBytes: peakBytes,
      resultBytes,
      quant,
      // Deliberately a range. A precise ETA we cannot honour is a small lie.
      estimatedMinutes: Math.max(2, Math.round((sourceBytes / GB) * 1.5)),
    },
    /** Plain-language sentence the UI shows before asking for consent. */
    summary: (() => {
      const dl = (sourceBytes / GB).toFixed(1);
      const peak = (peakBytes / GB).toFixed(1);
      const out = (resultBytes / GB).toFixed(1);
      const mins = Math.max(2, Math.round((sourceBytes / GB) * 1.5));
      return `Downloads ${dl} GB, needs ${peak} GB free while working, and leaves a ${out} GB ${quant} model. Takes roughly ${mins} minutes.`;
    })(),
  };
}

/** Fetch the converter script matching the installed runtime release. */
async function ensureConverter(o = {}) {
  const dest = path.join(o.workDir, 'convert_hf_to_gguf.py');

  // The pin travels with the runtime manifest, where the binaries are already
  // pinned and hash-verified. One place, one mechanism.
  let pin = null;
  try { pin = require('./runtime-assets.json').converter || null; } catch {}
  if (!pin || !pin.sha256 || !pin.tag) {
    return { ok: false, error: 'converter is not pinned in runtime-assets.json — refusing to fetch executable code without a hash' };
  }

  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  // A cached copy is verified too. Otherwise the check is a one-time formality
  // that anything with write access to workDir can step around afterwards.
  if (fs.existsSync(dest)) {
    const onDisk = sha(fs.readFileSync(dest));
    if (onDisk === pin.sha256) return { ok: true, path: dest, cached: true, sha256: onDisk, tag: pin.tag };
    try { fs.unlinkSync(dest); } catch {}
    // R-05: say it, do not silently re-fetch over a file that failed its hash.
    console.warn(`[CONVERTER] cached converter failed hash check (${onDisk.slice(0, 12)}… != ${pin.sha256.slice(0, 12)}…); discarded`);
  }

  try {
    fs.mkdirSync(o.workDir, { recursive: true });

    // An explicit runtimeTag must agree with the pin — a caller cannot redirect
    // this fetch at a different revision.
    const tag = o.runtimeTag || pin.tag;
    if (tag !== pin.tag) {
      return { ok: false, error: `converter tag "${tag}" does not match the pinned tag "${pin.tag}"` };
    }

    const res = await fetch(converterUrl(tag));
    if (!res.ok) return { ok: false, error: `converter fetch failed: HTTP ${res.status}` };

    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha(buf);
    if (got !== pin.sha256) {
      // Fail closed. This is the whole point: unverified code is not executed.
      return {
        ok: false,
        error: `converter hash mismatch — expected ${pin.sha256}, got ${got}. Refusing to execute unverified code.`,
      };
    }

    fs.writeFileSync(dest, buf);
    return { ok: true, path: dest, cached: false, sha256: got, tag };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Convert a downloaded HF snapshot to GGUF, then quantise.
 * Streams progress lines to onStatus. Resolves { ok, ggufPath, bytes } or
 * { ok:false, error } — never throws, never leaves a half-file registered.
 */
function convert(o = {}) {
  return new Promise(async (resolve) => {
    const { pythonExe, converterPath, snapshotDir, outDir, quant = 'Q4_K_M', quantizeExe, onStatus = () => {} } = o;
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    const f16Path = path.join(outDir, 'model-f16.gguf');
    const finalPath = path.join(outDir, `model-${quant}.gguf`);

    onStatus('Converting weights to GGUF (this is the slow part)…');
    const conv = spawn(pythonExe, [converterPath, snapshotDir, '--outfile', f16Path, '--outtype', 'f16'],
      { windowsHide: true });

    let errTail = '';
    conv.stdout.on('data', d => { const s = String(d).trim(); if (s) onStatus(s.split('\n').pop()); });
    conv.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-4000); });

    conv.on('error', (e) => resolve({ ok: false, error: `converter failed to start: ${e.message}` }));
    conv.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(f16Path)) {
        // Clean up so a failed run cannot be mistaken for a partial success.
        try { fs.rmSync(f16Path, { force: true }); } catch {}
        return resolve({
          ok: false,
          error: `Conversion failed (exit ${code}). ${errTail.split('\n').filter(Boolean).pop() || ''}`.trim(),
        });
      }

      if (!quantizeExe || !fs.existsSync(quantizeExe)) {
        const st = fs.statSync(f16Path);
        onStatus('Converted to f16. llama-quantize not available — keeping f16.');
        return resolve({ ok: true, ggufPath: f16Path, bytes: st.size, quant: 'F16' });
      }

      onStatus(`Quantising to ${quant}…`);
      const q = spawn(quantizeExe, [f16Path, finalPath, quant], { windowsHide: true });
      let qErr = '';
      q.stdout.on('data', d => { const s = String(d).trim(); if (s) onStatus(s.split('\n').pop()); });
      q.stderr.on('data', d => { qErr = (qErr + String(d)).slice(-2000); });
      q.on('error', (e) => resolve({ ok: false, error: `quantise failed to start: ${e.message}` }));
      q.on('close', (qc) => {
        if (qc !== 0 || !fs.existsSync(finalPath)) {
          const st = fs.existsSync(f16Path) ? fs.statSync(f16Path) : null;
          if (st) {
            onStatus('Quantise failed — keeping the f16 conversion.');
            return resolve({ ok: true, ggufPath: f16Path, bytes: st.size, quant: 'F16', warning: qErr.trim() || null });
          }
          return resolve({ ok: false, error: `Quantise failed (exit ${qc}). ${qErr.trim()}` });
        }
        // Reclaim the intermediate — it is 3x the size of what we keep.
        try { fs.rmSync(f16Path, { force: true }); } catch {}
        const st = fs.statSync(finalPath);
        resolve({ ok: true, ggufPath: finalPath, bytes: st.size, quant });
      });
    });
  });
}

module.exports = { preflight, ensureConverter, convert, findPython, checkPyDeps, converterUrl, GB };
