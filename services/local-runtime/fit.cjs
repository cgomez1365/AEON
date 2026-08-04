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
 * Working-set estimate for a GGUF model.
 *
 * weights + KV cache + runtime overhead. The KV term is what people forget:
 * it scales with context length, which is why a model that "just fits" at 2k
 * fails at 32k. Deliberately an over-estimate — telling someone a model fits
 * when it does not is far worse than telling them it is tight.
 */
function estimateWorkingSet(modelBytes, contextTokens) {
  const ctx = Math.max(512, Math.min(contextTokens || 4096, 131072));
  // ~0.5 MB per 1k tokens per GB of weights. Empirical, deliberately generous.
  const kv = (modelBytes / GB) * (ctx / 1024) * 0.5 * 1024 * 1024;
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

  const required = estimateWorkingSet(bytes, ctx);
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

/** Largest catalogue entry that runs comfortably — the "start here" pick. */
function recommend(models, caps, opts = {}) {
  const { shown } = assessCatalog(models, caps, opts);
  return shown.find(m => m.fit.verdict === 'runnable') || shown[0] || null;
}

module.exports = { assess, assessCatalog, recommend, estimateWorkingSet, SERVABLE_FORMATS, GB };
