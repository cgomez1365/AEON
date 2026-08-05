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
 *   listReadyModels(cap) → array — THE model list every picker renders
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
const { ServerSession } = require('./server-session.cjs');
const { ensureLocalReady: _ensureLocalReady } = require('./provision.cjs');

// ── Registry accessor ─────────────────────────────────────────────────────────
function _registry() {
  return storage.getLocalRuntimeRegistry();
}

function _dataRoot() {
  const reg = _registry();
  // registry.file is <dataRoot>/local-runtime/local-runtime.json, so dataRoot
  // is TWO levels up from the file: file → local-runtime/ → dataRoot.
  //
  // This said three, which resolved to dataRoot's PARENT. Nothing had ever
  // called it — every other path goes through the registry object directly —
  // so the first caller that did (auto-provisioning) installed 4.7 GB of
  // runtime and weights one directory above where AEON looks for them, then
  // reported success while status() showed nothing installed.
  return path.resolve(reg.file, '..', '..');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * True when a ready runtime AND at least one ready model are in the registry.
 */
function isAvailable(capability = 'chat') {
  try {
    const reg = _registry();
    if (!reg.activeRuntime()) return false;
    const ready = reg.readyModels();
    if (!ready.length) return false;
    // Capability matters: this used to answer "any model at all is ready",
    // but every caller asks it to decide whether local can serve a CHAT turn.
    // Install only the embedding model and local advertised itself as a chat
    // provider, got selected ahead of the cloud, and returned a 500 instead of
    // degrading — defaultModel() was null the whole time.
    if (!capability) return true;
    return ready.some(m => (m.capabilities || []).includes(capability));
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
 * THE read path for "which local models can serve right now".
 *
 * Every operator-facing surface — the Settings role picker, Council's model
 * menu, auto-pick — calls this. None of them may index `status()` by hand.
 *
 * That rule exists because they did. `status()` reports under `readyModels`;
 * three call sites read `.models`, which is `undefined`, which each turned into
 * `[]`. The expression was copy-pasted from a site where it was correct — it
 * read the legacy flat store, which genuinely carries `.models`. Right field
 * name, wrong object, and every picker went blank while a verified GGUF sat
 * ready on disk (2026-08-04).
 *
 * A named function removes the chance to guess. `capability` defaults to 'chat'
 * because every current caller is choosing a conversational model; pass null to
 * list every ready model regardless of capability.
 *
 * @param {string|null} capability
 * @returns {Array<{id:string, displayName:string, capabilities:string[], quantization:string|null}>}
 */
function listReadyModels(capability = 'chat') {
  try {
    const reg = _registry();
    const models = capability ? reg.modelsForCapability(capability) : reg.readyModels();
    return models.map(m => ({
      id: m.id,
      displayName: m.displayName || m.id,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      quantization: m.quantization || null,
    }));
  } catch { return []; }
}

/**
 * Run inference. Starts a llama-server session for the model on first call and
 * keeps it warm for subsequent turns.
 *
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, temperature?: number, stop?: string[] }} opts
 * @returns {Promise<{ text: string, tokens: number, latencyMs: number, provider: 'local', model: string }>}
 */
async function infer(prompt, opts = {}) {
  return _run(prompt, opts, null);
}

/**
 * Streaming inference. onToken is called for each token as it arrives.
 * Returns the same shape as infer() when complete.
 */
async function inferStream(prompt, opts = {}, onToken) {
  return _run(prompt, opts, onToken);
}

/**
 * Both inference paths, over a llama-server session on loopback.
 *
 * Previously these went through supervisor.cjs/worker.mjs, which spawned
 * `llama-cli --server` (no such flag), bound `--host` to a named pipe
 * (llama.cpp is TCP-only), and waited on a stdout banner that goes to stderr
 * and was discarded. Readiness never arrived, and the 120s inference timeout
 * was armed inside the ready callback — on the wrong side of the gate it
 * needed to protect — so this hung forever with no error and no log.
 * See server-session.cjs.
 */
// ── One machine, one slot ──────────────────────────────────────────────────
//
// llama.cpp in server mode does one inference at a time. Without a queue,
// concurrent callers all fire at the single slot, each waits behind the others
// inside its own request, and every one of them blows the 180 s request
// timeout.
//
// Measured 2026-08-04 on a bare clone: ONE ask answered in 19 s; FOUR parallel
// asks all failed at exactly 180.2 s with "The operation was aborted due to
// timeout". Not a slow answer — no answer at all, for anybody.
//
// queue.cjs was written for exactly this, documented for exactly this, and was
// never wired to anything. Serializing turns four timeouts into four answers,
// and a genuine overload into an immediate honest "busy" instead of a
// three-minute stall.
const { InferenceQueue } = require('./queue.cjs');
const _queue = new InferenceQueue();

async function _run(prompt, opts = {}, onToken) {
  return _queue.enqueue(() => _runNow(prompt, opts, onToken));
}

/** Queue depth/busy state, so a UI can say "waiting" rather than hang. */
function queueState() {
  return { depth: _queue.depth, busy: _queue.busy };
}

async function _runNow(prompt, opts = {}, onToken) {
  const t0 = Date.now();
  const { session, modelId } = await _sessionForModel(opts.model);

  // A plain string becomes one user turn; callers may pass real messages.
  const messages = Array.isArray(opts.messages) && opts.messages.length
    ? opts.messages
    : [
        ...(opts.system ? [{ role: 'system', content: String(opts.system) }] : []),
        { role: 'user', content: typeof prompt === 'string' ? prompt : String(prompt) },
      ];

  const r = await session.chat(messages, {
    maxTokens: opts.maxTokens ?? opts.max_tokens ?? 512,
    temperature: opts.temperature ?? 0.7,
    stop: opts.stop,
    onToken: onToken || undefined,
  });

  return {
    text: r.text,
    tokens: r.tokens,
    latencyMs: Date.now() - t0,
    provider: 'local',
    model: modelId,
  };
}

/**
 * Embed a string using the first ready embed-capable model.
 * Returns a float32 array.
 */
async function embed(text) {
  const reg = _registry();
  const models = reg.modelsForCapability('embed');
  if (!models.length) throw new Error('No local embedding model installed yet.');
  const embedModel = models[0];
  const runtime = reg.activeRuntime();
  if (!runtime) throw new Error('No local AI engine installed yet.');

  // Same ServerSession class as chat, started in embedding mode. llama.cpp
  // b10216 removed the standalone llama-embedding binary and made embeddings a
  // llama-server endpoint, so both capabilities now share one code path, one
  // readiness handshake and one warm process per model.
  //
  // Capped at 2048: nomic-embed-text advertises 8192 but its GGUF reports it
  // was trained on 2048, and llama-server needs n_batch >= n_ctx.
  const key = `embed:${embedModel.id}`;
  let session = _sessions.get(key);
  if (!session || session.state === 'error' || session.state === 'stopped') {
    session = new ServerSession({
      entryAbsPath: reg.resolveEntryPath(runtime),
      modelAbsPath: reg.resolveEntryPath(embedModel),
      contextSize: Math.min(Number(embedModel.contextCeiling) || 512, 2048),
      embeddings: true,
    });
    _sessions.set(key, session);
    await session.start();
  }
  return session.embed(text);
}

/**
 * Make local inference available, downloading the engine and a starter model if
 * they are missing. See provision.cjs — this is the "backend does the rest"
 * seam, so no user has to understand what a GGUF is.
 */
async function ensureLocalReady(opts = {}) {
  return _ensureLocalReady({ dataRoot: _dataRoot(), ...opts });
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
  // Kill every warm model process. A crashed or restarted kernel must never
  // leave multiple gigabytes of weights resident on a user's machine.
  for (const [, session] of _sessions) {
    try { session.stop(); } catch { /* already gone */ }
  }
  _sessions.clear();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * One warm llama-server per model. Keeping the process alive is the whole
 * reason for choosing a server over one-shot llama-cli: reloading a 1.8 GB
 * model on every message costs 10-20s per reply on a laptop CPU, which is the
 * difference between a usable assistant and an abandoned one.
 */
const _sessions = new Map();   // modelId → ServerSession

async function _sessionForModel(modelId) {
  const reg = _registry();
  const runtime = reg.activeRuntime();
  if (!runtime) throw new Error('No local AI engine installed yet.');

  let model;
  if (modelId) {
    model = reg.readyModels().find(m => m.id === modelId);
    if (!model) throw new Error(`Model "${modelId}" is not ready`);
  } else {
    const models = reg.modelsForCapability('chat');
    if (!models.length) throw new Error('No local chat model installed yet.');
    model = models[0];
  }

  const existing = _sessions.get(model.id);
  if (existing && existing.state !== 'error' && existing.state !== 'stopped') {
    return { session: existing, modelId: model.id };
  }

  const session = new ServerSession({
    entryAbsPath: reg.resolveEntryPath(runtime),
    modelAbsPath: reg.resolveEntryPath(model),
    contextSize: Math.min(Number(model.contextCeiling) || 4096, 8192),
  });
  _sessions.set(model.id, session);
  await session.start();
  return { session, modelId: model.id };
}

module.exports = { isAvailable, defaultModel, listReadyModels, infer, inferStream, embed, status, shutdown, ensureLocalReady, queueState };
