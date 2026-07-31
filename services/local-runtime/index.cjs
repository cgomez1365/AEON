'use strict';
/**
 * Phase 5 — Local runtime public entry point.
 *
 * This is the only import path the kernel (ai.js, endpoints.cjs) uses.
 * Everything else in services/local-runtime/ is an implementation detail.
 *
 * Exports:
 *   isAvailable()     → boolean — runtime + at least one ready model in registry
 *   defaultModel()    → string|null — first ready chat model id
 *   infer(prompt, opts) → Promise<{ text, tokens, latencyMs, provider, model }>
 *   inferStream(prompt, opts, onToken) → Promise<{ text, tokens, latencyMs, ... }>
 *   embed(text)       → Promise<number[]>   (EMBED_MODEL capability)
 *   status()          → object  — for Settings diagnostics
 *   shutdown()        → Promise<void>
 */

const path = require('path');
const storage = require('../storage.js');
const P = require('./paths.cjs');
const R = require('./registry.cjs');
const { getSupervisor, shutdownSupervisor } = require('./supervisor.cjs');
const { embedOnce } = require('./embedder.cjs');

// ── Registry accessor ─────────────────────────────────────────────────────────
function _registry() {
  return storage.getLocalRuntimeRegistry();
}

function _dataRoot() {
  const reg = _registry();
  // registry.file is inside managedRoot; managedRoot is inside dataRoot
  return path.resolve(reg.file, '..', '..', '..');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * True when a ready runtime AND at least one ready model are in the registry.
 */
function isAvailable() {
  try {
    const reg = _registry();
    return !!reg.activeRuntime() && reg.readyModels().length > 0;
  } catch { return false; }
}

/**
 * Id of the first ready chat-capable model, or null.
 */
function defaultModel() {
  try {
    const models = _registry().modelsForCapability('chat');
    return models.length ? models[0].id : null;
  } catch { return null; }
}

/**
 * Run inference. Starts the supervisor (and thus llama.cpp) on first call.
 * Serializes via the InferenceQueue — concurrent callers are safely queued.
 *
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, temperature?: number, stop?: string[] }} opts
 * @returns {Promise<{ text: string, tokens: number, latencyMs: number, provider: 'local', model: string }>}
 */
async function infer(prompt, opts = {}) {
  const sup = await _getSupervisorForModel(opts.model);
  return sup.infer(prompt, opts);
}

/**
 * Streaming inference. onToken is called for each token as it arrives.
 * Returns the same shape as infer() when complete.
 */
async function inferStream(prompt, opts = {}, onToken) {
  const sup = await _getSupervisorForModel(opts.model);
  return sup.infer(prompt, { ...opts, onToken });
}

/**
 * Embed a string using the first ready embed-capable model.
 * Returns a float32 array.
 */
async function embed(text) {
  const models = _registry().modelsForCapability('embed');
  if (!models.length) throw new Error('No embed-capable model installed');
  const embedModel = models[0];
  const runtime = _registry().activeRuntime();
  if (!runtime) throw new Error('No active runtime');

  const entryAbs = _registry().resolveEntryPath(runtime);
  const modelAbs = _registry().resolveEntryPath(embedModel);

  // One-shot through llama-embedding, NOT the supervisor. The supervisor's
  // worker never reaches a ready state (it spawns llama-cli with --server, a
  // flag that does not exist, and waits on a stdout banner that goes to
  // stderr), so this call used to hang forever with no output and no log.
  // See embedder.cjs for the full diagnosis.
  // Capped at 2048: nomic-embed-text advertises an 8192 ceiling but the GGUF
  // reports it was trained on 2048, and a larger window costs memory per call
  // for no gain. embedder.cjs pins n_batch to n_ctx either way.
  const ceiling = Number(embedModel.contextCeiling) || 512;
  return embedOnce({
    entryAbsPath: entryAbs,
    modelAbsPath: modelAbs,
    text,
    contextSize: Math.min(ceiling, 2048),
  });
}

/**
 * Status snapshot for Settings diagnostics.
 */
function status() {
  try {
    const reg = _registry();
    const runtime = reg.activeRuntime();
    const readyModels = reg.readyModels();
    return {
      available: !!runtime && readyModels.length > 0,
      runtimeId: runtime ? runtime.id : null,
      runtimeVersion: runtime ? runtime.version : null,
      runtimeBackend: runtime ? runtime.backend : null,
      readyModels: readyModels.map(m => ({
        id: m.id,
        displayName: m.displayName,
        capabilities: m.capabilities,
        quantization: m.quantization,
      })),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

async function shutdown() {
  await shutdownSupervisor();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _getSupervisorForModel(modelId) {
  const reg = _registry();
  const runtime = reg.activeRuntime();
  if (!runtime) throw new Error('No active local runtime. Install the runtime in Cookbook first.');

  let model;
  if (modelId) {
    model = reg.readyModels().find(m => m.id === modelId);
    if (!model) throw new Error(`Model "${modelId}" is not ready`);
  } else {
    const models = reg.modelsForCapability('chat');
    if (!models.length) throw new Error('No chat-capable local model installed. Download one from Cookbook.');
    model = models[0];
  }

  const entryAbs = reg.resolveEntryPath(runtime);
  const modelAbs = reg.resolveEntryPath(model);

  return getSupervisor({ entryAbsPath: entryAbs, modelAbsPath: modelAbs });
}

module.exports = { isAvailable, defaultModel, infer, inferStream, embed, status, shutdown };
