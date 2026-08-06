/**
 * Fit engine — can THIS machine actually run THIS model?
 *
 * BO-B1b. The Cookbook used to list every catalogue entry regardless of the
 * machine, so the operator picked one, waited for a multi-gigabyte download,
 * and found out afterwards. Worse, a model could be downloaded in a format the
 * installed runtime cannot open at all, and still be recorded ready.
 *
 * Every verdict here carries NUMBERS and a REASON. "Too big" without saying
 * what it needed and what you have is the same unhelpful failure in a nicer
 * font (Bible §08: an error must name the remedy).
 *
 * VERDICTS
 *   runnable     comfortable — fits with headroom
 *   tight        fits, but close enough that context length will hurt
 *   too_big      needs more memory than the budget allows
 *   no_disk      not enough free space to download it
 *   unsupported  the runtime cannot open this format at all
 *   unknown      a capability could not be probed; we refuse to guess
 */

const GB = 1024 * 1024 * 1024;

// Formats the llama.cpp runtime can actually open. Everything else must be
// converted first (see model-converter.cjs) or refused.
const SERVABLE_FORMATS = new Set(['gguf']);

/**
 * KV cache size, in bytes.
 *
 * BO-D1e. This used to be `(modelBytes/GB) * (ctx/1024) * 0.5 MB` — a flat
 * coefficient keyed off FILE SIZE, under a comment claiming it deliberately
 * over-estimated. For Llama-3.1-8B at its 131,072 ceiling it predicted
 * 0.29 GB against a real cache of 16.00 GB. Fifty-six times under, in the
 * one direction the comment promised it would never err (Bible §08).
 *
 * The cache is not a function of file size at all. Quantisation shrinks the
 * weights and leaves the KV element width alone, so a Q4 build and an f16
 * build of the same architecture carry an identical cache. It is:
 *
 *     layers x kv_heads x head_dim x 2 (K and V) x bytes_per_element x ctx
 *
 * `bytesPerElement` is 2 for the default f16 cache and 1 for q8_0 — that
 * flag is the lever that halves the cost and makes 32k reachable.
 *
 * @param {object|null} spec  { layers, kvHeads, headDim } — from the catalogue
 * @param {number} contextTokens
 * @param {object} [opts] { bytesPerElement = 2, modelBytes }
 */
function estimateKvBytes(spec, contextTokens, opts = {}) {
  const ctx = Math.max(512, Math.min(contextTokens || 4096, 131072));
  const b = opts.bytesPerElement || 2;

  if (spec && spec.layers && spec.kvHeads && spec.headDim) {
    return spec.layers * spec.kvHeads * spec.headDim * 2 * b * ctx;
  }

  // Architecture unknown — a discovered model with no catalogue entry.
  //
  // Now we honour what the old comment only claimed. Grouped-query attention
  // is what makes a modern cache small; a model we cannot inspect might be
  // full multi-head, which costs up to 8x more for the same parameter count.
  // So: derive a GQA reference from the parameter count, then assume the
  // worst-case MHA shape. Guessing high means "it will be tight" on a model
  // that turns out to be fine. Guessing low means an OOM the operator was
  // told would not happen — and that is the failure this module exists to
  // prevent.
  const params = (opts.modelBytes || 0) * 2;        // ~0.5 bytes/param, generous
  const gqaBytesPerTokenPerParam = 8.2e-6;          // measured on Llama-3.1-8B
  const perToken = params * gqaBytesPerTokenPerParam * (b / 2) * KV_UNKNOWN_MHA_FACTOR;
  return Math.round(perToken * ctx);
}

// Worst-case multi-head vs grouped-query ratio, applied when we cannot see
// the architecture. Llama-3.1-8B is 32 heads to 8 KV heads — a factor of 4;
// 8 leaves room for the wider ratios in circulation.
const KV_UNKNOWN_MHA_FACTOR = 8;

/**
 * Working-set estimate for a GGUF model.
 *
 * weights + KV cache + runtime overhead. The KV term is what people forget:
 * it scales with context length, which is why a model that "just fits" at 2k
 * fails at 32k.
 */
function estimateWorkingSet(modelBytes, contextTokens, opts = {}) {
  const kv = estimateKvBytes(opts.kv || null, contextTokens, {
    bytesPerElement: opts.bytesPerElement || 2,
    modelBytes,
  });
  const overhead = 300 * 1024 * 1024;   // allocator, graph, tokenizer
  return Math.round(modelBytes + kv + overhead);
}

const fmtGb = (b) => (b === null || b === undefined) ? '?' : `${(b / GB).toFixed(1)} GB`;

