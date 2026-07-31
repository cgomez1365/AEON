'use strict';
/**
 * Auto-provisioning — the difference between "AEON supports local AI" and
 * "AEON just works".
 *
 * THE PROBLEM THIS SOLVES
 *
 * Before this, local inference required the operator to know that a Cookbook
 * block existed, open it, understand the difference between a runtime and a
 * model, pick a quantization, and wait. The person this product is for — the
 * owner of a business, or their kid doing homework — will do none of that.
 * They install an app, make an account, and type a question. If the answer is
 * "first, choose a GGUF quantization", we have already lost them.
 *
 * So: when something needs local inference and it is not there yet, the backend
 * fetches it. The user is told what is happening in plain language and given a
 * percentage. Nothing is silent, and nothing requires a decision they have no
 * basis to make.
 *
 * WHAT IT WILL NOT DO
 *
 *   - It never starts a multi-gigabyte download without the caller opting in
 *     (`allowDownload`). A metered connection is a real cost to a real person.
 *   - It picks the model FOR the user, from RAM, and says which and why.
 *   - It never blocks a request forever: every stage reports, and failure is a
 *     sentence a non-technical person can act on.
 */

const os = require('os');

/**
 * The model a first-time user should get, chosen for the machine.
 *
 * Deliberately NOT "the biggest that fits". A 32 GB workstation would take
 * Llama 3.1 8B on that rule — a 4.9 GB download and slow CPU generation — as
 * someone's first impression of the product. The person opening this app wants
 * an answer, not the highest benchmark score, and they are on whatever laptop
 * their company bought.
 *
 * So: the catalog's `recommended` model when it fits, otherwise the smallest
 * that fits. Anyone who wants more picks it in Cookbook, deliberately, later.
 */
function pickStarterModel(catalog, { totalRamMB = Math.round(os.totalmem() / 1024 / 1024) } = {}) {
  const chat = catalog.models.filter(m => (m.capabilities || []).includes('chat'));
  if (!chat.length) return null;

  // Leave the OS and a browser room to breathe: a model that makes the whole
  // machine swap is worse than a smaller model that answers.
  const budget = totalRamMB * 0.5;
  const fits = chat.filter(m => (m.minRAMMB || 0) <= budget);
  const bySize = (a, b) => (a.minRAMMB || 0) - (b.minRAMMB || 0);

  const recommended = fits.find(m => (m.tags || []).includes('recommended'));
  if (recommended) return recommended;

  // Nothing tagged; smallest that fits. If nothing fits, smallest overall and
  // let the caller decide whether to warn.
  return fits.slice().sort(bySize)[0] || chat.slice().sort(bySize)[0];
}

function pickEmbedModel(catalog) {
  return catalog.models.find(m => (m.capabilities || []).includes('embed')) || null;
}

/**
 * What is missing before local inference can serve `need`?
 * @returns {{ ready: boolean, needsRuntime: boolean, needsModel: boolean, model: object|null, bytes: number }}
 */
function planFor(need, { registry, catalog, totalRamMB } = {}) {
  const capability = need === 'embed' ? 'embed' : 'chat';
  const hasRuntime = !!registry.activeRuntime();
  const existing = registry.modelsForCapability(capability);
  const model = existing.length
    ? null
    : (capability === 'embed' ? pickEmbedModel(catalog) : pickStarterModel(catalog, { totalRamMB }));

  return {
    ready: hasRuntime && existing.length > 0,
    needsRuntime: !hasRuntime,
    needsModel: existing.length === 0,
    model,
    bytes: (model ? model.bytes || 0 : 0),
  };
}

/** Bytes → the way a person says it. */
function humanBytes(n) {
  if (!n) return 'unknown size';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/**
 * Make local inference available for `need`, downloading what is missing.
 *
 * @param {object}   opts
 * @param {string}   opts.dataRoot
 * @param {'chat'|'embed'} [opts.need]
 * @param {boolean}  [opts.allowDownload]  false → report what is needed, fetch nothing
 * @param {(e:{stage:string,message:string,pct?:number,bytes?:number})=>void} [opts.onEvent]
 * @returns {Promise<{ ok: boolean, ready: boolean, installed: string[], reason?: string, needs?: object }>}
 */
async function ensureLocalReady({ dataRoot, need = 'chat', allowDownload = false, onEvent } = {}) {
  const R = require('./registry.cjs');
  const CATALOG = require('./model-catalog.json');
  const RI = require('./runtime-installer.cjs');
  const MI = require('./model-installer.cjs');

  const emit = (stage, message, extra = {}) => {
    if (onEvent) { try { onEvent({ stage, message, ...extra }); } catch { /* never let UI break install */ } }
  };

  const registry = R.createRegistry(dataRoot);
  const plan = planFor(need, { registry, catalog: CATALOG });

  if (plan.ready) return { ok: true, ready: true, installed: [] };

  if (!allowDownload) {
    // Deliberately explicit: the caller decides, with the size in hand.
    return {
      ok: false,
      ready: false,
      installed: [],
      reason: 'download-required',
      needs: {
        runtime: plan.needsRuntime,
        model: plan.model ? plan.model.id : null,
        modelName: plan.model ? plan.model.displayName : null,
        bytes: plan.bytes,
        human: humanBytes(plan.bytes),
      },
    };
  }

  const installed = [];

  try {
    if (plan.needsRuntime) {
      emit('runtime', 'Setting up the local AI engine…', { pct: 0 });
      const r = await RI.installRuntime({
        dataRoot,
        onProgress: (pct) => emit('runtime', 'Downloading the local AI engine…', { pct }),
        onStatus: (m) => emit('runtime', m),
      });
      installed.push(r.runtimeId);
      emit('runtime', 'Local AI engine ready.', { pct: 100 });
    }

    if (plan.needsModel && plan.model) {
      const label = plan.model.displayName;
      emit('model', `Downloading ${label} (${humanBytes(plan.bytes)}). This happens once.`, { pct: 0 });
      await MI.installModel({
        dataRoot,
        modelId: plan.model.id,
        onProgress: (pct) => emit('model', `Downloading ${label}…`, { pct }),
        onStatus: (m) => emit('model', m),
      });
      installed.push(plan.model.id);
      emit('model', `${label} is ready.`, { pct: 100 });
    }
  } catch (e) {
    emit('error', e.message);
    return { ok: false, ready: false, installed, reason: e.message };
  }

  const after = planFor(need, { registry: R.createRegistry(dataRoot), catalog: CATALOG });
  emit('done', 'Local AI is ready.');
  return { ok: true, ready: after.ready, installed };
}

module.exports = { ensureLocalReady, planFor, pickStarterModel, pickEmbedModel, humanBytes };