/**
 * @param {object} model  catalogue entry or discovered model
 *        { id, bytes, contextCeiling, format?, quantization?, arch? }
 * @param {object} caps   from capabilities.detect()
 * @param {object} [opts] { contextTokens }
 */
function assess(model, caps, opts = {}) {
  const bytes = Number(model.bytes) || 0;

  // Explicit branches, deliberately. The first draft was
  //   String(model.format || (model.filename||'').endsWith('.gguf') ? 'gguf' : …)
  // where `||` binds tighter than `?:`, so the condition was
  // `(model.format || endsWith(...))` — truthy for ANY declared format. Every
  // model reported as GGUF, including safetensors, which is the precise bug
  // this engine exists to catch. Caught by the catalogue-split test.
  const format = (() => {
    if (model.format) return String(model.format).toLowerCase();
    const name = String(model.filename || model.relPath || '').toLowerCase();
    if (name.endsWith('.gguf')) return 'gguf';
    if (name.endsWith('.safetensors')) return 'safetensors';
    if (name.endsWith('.bin') || name.endsWith('.pt') || name.endsWith('.pth')) return 'pytorch';
    return 'unknown';
  })();

  const ctx = opts.contextTokens || Math.min(model.contextCeiling || 4096, 8192);

  const base = {
    modelId: model.id,
    bytes,
    format,
    contextTokens: ctx,
    budgetBytes: caps?.budget?.bytes ?? null,
    budgetBasis: caps?.budget?.basis ?? null,
  };

  // 1. Format first. A model the runtime cannot open never "fits", however
  //    small it is — this is the check whose absence cost 5.8 GB.
  if (!SERVABLE_FORMATS.has(format)) {
    return {
      ...base,
      verdict: 'unsupported',
      canInstall: false,
      needsConversion: format === 'safetensors' || format === 'pytorch',
      reason: `The installed runtime reads GGUF. This model is ${format}.`,
      remedy: (format === 'safetensors' || format === 'pytorch')
        ? 'AEON can convert it to GGUF before installing — see the conversion preflight.'
        : 'Choose a GGUF build of this model.',
    };
  }

  // 2. Disk. Checked before memory because it fails earlier and more cheaply.
  if (caps?.disk?.known && caps.disk.freeBytes !== null) {
    // Need room for the download plus a little slack for the temp/staging copy.
    const needed = Math.round(bytes * 1.1);
    if (needed > caps.disk.freeBytes) {
      return {
        ...base, verdict: 'no_disk', canInstall: false,
        requiredBytes: needed,
        reason: `Needs about ${fmtGb(needed)} free; this drive has ${fmtGb(caps.disk.freeBytes)}.`,
        remedy: 'Free up disk space, or point AEON\'s data root at a larger drive.',
      };
    }
  }

  // 3. Memory. If we could not establish a budget we say so rather than guess.
  const budget = caps?.budget?.bytes;
  if (!budget) {
    return {
      ...base, verdict: 'unknown', canInstall: false,
      reason: 'Could not determine how much memory is available on this machine.',
      remedy: 'Re-run the hardware scan. If it keeps failing, install a model manually and report it.',
    };
  }

  const required = estimateWorkingSet(bytes, ctx, {
    kv: model.kv || null,
    bytesPerElement: opts.bytesPerElement || 2,
  });
  const ratio = required / budget;

  if (ratio <= 0.70) {
    return {
      ...base, verdict: 'runnable', canInstall: true, requiredBytes: required, ratio,
      reason: `Needs about ${fmtGb(required)} of ${fmtGb(budget)} ${base.budgetBasis?.toUpperCase()} at ${ctx.toLocaleString()} context.`,
    };
  }
  if (ratio <= 0.95) {
    return {
      ...base, verdict: 'tight', canInstall: true, requiredBytes: required, ratio,
      reason: `Needs about ${fmtGb(required)} of ${fmtGb(budget)} ${base.budgetBasis?.toUpperCase()} — it will run, with little room to spare.`,
      remedy: `Reduce context below ${ctx.toLocaleString()} if it struggles.`,
    };
  }
  return {
    ...base, verdict: 'too_big', canInstall: false, requiredBytes: required, ratio,
    reason: `Needs about ${fmtGb(required)} but only ${fmtGb(budget)} ${base.budgetBasis?.toUpperCase()} is available.`,
    remedy: 'Choose a smaller model or a heavier quantisation (Q4 instead of Q8).',
  };
}

/**
 * Assess a whole catalogue and split it.
 *
 * `shown` is what the operator sees by default — only things that can actually
 * be installed and run. `hidden` is everything else, WITH its reason, so the UI
 * can offer "show N that will not run on this machine" rather than pretending
 * they do not exist. Hiding without explaining is its own dishonesty.
 */
function assessCatalog(models, caps, opts = {}) {
  const assessed = (models || []).map(m => ({ ...m, fit: assess(m, caps, opts) }));
  const shown = assessed.filter(m => m.fit.canInstall);
  const hidden = assessed.filter(m => !m.fit.canInstall);

  // Best first: comfortable before tight, then larger (more capable) first.
  const rank = { runnable: 0, tight: 1 };
  shown.sort((a, b) => (rank[a.fit.verdict] - rank[b.fit.verdict]) || (b.bytes - a.bytes));

  return {
    shown, hidden,
    summary: {
      total: assessed.length,
      runnable: assessed.filter(m => m.fit.verdict === 'runnable').length,
      tight: assessed.filter(m => m.fit.verdict === 'tight').length,
      tooBig: assessed.filter(m => m.fit.verdict === 'too_big').length,
      unsupported: assessed.filter(m => m.fit.verdict === 'unsupported').length,
      noDisk: assessed.filter(m => m.fit.verdict === 'no_disk').length,
      unknown: assessed.filter(m => m.fit.verdict === 'unknown').length,
    },
  };
}

/**
 * Largest context this machine can actually serve for this model.
 *
 * BO-D1e, second half. Context was hardcoded to `min(contextCeiling, 8192)`
 * in local-runtime/index.cjs — the same 8,192 on a 4 GB laptop and on a
 * 32 GB workstation, against models declaring a 131,072 ceiling. One number
 * standing in for a measurement.
 *
 * Walks the standard context steps downward and returns the largest that
 * fits the measured budget with headroom, never exceeding the model's own
 * ceiling. Returns the numbers behind the choice so a UI can explain it
 * rather than assert it (§08).
 *
 * `target` caps the search: there is no point serving 131k to a chat box,
 * and the cache is charged whether or not the window is filled.
 */
const CONTEXT_STEPS = [131072, 65536, 32768, 16384, 8192, 4096, 2048];

function largestFittingContext(model, caps, opts = {}) {
  const target = opts.target || 32768;
  const ceiling = Number(model.contextCeiling) || 4096;
  const budget = caps?.budget?.bytes;
  const bytesPerElement = opts.bytesPerElement || 2;
  const headroom = opts.headroom ?? 0.70;   // same "runnable" bar as assess()

  if (!budget) {
    // No measurement, no promise. Fall back to the old floor and say why.
    return {
      contextTokens: Math.min(ceiling, 4096),
      limitedBy: 'unknown-budget',
      reason: 'Could not determine available memory; using a conservative window.',
    };
  }

  const candidates = CONTEXT_STEPS.filter(c => c <= Math.min(ceiling, target));
  for (const ctx of candidates) {
    const required = estimateWorkingSet(Number(model.bytes) || 0, ctx, {
      kv: model.kv || null,
      bytesPerElement,
    });
    if (required <= budget * headroom) {
      return {
        contextTokens: ctx,
        limitedBy: ctx === Math.min(ceiling, target) ? (ceiling <= target ? 'model-ceiling' : 'target') : 'memory',
        requiredBytes: required,
        budgetBytes: budget,
        kvBytes: estimateKvBytes(model.kv || null, ctx, { bytesPerElement, modelBytes: model.bytes }),
        bytesPerElement,
        reason: `${ctx.toLocaleString()} tokens needs about ${fmtGb(required)} of ${fmtGb(budget)}.`,
      };
    }
  }

  const smallest = candidates[candidates.length - 1] || 2048;
  return {
    contextTokens: smallest,
    limitedBy: 'memory',
    requiredBytes: estimateWorkingSet(Number(model.bytes) || 0, smallest, { kv: model.kv || null, bytesPerElement }),
    budgetBytes: budget,
    reason: `Even ${smallest.toLocaleString()} tokens is tight on ${fmtGb(budget)}.`,
    remedy: 'Use a heavier quantisation, or quantise the KV cache to q8_0 to halve it.',
  };
}

/** Largest catalogue entry that runs comfortably — the "start here" pick. */
function recommend(models, caps, opts = {}) {
  const { shown } = assessCatalog(models, caps, opts);
  return shown.find(m => m.fit.verdict === 'runnable') || shown[0] || null;
}

module.exports = { assess, assessCatalog, recommend, estimateWorkingSet, estimateKvBytes, largestFittingContext, SERVABLE_FORMATS, GB };
